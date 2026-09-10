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
function fetchAllSources_(book) {
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
      var found = fetchSource_(source);
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
  if (message.indexOf('aggregator key') !== -1) {
    return 'Add ADZUNA_APP_ID and ADZUNA_APP_KEY in Project Settings -> ' +
           'Script Properties, or set this row\'s Enabled to no. The ' +
           'aggregator is optional; nothing else needs it.';
  }
  return 'Check the Slug or URL on this row. Every other source still ran, so ' +
         'the report is complete apart from this one.';
}

/** The one dispatch point. Adding a type means adding a case and an adapter. */
function fetchSource_(source) {
  switch (source.type) {
    case 'ats_greenhouse': return fetchGreenhouse_(source.ref);
    case 'ats_lever': return fetchLever_(source.ref);
    case 'ats_ashby': return fetchAshby_(source.ref);
    case 'aggregator': return fetchAggregator_(source.ref);
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

// ----------------------------------------------------------------- aggregator

/**
 * Adzuna, and off by default.
 *
 * Keyword search across employers is the one thing a fixed list of ATS boards
 * cannot do, and this is the way to get it that has a real API and a licence to
 * use it rather than a scraper pointed at a site that forbids one. It is
 * optional on purpose: no key ships, no row ships enabled, and a deployer who
 * never reads this far still gets a complete morning report from the ATS
 * boards alone.
 *
 * ref is the search term. Location comes from the Profile, so the same
 * aggregator row means something different for each person running this.
 */
function fetchAggregator_(ref) {
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('ADZUNA_APP_ID');
  var appKey = props.getProperty('ADZUNA_APP_KEY');
  if (!appId || !appKey) {
    throw new Error('aggregator key is not set');
  }

  var parts = ref.split('@');
  var what = (parts[0] || '').trim();
  var where = (parts[1] || '').trim();

  var url = 'https://api.adzuna.com/v1/api/jobs/us/search/1' +
            '?app_id=' + encodeURIComponent(appId) +
            '&app_key=' + encodeURIComponent(appKey) +
            '&results_per_page=50' +
            '&max_days_old=7' +
            '&what=' + encodeURIComponent(what) +
            (where ? '&where=' + encodeURIComponent(where) : '');

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
      // The aggregator returns a snippet, not the posting. It is enough to
      // score on and it is what the licence covers; the link goes to the
      // employer for the rest.
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
