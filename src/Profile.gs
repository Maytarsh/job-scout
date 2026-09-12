/**
 * Profile.gs — everything that makes this someone's job search rather than a
 * job search.
 *
 * The Profile tab is the whole of the person-specific configuration, and it is
 * read and validated on every run. Nothing here falls back to a default when a
 * row is wrong: a weight typed as 35 where 30 was meant is a silent, permanent
 * change to every score the system will ever produce, and the deployer would
 * have no way to notice. A run that cannot trust its configuration stops and
 * says which row is wrong.
 *
 * The resume is parsed once and cached in _Facts. Re-reading a PDF every
 * morning would cost more than the entire scoring pass and would produce a
 * slightly different set of facts each time, so scores from two mornings would
 * not be comparable.
 */

/**
 * Read and validate the Profile tab. Throws with a specific message on the
 * first thing that is wrong.
 */
function readProfile_() {
  var raw = readKeyValues_(TABS.PROFILE, 1);
  return validateProfile_(raw);
}

/**
 * The validation rules, separated from the Sheet so they can be tested.
 *
 * Takes the raw key/value object, returns a typed profile, throws on anything
 * that would make the run's output wrong rather than absent.
 */
function validateProfile_(raw) {
  var profile = {};
  var missing = [];

  for (var i = 0; i < PROFILE_KEYS.length; i++) {
    var spec = PROFILE_KEYS[i];
    var value = raw[spec.key];
    var empty = (value === undefined || value === null ||
                 String(value).trim() === '');

    if (empty) {
      if (spec.required) missing.push(spec.key);
      profile[spec.key] = spec.type === 'list' ? [] : '';
      continue;
    }
    profile[spec.key] = coerceProfileValue_(spec, value);
  }

  if (missing.length) {
    throw new Error(
      'The Profile tab is missing ' + missing.join(', ') + '. Fill in ' +
      (missing.length === 1 ? 'that row' : 'those rows') +
      ' and run again — nothing is scored until the profile is complete.');
  }

  // The resume, as exactly one of two paths. Both set is ambiguous rather than
  // generous: the facts cached from whichever one won would silently outlive
  // the other, and no one would know which resume the scores were built on.
  var hasText = !!profile.resume_text;
  var hasFile = !!profile.resume_file_id;
  if (hasText && hasFile) {
    throw new Error(
      'The Profile tab has both resume_text and resume_file_id. Clear one of ' +
      'them — otherwise there is no telling which resume the scores were ' +
      'built on.');
  }
  if (!hasText && !hasFile) {
    throw new Error(
      'The Profile tab has no resume. Paste the resume text into resume_text, ' +
      'or put the Drive file id of a PDF into resume_file_id (that path also ' +
      'needs the Drive scope — see the README).');
  }

  var weightTotal = 0;
  for (var w = 0; w < WEIGHTS.length; w++) {
    weightTotal += profile[WEIGHTS[w].key];
  }
  if (weightTotal !== 100) {
    throw new Error(
      'The five weight rows in the Profile tab add up to ' + weightTotal +
      ', not 100. A score is a percentage of a possible 100 points, so ' +
      'anything else makes every score mean something different. Fix the ' +
      'weights and run again.');
  }

  if (profile.report_threshold > profile.apply_threshold) {
    throw new Error(
      'report_threshold (' + profile.report_threshold + ') is higher than ' +
      'apply_threshold (' + profile.apply_threshold + '), which would mean ' +
      'drafting applications for jobs too low-scoring to appear in the ' +
      'report. Set report_threshold at or below apply_threshold.');
  }

  // Optional, because a Sheet using only ats_ rows never needs one. Wrong is
  // a different thing from absent: a typo here would otherwise surface as
  // every aggregator row failing with an unrecognised-region message.
  if (profile.region) {
    profile.region = String(profile.region).trim().toUpperCase();
    if (!REGIONS[profile.region]) {
      throw new Error(
        'The Profile row "region" is "' + profile.region + '", which is not a ' +
        'region this knows. Use one of: ' + Object.keys(REGIONS).join(', ') +
        '. Leave it blank if you are not using an aggregator source.');
    }
  }

  if (profile.max_posting_age_hours <= 0) {
    throw new Error('max_posting_age_hours must be a positive number of hours.');
  }

  // Unset means on. A heartbeat that has to be switched on is a heartbeat
  // most people will not have.
  profile.email_report = (raw.email_report === undefined ||
                          String(raw.email_report).trim() === '')
    ? true : profile.email_report;

  // Unset means on, for the same reason: the default should be the one that
  // does not quietly spend money on jobs nobody can take.
  profile.only_my_locations = (raw.only_my_locations === undefined ||
                               String(raw.only_my_locations).trim() === '')
    ? true : profile.only_my_locations;

  return profile;
}

function coerceProfileValue_(spec, value) {
  if (spec.type === 'number') {
    // Number('') is 0, not NaN, so stripping the non-digits out of "eighty
    // five" and trusting the result silently produced a threshold of zero -
    // which is a working configuration that reports every job ever found.
    var text = String(value).trim();
    var number = Number(text.replace(/[^0-9.-]/g, ''));
    if (!/[0-9]/.test(text) || isNaN(number)) {
      throw new Error('The Profile row "' + spec.key + '" is "' + value +
                      '", which is not a number.');
    }
    return number;
  }
  if (spec.type === 'list') {
    return String(value).split(/[\n,;]+/)
      .map(function (part) { return part.trim(); })
      .filter(function (part) { return part.length > 0; });
  }
  if (spec.type === 'bool') return truthy_(value);
  return String(value).trim();
}

// -------------------------------------------------------------- resume facts

/**
 * The cached resume facts, parsing the resume first if there are none.
 *
 * Returns the facts object. The parse happens exactly once per resume; the
 * "Re-read the resume" menu item is how a changed resume gets picked up, and it
 * is deliberately manual — an automatic re-parse would change the basis of
 * every future score without anyone deciding to.
 */
function resumeFacts_(profile) {
  var cached = readKeyValues_(TABS.FACTS, 1);
  if (Object.keys(cached).length) return cached;

  var facts = parseResume_(profile);
  writeFacts_(facts);
  return facts;
}

/**
 * Read the resume once and turn it into structured facts.
 *
 * Two paths, because asking a non-technical person to grant read access to
 * their entire Drive so that one PDF can be opened is a bad trade for a tool
 * they are installing from a public repository. Pasting the text into the
 * Profile tab needs no Drive permission at all, and is the documented default.
 */
function parseResume_(profile) {
  var content = [];

  if (profile.resume_file_id) {
    var blob = DriveApp.getFileById(profile.resume_file_id).getBlob();
    var type = blob.getContentType();
    if (type !== 'application/pdf') {
      throw new Error('resume_file_id points at a ' + type + '. Either export ' +
                      'the resume as a PDF, or paste its text into ' +
                      'resume_text instead.');
    }
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Utilities.base64Encode(blob.getBytes())
      }
    });
  } else {
    content.push({
      type: 'text',
      text: '<resume>\n' + profile.resume_text + '\n</resume>'
    });
  }

  content.push({ type: 'text', text: RESUME_PROMPT });

  var res = callAnthropic_({
    model: CONFIG.PARSE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: content }],
    output_config: { format: { type: 'json_schema', schema: factsSchema_() } }
  });

  var facts = parsedJsonBlock_(res, 'resume parsing');
  Logger.log('parsed the resume: ' + (res.usage || {}).input_tokens + ' in / ' +
             (res.usage || {}).output_tokens + ' out, $' +
             spendToday_().toFixed(2) + ' today');
  return facts;
}

var RESUME_PROMPT =
  'Extract the facts this resume establishes, and only those.\n\n' +
  'Every field must be something the resume says. Where it says nothing, use ' +
  '"" — an empty field is a correct answer and a plausible-sounding guess is ' +
  'not. These facts become the basis of every job score and every cover letter ' +
  'this system produces for months, so one invented year of experience or one ' +
  'assumed credential is repeated everywhere and corrected nowhere.\n\n' +
  'years_total is the span the resume actually documents, as a number of years. ' +
  'If the dates do not support a single figure, say what they do support in ' +
  'words rather than picking one.\n\n' +
  'Do not record anything about work authorisation, visa status, salary ' +
  'expectations or willingness to relocate, even if the resume mentions them. ' +
  'Those are answered by the person, in the Answers tab, and nowhere else.';

function writeFacts_(facts) {
  var rows = [];
  Object.keys(facts).forEach(function (key) {
    rows.push([key, safeCell_(facts[key], 2000)]);
  });
  var sheet = getSheet_(TABS.FACTS);
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, FACTS_HEADERS.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, FACTS_HEADERS.length).setValues(rows);
}

// ------------------------------------------------------------------- answers

/** The Answers tab as { key: answer }, blank answers included as ''. */
function readAnswers_() {
  var sheet = getSheet_(TABS.ANSWERS);
  var last = sheet.getLastRow();
  if (last < 2) return {};

  var rows = sheet.getRange(2, 1, last - 1, ANSWERS_HEADERS.length).getValues();
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][Q_KEY] || '').trim();
    if (key) out[key] = String(rows[i][Q_ANSWER] || '').trim();
  }
  return out;
}

/**
 * Answer one application question, or refuse to.
 *
 * The order is fixed and the first rule is the important one. A question marked
 * humanOnly is answered from the Answers tab or not at all — never from the
 * resume, never by the model, never by inference. The resume can say someone
 * holds an H-1B and is eligible from some date, and that still does not answer
 * "do you require sponsorship"; the two questions are related and the answers are not the same,
 * and the cost of getting it wrong is a false statement on a real application
 * submitted under someone's name.
 *
 * Everything else may come from a resume fact, because the questions that are
 * not humanOnly are the ones a resume genuinely does establish — a name, a
 * degree, a job title.
 *
 * Returns { key, question, answer, source } where source is 'answers',
 * 'resume' or UNESTABLISHED.
 */
function resolveAnswer_(spec, facts, answers) {
  var fromAnswers = String((answers || {})[spec.key] || '').trim();
  if (fromAnswers) {
    return { key: spec.key, question: spec.question, answer: fromAnswers,
             source: 'answers' };
  }

  if (!spec.humanOnly && spec.factKey) {
    var fromResume = String((facts || {})[spec.factKey] || '').trim();
    if (fromResume) {
      return { key: spec.key, question: spec.question, answer: fromResume,
               source: 'resume' };
    }
  }

  return { key: spec.key, question: spec.question, answer: UNESTABLISHED,
           source: UNESTABLISHED };
}

/**
 * Resolve the standard question set plus whatever this posting adds.
 *
 * A posting-specific question is treated as humanOnly without exception. It
 * arrived as free text from an employer, nothing maps it to a resume field, and
 * the only honest thing to do with a question nobody has answered is to ask.
 */
function resolveAnswers_(extraQuestions, facts, answers) {
  var out = [];
  for (var i = 0; i < ANSWER_KEYS.length; i++) {
    out.push(resolveAnswer_(ANSWER_KEYS[i], facts, answers));
  }

  var seen = {};
  for (var k = 0; k < out.length; k++) seen[out[k].key] = true;

  var extras = extraQuestions || [];
  for (var j = 0; j < extras.length; j++) {
    var key = String(extras[j].key || '').trim();
    if (!key || seen[key]) continue;
    seen[key] = true;
    out.push(resolveAnswer_(
      { key: key, question: String(extras[j].question || ''), humanOnly: true },
      facts, answers));
  }
  return out;
}

/** The questions that stopped this application, by key. */
function unestablished_(resolved) {
  var out = [];
  for (var i = 0; i < resolved.length; i++) {
    if (resolved[i].source === UNESTABLISHED) out.push(resolved[i].key);
  }
  return out;
}

/**
 * Add any question this run had to ask to the Answers tab, blank.
 *
 * So the human answers it once, in the place the next job will look, rather
 * than being asked the same thing again next Tuesday by a different posting.
 * Existing rows are never touched — an answer already given is the one thing
 * in this system that must not be regenerated.
 */
function ensureAnswerRows_(resolved) {
  var existing = readAnswers_();
  var additions = [];

  for (var i = 0; i < resolved.length; i++) {
    var item = resolved[i];
    if (existing[item.key] !== undefined) continue;
    existing[item.key] = '';
    additions.push([item.key, safeCell_(item.question, 300), '', '']);
  }

  appendRows_(TABS.ANSWERS, additions);
  return additions.length;
}
