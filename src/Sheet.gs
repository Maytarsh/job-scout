/**
 * Sheet.gs — all spreadsheet state.
 *
 * Everything is loaded once, mutated in memory, and flushed in batched writes.
 * Per-cell writes are the usual reason an Apps Script run hits the 6-minute cap.
 *
 * The Jobs tab is the database, and the reason this project exists: the Codex
 * prototype it replaces kept its results in an ephemeral workspace, so every
 * morning it rediscovered yesterday's jobs as though they were new. A row here
 * outlives the run that created it, which is what makes dedupe work across days.
 */

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sheet;
}

/**
 * Neutralise one value on its way into a cell.
 *
 * Everything reaching the Sheet came off a job board, so it is untrusted: a
 * company controls its own posting text, and a posting that starts with "=" is
 * a formula the moment it lands in a cell. Control characters, unbounded
 * length and formula prefixes are all handled here so no call site has to
 * remember to.
 */
function safeCell_(value, maxLen) {
  if (value === '' || value === null || value === undefined) return '';
  if (value instanceof Date || typeof value === 'number') return value;

  var text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return '';

  var cap = maxLen || 500;
  if (text.length > cap) text = text.substring(0, cap - 1) + '…';
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return text;
}

// ------------------------------------------------------------------ the book

/**
 * Load the Jobs tab and everything the run will write alongside it.
 *
 * byKey indexes existing rows and rows appended during this run alike, so two
 * sources that both carry the same posting collapse into one row rather than
 * racing to append it twice.
 */
function openBook_() {
  var jobSheet = getSheet_(TABS.JOBS);
  var last = jobSheet.getLastRow();
  var rows = last > 1
    ? jobSheet.getRange(2, 1, last - 1, JOBS_HEADERS.length).getValues()
    : [];

  var book = {
    jobSheet: jobSheet,
    rows: rows,
    appended: [],
    dirty: {},
    byKey: {},
    runs: [],
    errors: [],
    deadline: Date.now() + CONFIG.RUN_BUDGET_SECONDS * 1000
  };

  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][J_KEY] || '');
    if (key) book.byKey[key] = { list: 'rows', i: i };
  }
  return book;
}

/** Locate a job by dedupe key. Returns the row array, or null. */
function jobRow_(book, key) {
  var at = book.byKey[key];
  if (!at) return null;
  return at.list === 'rows' ? book.rows[at.i] : book.appended[at.i];
}

/** Mark an existing row changed. Appended rows flush as inserts, so they are skipped. */
function touchJob_(book, key) {
  var at = book.byKey[key];
  if (at && at.list === 'rows') book.dirty[at.i] = true;
}

/**
 * Record one normalized job. Returns true if it was new to the Sheet.
 *
 * A job already present is deliberately left alone — not re-scored, not
 * re-dated, not re-described. Its Score, Status and any draft on it are the
 * product of work already done, and possibly of a human's decision since.
 */
function upsertJob_(book, job) {
  if (book.byKey[job.key]) return false;

  var row = new Array(JOBS_HEADERS.length).fill('');
  row[J_KEY] = job.key;
  row[J_COMPANY] = safeCell_(job.company, 120);
  row[J_POSITION] = safeCell_(job.title, 200);
  row[J_LOCATION] = safeCell_(job.location, 120);
  row[J_STATUS] = 'FOUND';
  row[J_SALARY] = safeCell_(job.salary, 120);
  row[J_SOURCE] = safeCell_(job.source, 80);
  row[J_POSTED] = job.posted ? job.posted : UNKNOWN_AGE;
  row[J_AGE] = (job.ageHours === null || job.ageHours === undefined)
    ? UNKNOWN_AGE : job.ageHours;
  row[J_LINK] = safeCell_(job.url, 500);
  row[J_FIRST_SEEN] = new Date();
  // The description is parked on the row so scoring, which runs in a later
  // execution, does not have to fetch the posting a second time. It is already
  // capped at MAX_DESC_TOKENS by the time it arrives here.
  row[J_NOTES] = safeCell_(job.description, 40000);

  book.appended.push(row);
  book.byKey[job.key] = { list: 'appended', i: book.appended.length - 1 };
  return true;
}

/** Every row found but never scored, oldest first, capped. This is the queue. */
function unscoredJobs_(book, limit) {
  var out = [];
  var lists = [book.rows, book.appended];
  for (var l = 0; l < lists.length && out.length < limit; l++) {
    for (var i = 0; i < lists[l].length && out.length < limit; i++) {
      var row = lists[l][i];
      if (row[J_SCORE] === '' || row[J_SCORE] === null) out.push(row);
    }
  }
  return out;
}

/** Write everything buffered, in as few range writes as the shapes allow. */
function flushBook_(book) {
  var width = JOBS_HEADERS.length;

  Object.keys(book.dirty).forEach(function (i) {
    var idx = Number(i);
    book.jobSheet.getRange(idx + 2, 1, 1, width).setValues([book.rows[idx]]);
  });

  if (book.appended.length) {
    book.jobSheet
      .getRange(book.jobSheet.getLastRow() + 1, 1, book.appended.length, width)
      .setValues(book.appended);
  }

  appendRows_(TABS.RUNS, book.runs);
  appendRows_(TABS.ERRORS, book.errors);
  book.dirty = {};
  book.appended = [];
  book.runs = [];
  book.errors = [];
}

function appendRows_(tabName, rows) {
  if (!rows || !rows.length) return;
  var sheet = getSheet_(tabName);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
    .setValues(rows);
}

// ------------------------------------------------------------------- logging

/**
 * A source that failed, or a job that could not be scored.
 *
 * "What to do" is not decoration. These rows are read by someone who did not
 * write the code and cannot read an execution log, and a failure they cannot
 * act on is indistinguishable to them from the thing having quietly stopped.
 */
function logError_(book, where, what, todo) {
  var row = [new Date(), safeCell_(where, 200), safeCell_(what, 900),
             safeCell_(todo, 500)];
  if (book) book.errors.push(row);
  else appendRows_(TABS.ERRORS, [row]);
  Logger.log('error at ' + where + ': ' + what);
}

/** One row per step per run. This is the token and cost record. */
function logRun_(book, fields) {
  var row = new Array(RUNS_HEADERS.length).fill('');
  row[0] = new Date();
  row[1] = fields.step || '';
  row[2] = num_(fields.sourcesOk);
  row[3] = num_(fields.sourcesFailed);
  row[4] = num_(fields.jobsSeen);
  row[5] = num_(fields.newJobs);
  row[6] = num_(fields.submitted);
  row[7] = num_(fields.scored);
  row[8] = safeCell_(fields.batchId, 120);
  row[9] = num_(fields.estInputTokens);
  row[10] = num_(fields.inputTokens);
  row[11] = num_(fields.outputTokens);
  row[12] = fields.costUsd === undefined
    ? '' : Number(Number(fields.costUsd).toFixed(4));
  row[13] = safeCell_(fields.note, 500);
  if (book) book.runs.push(row);
  else appendRows_(TABS.RUNS, [row]);
  Logger.log(fields.step + ': ' + JSON.stringify(fields));
}

function num_(value) {
  return (value === undefined || value === null || value === '') ? '' : Number(value);
}

// ---------------------------------------------------------- key/value tabs

/**
 * Read a two-or-more column tab as a key/value object.
 *
 * Used for Profile, Answers and _Facts. Blank keys are skipped, so a deployer
 * can leave spacer rows in the tab without breaking the read.
 */
function readKeyValues_(tabName, valueColumn) {
  var sheet = getSheet_(tabName);
  var last = sheet.getLastRow();
  if (last < 2) return {};

  var column = valueColumn || 1;
  var rows = sheet.getRange(2, 1, last - 1, column + 1).getValues();
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0] || '').trim();
    if (key) out[key] = rows[i][column];
  }
  return out;
}

// -------------------------------------------------------------------- report

/**
 * Rebuild the Report tab from the Jobs tab.
 *
 * Rebuilt rather than appended: the Report is a view, and a view that
 * accumulates is a second database that can disagree with the first one. Jobs
 * is the source of truth; everything here can be recomputed from it.
 */
function rebuildReport_(book, profile) {
  var matches = reportRows_(book, profile);
  var sheet = getSheet_(TABS.REPORT);
  var last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, REPORT_HEADERS.length).clearContent();
  }
  if (matches.length) {
    sheet.getRange(2, 1, matches.length, REPORT_HEADERS.length).setValues(matches);
  }
  return matches;
}

/** The report's rows, score-descending. No Sheet calls, so it is testable. */
function reportRows_(book, profile) {
  var all = book.rows.concat(book.appended);
  var out = [];

  for (var i = 0; i < all.length; i++) {
    var row = all[i];
    var score = row[J_SCORE];
    if (score === '' || score === null || score === undefined) continue;
    if (Number(score) < profile.report_threshold) continue;

    out.push([
      Number(score),
      row[J_COMPANY],
      row[J_POSITION],
      row[J_LOCATION],
      row[J_SALARY] || '',
      row[J_SOURCE],
      row[J_AGE] === UNKNOWN_AGE ? UNKNOWN_AGE : row[J_AGE] + 'h',
      row[J_WHY],
      row[J_LINK],
      row[J_STATUS]
    ]);
  }

  out.sort(function (a, b) { return b[0] - a[0]; });
  return out;
}
