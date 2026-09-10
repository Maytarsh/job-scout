/**
 * Jobs.gs — the pure decisions: what counts as the same job, how old a posting
 * is, what a set of dimension scores adds up to, and which side of a threshold
 * that lands on.
 *
 * Nothing here touches the Sheet, the network or the clock beyond what it is
 * handed, which is why all of it is under test. Every bug this project can
 * ship that a human would actually notice — the same job reported twice, a
 * stale posting presented as fresh, a 74 treated as an 85 — is a bug in this
 * file.
 */

// ---------------------------------------------------------------- dedupe key

/**
 * Strip a company name down to its identity.
 *
 * "Marlow Ridge", "Marlow Ridge, Inc." and "MARLOW RIDGE LLC" are one
 * employer, and a board that renders any two of those spellings would
 * otherwise produce two rows and two scores for the same job.
 */
function normalizeCompany_(name) {
  var text = basicNormalize_(name);
  var parts = text.split(' ');
  // Only trailing suffixes: "Group 1 Automotive" keeps its "group", because
  // there the word is part of the name rather than a legal form after it.
  while (parts.length > 1 &&
         COMPANY_SUFFIXES.indexOf(parts[parts.length - 1]) !== -1) {
    parts.pop();
  }
  return parts.join(' ');
}

/**
 * Strip a job title down to its identity.
 *
 * Requisition numbers and the office name appended to a title are the two
 * things that change between boards for one posting: the same role is
 * "Analyst, Acquisitions (Req 4471)" on the ATS and "Analyst, Acquisitions -
 * Downtown LA" on the careers page.
 */
function normalizeTitle_(title) {
  var text = String(title || '')
    .replace(/\(?\b(req|requisition|job)\s*[#:]?\s*[a-z0-9-]{2,}\)?/gi, ' ')
    .replace(/\b\d{4,}\b/g, ' ');
  return basicNormalize_(text);
}

/**
 * Strip a location down to its identity.
 *
 * Every board writes a location differently — "Remote - US", "Remote, US" and
 * "US Remote" are one place — and the state abbreviation is expanded so
 * "Portland, OR" and "Portland, Oregon" agree.
 */
function normalizeLocation_(location) {
  var text = basicNormalize_(location)
    .replace(/\bunited states of america\b/g, 'us')
    .replace(/\bunited states\b/g, 'us')
    .replace(/\busa\b/g, 'us')
    // Expanded from the shared table rather than from a handful of states
    // written out here: whoever runs this is looking somewhere, and the three
    // states the sample profile happens to name are not necessarily theirs.
    .replace(/\b([a-z]{2})\b/g, function (whole, abbreviation) {
      return US_STATES[abbreviation] || whole;
    });

  if (/\bremote\b/.test(text)) {
    var rest = text.replace(/\b(remote|hybrid|onsite|on site)\b/g, ' ')
                   .replace(/\s+/g, ' ').trim();
    return rest ? 'remote ' + rest : 'remote';
  }
  return text;
}

/** Lower-case, unpunctuate, collapse. The shared first half of all three. */
function basicNormalize_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The stable identity of one job: normalized company, title and location.
 *
 * Stable across days and across sources, which is the property the prototype
 * this replaces did not have. It must not include anything that varies between
 * boards or between runs — no URL, no posting date, no requisition id — or the
 * same job reappears every morning as a new one.
 */
function dedupeKey_(company, title, location) {
  return [normalizeCompany_(company), normalizeTitle_(title),
          normalizeLocation_(location)].join('|');
}

/**
 * The batch request id for a job.
 *
 * The API allows custom_id up to 64 characters and a full SHA-256 hex digest is
 * exactly 64 — no headroom for a prefix, and nothing to do but guess if the
 * limit ever tightens. Half a digest is still 128 bits, which is more than a
 * few hundred jobs a day will ever need.
 */
function jobCustomId_(key) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key);
  var hex = '';
  for (var i = 0; i < bytes.length && hex.length < 32; i++) {
    var byte = (bytes[i] + 256) % 256;
    hex += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return hex.substring(0, 32);
}

// ------------------------------------------------------------------- freshness

/**
 * How many hours ago a posting went up, or null if the source did not say.
 *
 * null means UNKNOWN, and UNKNOWN is reported as UNKNOWN. The prototype this
 * replaces could not verify posting age for a single one of its four matches
 * and presented them anyway as though it had; a guess here is worse than a
 * blank, because a guess is what a human would act on.
 */
function postingAgeHours_(posted, now) {
  if (!posted) return null;
  var when = posted instanceof Date ? posted : new Date(posted);
  var ms = when.getTime();
  if (!ms || isNaN(ms)) return null;

  var hours = Math.round((now.getTime() - ms) / 36e5);
  // A posting dated in the future is a timezone artefact or a bad field, not a
  // job that has not happened yet. Either way the date does not mean what it
  // says, so it is not a date this will report on.
  if (hours < -24) return null;
  return Math.max(0, hours);
}

/**
 * Is this posting fresh enough to bother scoring?
 *
 * An unknown age always passes. Most ATS APIs give no reliable posted date at
 * all, and filtering on a field that is usually missing would throw away most
 * of the real matches to enforce a rule the data cannot support. The report
 * says UNKNOWN and lets the human judge.
 */
function isFreshEnough_(ageHours, maxAgeHours) {
  if (ageHours === null || ageHours === undefined || ageHours === UNKNOWN_AGE) {
    return true;
  }
  return Number(ageHours) <= Number(maxAgeHours);
}

// --------------------------------------------------------------------- scoring

/**
 * The rubric, applied in code.
 *
 * The model returns five independent 0-100 judgements and this multiplies them
 * by the Profile's weights. It is deliberately not the model's arithmetic:
 * a weighted sum is not a thing to ask a language model for when the caller
 * already has the weights, the result has to be comparable across months of
 * rows, and a re-weighting should not mean re-scoring six hundred jobs.
 *
 * Throws on a dimension outside 0-100 rather than clamping. A model returning
 * 150 for industry fit has misunderstood the scale, and every other number it
 * returned in the same response is then suspect too.
 */
function totalScore_(dims, weights) {
  var total = 0;
  for (var i = 0; i < WEIGHTS.length; i++) {
    var dim = WEIGHTS[i].dim;
    var value = dims[dim];
    if (typeof value !== 'number' || isNaN(value) || value < 0 || value > 100) {
      throw new Error('dimension "' + dim + '" was ' + JSON.stringify(value) +
                      ', which is not a score from 0 to 100');
    }
    total += value * Number(weights[WEIGHTS[i].key]) / 100;
  }
  return Math.round(total);
}

/**
 * Which side of the two thresholds a score falls on.
 *
 * Below the report threshold the row is still kept — dedupe depends on it
 * existing — it is simply not shown. Dropping the row instead would rediscover
 * and re-score the same unsuitable job every morning for as long as it stays
 * open.
 */
function routeByThreshold_(total, profile) {
  return {
    inReport: total >= profile.report_threshold,
    shouldApply: total >= profile.apply_threshold
  };
}

/**
 * Does this posting need something a script must not do?
 *
 * A login wall, MFA or a CAPTCHA is not an obstacle to route around — routing
 * around it is the thing this project will not do. Say what it is and hand it
 * to the human. Returns the matched reason, or ''.
 */
function blockedReason_(text) {
  var haystack = String(text || '');
  for (var i = 0; i < BLOCKED_PATTERNS.length; i++) {
    var hit = haystack.match(BLOCKED_PATTERNS[i]);
    if (hit) return hit[0];
  }
  return '';
}
