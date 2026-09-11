/**
 * Setup.gs — first run, and the menu.
 *
 * setup() is idempotent: it creates any missing tab, leaves an existing one
 * alone, and reinstalls the triggers from scratch. Running it twice is safe and
 * is the documented fix for most "nothing happened this morning" reports.
 *
 * The sample data below is the only place in this codebase where a location, a
 * job title or a company name appears, and it is sample data: it is written
 * into a Sheet on first run, marked as an example, and expected to be
 * overwritten before the first real run. No .gs file reads it, and nothing
 * falls back to it. That is what makes this hand-off-able — someone else
 * changes the Profile and Sources tabs and changes nothing else.
 */

function setup() {
  ensureTab_(TABS.PROFILE, PROFILE_HEADERS, sampleProfile_());
  ensureTab_(TABS.SOURCES, SOURCES_HEADERS, sampleSources_());
  ensureTab_(TABS.ANSWERS, ANSWERS_HEADERS, blankAnswers_());
  ensureTab_(TABS.JOBS, JOBS_HEADERS, []);
  ensureTab_(TABS.REPORT, REPORT_HEADERS, []);
  ensureTab_(TABS.FACTS, FACTS_HEADERS, []);
  ensureTab_(TABS.RUNS, RUNS_HEADERS, []);
  ensureTab_(TABS.ERRORS, ERRORS_HEADERS, []);

  formatJobs_();
  hideWorkingTabs_();
  installTriggers_();

  var hasKey = !!PropertiesService.getScriptProperties()
    .getProperty('ANTHROPIC_API_KEY');

  var message = [
    (hasKey ? '✓' : '✗') + ' Anthropic API key' +
      (hasKey ? '' : ' — add ANTHROPIC_API_KEY in Project Settings -> Script Properties'),
    '✓ Eight tabs ready',
    '✓ Triggers installed: discovery daily, collection hourly',
    '',
    'Next: replace the sample rows in the Profile and Sources tabs with your',
    'own, then run Job scout -> Find jobs now.'
  ].join('\n');

  Logger.log('setup: ' + message);
  try {
    SpreadsheetApp.getUi().alert('Job scout', message,
                                 SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* no UI when run from the editor */ }
  return message;
}

/**
 * Create a tab if it is missing, with headers and any seed rows.
 *
 * An existing tab is never touched. Re-running setup() after months of use must
 * not overwrite a Profile someone has tuned or an Answers tab they have filled
 * in — those are the two things in this Sheet that cannot be regenerated.
 */
function ensureTab_(name, headers, seedRows) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(name);
  if (sheet) return sheet;

  sheet = book.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (seedRows && seedRows.length) {
    sheet.getRange(2, 1, seedRows.length, headers.length).setValues(seedRows);
  }
  sheet.autoResizeColumns(1, Math.min(headers.length, 6));
  return sheet;
}

function formatJobs_() {
  var sheet = getSheet_(TABS.JOBS);
  var rows = Math.max(sheet.getMaxRows() - 1, 1);

  // Status is a dropdown because APPLIED is a value only a person sets, and a
  // dropdown is how a person is told which values exist.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, J_STATUS + 1, rows, 1).setDataValidation(rule);

  sheet.setColumnWidth(J_WHY + 1, 380);
  sheet.setColumnWidth(J_NEEDS + 1, 320);
  sheet.setColumnWidth(J_DRAFT + 1, 420);
  sheet.setColumnWidth(J_NOTES + 1, 320);
  sheet.hideColumns(J_KEY + 1);
}

/** The audit tabs are for reading when something is wrong, not for every day. */
function hideWorkingTabs_() {
  [TABS.FACTS, TABS.RUNS, TABS.ERRORS].forEach(function (name) {
    var sheet = SpreadsheetApp.getActive().getSheetByName(name);
    if (sheet) sheet.hideSheet();
  });
}

/**
 * Install both triggers, deleting any existing copy first so setup() is safe to
 * re-run. Triggers are identified by their handler function name; they have no
 * other name.
 *
 * Discovery runs once, early. Collection runs hourly and does nothing at all
 * unless a batch is pending — most of its executions are a single property read
 * — which is what lets a batch that finishes at 07:20 be reported at 08:00
 * rather than tomorrow.
 */
function installTriggers_() {
  var wanted = { runDiscovery: true, collectScores: true };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (wanted[trigger.getHandlerFunction()]) ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('runDiscovery').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('collectScores').timeBased().everyHours(1).create();
}

// ---------------------------------------------------------------- sample data

/**
 * The Profile tab as it ships.
 *
 * These values are the ones from the original spec this project implements —
 * one person's locations, one person's target roles, one person's thresholds.
 * They are here as a worked example of the shape and are meant to be replaced.
 * Every row says what it does, because the person filling this in is not
 * necessarily the person who read the README.
 */
function sampleProfile_() {
  return [
    ['resume_text', 'SAMPLE — paste your resume here as plain text, or clear ' +
      'this row and use resume_file_id instead.',
      'Your resume. Read once, then cached in _Facts. Pasting text needs no ' +
      'Drive permission; a file id does.'],
    ['resume_file_id', '',
      'Alternative to resume_text: the id of a PDF in your Drive — the long ' +
      'string in its URL. Needs the Drive scope added; see the README.'],
    ['locations', 'SAMPLE: Los Angeles area, Manhattan Beach, Malibu, ' +
      'Orange County CA, Austin TX, New York City',
      'Where you would work. Comma-separated. Remote counts as a match for ' +
      'any of them.'],
    ['target_roles', 'SAMPLE: Real estate development, Real estate ' +
      'acquisitions, Real estate investment, Asset management, Commercial ' +
      'real estate, Financial analyst, Construction management, Project ' +
      'management, Business operations',
      'The roles you want. Comma-separated. Related roles where your ' +
      'experience transfers still score, just lower.'],
    ['weight_industry_fit', 30, 'How much industry and function fit matters. ' +
      'The five weights must add up to 100.'],
    ['weight_experience', 25, 'How much your experience and transferable ' +
      'skills matter.'],
    ['weight_compensation', 15, 'How much the stated pay matters.'],
    ['weight_location', 10, 'How much the location matters.'],
    ['weight_interview_odds', 20, 'How much your likelihood of getting an ' +
      'interview matters.'],
    ['report_threshold', 75, 'Below this, a job is recorded but not shown in ' +
      'the report.'],
    ['apply_threshold', 85, 'At or above this, Draft applications will write ' +
      'a cover letter for it. Must be at or above report_threshold.'],
    ['max_posting_age_hours', 72, 'Skip postings older than this. Postings ' +
      'whose age the source does not state are always kept and shown as ' +
      'UNKNOWN — never guessed.'],
    ['email_report', 'yes', 'Email the daily digest. It is sent even on ' +
      'zero-match days, which is how you know the whole thing is still ' +
      'running.'],
    ['notes', 'SAMPLE: prefer remote-first employers; not interested in ' +
      'roles requiring more than 25% travel.',
      'Anything that does not fit a field above. Passed to the scorer word ' +
      'for word, so write it as you would say it.']
  ];
}

/**
 * The Sources tab as it ships.
 *
 * Twenty employers across real estate, proptech, construction technology and
 * fintech, as a worked example of each type. **Every slug here was live when it
 * was written (checked 2026-09-11)** — the first version of this file guessed at
 * board names and seventeen of eighteen were wrong, which is a sample tab that
 * teaches a new deployer nothing except that the tool appears broken.
 *
 * They will go stale anyway: companies change ATS, and a board name changes with
 * it. That is the designed behaviour rather than a failure — a dead row writes
 * an _Errors row saying what to do and the rest of the run is unaffected — and
 * "Check sources" on the menu is how to find out which are still live before a
 * first real morning. Replace them with employers you would actually work for;
 * that is the point of the tab.
 *
 * The aggregator row ships disabled and with no key. It is the one source that
 * searches across employers rather than within one, and it is optional: a
 * deployer who never sets an Adzuna key gets a complete report from the ATS
 * boards alone.
 */
function sampleSources_() {
  var sample = [
    ['ats_greenhouse', 'carta', 'SAMPLE: Carta'],
    ['ats_greenhouse', 'roofstock', 'SAMPLE: Roofstock'],
    ['ats_greenhouse', 'orchard', 'SAMPLE: Orchard'],
    ['ats_greenhouse', 'betterment', 'SAMPLE: Betterment'],
    ['ats_greenhouse', 'dealpath', 'SAMPLE: Dealpath'],
    ['ats_greenhouse', 'homelight', 'SAMPLE: HomeLight'],
    ['ats_greenhouse', 'vts', 'SAMPLE: VTS'],
    ['ats_greenhouse', 'crexi', 'SAMPLE: Crexi'],
    ['ats_greenhouse', 'blend', 'SAMPLE: Blend'],
    ['ats_greenhouse', 'figure', 'SAMPLE: Figure'],
    ['ats_greenhouse', 'northspyre', 'SAMPLE: Northspyre'],
    ['ats_greenhouse', 'pacaso', 'SAMPLE: Pacaso'],
    ['ats_greenhouse', 'doma', 'SAMPLE: Doma'],
    ['ats_greenhouse', 'homeward', 'SAMPLE: Homeward'],
    ['ats_lever', 'wealthfront', 'SAMPLE: Wealthfront'],
    ['ats_lever', 'entrata', 'SAMPLE: Entrata'],
    ['ats_lever', 'fundrise', 'SAMPLE: Fundrise'],
    ['ats_lever', 'cherre', 'SAMPLE: Cherre'],
    ['ats_ashby', 'junipersquare', 'SAMPLE: Juniper Square'],
    ['ats_ashby', 'tomo', 'SAMPLE: Tomo']
  ];

  var rows = sample.map(function (row) {
    return [row[0], row[1], row[2], 'yes'];
  });

  rows.push(['aggregator', 'real estate analyst@Los Angeles',
             'SAMPLE (optional): Adzuna keyword search — "terms@location"', 'no']);
  return rows;
}

/**
 * The Answers tab as it ships: every recurring question, every answer blank.
 *
 * Blank is not an oversight, it is the state that means UNESTABLISHED. Nothing
 * in this codebase writes an answer here — not the resume parser, not the
 * model, not a default. A blank row stops an application and asks, which is the
 * behaviour the whole design exists to guarantee.
 */
function blankAnswers_() {
  return ANSWER_KEYS.map(function (spec) {
    return [spec.key, spec.question, '', ''];
  });
}

// ---------------------------------------------------------------------- menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job scout')
    .addItem('Find jobs now', 'findJobsNow')
    .addItem('Collect scores now', 'collectNow')
    .addSeparator()
    .addItem('Draft applications (85+)', 'menuDraftApplications')
    .addSeparator()
    .addItem('Check sources', 'menuCheckSources')
    .addItem('Re-read the resume', 'menuReReadResume')
    .addItem('Run setup again', 'setup')
    .addToUi();
}

function menuDraftApplications() {
  var result = runApply();
  toast_(result.drafted + ' drafted: ' + result.ready + ' ready to send, ' +
         result.needInput + ' need answers from you, ' + result.blocked +
         ' blocked.' +
         (result.asked ? ' ' + result.asked + ' new question(s) in Answers.' : ''));
}

/**
 * Menu: which sources actually answer?
 *
 * Worth its own entry because a wrong board slug is the single most likely
 * thing to be wrong on a freshly filled-in Sheet, and finding out at 6am
 * tomorrow through an empty report is a bad way to learn it.
 */
function menuCheckSources() {
  var sources = readSources_();
  var lines = [];

  for (var i = 0; i < sources.length; i++) {
    try {
      var jobs = fetchSource_(sources[i]);
      lines.push('OK    ' + sources[i].label + ' — ' + jobs.length + ' job(s)');
    } catch (err) {
      lines.push('FAIL  ' + sources[i].label + ' — ' + String(err.message || err));
    }
  }
  if (!lines.length) lines.push('No enabled sources on the Sources tab.');

  var report = lines.join('\n');
  Logger.log(report);
  try {
    SpreadsheetApp.getUi().alert('Source check', report,
                                 SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* no UI when run from the editor */ }
  return report;
}

/**
 * Menu: re-read the resume after changing it.
 *
 * Deliberately manual. An automatic re-parse would quietly change the basis of
 * every future score, and scores from before and after would not be comparable
 * without anyone having decided to make them so.
 */
function menuReReadResume() {
  var profile = readProfile_();
  var facts = parseResume_(profile);
  writeFacts_(facts);
  toast_('Resume re-read. Future scores use the new facts; existing scores are ' +
         'unchanged.');
}

function toast_(message) {
  SpreadsheetApp.getActive().toast(message, 'Job scout', 8);
}
