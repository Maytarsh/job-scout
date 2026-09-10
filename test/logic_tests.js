/**
 * Pure-logic tests. Loaded alongside the .gs sources in a real JS engine, with
 * the Apps Script services stubbed. Covers the parts that decide what lands in
 * the Sheet and what a human is shown - text extraction, dedupe, freshness,
 * scoring, threshold routing, answer resolution and the batch contract.
 */
var results = [];
function t(name, fn) {
  try { fn(); results.push({ name: name, pass: true }); }
  catch (e) { results.push({ name: name, pass: false, err: String(e.message || e) }); }
}
function eq(actual, expected, what) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || '') + ' expected ' + b + ' got ' + a);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function throws(fn, fragment, what) {
  var message = '';
  try { fn(); } catch (e) { message = String(e.message || e); }
  if (!message) throw new Error((what || '') + ' did not throw');
  if (message.indexOf(fragment) === -1) {
    throw new Error((what || '') + ' threw "' + message + '", wanted "' + fragment + '"');
  }
}

// -------------------------------------------------------------- html to text

t('no markup survives any saved page', function () {
  Object.keys(FIXTURES).forEach(function (name) {
    var text = htmlToText_(FIXTURES[name]);
    ok(text.indexOf('<') === -1, name + ' still has "<": ' + text.substring(0, 120));
    ok(text.indexOf('>') === -1, name + ' still has ">"');
    ok(!/&[a-z]+;/i.test(text), name + ' still has a named entity');
    ok(!/&#\d+;/.test(text), name + ' still has a numeric entity');
  });
});

t('script and style contents are removed, not unwrapped', function () {
  Object.keys(FIXTURES).forEach(function (name) {
    var text = htmlToText_(FIXTURES[name]);
    ok(text.indexOf('__analytics') === -1, name + ' leaked script source');
    ok(text.indexOf('function trackApply') === -1, name + ' leaked a function body');
    ok(text.indexOf('font-family') === -1, name + ' leaked a stylesheet');
    ok(text.indexOf('Helvetica') === -1, name + ' leaked a style value');
  });
});

t('navigation, header and footer chrome is dropped', function () {
  var text = htmlToText_(FIXTURES['careers_plain.html']);
  ok(text.indexOf('Investor relations') === -1, 'nav survived');
  ok(text.indexOf('All rights reserved') === -1, 'footer survived');
  ok(text.indexOf('Building places that last') === -1, 'header survived');
});

t('the words of the posting itself survive', function () {
  var text = htmlToText_(FIXTURES['careers_plain.html']);
  ok(text.indexOf('Acquisitions Analyst') !== -1, 'lost the title');
  ok(text.indexOf('cash-flow models') !== -1, 'lost a responsibility');
  ok(text.indexOf('Argus') !== -1, 'lost a requirement');
});

t('a minified page still comes back as lines, not one run-on sentence', function () {
  var text = htmlToText_(FIXTURES['careers_minified.html']);
  ok(text.split('\n').length > 5, 'got ' + text.split('\n').length + ' line(s)');
  ok(text.indexOf('modelsPrepare') === -1, 'two list items ran together');
});

t('entities are decoded after tags are stripped, never before', function () {
  // A posting that mentions a tag in its own text must not become one.
  var html = '<p>Use &lt;script&gt; tags carefully</p><script>secret()</script>';
  var text = htmlToText_(html);
  eq(text, 'Use <script> tags carefully', 'decoded text');
  ok(text.indexOf('secret') === -1, 'the real script survived');
});

t('an unclosed script swallows to the end rather than leaking', function () {
  var text = htmlToText_('<p>Role</p><script>var a = 1; // never closed');
  eq(text, 'Role', 'unclosed script');
});

t('list items and paragraphs become their own lines', function () {
  var text = htmlToText_('<ul><li>One</li><li>Two</li></ul><p>After</p>');
  eq(text, '- One\n- Two\n\nAfter', 'line breaks');
});

t('an unrecognised entity is left alone rather than mangled', function () {
  eq(decodeEntities_('a &zzz; b'), 'a &zzz; b', 'unknown entity');
  eq(decodeEntities_('5 &#8212; 6'), '5 — 6', 'numeric entity');
  eq(decodeEntities_('&#x2014;'), '—', 'hex entity');
});

// ------------------------------------------------------------------- json-ld

t('a JobPosting block yields clean fields with no markup', function () {
  var job = jsonLdJobPosting_(FIXTURES['careers_jsonld.html']);
  ok(job, 'no posting found');
  eq(job.title, 'Acquisitions Analyst', 'title');
  eq(job.company, 'Marlow Ridge Partners', 'company');
  eq(job.location, 'Santa Monica, CA, US', 'location');
  eq(job.salary, 'USD 95000-115000 per year', 'salary');
  eq(job.posted, '2026-09-09T14:05:00+00:00', 'posted');
  ok(job.description.indexOf('<p>') === -1, 'description kept markup');
  ok(job.description.indexOf('memoranda & coordinate') !== -1, 'description lost its entity');
});

t('a @graph wrapper is walked, and a malformed sibling block does not throw', function () {
  var job = jsonLdJobPosting_(FIXTURES['careers_graph.html']);
  ok(job, 'no posting found inside @graph');
  eq(job.title, 'Development Project Manager', 'title');
  eq(job.location, 'Remote (CA, US)', 'a remote role keeps its office as context');
});

t('a page with no JobPosting returns null instead of guessing', function () {
  eq(jsonLdJobPosting_(FIXTURES['careers_plain.html']), null, 'plain page');
  eq(jsonLdJobPosting_('<script type="application/ld+json">{}</script>'), null, 'empty block');
  eq(jsonLdJobPosting_('no scripts here'), null, 'no blocks');
});

// -------------------------------------------------------------------- tokens

t('every fixture fits under the cap once extracted', function () {
  Object.keys(FIXTURES).forEach(function (name) {
    var capped = capTokens_(htmlToText_(FIXTURES[name]), CONFIG.MAX_DESC_TOKENS);
    ok(estimateTokens_(capped) <= CONFIG.MAX_DESC_TOKENS,
       name + ' came to ' + estimateTokens_(capped) + ' tokens');
  });
});

t('extraction is where the saving is, not the cap', function () {
  // If this ratio ever collapses, the pipeline has stopped stripping and the
  // cap is silently doing all the work - which means paying for chrome and
  // losing the end of every description to make room for it.
  var raw = FIXTURES['careers_plain.html'];
  var text = htmlToText_(raw);
  ok(estimateTokens_(text) * 4 < estimateTokens_(raw),
     'stripped ' + estimateTokens_(raw) + ' tokens to ' + estimateTokens_(text));
});

t('a long description is cut on a word boundary and says so', function () {
  var long = new Array(3000).join('responsibility ');
  var capped = capTokens_(long, 10);
  ok(capped.length <= 10 * CONFIG.CHARS_PER_TOKEN + 20, 'length ' + capped.length);
  ok(capped.indexOf('[truncated]') !== -1, 'no truncation marker');
  ok(capped.indexOf('responsibilit\n') === -1, 'cut mid-word');
});

t('a short description is returned untouched', function () {
  eq(capTokens_('Short posting.', 1200), 'Short posting.', 'no marker added');
});

// --------------------------------------------------------------- dedupe key

t('a company keeps its identity and loses its legal form', function () {
  eq(normalizeCompany_('Marlow Ridge Partners, Inc.'), 'marlow ridge', 'inc');
  eq(normalizeCompany_('MARLOW RIDGE LLC'), 'marlow ridge', 'llc');
  eq(normalizeCompany_('Marlow  Ridge'), 'marlow ridge', 'double space');
  eq(normalizeCompany_('Marlow & Ridge'), 'marlow and ridge', 'ampersand');
});

t('a suffix inside a name is not a suffix', function () {
  eq(normalizeCompany_('Group 1 Automotive'), 'group 1 automotive', 'leading group');
});

t('a title loses its requisition number and keeps its role', function () {
  eq(normalizeTitle_('Analyst, Acquisitions (Req 4471)'), 'analyst acquisitions', 'req');
  eq(normalizeTitle_('Analyst, Acquisitions - 88213'), 'analyst acquisitions', 'bare number');
  eq(normalizeTitle_('Senior Analyst II'), 'senior analyst ii', 'roman numeral kept');
});

t('the same place written four ways is one place', function () {
  var wanted = normalizeLocation_('Remote - US');
  eq(normalizeLocation_('Remote, US'), wanted, 'comma');
  eq(normalizeLocation_('US Remote'), wanted, 'reversed');
  eq(normalizeLocation_('Remote (United States)'), wanted, 'spelled out');
  eq(normalizeLocation_('Los Angeles, CA'), normalizeLocation_('Los Angeles, California'),
     'state abbreviation');
});

t('the same job from two sources collapses to one key', function () {
  var fromAts = dedupeKey_('Marlow Ridge Partners, Inc.',
                           'Analyst, Acquisitions (Req 4471)', 'Los Angeles, CA');
  var fromPage = dedupeKey_('MARLOW RIDGE PARTNERS LLC',
                            'Analyst, Acquisitions', 'Los Angeles, California');
  eq(fromAts, fromPage, 'two spellings of one job');
});

t('two different jobs at one company do not collapse', function () {
  var a = dedupeKey_('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX');
  var b = dedupeKey_('Marlow Ridge', 'Development Manager', 'Austin, TX');
  ok(a !== b, 'distinct roles collided');
  var c = dedupeKey_('Marlow Ridge', 'Acquisitions Analyst', 'New York, NY');
  ok(a !== c, 'distinct locations collided');
});

t('a custom_id is 32 characters and stable for a key', function () {
  var key = dedupeKey_('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX');
  var id = jobCustomId_(key);
  eq(id.length, 32, 'length');
  ok(/^[a-f0-9]+$/.test(id), 'not hex: ' + id);
  eq(jobCustomId_(key), id, 'not stable across calls');
  ok(jobCustomId_(key + 'x') !== id, 'two keys produced one id');
});

// ------------------------------------------------------------------ freshness

t('an age is hours behind now, never negative', function () {
  var now = new Date('2026-09-10T12:00:00Z');
  eq(postingAgeHours_('2026-09-09T12:00:00Z', now), 24, 'a day old');
  eq(postingAgeHours_(new Date('2026-09-10T12:00:00Z'), now), 0, 'this instant');
  eq(postingAgeHours_('2026-09-10T18:00:00Z', now), 0, 'a few hours ahead is a timezone');
});

t('an age that cannot be established is UNKNOWN, never a guess', function () {
  var now = new Date('2026-09-10T12:00:00Z');
  eq(postingAgeHours_('', now), null, 'empty');
  eq(postingAgeHours_(null, now), null, 'null');
  eq(postingAgeHours_('sometime last week', now), null, 'unparseable');
  eq(postingAgeHours_('2027-09-10T12:00:00Z', now), null, 'a year in the future');
});

t('an unknown age is never filtered out by the freshness rule', function () {
  ok(isFreshEnough_(null, 72), 'null age was filtered');
  ok(isFreshEnough_(UNKNOWN_AGE, 72), 'UNKNOWN age was filtered');
  ok(isFreshEnough_(24, 72), '24h inside 72h');
  ok(isFreshEnough_(72, 72), 'the boundary is inclusive');
  ok(!isFreshEnough_(73, 72), '73h passed a 72h limit');
});

// -------------------------------------------------------------------- scoring

var WEIGHTS_100 = {
  weight_industry_fit: 30, weight_experience: 25, weight_compensation: 15,
  weight_location: 10, weight_interview_odds: 20
};

t('the rubric is a weighted sum of the five dimensions', function () {
  var dims = { industry_fit: 100, experience: 100, compensation: 100,
               location: 100, interview_odds: 100 };
  eq(totalScore_(dims, WEIGHTS_100), 100, 'a perfect job');

  var zero = { industry_fit: 0, experience: 0, compensation: 0,
               location: 0, interview_odds: 0 };
  eq(totalScore_(zero, WEIGHTS_100), 0, 'a hopeless job');

  var mixed = { industry_fit: 88, experience: 72, compensation: 60,
                location: 95, interview_odds: 55 };
  // 26.4 + 18 + 9 + 9.5 + 11 = 73.9
  eq(totalScore_(mixed, WEIGHTS_100), 74, 'a rounded middling job');
});

t('re-weighting changes the total without re-scoring anything', function () {
  var dims = { industry_fit: 100, experience: 0, compensation: 0,
               location: 0, interview_odds: 0 };
  eq(totalScore_(dims, WEIGHTS_100), 30, 'industry weighted 30');
  var shifted = { weight_industry_fit: 60, weight_experience: 10,
                  weight_compensation: 10, weight_location: 10,
                  weight_interview_odds: 10 };
  eq(totalScore_(dims, shifted), 60, 'industry weighted 60');
});

t('a dimension off the scale fails loudly instead of being clamped', function () {
  var dims = { industry_fit: 150, experience: 50, compensation: 50,
               location: 50, interview_odds: 50 };
  throws(function () { totalScore_(dims, WEIGHTS_100); },
         'industry_fit', 'out of range');

  var missing = { industry_fit: 50, experience: 50, compensation: 50, location: 50 };
  throws(function () { totalScore_(missing, WEIGHTS_100); },
         'interview_odds', 'missing dimension');

  var stringy = { industry_fit: '90', experience: 50, compensation: 50,
                  location: 50, interview_odds: 50 };
  throws(function () { totalScore_(stringy, WEIGHTS_100); },
         'industry_fit', 'a string that looks like a number');
});

// ----------------------------------------------------------- threshold routing

var THRESHOLDS = { report_threshold: 75, apply_threshold: 85 };

t('a job below the report threshold is kept but not shown', function () {
  var route = routeByThreshold_(74, THRESHOLDS);
  eq(route, { inReport: false, shouldApply: false }, '74');
});

t('a job between the thresholds is reported and not applied to', function () {
  eq(routeByThreshold_(75, THRESHOLDS), { inReport: true, shouldApply: false }, '75');
  eq(routeByThreshold_(84, THRESHOLDS), { inReport: true, shouldApply: false }, '84');
});

t('a job at or above the apply threshold is flagged for drafting', function () {
  eq(routeByThreshold_(85, THRESHOLDS), { inReport: true, shouldApply: true }, '85');
  eq(routeByThreshold_(100, THRESHOLDS), { inReport: true, shouldApply: true }, '100');
});

t('equal thresholds mean everything reported is also drafted', function () {
  var equal = { report_threshold: 80, apply_threshold: 80 };
  eq(routeByThreshold_(80, equal), { inReport: true, shouldApply: true }, '80');
  eq(routeByThreshold_(79, equal), { inReport: false, shouldApply: false }, '79');
});

// -------------------------------------------------------------------- blocked

t('a login or captcha wall is named, not routed around', function () {
  ok(blockedReason_('Please solve the CAPTCHA to continue'), 'captcha');
  ok(blockedReason_('Sign in to apply for this role'), 'login wall');
  ok(blockedReason_('You will need multi-factor authentication'), 'mfa');
  eq(blockedReason_('Apply below with your resume'), '', 'an ordinary posting');
});
