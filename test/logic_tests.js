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

t('state abbreviations expand for every state, not a chosen few', function () {
  // The first version of this expanded CA, NY and TX - which were the three
  // states in the sample profile. Anyone running this from anywhere else got
  // two rows for one job and no indication why.
  eq(normalizeLocation_('Miami, FL'), normalizeLocation_('Miami, Florida'), 'FL');
  eq(normalizeLocation_('Chicago, IL'), normalizeLocation_('Chicago, Illinois'), 'IL');
  eq(normalizeLocation_('Seattle, WA'), normalizeLocation_('Seattle, Washington'), 'WA');
  // Not every two-letter word is a state: "Washington DC" must not become
  // something else on its way through.
  ok(normalizeLocation_('Boston, MA').indexOf('massachusetts') !== -1, 'MA');
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

// ------------------------------------------------------- regions and places

t('an Israeli city collapses however a board spells it', function () {
  var want = normalizeLocation_('Tel Aviv');
  eq(normalizeLocation_('Tel Aviv-Yafo'), want, 'Yafo');
  eq(normalizeLocation_('Tel Aviv, Israel'), want, 'with the country');
  eq(normalizeLocation_('TLV'), want, 'airport code');
  eq(normalizeLocation_('Tel Aviv District'), want, 'district');
  eq(normalizeLocation_('Herzliya Pituach'), normalizeLocation_('Herzlia'), 'Herzliya');
  eq(normalizeLocation_('Petach Tikva'), normalizeLocation_('Petah Tikva'), 'Petah Tikva');
});

t('"IL" is Israel next to an Israeli city and Illinois next to an American one', function () {
  // The two-letter table would otherwise file every Tel Aviv job in Illinois,
  // silently, and the report would read as though the search had gone abroad.
  eq(normalizeLocation_('Tel Aviv, IL'), normalizeLocation_('Tel Aviv'), 'Israel');
  eq(normalizeLocation_('Chicago, IL'), normalizeLocation_('Chicago, Illinois'),
     'Illinois');
  ok(normalizeLocation_('Chicago, IL').indexOf('illinois') !== -1,
     'Chicago stopped being in Illinois');
});

t('the country is dropped so one job is one job', function () {
  eq(normalizeLocation_('New York, NY, US'), normalizeLocation_('New York, New York'),
     'US suffix');
  eq(normalizeLocation_('Haifa, Israel'), normalizeLocation_('Haifa'), 'Israel suffix');
});

t('a region must be one this knows, and may be left out', function () {
  var raw = validProfileRaw();
  eq(validateProfile_(raw).region, '', 'absent is allowed');

  raw.region = 'il';
  eq(validateProfile_(raw).region, 'IL', 'case is normalised');

  raw.region = 'Atlantis';
  throws(function () { validateProfile_(raw); }, 'not a region', 'unknown region');
});

t('an aggregator row reads its terms, location and region', function () {
  var profile = { region: 'IL' };
  var q = aggregatorQuery_('python infrastructure@Tel Aviv', profile);
  eq(q.what, 'python infrastructure', 'terms');
  eq(q.where, 'Tel Aviv', 'location');
  eq(q.region.careerjet_locale, 'en_IL', 'locale from the profile');

  // The third segment is how one Sheet searches two countries at once.
  var override = aggregatorQuery_('analyst@Austin@US', profile);
  eq(override.region.careerjet_locale, 'en_US', 'row overrides the profile');

  eq(aggregatorQuery_('python', profile).where, '', 'location is optional');
});

t('an aggregator row without a region says so instead of guessing one', function () {
  throws(function () { aggregatorQuery_('python@Tel Aviv', {}); },
         'needs a region', 'no region anywhere');
  throws(function () { aggregatorQuery_('@Tel Aviv', { region: 'IL' }); },
         'needs search terms', 'no terms');
  throws(function () { aggregatorQuery_('python@x@Atlantis', {}); },
         'unknown region', 'bad override');
});

t('an unresolved aggregator location is an error, not an empty morning', function () {
  // Careerjet answers a location it cannot place with type LOCATIONS and no
  // jobs. Read as a normal response that is a row which has never worked and
  // never will, reporting zero matches every day, indistinguishable from a
  // quiet market.
  var responses = [
    { type: 'LOCATIONS', locations: [], message: 'no matching location found' },
    { type: 'LOCATIONS', locations: ['Tel Aviv', 'Tel Aviv District'],
      message: 'multiple locations found' }
  ];
  responses.forEach(function (body) {
    var threw = '';
    withGlobals({
      PropertiesService: {
        getScriptProperties: function () {
          return { getProperty: function () { return 'key'; },
                   setProperty: function () {}, deleteProperty: function () {} };
        }
      },
      httpGet_: function () { return JSON.stringify(body); }
    }, function () {
      try { fetchCareerjet_('python@Nowhere', { region: 'IL' }); }
      catch (e) { threw = String(e.message); }
    });
    ok(threw.indexOf('could not resolve the location') !== -1,
       'silently returned nothing: ' + threw);
  });
});

t('a Careerjet row asks for a real description, not a headline', function () {
  var asked = '';
  withGlobals({
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function () { return 'key'; },
                 setProperty: function () {}, deleteProperty: function () {} };
      }
    },
    httpGet_: function (url) { asked = url; return JSON.stringify({ type: 'JOBS', jobs: [] }); }
  }, function () {
    fetchCareerjet_('python@Tel Aviv', { region: 'IL' });
  });

  ok(asked.indexOf('fragment_size=' + (CONFIG.MAX_DESC_TOKENS * CONFIG.CHARS_PER_TOKEN)) !== -1,
     'fragment_size was left at the 120-character default: ' + asked);
  ok(asked.indexOf('locale_code=en_IL') !== -1, 'wrong locale: ' + asked);
  ok(asked.indexOf('sort=date') !== -1, 'not sorted newest first');
});

t('Adzuna refuses Israel rather than searching the wrong country', function () {
  // It publishes no Israeli index, and the request returns a US-shaped error
  // page - which would parse as an empty result and read as a quiet morning.
  throws(function () { fetchAdzuna_('python@Tel Aviv', { region: 'IL' }); },
         'does not cover Israel', 'IL');
  eq(REGIONS.US.adzuna_country, 'us', 'and still covers the US');
});

t('every region entry answers for every aggregator', function () {
  Object.keys(REGIONS).forEach(function (code) {
    var region = REGIONS[code];
    ok(region.label, code + ' has no label');
    ok(typeof region.careerjet_locale === 'string' && region.careerjet_locale,
       code + ' has no Careerjet locale');
    ok(typeof region.adzuna_country === 'string',
       code + ' does not say whether Adzuna covers it');
  });
});

t('a Comeet row needs both halves of its reference', function () {
  throws(function () { fetchComeet_('justauid'); }, 'uid/token', 'no token');
  throws(function () { fetchComeet_(''); }, 'uid/token', 'empty');
});

t('every source type in the config has an adapter behind it', function () {
  // The dispatcher is the one place that knows the list. A type added to the
  // config and forgotten here fails at 6am on a row someone thought was live.
  for (var i = 0; i < SOURCE_TYPES.length; i++) {
    var threw = '';
    try {
      fetchSource_({ type: SOURCE_TYPES[i], ref: '', label: 'x' }, {});
    } catch (e) {
      threw = String(e.message || e);
    }
    ok(threw.indexOf('unknown source type') === -1,
       SOURCE_TYPES[i] + ' has no case in fetchSource_');
  }
});

// ------------------------------------------------------------------ discovery

t('a company name becomes the slug these boards actually use', function () {
  eq(boardSlug_('Cato Networks'), 'catonetworks', 'two words');
  eq(boardSlug_('Logz.io'), 'logzio', 'punctuation');
  eq(boardSlug_('  Moon Active  '), 'moonactive', 'whitespace');
  eq(boardSlug_('Salt Security'), 'saltsecurity', 'two words again');
});

t('a board only counts if it hires where the person would work', function () {
  // This is what makes slug-guessing safe. Probing "Next Insurance" finds a
  // real Greenhouse board at "insurance" and "Moon Active" finds one at
  // "moon" - both live, neither the right company. Requiring a job in the
  // deployer's own locations threw out every such collision without anyone
  // having to recognise the names.
  var profile = { locations: ['Tel Aviv', 'Herzliya'] };
  ok(locationsMatch_(['Tel Aviv-Yafo, Tel Aviv District, Israel'], profile),
     'the long form of Tel Aviv');
  ok(locationsMatch_(['Herzliya'], profile), 'exact');
  ok(locationsMatch_(['New York', 'Tel Aviv'], profile), 'one of several');
  ok(!locationsMatch_(['New York', 'Austin, TX'], profile),
     'a board hiring only in the US was accepted');
  ok(!locationsMatch_([], profile), 'a board with no locations was accepted');
});

t('a profile with no locations accepts any board rather than none', function () {
  ok(locationsMatch_(['Anywhere'], { locations: [] }), 'empty profile');
});

t('discovery adds one row per board and never a duplicate', function () {
  var discoverRows = [
    ['Cato Networks', '', ''],
    ['Moon Active', '', ''],
    ['Nowhere Ltd', '', '']
  ];
  var sourceRows = [['ats_greenhouse', 'catonetworks', 'Cato Networks', 'yes']];
  var appended = [];
  var written = null;

  var sheets = {};
  sheets[TABS.DISCOVER] = fakeSheet(DISCOVER_HEADERS, discoverRows,
                                    function (v) { written = v; });
  sheets[TABS.SOURCES] = fakeSheet(SOURCES_HEADERS, sourceRows, null);

  var result = withGlobals({
    getSheet_: function (name) { return sheets[name]; },
    appendRows_: function (tab, rows) { appended = rows; },
    probeBoards_: function () {
      return {
        // Already on the Sources tab - must not be added twice.
        catonetworks: [{ type: 'ats_greenhouse', locations: ['Tel Aviv'] }],
        // New, and hiring where we are.
        moonactive: [{ type: 'ats_ashby', locations: ['Tel Aviv'] }]
        // "Nowhere Ltd" resolves to nothing at all.
      };
    }
  }, function () {
    return discoverBoards_({ locations: ['Tel Aviv'] });
  });

  eq(result.checked, 3, 'names checked');
  eq(result.added, 1, 'rows added');
  eq(appended, [['ats_ashby', 'moonactive', 'Moon Active', 'yes']], 'the new row');
  eq(written[0][D_RESULT], 'added: greenhouse', 'already-present board still reported');
  eq(written[1][D_RESULT], 'added: ashby', 'new board');
  ok(String(written[2][D_RESULT]).indexOf('no board found') === 0, 'the miss');
});

t('a board that exists but hires elsewhere says so, and is not added', function () {
  var discoverRows = [['Some US Co', '', '']];
  var appended = [];
  var written = null;
  var sheets = {};
  sheets[TABS.DISCOVER] = fakeSheet(DISCOVER_HEADERS, discoverRows,
                                    function (v) { written = v; });
  sheets[TABS.SOURCES] = fakeSheet(SOURCES_HEADERS, [], null);

  withGlobals({
    getSheet_: function (name) { return sheets[name]; },
    appendRows_: function (tab, rows) { appended = rows; },
    probeBoards_: function () {
      return { someusco: [{ type: 'ats_greenhouse', locations: ['Austin, TX'] }] };
    }
  }, function () {
    return discoverBoards_({ locations: ['Tel Aviv'] });
  });

  eq(appended, [], 'it was added anyway');
  ok(String(written[0][D_RESULT]).indexOf('nothing in your locations') !== -1,
     'result said: ' + written[0][D_RESULT]);
});

t('discovery stops at the per-run cap and leaves the rest unchecked', function () {
  var discoverRows = [];
  for (var i = 0; i < CONFIG.MAX_DISCOVER_PER_RUN + 10; i++) {
    discoverRows.push(['Company ' + i, '', '']);
  }
  var sheets = {};
  sheets[TABS.DISCOVER] = fakeSheet(DISCOVER_HEADERS, discoverRows, function () {});
  sheets[TABS.SOURCES] = fakeSheet(SOURCES_HEADERS, [], null);

  var result = withGlobals({
    getSheet_: function (name) { return sheets[name]; },
    appendRows_: function () {},
    probeBoards_: function () { return {}; }
  }, function () {
    return discoverBoards_({ locations: [] });
  });
  eq(result.checked, CONFIG.MAX_DISCOVER_PER_RUN, 'checked this run');
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

// ------------------------------------------------- paying only for reachable jobs

t('a job in a country the candidate never listed is not scored at all', function () {
  // On one real run, 274 of 366 ingested postings were in India, the US, the
  // Philippines and Czechia. Every one was fetched, stored and sent to the
  // model, every one came back in single digits, and three quarters of that
  // run's cost bought nothing.
  var profile = { only_my_locations: true, locations: ['Tel Aviv', 'Herzliya'] };
  ok(wantsLocation_('Tel Aviv District, Israel', profile), 'the long form');
  ok(wantsLocation_('Herzliya', profile), 'exact');
  ok(!wantsLocation_('India', profile), 'India was ingested');
  ok(!wantsLocation_('Manila, Manila, Philippines', profile), 'Manila');
  ok(!wantsLocation_('Austin, Texas, United States', profile), 'Austin');
  ok(!wantsLocation_('Prague, Czech Republic', profile), 'Prague');
});

t('what cannot be judged is kept rather than thrown away', function () {
  var profile = { only_my_locations: true, locations: ['Tel Aviv'] };
  ok(wantsLocation_('', profile), 'a source that states no location');
  ok(wantsLocation_('Remote', profile), 'remote');
  ok(wantsLocation_('Remote - US', profile), 'remote anywhere');
  ok(wantsLocation_('Anywhere', profile), 'anywhere');
});

t('the filter is off when it is turned off, and when nothing is listed', function () {
  ok(wantsLocation_('India', { only_my_locations: false, locations: ['Tel Aviv'] }),
     'switched off');
  ok(wantsLocation_('India', { only_my_locations: true, locations: [] }),
     'no locations to filter by');
});

t('the location filter defaults on, like the digest', function () {
  var raw = validProfileRaw();
  eq(validateProfile_(raw).only_my_locations, true, 'unset means on');
  raw.only_my_locations = 'no';
  eq(validateProfile_(raw).only_my_locations, false, 'explicitly off');
});

t('what the candidate rules out is put to the model as binding', function () {
  // industry_fit scored an IT systems role at 72 for an infrastructure
  // engineer who had never done system administration. Transferability is a
  // reason to consider a neighbouring role, not a reason to overrule somebody
  // about their own career.
  var prompt = scoreSystemPrompt_(
    { target_roles: ['Infrastructure Engineer'], locations: ['Tel Aviv'],
      weight_industry_fit: 30, weight_experience: 35, weight_compensation: 0,
      weight_location: 10, weight_interview_odds: 25,
      notes: 'Not interested in IT or full-stack roles.' },
    { current_title: 'Infrastructure Engineer' });

  ok(prompt.indexOf('hard exclusion') !== -1, 'exclusions are not called binding');
  ok(prompt.indexOf('Not interested in IT or full-stack roles.') !== -1,
     'the notes did not reach the prompt verbatim');
  ok(prompt.indexOf('function, not the industry alone') !== -1,
     'nothing separates two roles that are both software');
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

// ------------------------------------------------------------------ isolation

/**
 * Everything in the sources is a top-level var or function declaration, so it
 * is reassignable, and swapping one out is how the pipeline gets tested without
 * a Sheet, a network or an API key. Always restored in a finally: a leaked stub
 * turns into a failure three tests later with nothing to connect it to.
 */
function withGlobals(overrides, fn) {
  var keys = Object.keys(overrides);
  var saved = {};
  keys.forEach(function (k) { saved[k] = window[k]; window[k] = overrides[k]; });
  try { return fn(); } finally { keys.forEach(function (k) { window[k] = saved[k]; }); }
}

function withProps(store, fn) {
  return withGlobals({
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) {
            return store[k] === undefined ? null : store[k];
          },
          setProperty: function (k, v) { store[k] = String(v); },
          deleteProperty: function (k) { delete store[k]; }
        };
      }
    }
  }, fn);
}

/** A Sheet stand-in that records the values written back to it. */
function fakeSheet(headers, rows, onWrite) {
  return {
    getLastRow: function () { return rows.length + 1; },
    getRange: function () {
      return {
        getValues: function () { return rows; },
        setValues: function (v) { if (onWrite) onWrite(v); },
        clearContent: function () {},
        setDataValidation: function () {}
      };
    }
  };
}

/** A book with the given Jobs rows, and nowhere for a write to escape to. */
function fakeBook(rows) {
  var book = {
    jobSheet: null, rows: rows || [], appended: [], dirty: {}, byKey: {},
    runs: [], errors: [], deadline: Date.now() + 60000
  };
  for (var i = 0; i < book.rows.length; i++) {
    book.byKey[String(book.rows[i][J_KEY])] = { list: 'rows', i: i };
  }
  return book;
}

/** A Jobs row for a job that has been found and not yet scored. */
function foundRow(company, title, location) {
  var row = new Array(JOBS_HEADERS.length).fill('');
  row[J_KEY] = dedupeKey_(company, title, location);
  row[J_COMPANY] = company;
  row[J_POSITION] = title;
  row[J_LOCATION] = location;
  row[J_STATUS] = 'FOUND';
  row[J_AGE] = UNKNOWN_AGE;
  row[J_NOTES] = 'Underwrite acquisitions and build models.';
  return row;
}

/** A succeeded batch result envelope carrying the given dimension scores. */
function batchResult(customId, dims, extras) {
  var body = {
    industry_fit: dims[0], experience: dims[1], compensation: dims[2],
    location: dims[3], interview_odds: dims[4],
    why: 'Directly relevant.', salary_text: '', concerns: ''
  };
  Object.keys(extras || {}).forEach(function (k) { body[k] = extras[k]; });
  return {
    custom_id: customId,
    result: {
      type: 'succeeded',
      message: {
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(body) }],
        usage: { input_tokens: 2000, output_tokens: 200 }
      }
    }
  };
}

// --------------------------------------------------------- profile validation

function validProfileRaw() {
  return {
    resume_text: 'Analyst with three years in acquisitions.',
    resume_file_id: '',
    locations: 'Austin TX, Remote',
    target_roles: 'Acquisitions, Asset management',
    weight_industry_fit: 30, weight_experience: 25, weight_compensation: 15,
    weight_location: 10, weight_interview_odds: 20,
    report_threshold: 75, apply_threshold: 85, max_posting_age_hours: 72,
    email_report: 'yes', notes: 'prefer remote-first'
  };
}

t('a complete profile reads back typed', function () {
  var profile = validateProfile_(validProfileRaw());
  eq(profile.locations, ['Austin TX', 'Remote'], 'locations split');
  eq(profile.target_roles.length, 2, 'roles split');
  eq(profile.report_threshold, 75, 'threshold is a number');
  eq(profile.email_report, true, 'digest on');
  eq(profile.notes, 'prefer remote-first', 'notes kept verbatim');
});

t('weights that do not add up to 100 fail the run', function () {
  var raw = validProfileRaw();
  raw.weight_industry_fit = 29;
  throws(function () { validateProfile_(raw); }, 'add up to 99', 'sums to 99');
});

t('a report threshold above the apply threshold fails the run', function () {
  var raw = validProfileRaw();
  raw.report_threshold = 90;
  throws(function () { validateProfile_(raw); }, 'higher than', 'inverted');
});

t('a missing required row fails the run and names the row', function () {
  var raw = validProfileRaw();
  raw.locations = '';
  throws(function () { validateProfile_(raw); }, 'locations', 'missing locations');

  var blank = validProfileRaw();
  blank.weight_location = '   ';
  throws(function () { validateProfile_(blank); }, 'weight_location', 'whitespace');
});

t('a threshold that is not a number fails rather than reading as zero', function () {
  var raw = validProfileRaw();
  raw.apply_threshold = 'eighty five';
  throws(function () { validateProfile_(raw); }, 'not a number', 'words');
});

t('exactly one resume path is required', function () {
  var both = validProfileRaw();
  both.resume_file_id = '1AbC';
  throws(function () { validateProfile_(both); }, 'both resume_text', 'both set');

  var neither = validProfileRaw();
  neither.resume_text = '';
  throws(function () { validateProfile_(neither); }, 'no resume', 'neither set');

  var fileOnly = validProfileRaw();
  fileOnly.resume_text = '';
  fileOnly.resume_file_id = '1AbC';
  eq(validateProfile_(fileOnly).resume_file_id, '1AbC', 'file id alone is fine');
});

t('nothing invalid falls back to a default', function () {
  // The failure this guards against is the quiet one: a profile that is wrong
  // in a way the run works around produces months of scores that mean
  // something nobody chose, and the report looks entirely normal throughout.
  var raw = validProfileRaw();
  raw.weight_experience = 99;
  var scored = false;
  try { validateProfile_(raw); scored = true; } catch (e) { /* expected */ }
  ok(!scored, 'a profile summing to 174 was accepted');
});

t('the digest is on unless it is explicitly turned off', function () {
  var unset = validProfileRaw();
  delete unset.email_report;
  eq(validateProfile_(unset).email_report, true, 'unset means on');

  var off = validProfileRaw();
  off.email_report = 'no';
  eq(validateProfile_(off).email_report, false, 'explicitly off');
});

// ---------------------------------------------------------- answer resolution

var FACTS = {
  name: 'A Candidate',
  current_title: 'Acquisitions Analyst',
  education: 'BA Economics',
  years_total: '3',
  summary: 'Holds an H-1B, eligible from next spring'
};

function specFor(key) {
  for (var i = 0; i < ANSWER_KEYS.length; i++) {
    if (ANSWER_KEYS[i].key === key) return ANSWER_KEYS[i];
  }
  throw new Error('no ANSWER_KEYS entry for ' + key);
}

t('a resume fact never answers a question only the person can answer', function () {
  // The whole failsafe in one assertion. The facts above say the candidate
  // holds an H-1B and is eligible from a date - which reads like an answer to
  // "do you need sponsorship" and is not one. An agent that treats it as one
  // has put a false statement on a real application under someone's name.
  var sponsorship = resolveAnswer_(specFor('needs_sponsorship'), FACTS, {});
  eq(sponsorship.answer, UNESTABLISHED, 'sponsorship');
  eq(sponsorship.source, UNESTABLISHED, 'sponsorship source');

  var authorized = resolveAnswer_(specFor('work_authorized'), FACTS, {});
  eq(authorized.answer, UNESTABLISHED, 'work authorisation');

  var salary = resolveAnswer_(specFor('salary_expectation'), FACTS, {});
  eq(salary.answer, UNESTABLISHED, 'salary');

  var years = resolveAnswer_(specFor('years_experience'), FACTS,
                             { years_experience: '' });
  eq(years.answer, UNESTABLISHED, 'years in a named field, despite years_total');
});

t('every humanOnly key really is unanswerable from any resume fact', function () {
  // Guards the table itself: adding a humanOnly key and quietly giving it a
  // factKey would reopen the hole this design exists to close.
  var everything = {};
  for (var f = 0; f < ANSWER_KEYS.length; f++) {
    everything[ANSWER_KEYS[f].key] = 'a fact';
    if (ANSWER_KEYS[f].factKey) everything[ANSWER_KEYS[f].factKey] = 'a fact';
  }
  for (var i = 0; i < ANSWER_KEYS.length; i++) {
    if (!ANSWER_KEYS[i].humanOnly) continue;
    ok(!ANSWER_KEYS[i].factKey, ANSWER_KEYS[i].key + ' has a factKey');
    var resolved = resolveAnswer_(ANSWER_KEYS[i], everything, {});
    eq(resolved.answer, UNESTABLISHED, ANSWER_KEYS[i].key + ' from facts');
  }
});

t('the Answers tab is the one place a humanOnly answer comes from', function () {
  var resolved = resolveAnswer_(specFor('needs_sponsorship'), FACTS,
                                { needs_sponsorship: 'Yes, from Nov 2026' });
  eq(resolved.answer, 'Yes, from Nov 2026', 'answer');
  eq(resolved.source, 'answers', 'source');
});

t('a question the resume does establish is answered from it', function () {
  var resolved = resolveAnswer_(specFor('education'), FACTS, {});
  eq(resolved.answer, 'BA Economics', 'education');
  eq(resolved.source, 'resume', 'source');
});

t('a question this posting invented is treated as the person\'s to answer', function () {
  var resolved = resolveAnswers_(
    [{ key: 'portfolio_url', question: 'Link to a deal sheet?' }], FACTS, {});
  var extra = resolved[resolved.length - 1];
  eq(extra.key, 'portfolio_url', 'key');
  eq(extra.answer, UNESTABLISHED, 'answer');
  ok(unestablished_(resolved).indexOf('portfolio_url') !== -1, 'not listed as missing');
});

t('an answered profile leaves nothing unestablished', function () {
  var answers = {};
  for (var i = 0; i < ANSWER_KEYS.length; i++) {
    if (ANSWER_KEYS[i].humanOnly) answers[ANSWER_KEYS[i].key] = 'answered';
  }
  var resolved = resolveAnswers_([], FACTS, answers);
  eq(unestablished_(resolved), [], 'still missing something');
});

// -------------------------------------------------------------- batch results

t('results are applied by custom_id, whatever order they arrive in', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX'),
              foundRow('Marlow Ridge', 'Development Manager', 'Austin, TX'),
              foundRow('Ledge Investments', 'Asset Manager', 'Remote')];
  var book = fakeBook(rows);
  var profile = validateProfile_(validProfileRaw());

  // Deliberately not in row order, and keyed only by custom_id.
  var results = {};
  results[jobCustomId_(rows[2][J_KEY])] = batchResult('c', [10, 10, 10, 10, 10]);
  results[jobCustomId_(rows[0][J_KEY])] = batchResult('a', [100, 100, 100, 100, 100]);
  results[jobCustomId_(rows[1][J_KEY])] = batchResult('b', [50, 50, 50, 50, 50]);

  var outcome = withProps({}, function () {
    return applyScores_(book, profile, results);
  });

  eq(outcome.scored, 3, 'scored');
  eq(rows[0][J_SCORE], 100, 'first row got its own score');
  eq(rows[1][J_SCORE], 50, 'second row got its own score');
  eq(rows[2][J_SCORE], 10, 'third row got its own score');
});

t('all five dimensions are kept as their own columns', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX')];
  var book = fakeBook(rows);
  var results = {};
  results[jobCustomId_(rows[0][J_KEY])] =
    batchResult('a', [88, 72, 60, 95, 55], { salary_text: 'USD 95k-115k' });

  withProps({}, function () {
    applyScores_(book, validateProfile_(validProfileRaw()), results);
  });

  eq(rows[0][J_INDUSTRY], 88, 'industry fit');
  eq(rows[0][J_EXPERIENCE], 72, 'experience');
  eq(rows[0][J_COMPENSATION], 60, 'compensation');
  eq(rows[0][J_LOCATION_FIT], 95, 'location fit');
  eq(rows[0][J_INTERVIEW], 55, 'interview odds');
  eq(rows[0][J_SCORE], 74, 'the weighted total');
  eq(rows[0][J_SALARY], 'USD 95k-115k', 'salary as the posting stated it');
});

t('a result that never arrived leaves its row queued, not mis-scored', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX'),
              foundRow('Marlow Ridge', 'Development Manager', 'Austin, TX')];
  var book = fakeBook(rows);
  var results = {};
  results[jobCustomId_(rows[1][J_KEY])] = batchResult('b', [80, 80, 80, 80, 80]);

  var outcome = withProps({}, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });

  eq(outcome.scored, 1, 'scored');
  eq(rows[0][J_SCORE], '', 'the missing one kept an empty score');
  eq(rows[1][J_SCORE], 80, 'the present one was scored');
  eq(unscoredJobs_(book, 10).length, 1, 'the missing one is back in the queue');
});

t('a result for a job that is not in the Sheet is ignored', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX')];
  var book = fakeBook(rows);
  var results = { deadbeefdeadbeefdeadbeefdeadbeef: batchResult('x', [9, 9, 9, 9, 9]) };
  results[jobCustomId_(rows[0][J_KEY])] = batchResult('a', [80, 80, 80, 80, 80]);

  var outcome = withProps({}, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });
  eq(outcome.scored, 1, 'only the known job was scored');
  eq(rows[0][J_SCORE], 80, 'and it got the right score');
});

t('an already-scored row is never re-scored', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX')];
  rows[0][J_SCORE] = 91;
  var book = fakeBook(rows);
  var results = {};
  results[jobCustomId_(rows[0][J_KEY])] = batchResult('a', [10, 10, 10, 10, 10]);

  var outcome = withProps({}, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });
  eq(outcome.scored, 0, 'scored');
  eq(rows[0][J_SCORE], 91, 'the existing score was overwritten');
});

t('a response that violates the schema stops being retried forever', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX')];
  var book = fakeBook(rows);
  var broken = batchResult('a', [80, 80, 80, 80, 80]);
  broken.result.message.content = [{ type: 'text', text: 'not json at all' }];
  var results = {};
  results[jobCustomId_(rows[0][J_KEY])] = broken;

  var outcome = withProps({}, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });

  eq(outcome.failed, 1, 'failed');
  eq(rows[0][J_STATUS], 'BLOCKED', 'status');
  eq(unscoredJobs_(book, 10).length, 0, 'it would be retried forever');
  ok(book.errors.length === 1, 'no error row for the human');
});

t('a transient API error leaves the row for the next run', function () {
  var rows = [foundRow('Marlow Ridge', 'Acquisitions Analyst', 'Austin, TX')];
  var book = fakeBook(rows);
  var results = {};
  results[jobCustomId_(rows[0][J_KEY])] = {
    custom_id: 'a',
    result: { type: 'errored', error: { type: 'api_error', message: 'overloaded' } }
  };

  var outcome = withProps({}, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });

  eq(outcome.failed, 1, 'failed');
  eq(rows[0][J_SCORE], '', 'the score was filled in anyway');
  eq(unscoredJobs_(book, 10).length, 1, 'it is not queued for a retry');
});

t('a batch results body parses by custom_id and survives a broken line', function () {
  var body = [
    JSON.stringify({ custom_id: 'aaa', result: { type: 'succeeded' } }),
    'this line is not json',
    '',
    JSON.stringify({ custom_id: 'bbb', result: { type: 'succeeded' } })
  ].join('\n');

  var parsed = parseBatchResults_(body);
  eq(Object.keys(parsed).sort(), ['aaa', 'bbb'], 'one bad line cost the others');
});

// ----------------------------------------------------------- the submission cap

t('a backlog is submitted in chunks, oldest first', function () {
  var rows = [];
  for (var i = 0; i < 120; i++) {
    rows.push(foundRow('Company ' + i, 'Analyst', 'Austin, TX'));
  }
  var book = fakeBook(rows);
  var profile = validateProfile_(validProfileRaw());
  var store = {};
  var submitted = [];

  withGlobals({
    readKeyValues_: function () { return FACTS; },
    submitBatch_: function (requests) { submitted.push(requests); return 'batch_1'; }
  }, function () {
    withProps(store, function () {
      eq(submitPending_(book, profile), CONFIG.MAX_NEW_JOBS_PER_RUN, 'first chunk');
    });
  });

  eq(submitted[0].length, 50, 'first batch size');
  eq(submitted[0][0].custom_id, jobCustomId_(rows[0][J_KEY]), 'oldest first');
  eq(store.BATCH_ID, 'batch_1', 'the batch id was recorded');
  ok(store.BATCH_SUBMITTED_AT, 'the submit time was recorded');
});

t('nothing is submitted while a batch is already pending', function () {
  var book = fakeBook([foundRow('Marlow Ridge', 'Analyst', 'Austin, TX')]);
  var sent = false;

  withGlobals({
    readKeyValues_: function () { return FACTS; },
    submitBatch_: function () { sent = true; return 'batch_2'; }
  }, function () {
    withProps({ BATCH_ID: 'batch_1' }, function () {
      eq(submitPending_(book, validateProfile_(validProfileRaw())), 0, 'submitted');
    });
  });
  ok(!sent, 'a second batch was submitted over the pending one');
});

t('an empty queue submits nothing at all', function () {
  var row = foundRow('Marlow Ridge', 'Analyst', 'Austin, TX');
  row[J_SCORE] = 80;
  var sent = false;

  withGlobals({
    readKeyValues_: function () { return FACTS; },
    submitBatch_: function () { sent = true; return 'batch_1'; }
  }, function () {
    withProps({}, function () {
      eq(submitPending_(fakeBook([row]), validateProfile_(validProfileRaw())), 0,
         'submitted');
    });
  });
  ok(!sent, 'an empty batch was sent');
});

t('every submitted request carries the job schema and its own custom_id', function () {
  var rows = [foundRow('Marlow Ridge', 'Analyst', 'Austin, TX'),
              foundRow('Ledge Investments', 'Asset Manager', 'Remote')];
  var captured = null;

  withGlobals({
    readKeyValues_: function () { return FACTS; },
    submitBatch_: function (requests) { captured = requests; return 'batch_1'; }
  }, function () {
    withProps({}, function () {
      submitPending_(fakeBook(rows), validateProfile_(validProfileRaw()));
    });
  });

  eq(captured.length, 2, 'request count');
  ok(captured[0].custom_id !== captured[1].custom_id, 'two jobs shared one id');
  eq(captured[0].params.model, CONFIG.SCORE_MODEL, 'model');
  eq(captured[0].params.output_config.format.type, 'json_schema', 'structured output');
  eq(captured[0].params.output_config.format.schema.additionalProperties, false,
     'the schema lets anything through');
});

// --------------------------------------------------------------- the heartbeat

/** runDiscovery with everything below it stubbed out. Returns what it did. */
function discoveryRun(options) {
  var seen = { digests: [], submitted: 0 };
  var profile = validateProfile_(validProfileRaw());

  withGlobals({
    readProfile_: function () { return profile; },
    openBook_: function () { return fakeBook(options.rows || []); },
    resumeFacts_: function () { return FACTS; },
    fetchAllSources_: function () {
      return { jobs: options.jobs || [], ok: options.ok || 0, failed: 0 };
    },
    submitPending_: function () { return options.submits || 0; },
    flushBook_: function () {},
    rebuildReport_: function () { return options.matches || []; },
    sendDigest_: function (p, matches) { seen.digests.push(matches.length); return true; }
  }, function () {
    seen.result = runDiscovery();
  });
  return seen;
}

t('a discovery run with nothing to submit still sends the heartbeat', function () {
  // The case the digest exists for, and the one that is easiest to leave out:
  // no jobs means no batch, no batch means collectScores has nothing to pick
  // up, and the mail that would have said so is the mail that never arrives.
  // A quiet morning and a trigger that stopped firing look identical from an
  // inbox unless this fires.
  var seen = discoveryRun({ jobs: [], submits: 0, ok: 3 });
  eq(seen.digests, [0], 'digests sent');
});

t('a run that found jobs but submitted none still sends it', function () {
  // Everything already scored, or a batch still pending. Either way nothing is
  // coming from collectScores today.
  var scored = foundRow('Marlow Ridge', 'Analyst', 'Austin, TX');
  scored[J_SCORE] = 88;
  var seen = discoveryRun({ rows: [scored], jobs: [], submits: 0, ok: 3,
                            matches: [[88]] });
  eq(seen.digests, [1], 'digests sent');
});

t('a run that did submit leaves the digest to the scoring step', function () {
  var seen = discoveryRun({ jobs: [], submits: 12, ok: 3 });
  eq(seen.digests, [], 'discovery sent a digest as well as collectScores');
  eq(seen.result.submitted, 12, 'submitted');
});

// ----------------------------------------------------------- source isolation

t('one dead source does not cost the others their jobs', function () {
  var sources = [
    { type: 'ats_greenhouse', ref: 'alive', label: 'Alive' },
    { type: 'ats_greenhouse', ref: 'dead', label: 'Dead' },
    { type: 'ats_lever', ref: 'alsoalive', label: 'Also alive' }
  ];
  var book = fakeBook([]);

  var found = withGlobals({
    readSources_: function () { return sources; },
    fetchSource_: function (source) {
      if (source.ref === 'dead') throw new Error('HTTP 404 from the board');
      return [normalizedJob_({ company: source.label, title: 'Analyst',
                               location: 'Austin, TX', description: 'Work.' })];
    }
  }, function () { return fetchAllSources_(book); });

  eq(found.ok, 2, 'sources that answered');
  eq(found.failed, 1, 'sources that failed');
  eq(found.jobs.length, 2, 'jobs from the living sources');
  eq(book.errors.length, 1, 'error rows');
  ok(String(book.errors[0][3]).indexOf('careers page') !== -1,
     'the error row does not say what to do: ' + book.errors[0][3]);
});

t('an unknown source type is reported rather than skipped in silence', function () {
  throws(function () {
    fetchSource_({ type: 'ats_workday', ref: 'x', label: 'x' });
  }, 'unknown source type', 'unknown type');
});

t('every adapter returns the same shape, keyed and capped', function () {
  var job = normalizedJob_({
    company: 'Marlow Ridge Partners, Inc.', title: 'Analyst  ',
    location: 'Los Angeles, CA', description: new Array(20000).join('word '),
    url: 'https://example.invalid/j/1', posted: '2026-09-09T00:00:00Z'
  });
  eq(job.key, dedupeKey_('Marlow Ridge Partners, Inc.', 'Analyst', 'Los Angeles, CA'),
     'key');
  eq(job.title, 'Analyst', 'trimmed');
  ok(estimateTokens_(job.description) <= CONFIG.MAX_DESC_TOKENS,
     'description was not capped: ' + estimateTokens_(job.description));
});

// ------------------------------------------------------------- dedupe on write

t('a job already in the Sheet is not added again, on any later day', function () {
  var existing = foundRow('Marlow Ridge Partners', 'Acquisitions Analyst',
                          'Los Angeles, CA');
  existing[J_SCORE] = 88;
  existing[J_STATUS] = 'APPLIED';
  var book = fakeBook([existing]);

  // Tomorrow, spelled differently by a different board.
  var again = normalizedJob_({
    company: 'MARLOW RIDGE PARTNERS LLC', title: 'Acquisitions Analyst (Req 4471)',
    location: 'Los Angeles, California', description: 'Same job.'
  });

  eq(upsertJob_(book, again), false, 'it was added a second time');
  eq(book.appended.length, 0, 'appended rows');
  eq(existing[J_SCORE], 88, 'the existing score was disturbed');
  eq(existing[J_STATUS], 'APPLIED', 'a human decision was overwritten');
});

t('two sources carrying one job in the same run collapse to one row', function () {
  var book = fakeBook([]);
  var fromAts = normalizedJob_({ company: 'Marlow Ridge', title: 'Analyst',
                                 location: 'Austin, TX', description: 'A.' });
  var fromPage = normalizedJob_({ company: 'Marlow Ridge Inc.', title: 'Analyst',
                                  location: 'Austin, Texas', description: 'B.' });
  eq(upsertJob_(book, fromAts), true, 'first');
  eq(upsertJob_(book, fromPage), false, 'second');
  eq(book.appended.length, 1, 'rows appended');
});

t('an unknown posting age is written as UNKNOWN, not as a blank or a zero', function () {
  var book = fakeBook([]);
  upsertJob_(book, normalizedJob_({ company: 'Marlow Ridge', title: 'Analyst',
                                    location: 'Austin, TX', description: 'A.' }));
  eq(book.appended[0][J_AGE], UNKNOWN_AGE, 'age');
  eq(book.appended[0][J_POSTED], UNKNOWN_AGE, 'posted');
});

// -------------------------------------------------------------------- report

t('the report shows matches only, best first, and says UNKNOWN where it is', function () {
  var rows = [foundRow('A Co', 'Analyst', 'Austin, TX'),
              foundRow('B Co', 'Manager', 'Remote'),
              foundRow('C Co', 'Associate', 'Austin, TX')];
  rows[0][J_SCORE] = 74;
  rows[1][J_SCORE] = 91;
  rows[2][J_SCORE] = 80;
  rows[2][J_AGE] = 30;

  var report = reportRows_(fakeBook(rows), { report_threshold: 75 });
  eq(report.length, 2, 'rows shown');
  eq(report[0][1], 'B Co', 'highest score first');
  eq(report[1][1], 'C Co', 'second');
  eq(report[0][6], UNKNOWN_AGE, 'an unknown age');
  eq(report[1][6], '30h', 'a known age');
});

t('an unscored row is not reported as a zero', function () {
  var rows = [foundRow('A Co', 'Analyst', 'Austin, TX')];
  eq(reportRows_(fakeBook(rows), { report_threshold: 0 }).length, 0, 'reported');
});

// ----------------------------------------------------------- who gets the mail

t('the recipient comes from the Profile, not from an OAuth scope', function () {
  // Session.getActiveUser() needs the userinfo.email scope, which this project
  // does not request. It threw the first time a digest was actually sent -
  // after a run that had already found and scored everything correctly.
  eq(reportRecipient_({ report_email: 'someone@example.invalid' }),
     'someone@example.invalid', 'from the profile');
  eq(reportRecipient_({}, 'hint@example.invalid'), 'hint@example.invalid',
     'from the raw cell when the profile did not validate');
  eq(reportRecipient_({ report_email: 'a@example.invalid' }, 'b@example.invalid'),
     'a@example.invalid', 'the profile wins over the hint');
});

t('no address anywhere is an error that says what to add', function () {
  withGlobals({
    Session: {
      getActiveUser: function () {
        throw new Error('Specified permissions are not sufficient to call ' +
                        'Session.getActiveUser');
      }
    }
  }, function () {
    throws(function () { reportRecipient_({}, ''); }, 'report_email',
           'no recipient');
  });
});

t('the Session fallback still works for anyone who added the scope', function () {
  withGlobals({
    Session: {
      getActiveUser: function () {
        return { getEmail: function () { return 'scoped@example.invalid'; } };
      }
    }
  }, function () {
    eq(reportRecipient_({}, ''), 'scoped@example.invalid', 'fallback');
  });
});

t('a digest that cannot be sent does not fail a run that worked', function () {
  // Everything is found, scored and flushed before the digest goes out. An
  // unsendable email is worth a loud row in _Errors; it is not worth telling
  // someone that scoring broke when it did not.
  var logged = [];
  var threw = '';

  withGlobals({
    sendDigest_: function () { throw new Error('no report_email on the Profile tab'); },
    logError_: function (book, where, what, todo) { logged.push([where, what, todo]); }
  }, function () {
    try { deliverDigest_(fakeBook([]), {}, [], 'summary'); }
    catch (e) { threw = String(e.message || e); }
  });

  eq(threw, '', 'the run was failed by a mail problem');
  eq(logged.length, 1, 'nothing was written to _Errors');
  eq(logged[0][0], 'digest', 'error row subject');
  ok(String(logged[0][2]).indexOf('report_email') !== -1,
     'the error row does not say how to fix it: ' + logged[0][2]);
});

t('a digest that sends fine writes no error row', function () {
  var logged = 0;
  withGlobals({
    sendDigest_: function () { return true; },
    logError_: function () { logged++; }
  }, function () {
    deliverDigest_(fakeBook([]), {}, [], 'summary');
  });
  eq(logged, 0, 'a successful send still logged an error');
});

// -------------------------------------------------------------- spend ceiling

t('no request leaves the script once the day is over budget', function () {
  var store = {
    SPEND_DAY: new Date().toISOString().substring(0, 10),
    SPEND_USD: String(CONFIG.DAILY_BUDGET_USD)
  };
  var fetched = false;

  withGlobals({
    UrlFetchApp: { fetch: function () { fetched = true; throw new Error('should not run'); } }
  }, function () {
    withProps(store, function () {
      throws(function () { apiFetch_(CONFIG.BATCH_URL, 'post', { requests: [] }); },
             'daily budget reached', 'over budget');
      ok(!fetched, 'the request was sent anyway');
    });
  });
});

t('an unpriced model cannot silently escape the ledger', function () {
  [CONFIG.SCORE_MODEL, CONFIG.DRAFT_MODEL, CONFIG.PARSE_MODEL].forEach(function (model) {
    ok(CONFIG.PRICE_PER_MTOK[model], model + ' has no entry in PRICE_PER_MTOK');
  });
});

t('the dated id a response carries is priced like the alias that was sent', function () {
  // This is the version of the test above that would have caught the real bug.
  // The one above checks the ids we send; the ledger prices the ids we get
  // back, and those are not the same string. A live probe answered with
  // 'claude-haiku-4-5-20251001' for a request that said 'claude-haiku-4-5',
  // found no price, and charged zero - for the batch pass, which is almost all
  // of what this system spends.
  [CONFIG.SCORE_MODEL, CONFIG.DRAFT_MODEL, CONFIG.PARSE_MODEL].forEach(function (model) {
    eq(priceFor_(model + '-20251001'), CONFIG.PRICE_PER_MTOK[model],
       model + ' dated');
  });
});

t('a model nobody has priced errs high rather than free', function () {
  var unknown = priceFor_('claude-something-nobody-added-5');
  var worst = { input: 0, output: 0 };
  Object.keys(CONFIG.PRICE_PER_MTOK).forEach(function (known) {
    if (CONFIG.PRICE_PER_MTOK[known].input > worst.input) {
      worst = CONFIG.PRICE_PER_MTOK[known];
    }
  });
  eq(unknown, worst, 'an unknown model was not priced at the highest rate');
  ok(unknown.input > 0, 'an unknown model was priced at zero');
});

t('a batch result reaches the ledger at all', function () {
  // The end-to-end version: a succeeded result carrying a dated model id must
  // move SPEND_USD. It read zero here, and a run that spends nothing never
  // trips the ceiling that exists to bound a runaway.
  var rows = [foundRow('Marlow Ridge', 'Analyst', 'Austin, TX')];
  var book = fakeBook(rows);
  var result = batchResult('a', [80, 80, 80, 80, 80]);
  result.result.message.model = CONFIG.SCORE_MODEL + '-20251001';
  var results = {};
  results[jobCustomId_(rows[0][J_KEY])] = result;

  var store = {};
  var outcome = withProps(store, function () {
    return applyScores_(book, validateProfile_(validProfileRaw()), results);
  });

  eq(outcome.scored, 1, 'scored');
  ok(Number(store.SPEND_USD) > 0,
     'the batch pass was recorded as free: SPEND_USD is ' + store.SPEND_USD);
});

t('a batch result is billed at half price', function () {
  var store = {};
  var usage = { input_tokens: 1e6, output_tokens: 0 };
  withProps(store, function () {
    var live = recordSpend_('claude-haiku-4-5', usage, 1);
    store.SPEND_USD = '0';
    var batched = recordSpend_('claude-haiku-4-5', usage, CONFIG.BATCH_DISCOUNT);
    eq(live, 1, 'a million input tokens of Haiku at full price');
    eq(batched, 0.5, 'the same at batch rates');
  });
});

// -------------------------------------------------------------- the load order

t('nothing derived from Config.gs is built at load time', function () {
  // Apps Script evaluates project files alphabetically, so Apply.gs, Claude.gs
  // and Extract.gs all run before Config.gs. Anything built into a top-level
  // var from CONFIG or WEIGHTS is undefined when it is built, and
  // JSON.stringify drops undefined keys without complaining - which is how a
  // schema that constrains nothing gets shipped.
  var schema = scoreSchema_();
  eq(Object.keys(schema.properties).length, 8, 'schema properties');
  eq(schema.additionalProperties, false, 'additionalProperties');

  var dims = [];
  for (var i = 0; i < WEIGHTS.length; i++) dims.push(WEIGHTS[i].dim);
  for (var d = 0; d < dims.length; d++) {
    ok(schema.properties[dims[d]], 'the schema is missing ' + dims[d]);
    ok(schema.required.indexOf(dims[d]) !== -1, dims[d] + ' is not required');
  }
});

t('every sample source row is a type the dispatcher knows', function () {
  // Seventeen of the first eighteen sample slugs were dead on arrival. The
  // slugs themselves cannot be checked without a network, but a row whose type
  // is misspelled is a row that fails for a reason nobody should have to
  // diagnose from an _Errors tab on their first morning.
  var rows = sampleSources_();
  ok(rows.length >= 15, 'only ' + rows.length + ' sample source(s)');
  for (var i = 0; i < rows.length; i++) {
    ok(SOURCE_TYPES.indexOf(rows[i][S_TYPE]) !== -1,
       'unknown sample type "' + rows[i][S_TYPE] + '"');
    ok(String(rows[i][S_REF]).trim(), 'sample row ' + i + ' has no slug');
    ok(String(rows[i][S_LABEL]).indexOf('SAMPLE') === 0,
       'sample row ' + i + ' is not marked SAMPLE');
  }
});

t('the optional aggregator ships switched off', function () {
  // It needs a key that does not ship. Enabled by default it would write an
  // error row on every single run, and a deployer would learn to ignore the
  // _Errors tab - which is where everything that actually matters is reported.
  var rows = sampleSources_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][S_TYPE] === 'aggregator') {
      eq(truthy_(rows[i][S_ENABLED]), false, 'the aggregator row is enabled');
    }
  }
});

t('the status vocabulary is exactly the spec\'s four', function () {
  eq(STATUSES.sort(), ['APPLIED', 'BLOCKED', 'FOUND', 'NEEDS INPUT'], 'statuses');
});
