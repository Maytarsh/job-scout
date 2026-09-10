/**
 * Config.gs — every knob lives here. Nothing below this file needs editing
 * for normal tuning.
 *
 * Nothing person-specific belongs in this file, or in any other .gs file. This
 * repository is public; the resume, the locations, the target roles and the
 * thresholds all live in the deployer's own Sheet. The sample values that get
 * written into that Sheet on first run are in Setup.gs, marked as samples, and
 * they are examples of the shape — not defaults the code falls back to.
 */

var CONFIG = {
  // Bulk scoring is mechanical and high-volume: Haiku, no thinking, structured
  // outputs, and the Batch API at half price. Drafting happens a handful of
  // times a month on jobs that already cleared the apply threshold, so it gets
  // the capable model. Both are swappable — add a PRICE_PER_MTOK entry first.
  SCORE_MODEL: 'claude-haiku-4-5',
  DRAFT_MODEL: 'claude-opus-5',
  // The resume is parsed once, ever, and every score for months afterwards is
  // built on those facts. Cheapness is worth nothing here.
  PARSE_MODEL: 'claude-opus-5',

  // Jobs submitted for scoring in one batch. Most ATS boards give no reliable
  // posted date, and an unknown date is never filtered (see Jobs.gs), so the
  // first run of a freshly configured Sheet sees every open role at every
  // company on the Sources tab — several hundred, not a morning's worth. The
  // leftovers stay unscored and the next poll picks them up.
  MAX_NEW_JOBS_PER_RUN: 50,

  // Hard cap on one job description before it is sent. The whole cost model
  // rests on this number.
  MAX_DESC_TOKENS: 1200,
  // Tokens are estimated, not counted: Apps Script cannot run a tokenizer and
  // an extra round-trip to count_tokens would cost more than the slack. Four
  // characters per token is the usual English approximation; it errs low on
  // punctuation-heavy postings, which is why the cap has room under the budget.
  CHARS_PER_TOKEN: 4,

  // Apps Script kills an execution at 6 minutes and everything buffered in
  // memory dies with it. Stop early and flush instead.
  RUN_BUDGET_SECONDS: 240,

  // A batch the API has not finished is left for the next poll. A batch still
  // unfinished after this long is abandoned: the API's own ceiling is 24 hours,
  // so past that it is never going to arrive, and holding the slot would stop
  // every future run from submitting anything at all.
  BATCH_MAX_AGE_HOURS: 26,

  API_URL: 'https://api.anthropic.com/v1/messages',
  BATCH_URL: 'https://api.anthropic.com/v1/messages/batches',
  API_VERSION: '2023-06-01',
  API_MAX_ATTEMPTS: 4,

  // Hard ceiling on API spend per calendar day (UTC). Every response is priced
  // from its own usage and added to a running total in Script Properties; once
  // the day is over budget callAnthropic_ refuses to send anything at all until
  // midnight. Not a warning, not a per-run cap that a loop can spend repeatedly
  // — the one number that bounds a runaway.
  //
  // Reset it early by deleting SPEND_USD in Project Settings -> Script Properties.
  DAILY_BUDGET_USD: 2.00,

  // $ per million tokens, from the published rates. Cache reads bill less than
  // fresh input; counting them at full price makes the ceiling err high, which
  // is the safe direction for a guard.
  // A model missing from this table is priced at zero and escapes the ceiling
  // entirely, so add an entry before ever changing SCORE_MODEL, DRAFT_MODEL or
  // PARSE_MODEL. There is a test that fails if any of the three is unpriced.
  PRICE_PER_MTOK: {
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-opus-5': { input: 5, output: 25 }
  },
  // The Batch API bills half of everything. Applied when pricing batch results,
  // never to a live call.
  BATCH_DISCOUNT: 0.5
};

var TABS = {
  PROFILE: 'Profile',
  SOURCES: 'Sources',
  ANSWERS: 'Answers',
  JOBS: 'Jobs',
  REPORT: 'Report',
  FACTS: '_Facts',
  RUNS: '_Runs',
  ERRORS: '_Errors'
};

var PROFILE_HEADERS = ['Key', 'Value', 'What it does'];
var SOURCES_HEADERS = ['Type', 'Slug or URL', 'Label', 'Enabled'];
var ANSWERS_HEADERS = ['Question key', 'Question', 'Your answer', 'Updated'];
var FACTS_HEADERS = ['Fact', 'Value'];

var JOBS_HEADERS = [
  'Job key', 'Company', 'Position', 'Location', 'Status', 'Score',
  'Industry fit', 'Experience', 'Compensation', 'Location fit', 'Interview odds',
  'Why', 'Salary', 'Source', 'Posted', 'Age hours', 'Link',
  'First seen', 'Scored at', 'Needs', 'Draft', 'Notes'
];

var REPORT_HEADERS = [
  'Score', 'Company', 'Position', 'Location', 'Salary', 'Source',
  'Posting age', 'Why', 'Link', 'Status'
];

var RUNS_HEADERS = [
  'When', 'Step', 'Sources OK', 'Sources failed', 'Jobs seen', 'New',
  'Submitted', 'Scored', 'Batch id', 'Est. input tokens',
  'Input tokens', 'Output tokens', 'Cost USD', 'Note'
];

var ERRORS_HEADERS = ['When', 'Where', 'What happened', 'What to do'];

// Jobs column indices (0-based, must match JOBS_HEADERS).
var J_KEY = 0, J_COMPANY = 1, J_POSITION = 2, J_LOCATION = 3, J_STATUS = 4,
    J_SCORE = 5, J_INDUSTRY = 6, J_EXPERIENCE = 7, J_COMPENSATION = 8,
    J_LOCATION_FIT = 9, J_INTERVIEW = 10, J_WHY = 11, J_SALARY = 12,
    J_SOURCE = 13, J_POSTED = 14, J_AGE = 15, J_LINK = 16, J_FIRST_SEEN = 17,
    J_SCORED_AT = 18, J_NEEDS = 19, J_DRAFT = 20, J_NOTES = 21;

// Answers column indices (0-based, must match ANSWERS_HEADERS).
var Q_KEY = 0, Q_QUESTION = 1, Q_ANSWER = 2, Q_UPDATED = 3;

// Sources column indices (0-based, must match SOURCES_HEADERS).
var S_TYPE = 0, S_REF = 1, S_LABEL = 2, S_ENABLED = 3;

/**
 * The four statuses, with the spec's failsafe semantics intact.
 *
 * APPLIED is set by a human and only by a human. Nothing in this codebase
 * writes it — see Apply.gs.
 */
var STATUSES = ['FOUND', 'APPLIED', 'NEEDS INPUT', 'BLOCKED'];

// Written into Posted/Age hours when a source does not state a posting date.
// The Codex prototype could not verify posting age either, and reported as
// though it could; this is the honest version of that answer.
var UNKNOWN_AGE = 'UNKNOWN';

// The value resolveAnswer_ returns for a question nothing truthfully answers.
var UNESTABLISHED = 'UNESTABLISHED';

/**
 * Every Profile row the Sheet must carry, and what validation demands of it.
 *
 * type: 'text' | 'number' | 'list' | 'bool'. required: the run fails without it.
 * The two resume rows are required as a pair-of-one — exactly one must be set —
 * which validateProfile_ handles separately.
 */
var PROFILE_KEYS = [
  { key: 'resume_text', type: 'text', required: false },
  { key: 'resume_file_id', type: 'text', required: false },
  { key: 'locations', type: 'list', required: true },
  { key: 'target_roles', type: 'list', required: true },
  { key: 'weight_industry_fit', type: 'number', required: true },
  { key: 'weight_experience', type: 'number', required: true },
  { key: 'weight_compensation', type: 'number', required: true },
  { key: 'weight_location', type: 'number', required: true },
  { key: 'weight_interview_odds', type: 'number', required: true },
  { key: 'report_threshold', type: 'number', required: true },
  { key: 'apply_threshold', type: 'number', required: true },
  { key: 'max_posting_age_hours', type: 'number', required: true },
  { key: 'email_report', type: 'bool', required: false },
  { key: 'notes', type: 'text', required: false }
];

// The five weight rows, in the order the rubric states them, paired with the
// scoring dimension each one weights. Nothing else may weight a score.
var WEIGHTS = [
  { key: 'weight_industry_fit', dim: 'industry_fit' },
  { key: 'weight_experience', dim: 'experience' },
  { key: 'weight_compensation', dim: 'compensation' },
  { key: 'weight_location', dim: 'location' },
  { key: 'weight_interview_odds', dim: 'interview_odds' }
];

/**
 * The recurring application questions, and which of them a human alone may answer.
 *
 * humanOnly is the whole failsafe in one flag. A resume establishes what someone
 * has done; it does not establish what they want, what they will accept, or what
 * an immigration lawyer would say about them. "Holds an H-1B, eligible from
 * some date" sits in the resume facts and looks like it answers "do you require
 * sponsorship" — it does not, and an agent that treats it as an answer has just
 * put a wrong one on a real job application under someone's name. Every key here
 * marked humanOnly can be filled from the Answers tab and from nowhere else,
 * including the parsed resume, including the model. Blank means UNESTABLISHED,
 * which means the row stops and asks.
 *
 * factKey names a _Facts row that may truthfully answer a non-humanOnly question.
 */
var ANSWER_KEYS = [
  { key: 'salary_expectation', humanOnly: true,
    question: 'What salary are you asking for?' },
  { key: 'work_authorized', humanOnly: true,
    question: 'Are you authorized to work in the country of this job?' },
  { key: 'needs_sponsorship', humanOnly: true,
    question: 'Do you now or in the future require visa sponsorship?' },
  { key: 'willing_to_relocate', humanOnly: true,
    question: 'Are you willing to relocate for this role?' },
  { key: 'earliest_start_date', humanOnly: true,
    question: 'What is the earliest date you can start?' },
  { key: 'licenses', humanOnly: true,
    question: 'Do you hold any professional licenses or certifications?' },
  { key: 'security_clearance', humanOnly: true,
    question: 'Do you hold an active security clearance?' },
  { key: 'background_disclosure', humanOnly: true,
    question: 'Anything to disclose on a criminal or background check?' },
  { key: 'years_experience', humanOnly: true,
    question: 'How many years of experience do you have in this specific field?' },
  { key: 'reference_contacts', humanOnly: true,
    question: 'Who may we contact as references?' },

  { key: 'full_name', humanOnly: false, factKey: 'name',
    question: 'Your full name.' },
  { key: 'education', humanOnly: false, factKey: 'education',
    question: 'Your highest degree and institution.' },
  { key: 'current_title', humanOnly: false, factKey: 'current_title',
    question: 'Your current or most recent job title.' }
];

/**
 * Source types the dispatcher knows. Adding one means adding an adapter in
 * Sources.gs and a line here — never a change to the pipeline that consumes them.
 */
var SOURCE_TYPES = [
  'ats_greenhouse', 'ats_lever', 'ats_ashby', 'aggregator', 'careers_url'
];

/**
 * State abbreviation to state name. Person-agnostic reference data, not
 * configuration — it is here so that "Austin, TX" and "Austin, Texas" produce
 * one dedupe key rather than two rows for one job, whoever is running this and
 * wherever they are looking.
 *
 * The tooling that keeps person-specific values out of src/ knows this block by
 * name; see .claude/hooks/check-no-personal-data.sh.
 */
var US_STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida',
  ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine',
  md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska',
  nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
  ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island',
  sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas',
  ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'washington dc'
};

// Company-name suffixes that carry no identity, stripped when building the
// dedupe key. "Marlow Ridge" and "Marlow Ridge, Inc." are one employer.
var COMPANY_SUFFIXES = [
  'inc', 'incorporated', 'llc', 'l l c', 'llp', 'ltd', 'limited', 'corp',
  'corporation', 'co', 'company', 'plc', 'gmbh', 'holdings', 'group',
  'partners', 'lp'
];

// Blocks whose contents are never part of a job description. Removed with their
// contents, not merely unwrapped — see Extract.gs.
var STRIP_ELEMENTS = [
  'script', 'style', 'nav', 'header', 'footer', 'svg', 'noscript', 'iframe',
  'form', 'aside', 'template'
];

// Signs in a posting or an apply URL that a human cannot get past this without
// doing something a script must not: logging in, solving a CAPTCHA, or being
// somewhere the site says not to be. These become BLOCKED, by design.
var BLOCKED_PATTERNS = [
  /\bcaptcha\b/i,
  /\brecaptcha\b/i,
  /sign in to (apply|continue)/i,
  /log ?in to (apply|continue)/i,
  /create an account to apply/i,
  /\bmulti-?factor\b/i,
  /\bverify you are human\b/i
];
