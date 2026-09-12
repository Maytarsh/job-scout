/**
 * Sources.gs — where jobs come from.
 *
 * One dispatch point, one adapter per source type, one normalized job shape out
 * the other side. Nothing downstream — dedupe, scoring, the report, the apply
 * step — knows or can find out which board a job came from, which is what makes
 * adding a source type a matter of adding an adapter rather than of touching
 * the pipeline.
 *
 * Every adapter returns objects shaped like this, and every field is either
 * present or empty; none is ever invented:
 *
 *   { company, title, location, salary, url, posted, description }
 *
 * posted is whatever date string the source stated, or ''. It is not derived,
 * not inferred from a sort order, and not filled in from the time we happened
 * to fetch the page.
 *
 * What is deliberately absent: LinkedIn, Indeed, Handshake and ZipRecruiter.
 * All four forbid automated access in their terms and say so again in
 * robots.txt. The spec this project implements named them; respecting the sites
 * is the higher rule, and an employer's own ATS is a better source anyway —
 * it is the same posting, first-hand, with a real API and no scraping.
 */

/**
 * Read the enabled rows of the Sources tab.
 *
 * An unknown type is a configuration mistake worth reporting rather than
 * skipping in silence, so it survives as a row and fails in the dispatcher
 * where the deployer will see why.
 */
function readSources_() {
  var sheet = getSheet_(TABS.SOURCES);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var rows = sheet.getRange(2, 1, last - 1, SOURCES_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var type = String(rows[i][S_TYPE] || '').trim();
    var ref = String(rows[i][S_REF] || '').trim();
    if (!type || !ref) continue;
    if (!truthy_(rows[i][S_ENABLED])) continue;
    out.push({
      type: type,
      ref: ref,
      label: String(rows[i][S_LABEL] || '').trim() || ref
    });
  }
  return out;
}

function truthy_(value) {
  if (value === true) return true;
  var text = String(value || '').trim().toLowerCase();
  return text === 'yes' || text === 'true' || text === 'y' || text === '1';
}

/**
 * Fetch every source, one at a time, each inside its own boundary.
 *
 * A dead careers page, a renamed board slug or an employer that has moved ATS
 * is an ordinary Tuesday, and none of them may take the morning report with
 * them. A source that throws writes an error row saying what to do about it,
 * and the run carries on with the rest.
 *
 * Returns { jobs, ok, failed }.
 */
function fetchAllSources_(book, profile) {
  var sources = readSources_();
  var jobs = [];
  var ok = 0;
  var failed = 0;

  for (var i = 0; i < sources.length; i++) {
    if (Date.now() > book.deadline) {
      logError_(book, 'fetchAllSources_',
                'ran out of time after ' + i + ' of ' + sources.length + ' sources',
                'The rest are fetched on the next run. If this happens every ' +
                'day, split the Sources tab across fewer rows or raise ' +
                'CONFIG.RUN_BUDGET_SECONDS.');
      break;
    }

    var source = sources[i];
    try {
      var found = fetchSource_(source, profile);
      for (var j = 0; j < found.length; j++) {
        found[j].source = source.label;
        jobs.push(found[j]);
      }
      ok++;
      Logger.log('fetched ' + source.label + ': ' + found.length + ' job(s)');
    } catch (err) {
      failed++;
      logError_(book, source.label + ' (' + source.type + ' / ' + source.ref + ')',
                String(err.message || err),
                sourceAdvice_(source, err));
    }
  }
  return { jobs: jobs, ok: ok, failed: failed };
}

/** What a deployer can actually do about a source that failed. */
function sourceAdvice_(source, err) {
  var message = String(err.message || err);
  if (message.indexOf('404') !== -1) {
    return 'The board no longer exists at that name. Open the company\'s ' +
           'careers page, check which ATS it uses now, and update this row\'s ' +
           'Type and Slug — or set Enabled to no.';
  }
  if (message.indexOf('robots.txt') !== -1) {
    return 'The site asks automated clients not to fetch this path. Leave it ' +
           'out, or find the same jobs on the employer\'s ATS board.';
  }
  if (message.indexOf('aggregator key is not set') !== -1) {
    return 'Add ' + message.split('aggregator key is not set: ')[1] +
           ' in Project Settings -> Script Properties, or set this row\'s ' +
           'Enabled to no. Aggregators are optional; the ats_ rows do not ' +
           'need a key and still produce a complete report.';
  }
  if (message.indexOf('needs a region') !== -1 ||
      message.indexOf('does not cover') !== -1) {
    return 'Set the "region" row on the Profile tab to ' +
           Object.keys(REGIONS).join(' or ') + ', or put the region on this ' +
           'row as "terms@location@IL".';
  }
  if (message.indexOf('Undeclared referrer') !== -1) {
    return 'Careerjet requires a Referer header and this one did not reach ' +
           'it. Apps Script may be stripping it; report this rather than ' +
           'working around it, because the call fails with an HTTP 200 and ' +
           'would otherwise read as a morning with no matches.';
  }
  return 'Check the Slug or URL on this row. Every other source still ran, so ' +
         'the report is complete apart from this one.';
}

/** The one dispatch point. Adding a type means adding a case and an adapter. */
function fetchSource_(source, profile) {
  switch (source.type) {
    case 'ats_greenhouse': return fetchGreenhouse_(source.ref);
    case 'ats_lever': return fetchLever_(source.ref);
    case 'ats_ashby': return fetchAshby_(source.ref);
    case 'ats_comeet': return fetchComeet_(source.ref);
    case 'aggregator_careerjet': return fetchCareerjet_(source.ref, profile);
    case 'aggregator_adzuna': return fetchAdzuna_(source.ref, profile);
    case 'careers_url': return fetchCareersUrl_(source.ref);
    default:
      throw new Error('unknown source type "' + source.type + '". Known types: ' +
                      SOURCE_TYPES.join(', '));
  }
}

// --------------------------------------------------------------------- http

/**
 * GET a URL and return the body, or throw with the status in the message.
 *
 * muteHttpExceptions so a 404 can be reported as a configuration problem the
 * deployer can fix rather than as a stack trace.
 */
function httpGet_(url, options) {
  var settings = options || {};
  settings.method = 'get';
  settings.muteHttpExceptions = true;
  settings.followRedirects = settings.followRedirects !== false;

  var res = UrlFetchApp.fetch(url, settings);
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' from ' + url);
  }
  return res.getContentText();
}

function getJson_(url) {
  var body = httpGet_(url);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error('response from ' + url + ' was not JSON: ' + err);
  }
}

// ------------------------------------------------------------------ ATS APIs

/**
 * Greenhouse. One call returns every open role with its description.
 *
 * content is HTML, entity-encoded a second time by the API, so it goes through
 * the text pipeline like any other markup. updated_at is the only date the
 * board gives and it is not the posting date — a role edited this morning has
 * been open since spring — so it is deliberately not read as one.
 */
function fetchGreenhouse_(slug) {
  var url = 'https://boards-api.greenhouse.io/v1/boards/' +
            encodeURIComponent(slug) + '/jobs?content=true';
  var data = getJson_(url);
  var jobs = data.jobs || [];
  var out = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    out.push(normalizedJob_({
      company: (data.name || slug),
      title: job.title,
      location: (job.location || {}).name,
      salary: '',
      url: job.absolute_url,
      posted: job.first_published || '',
      description: htmlToText_(job.content)
    }));
  }
  return out;
}

/**
 * Lever. descriptionPlain arrives already stripped, so no pipeline is needed —
 * the cheapest source there is. createdAt is milliseconds since the epoch and
 * is a real posting date.
 */
function fetchLever_(slug) {
  var url = 'https://api.lever.co/v0/postings/' +
            encodeURIComponent(slug) + '?mode=json';
  var postings = getJson_(url);
  var out = [];

  for (var i = 0; i < postings.length; i++) {
    var post = postings[i];
    var categories = post.categories || {};
    out.push(normalizedJob_({
      company: slug,
      title: post.text,
      location: categories.location,
      salary: categories.commitment === 'Salary' ? '' : (post.salaryRange
        ? [post.salaryRange.currency, post.salaryRange.min, '-',
           post.salaryRange.max].join(' ') : ''),
      url: post.hostedUrl || post.applyUrl,
      posted: post.createdAt ? new Date(post.createdAt).toISOString() : '',
      description: post.descriptionPlain || htmlToText_(post.description)
    }));
  }
  return out;
}

/** Ashby. Same shape as Lever, with publishedAt as a real posting date. */
function fetchAshby_(slug) {
  var url = 'https://api.ashbyhq.com/posting-api/job-board/' +
            encodeURIComponent(slug) + '?includeCompensation=true';
  var data = getJson_(url);
  var jobs = data.jobs || [];
  var out = [];

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    out.push(normalizedJob_({
      company: job.organizationName || slug,
      title: job.title,
      location: job.location,
      salary: ashbySalary_(job.compensation),
      url: job.jobUrl || job.applyUrl,
      posted: job.publishedAt || '',
      description: job.descriptionPlain || htmlToText_(job.descriptionHtml)
    }));
  }
  return out;
}

function ashbySalary_(compensation) {
  var summary = (compensation || {}).compensationTierSummary;
  return typeof summary === 'string' ? summary : '';
}

/**
 * Comeet — now sold as Spark Hire Recruit, and the one adapter here whose
 * response shape has NOT been checked against a live board.
 *
 * The endpoint is confirmed: /careers-api/2.0/company/{uid}/positions answers
 * "Token is missing" without one, so the path and the auth model are right. The
 * field names below come from Comeet's published API description, not from a
 * board that was actually read — ten well-known Israeli employers' careers
 * pages were searched for a Comeet embed and none had one, so there was nothing
 * to verify against.
 *
 * That distinction matters here more than usual. This project already shipped
 * seventeen dead board slugs written from memory, and an adapter that invents
 * field names fails the same way but quieter: it returns rows with blank titles
 * and a dedupe key of "||", which looks like a board with no jobs on it. So it
 * throws on the first position missing a name rather than returning empties,
 * and says what it actually received.
 *
 * ref is "uid/token" — both are public values embedded in the careers page that
 * a browser reads them from.
 */
function fetchComeet_(ref) {
  var parts = String(ref || '').split(/[\/:]/);
  var uid = (parts[0] || '').trim();
  var token = (parts[1] || '').trim();
  if (!uid || !token) {
    throw new Error('a Comeet row needs "uid/token" — both appear in the ' +
                    'careers page source. Got "' + ref + '".');
  }

  var url = 'https://www.comeet.co/careers-api/2.0/company/' +
            encodeURIComponent(uid) + '/positions?token=' +
            encodeURIComponent(token);
  var data = getJson_(url);
  var positions = (Object.prototype.toString.call(data) === '[object Array]')
    ? data : (data.positions || []);
  var out = [];

  for (var i = 0; i < positions.length; i++) {
    var job = positions[i];
    var title = job.name || job.position_name || '';
    if (!title) {
      throw new Error('Comeet returned a position with no name. The response ' +
                      'shape has changed or was never what this adapter ' +
                      'expects. First position: ' +
                      JSON.stringify(job).substring(0, 300));
    }
    out.push(normalizedJob_({
      company: job.company_name || uid,
      title: title,
      location: comeetLocation_(job.location),
      salary: '',
      url: job.url_active_page || job.url_comeet_hosted_page || '',
      posted: job.time_created || job.time_updated || '',
      description: htmlToText_(comeetDescription_(job.details))
    }));
  }
  return out;
}

function comeetLocation_(location) {
  if (!location) return '';
  if (typeof location === 'string') return location;
  var parts = [location.city, location.country]
    .filter(function (part) { return typeof part === 'string' && part.trim(); });
  var text = location.name || parts.join(', ');
  return location.is_remote ? 'Remote (' + text + ')' : text;
}

/** Comeet splits a posting across named sections; the scorer wants all of them. */
function comeetDescription_(details) {
  if (!details || !details.length) return '';
  var chunks = [];
  for (var i = 0; i < details.length; i++) {
    var section = details[i] || {};
    if (section.value) chunks.push((section.name || '') + '\n' + section.value);
  }
  return chunks.join('\n\n');
}

// ----------------------------------------------------------------- aggregator

/**
 * Which country an aggregator row is searching, and what that region supports.
 *
 * Region comes from the Profile, because it is the one setting that has to
 * change when this Sheet is handed to someone in another country. A row may
 * override it with a third segment — "python@Tel Aviv@IL" — for the person
 * searching two countries at once, which a single Profile row cannot express.
 */
function regionFor_(profile, override) {
  var code = String(override || (profile || {}).region || '').trim().toUpperCase();
  if (!code) {
    throw new Error(
      'this aggregator row needs a region, and the Profile has no "region" ' +
      'row. Set it to one of: ' + Object.keys(REGIONS).join(', ') +
      ' — or put it on the row itself as "terms@location@IL".');
  }
  var region = REGIONS[code];
  if (!region) {
    throw new Error('unknown region "' + code + '". Known regions: ' +
                    Object.keys(REGIONS).join(', '));
  }
  region.code = code;
  return region;
}

/**
 * Split an aggregator row's reference into its parts.
 *
 * "python infrastructure@Tel Aviv" or "python@Tel Aviv@IL". The location is
 * optional; without one the aggregator searches the whole region.
 */
function aggregatorQuery_(ref, profile) {
  var parts = String(ref || '').split('@');
  var what = (parts[0] || '').trim();
  if (!what) {
    throw new Error('an aggregator row needs search terms, as "terms@location".');
  }
  return {
    what: what,
    where: (parts[1] || '').trim(),
    region: regionFor_(profile, parts[2])
  };
}

/**
 * Careerjet. The open half of the search: any employer, not only the ones on
 * the Sources tab.
 *
 * Authenticated with HTTP Basic, the API key as the user name and an empty
 * password — that is what a Publisher account issues. user_ip and user_agent
 * are required and neither is meaningful from a server; the API rejects them
 * empty and accepts any value in them.
 *
 * fragment_size is asked for explicitly. Left alone it returns 120 characters,
 * which is a headline rather than a description and nowhere near enough to
 * judge a job on — the scorer would be reading titles. Asking for the same
 * budget every other source gets costs nothing and is what makes an aggregator
 * row comparable to a company board rather than merely a lead.
 *
 * One page, newest first, for the same reason the freshness filter exists.
 */
function fetchCareerjet_(ref, profile) {
  var query = aggregatorQuery_(ref, profile);
  var apiKey = PropertiesService.getScriptProperties()
    .getProperty('CAREERJET_API_KEY');
  if (!apiKey) {
    throw new Error('aggregator key is not set: CAREERJET_API_KEY');
  }

  var url = CAREERJET_URL +
    '?locale_code=' + encodeURIComponent(query.region.careerjet_locale) +
    '&keywords=' + encodeURIComponent(query.what) +
    (query.where ? '&location=' + encodeURIComponent(query.where) : '') +
    '&sort=date' +
    '&page=1' +
    '&page_size=' + CAREERJET_PAGE_SIZE +
    '&fragment_size=' + (CONFIG.MAX_DESC_TOKENS * CONFIG.CHARS_PER_TOKEN) +
    '&user_ip=0.0.0.0' +
    '&user_agent=' + encodeURIComponent('job-scout');

  var body = httpGet_(url, {
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(apiKey + ':')
    }
  });

  var data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error('Careerjet did not return JSON: ' + body.substring(0, 200));
  }

  if (data.type === 'ERROR') {
    throw new Error('Careerjet refused the query: ' +
                    (data.error || 'no reason given'));
  }

  // Not an error and not a result: the location did not resolve to a place
  // Careerjet knows, or resolved to several. Either way no search happened, and
  // an empty jobs list would read as a morning with nothing new rather than as
  // a row that has never worked.
  if (data.type === 'LOCATIONS') {
    var choices = (data.locations || []).slice(0, 5).join(', ');
    throw new Error('Careerjet could not resolve the location "' + query.where +
                    '": ' + (data.message || 'no match') +
                    (choices ? '. Try one of: ' + choices : ''));
  }

  var found = data.jobs || [];
  var out = [];
  for (var i = 0; i < found.length; i++) {
    var job = found[i];
    out.push(normalizedJob_({
      company: job.company,
      title: job.title,
      location: job.locations,
      salary: job.salary,
      url: job.url,
      posted: job.date,
      // Plain text already, but the matched terms come wrapped in <b> tags, so
      // it goes through the pipeline like anything else.
      description: htmlToText_(job.description)
    }));
  }
  return out;
}

/**
 * Adzuna. The same job as Careerjet for the countries it indexes.
 *
 * It publishes no Israeli index at all, and asking for one returns a US-shaped
 * error page rather than an empty result — which would parse as "no jobs
 * today" and be indistinguishable from a quiet morning. The region table is
 * what turns that into a sentence someone can act on.
 */
function fetchAdzuna_(ref, profile) {
  var query = aggregatorQuery_(ref, profile);
  var country = query.region.adzuna_country;
  if (!country) {
    throw new Error('Adzuna does not cover ' + query.region.label +
                    '. Use aggregator_careerjet for this region, or disable ' +
                    'this row.');
  }

  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('ADZUNA_APP_ID');
  var appKey = props.getProperty('ADZUNA_APP_KEY');
  if (!appId || !appKey) {
    throw new Error('aggregator key is not set: ADZUNA_APP_ID and ADZUNA_APP_KEY');
  }

  var url = 'https://api.adzuna.com/v1/api/jobs/' + encodeURIComponent(country) +
            '/search/1' +
            '?app_id=' + encodeURIComponent(appId) +
            '&app_key=' + encodeURIComponent(appKey) +
            '&results_per_page=50' +
            '&sort_by=date' +
            '&what=' + encodeURIComponent(query.what) +
            (query.where ? '&where=' + encodeURIComponent(query.where) : '');

  var data = getJson_(url);
  var found = data.results || [];
  var out = [];
  for (var i = 0; i < found.length; i++) {
    var job = found[i];
    out.push(normalizedJob_({
      company: (job.company || {}).display_name,
      title: job.title,
      location: (job.location || {}).display_name,
      salary: adzunaSalary_(job),
      url: job.redirect_url,
      posted: job.created || '',
      description: htmlToText_(job.description)
    }));
  }
  return out;
}

function adzunaSalary_(job) {
  if (job.salary_min && job.salary_max) {
    return 'USD ' + Math.round(job.salary_min) + '-' + Math.round(job.salary_max);
  }
  return '';
}

// ---------------------------------------------------------------- careers URL

/**
 * Any careers page the deployer adds by URL.
 *
 * robots.txt is checked first and honoured. A site that asks automated clients
 * to stay off a path is not an obstacle to work around: the row fails, says so,
 * and the run continues without it.
 */
function fetchCareersUrl_(url) {
  if (!robotsAllows_(url)) {
    throw new Error('robots.txt disallows fetching ' + url);
  }

  var html = httpGet_(url);
  var structured = jsonLdJobPosting_(html);

  if (structured && structured.title) {
    structured.url = url;
    structured.source = '';
    return [normalizedJob_(structured)];
  }

  // No structured data. The page is still worth reading, but nothing about it
  // says which company or which title, so those cannot be filled in without
  // guessing — and a guessed company name would break dedupe for every other
  // source carrying the same job. Take the title tag, which is the one thing a
  // page does state about itself, and leave the rest to the model.
  var title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return [normalizedJob_({
    company: hostOf_(url),
    title: collapseWhitespace_(decodeEntities_(title)).split(/\s+[|-]\s+/)[0],
    location: '',
    salary: '',
    url: url,
    posted: '',
    description: htmlToText_(html)
  })];
}

/**
 * Does robots.txt allow this path?
 *
 * A deliberately conservative reader: it looks at the wildcard user-agent
 * group, honours Disallow prefixes, and treats an unreachable or unparseable
 * robots.txt as permission granted for that host only in the case where the
 * file genuinely does not exist. A 5xx means the site is having a bad day and
 * the answer is no rather than "probably fine".
 */
function robotsAllows_(url) {
  var host = hostOf_(url);
  if (!host) return false;

  var res;
  try {
    res = UrlFetchApp.fetch('https://' + host + '/robots.txt',
                            { method: 'get', muteHttpExceptions: true });
  } catch (err) {
    return false;
  }

  var code = res.getResponseCode();
  if (code === 404 || code === 410) return true;
  if (code !== 200) return false;

  var path = pathOf_(url);
  var lines = res.getContentText().split(/\r?\n/);
  var inWildcard = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    var match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;

    var field = match[1].toLowerCase();
    var value = match[2].trim();

    if (field === 'user-agent') {
      inWildcard = (value === '*');
    } else if (inWildcard && field === 'disallow' && value) {
      if (value === '/') return false;
      if (path.indexOf(value) === 0) return false;
    }
  }
  return true;
}

function hostOf_(url) {
  var match = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
  return match ? match[1] : '';
}

function pathOf_(url) {
  var match = String(url || '').match(/^https?:\/\/[^\/?#]+([^?#]*)/i);
  return (match && match[1]) || '/';
}

// ------------------------------------------------------------------ discovery

/**
 * Turn company names into Sources rows, so nobody has to know what an ATS is.
 *
 * The Sources tab is a list, and a list somebody maintains by hand is the thing
 * this was fairly accused of being. This does not remove the list — it removes
 * the maintenance. You write down companies you would work for; this works out
 * which board each one uses, checks the board is real, and appends the row.
 *
 * The location check is what makes it trustworthy. A slug guessed from a name
 * collides constantly: probing "Next Insurance" finds a live Greenhouse board
 * at "insurance", and "Moon Active" finds one at "moon" — both real boards,
 * neither the right company. Requiring at least one job in the deployer's own
 * locations threw out every such collision when this was built, without anyone
 * having to recognise the names.
 *
 * Returns a summary for the toast.
 */
function discoverBoards_(profile) {
  var sheet = getSheet_(TABS.DISCOVER);
  var last = sheet.getLastRow();
  if (last < 2) return { checked: 0, added: 0, empty: true };

  var rows = sheet.getRange(2, 1, last - 1, DISCOVER_HEADERS.length).getValues();
  var pending = [];
  for (var i = 0; i < rows.length && pending.length < CONFIG.MAX_DISCOVER_PER_RUN; i++) {
    var name = String(rows[i][D_NAME] || '').trim();
    if (name && !String(rows[i][D_RESULT] || '').trim()) {
      pending.push({ row: i, name: name, slug: boardSlug_(name) });
    }
  }
  if (!pending.length) return { checked: 0, added: 0, done: true };

  var results = probeBoards_(pending);
  var existing = existingSourceKeys_();
  var additions = [];

  for (var j = 0; j < pending.length; j++) {
    var item = pending[j];
    var found = results[item.slug] || [];
    var matched = [];
    var seenElsewhere = 0;

    for (var k = 0; k < found.length; k++) {
      if (locationsMatch_(found[k].locations, profile)) matched.push(found[k]);
      else seenElsewhere++;
    }

    if (matched.length) {
      var names = [];
      for (var m = 0; m < matched.length; m++) {
        var key = matched[m].type + '|' + item.slug;
        names.push(matched[m].type.replace('ats_', ''));
        if (existing[key]) continue;
        existing[key] = true;
        additions.push([matched[m].type, item.slug, item.name, 'yes']);
      }
      rows[item.row][D_RESULT] = 'added: ' + names.join(', ');
    } else if (seenElsewhere) {
      rows[item.row][D_RESULT] = 'board found, but nothing in your locations';
    } else {
      rows[item.row][D_RESULT] = 'no board found on greenhouse, lever or ashby';
    }
    rows[item.row][D_CHECKED] = new Date();
  }

  sheet.getRange(2, 1, rows.length, DISCOVER_HEADERS.length).setValues(rows);
  appendRows_(TABS.SOURCES, additions);
  return { checked: pending.length, added: additions.length };
}

/** A company name as a board slug: how these boards are almost always named. */
function boardSlug_(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Probe one slug against all three boards at once.
 *
 * UrlFetchApp.fetchAll issues them concurrently, which is the difference
 * between twenty-five companies fitting inside the execution cap and not. The
 * probe URLs are deliberately the light ones — Greenhouse with content=true
 * returns every description on the board, and discovery only needs to know
 * that the board exists and where its jobs are.
 *
 * Returns { slug: [ { type, locations } ] }.
 */
function probeBoards_(pending) {
  var kinds = ['ats_greenhouse', 'ats_lever', 'ats_ashby'];
  var requests = [];
  var index = [];

  for (var i = 0; i < pending.length; i++) {
    for (var k = 0; k < kinds.length; k++) {
      requests.push({
        url: boardProbeUrl_(kinds[k], pending[i].slug),
        method: 'get',
        muteHttpExceptions: true
      });
      index.push({ slug: pending[i].slug, type: kinds[k] });
    }
  }

  var responses = UrlFetchApp.fetchAll(requests);
  var out = {};

  for (var r = 0; r < responses.length; r++) {
    var at = index[r];
    if (responses[r].getResponseCode() !== 200) continue;
    var locations;
    try {
      locations = boardLocations_(at.type, JSON.parse(responses[r].getContentText()));
    } catch (err) {
      continue;
    }
    if (!locations.length) continue;
    if (!out[at.slug]) out[at.slug] = [];
    out[at.slug].push({ type: at.type, locations: locations });
  }
  return out;
}

function boardProbeUrl_(type, slug) {
  if (type === 'ats_greenhouse') {
    return 'https://boards-api.greenhouse.io/v1/boards/' +
           encodeURIComponent(slug) + '/jobs';
  }
  if (type === 'ats_lever') {
    return 'https://api.lever.co/v0/postings/' +
           encodeURIComponent(slug) + '?mode=json';
  }
  return 'https://api.ashbyhq.com/posting-api/job-board/' +
         encodeURIComponent(slug);
}

/** Just the locations, from whichever shape this board answers with. */
function boardLocations_(type, data) {
  var out = [];
  var jobs = (Object.prototype.toString.call(data) === '[object Array]')
    ? data : (data.jobs || []);

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var place = (type === 'ats_greenhouse') ? (job.location || {}).name
              : (type === 'ats_lever') ? (job.categories || {}).location
              : job.location;
    if (place) out.push(String(place));
  }
  return out;
}

/**
 * Does this board hire anywhere the deployer would work?
 *
 * Compared through normalizeLocation_, so "Tel Aviv" on the Profile matches a
 * board writing "Tel Aviv-Yafo, Tel Aviv District, Israel" — the same function
 * that stops those being two jobs.
 */
function locationsMatch_(locations, profile) {
  var wanted = (profile.locations || []).map(normalizeLocation_)
    .filter(function (place) { return place.length > 2; });
  if (!wanted.length) return true;

  for (var i = 0; i < locations.length; i++) {
    var place = normalizeLocation_(locations[i]);
    for (var w = 0; w < wanted.length; w++) {
      if (place.indexOf(wanted[w]) !== -1 || wanted[w].indexOf(place) !== -1) {
        return true;
      }
    }
  }
  return false;
}

/** What is already on the Sources tab, so discovery never adds a duplicate. */
function existingSourceKeys_() {
  var sheet = getSheet_(TABS.SOURCES);
  var last = sheet.getLastRow();
  var out = {};
  if (last < 2) return out;

  var rows = sheet.getRange(2, 1, last - 1, SOURCES_HEADERS.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    out[String(rows[i][S_TYPE]).trim() + '|' + String(rows[i][S_REF]).trim()] = true;
  }
  return out;
}

// ---------------------------------------------------------------- normalizing

/**
 * The one shape every adapter returns, with the dedupe key and the token cap
 * applied in one place so no adapter can forget either.
 */
function normalizedJob_(fields) {
  var company = String(fields.company || '').trim();
  var title = String(fields.title || '').trim();
  var location = String(fields.location || '').trim();

  return {
    key: dedupeKey_(company, title, location),
    company: company,
    title: title,
    location: location,
    salary: String(fields.salary || '').trim(),
    url: String(fields.url || '').trim(),
    source: fields.source || '',
    posted: String(fields.posted || '').trim(),
    description: capTokens_(fields.description, CONFIG.MAX_DESC_TOKENS)
  };
}
