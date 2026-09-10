/**
 * Extract.gs — turning a fetched page into the fewest tokens that still say
 * what the job is.
 *
 * Claude never sees raw HTML. That is not tidiness, it is the entire cost
 * model: a mid-sized careers page is 40,000 tokens of markup wrapped around
 * 600 tokens of job description, and sending the wrapper is the difference
 * between three dollars a month and a hundred and fifty.
 *
 * Preference order is structure first, text last. A schema.org JobPosting in a
 * <script type="application/ld+json"> block gives title, company, location,
 * salary and description as clean fields for free, and a great many boards
 * publish one because Google Jobs requires it. Only when there is no such
 * block does anything here fall back to reading the markup.
 *
 * Apps Script has no DOM parser, and XmlService rejects real-world HTML on the
 * first unclosed <br>, so the fallback is a string pipeline: a sequence of
 * small named steps, each of which can be tested on its own, rather than one
 * clever regex that nobody can debug at 7am when the morning report is empty.
 */

// ------------------------------------------------------------------ entities

var NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', hellip: '…', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', middot: '·', bull: '·', trade: '™',
  reg: '®', copy: '©', deg: '°', eacute: 'é', euro: '€', pound: '£',
  frac12: '1/2', times: 'x', minus: '-', shy: ''
};

/**
 * Decode HTML entities, numeric and named.
 *
 * Runs after tags are stripped, never before: decoding first would turn a
 * posting that mentions "&lt;script&gt;" in its text into a real tag, and the
 * next step would then strip the words around it.
 */
function decodeEntities_(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, function (whole, hex) {
      return codePoint_(parseInt(hex, 16), whole);
    })
    .replace(/&#(\d+);/g, function (whole, dec) {
      return codePoint_(parseInt(dec, 10), whole);
    })
    .replace(/&([a-z][a-z0-9]{1,9});/gi, function (whole, name) {
      var hit = NAMED_ENTITIES[name.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
}

/** An unrepresentable code point is left as it was rather than thrown away. */
function codePoint_(value, whole) {
  if (!isFinite(value) || value < 0 || value > 0x10ffff) return whole;
  try {
    return String.fromCharCode(value);
  } catch (err) {
    return whole;
  }
}

// ------------------------------------------------------------- html to text

/**
 * Remove elements whose contents are never part of a job description.
 *
 * With their contents — not unwrapped. Unwrapping a <script> leaves the
 * JavaScript behind as prose, and a single analytics bundle is more tokens
 * than the posting it sits next to. Unclosed tags are common enough that the
 * pattern also accepts a run to end-of-string.
 */
function stripElements_(html) {
  var out = String(html || '');
  for (var i = 0; i < STRIP_ELEMENTS.length; i++) {
    var tag = STRIP_ELEMENTS[i];
    var re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?(?:</' + tag + '\\s*>|$)', 'gi');
    out = out.replace(re, ' ');
    // Self-closing and void forms of the same elements carry no text but do
    // carry attributes, which would survive the tag strip as stray words.
    out = out.replace(new RegExp('<' + tag + '\\b[^>]*/?>', 'gi'), ' ');
  }
  return out.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
            .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, ' ')
            .replace(/<!DOCTYPE[^>]*>/gi, ' ');
}

/**
 * Turn the tags that mean "line ends here" into newlines before the rest are
 * dropped, so a bulleted requirements list does not arrive as one long
 * sentence with the words run together.
 */
function breakLines_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    // A closing block tag ends a paragraph. A list is a block too, so the
    // prose after one is separated from it rather than run on.
    .replace(
      /<\/(p|div|section|article|tr|h[1-6]|blockquote|pre|ul|ol|table)\s*>/gi, '\n\n')
    // <li> opens its own line, so </li> must not close it as well: the list
    // would otherwise arrive double-spaced, and every blank line is a token.
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]\s*>/gi, ' ');
}

/** Drop every remaining tag, complete or truncated. */
function stripTags_(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ');
}

/**
 * Collapse the whitespace a stripped page is mostly made of.
 *
 * Indentation alone can be a third of a page's characters. Runs of spaces and
 * tabs become one space, runs of blank lines become one blank line, and
 * trailing space on a line goes entirely.
 */
function collapseWhitespace_(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The whole fallback pipeline, in the one order that is correct. */
function htmlToText_(html) {
  return collapseWhitespace_(decodeEntities_(stripTags_(breakLines_(stripElements_(html)))));
}

// -------------------------------------------------------------------- tokens

/**
 * Roughly how many tokens a string will cost.
 *
 * Estimated, not counted: Apps Script cannot run a tokenizer, and a round-trip
 * to count_tokens would cost more than the slack it buys. Four characters per
 * token is the usual English approximation.
 */
function estimateTokens_(text) {
  return Math.ceil(String(text || '').length / CONFIG.CHARS_PER_TOKEN);
}

/**
 * Cut a description down to the cap, on a word boundary where one is near.
 *
 * The front of a posting is the part worth paying for — title, team, the first
 * paragraph of responsibilities. What gets cut is the benefits boilerplate and
 * the equal-opportunity statement, which are identical across every posting a
 * company writes and tell the scorer nothing.
 */
var TRUNCATION_MARKER = '\n[truncated]';

function capTokens_(text, maxTokens) {
  var limit = (maxTokens || CONFIG.MAX_DESC_TOKENS) * CONFIG.CHARS_PER_TOKEN;
  var out = String(text || '');
  if (out.length <= limit) return out;

  // The marker counts against the limit. Appending it afterwards made the cap
  // three tokens larger than the number it was given, which is harmless at
  // 1,200 and not harmless as the reason a hard limit is not hard.
  var room = limit - TRUNCATION_MARKER.length;
  out = out.substring(0, room);
  var lastSpace = out.lastIndexOf(' ');
  if (lastSpace > room - 200) out = out.substring(0, lastSpace);
  return out + TRUNCATION_MARKER;
}

// ------------------------------------------------------------------- json-ld

/**
 * Pull a schema.org JobPosting out of a page's ld+json blocks.
 *
 * Returns { title, company, location, salary, description } or null. Never
 * throws: a malformed block on one site must not take the run down, and the
 * caller has a working fallback for exactly this case.
 *
 * Three shapes are common and all three appear in the wild — a bare object, an
 * array of objects, and a @graph wrapper — so all three are walked rather than
 * assuming whichever one the first site tested happened to use.
 */
function jsonLdJobPosting_(html) {
  var blocks = String(html || '').match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi);
  if (!blocks) return null;

  for (var i = 0; i < blocks.length; i++) {
    var body = blocks[i].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    var parsed;
    try {
      parsed = JSON.parse(decodeEntities_(body));
    } catch (err) {
      continue;
    }
    var hit = findJobPosting_(parsed, 0);
    if (hit) return normalizeJsonLd_(hit);
  }
  return null;
}

/** Depth-first walk for the first node whose @type includes JobPosting. */
function findJobPosting_(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;

  if (isType_(node['@type'], 'JobPosting')) return node;

  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var value = node[keys[i]];
    if (!value || typeof value !== 'object') continue;
    if (Object.prototype.toString.call(value) === '[object Array]') {
      for (var j = 0; j < value.length; j++) {
        var inArray = findJobPosting_(value[j], depth + 1);
        if (inArray) return inArray;
      }
    } else {
      var nested = findJobPosting_(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** @type is a string on most sites and an array on some. */
function isType_(value, wanted) {
  if (!value) return false;
  if (typeof value === 'string') return value === wanted;
  for (var i = 0; i < value.length; i++) {
    if (value[i] === wanted) return true;
  }
  return false;
}

/**
 * Flatten a JobPosting node into the same fields every adapter returns.
 *
 * description arrives as HTML often enough that it goes through htmlToText_
 * regardless — a JSON-LD block is structured, but the string inside one of its
 * fields need not be.
 */
function normalizeJsonLd_(node) {
  return {
    title: firstString_(node.title, node.name),
    company: firstString_((node.hiringOrganization || {}).name, node.hiringOrganization),
    location: jsonLdLocation_(node),
    salary: jsonLdSalary_(node.baseSalary),
    posted: firstString_(node.datePosted),
    description: htmlToText_(firstString_(node.description))
  };
}

function firstString_() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function jsonLdLocation_(node) {
  // A fully remote posting states it in a dedicated field and often leaves
  // jobLocation as the company's head office, which would file a remote role
  // under a city nobody has to be in.
  var remote = node.jobLocationType;
  var place = node.jobLocation;
  if (Object.prototype.toString.call(place) === '[object Array]') place = place[0];
  var address = (place || {}).address || {};

  var parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .filter(function (part) { return typeof part === 'string' && part.trim(); });

  if (remote === 'TELECOMMUTE') {
    return parts.length ? 'Remote (' + parts.join(', ') + ')' : 'Remote';
  }
  return parts.join(', ');
}

function jsonLdSalary_(salary) {
  if (!salary || typeof salary !== 'object') return '';
  var value = salary.value || {};
  var currency = salary.currency || salary.salaryCurrency || '';
  var unit = value.unitText ? ' per ' + String(value.unitText).toLowerCase() : '';

  if (value.minValue && value.maxValue) {
    return (currency + ' ' + value.minValue + '-' + value.maxValue + unit).trim();
  }
  if (value.value) return (currency + ' ' + value.value + unit).trim();
  return '';
}
