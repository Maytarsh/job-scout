/**
 * Main.gs — the entry points and the shape of a morning.
 *
 * Two triggers, because Apps Script kills an execution at six minutes and
 * fetching every source, then waiting for a scoring pass, does not fit in one.
 *
 *   runDiscovery   daily    finds jobs, records them, submits a batch
 *   collectScores  hourly   picks up a finished batch, scores rows, reports
 *
 * They communicate through the Sheet and three script properties, never through
 * memory: the execution that submits a batch is over long before the one that
 * reads it starts, and neither can hand the other anything.
 *
 * The queue is "rows with no score", not "jobs found today". That one choice is
 * what makes the whole thing self-healing: a source that was down, a batch that
 * expired, a run that hit the six-minute cap — all of them leave rows unscored,
 * and unscored rows are exactly what the next submission picks up.
 */

var PROP_BATCH_ID = 'BATCH_ID';
var PROP_BATCH_AT = 'BATCH_SUBMITTED_AT';

// ------------------------------------------------------------------ discovery

/**
 * Find today's jobs. The daily trigger.
 *
 * Every new posting gets a row, including the ones that will score badly:
 * appending is free, and a row that does not exist cannot dedupe. What is
 * capped is how many get scored at once, not how many are recorded.
 */
function runDiscovery() {
  var book, profile;

  try {
    profile = readProfile_();
    book = openBook_();
    resumeFacts_(profile);
  } catch (err) {
    // Configuration and resume failures happen before there is a book to log
    // into, and they are the ones a deployer most needs told about, because
    // the symptom is an empty report that looks like a quiet morning.
    logError_(null, 'runDiscovery', String(err.message || err),
              'Fix the Profile tab and run Job scout -> Find jobs now.');
    sendFailure_('discovery', err, 'the Profile tab');
    throw err;
  }

  try {
    var found = fetchAllSources_(book, profile);
    var newJobs = 0;
    var skippedStale = 0;
    var skippedElsewhere = 0;
    var now = new Date();

    for (var i = 0; i < found.jobs.length; i++) {
      var job = found.jobs[i];
      if (!job.company || !job.title) continue;

      job.ageHours = postingAgeHours_(job.posted, now);
      if (!isFreshEnough_(job.ageHours, profile.max_posting_age_hours)) {
        skippedStale++;
        continue;
      }
      if (!wantsLocation_(job.location, profile)) {
        skippedElsewhere++;
        continue;
      }
      if (upsertJob_(book, job)) newJobs++;
    }

    logRun_(book, {
      step: 'discovery',
      sourcesOk: found.ok,
      sourcesFailed: found.failed,
      jobsSeen: found.jobs.length,
      newJobs: newJobs,
      note: skippedStale + ' too old, ' + skippedElsewhere +
            ' outside your locations'
    });

    var submitted = submitPending_(book, profile);
    flushBook_(book);

    // A run with nothing to submit ends here, and it is the run that most needs
    // to say so: no batch means collectScores has nothing to pick up, so the
    // digest it would otherwise send never happens. That is precisely the case
    // the heartbeat exists for — a quiet morning and a broken trigger produce
    // the same empty inbox unless this fires.
    if (!submitted) {
      var quiet = rebuildReport_(book, profile);
      deliverDigest_(book, profile, quiet,
                     'Nothing new to score this morning: ' + found.ok +
                     ' source(s) answered, ' + found.failed + ' failed.');
    }
    return { newJobs: newJobs, submitted: submitted };

  } catch (err) {
    try { flushBook_(book); } catch (flushErr) { Logger.log('flush failed: ' + flushErr); }
    sendFailure_('discovery', err, '', profile);
    throw err;
  }
}

// ----------------------------------------------------------------- submission

/**
 * Submit the next chunk of the unscored queue. Returns the number submitted.
 *
 * Shared by both triggers, so a backlog drains at the hourly poll rather than
 * one chunk per day.
 *
 * The cap was added on the belief that most ATS boards state no posting date,
 * so the first run of a fresh Sheet would score every open role at every
 * company. Measured, that turned out false: Greenhouse, Lever and Ashby all
 * date every posting, so the freshness filter removes most of them before
 * anything is sent. The cap stays because the cases it does cover are real —
 * careers_url rows genuinely have no date, an aggregator row can return fifty
 * at once, and a widened max_posting_age_hours backfills months — and because
 * a bound on what one run can spend is worth having whether or not today is
 * the day it binds.
 */
function submitPending_(book, profile) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_BATCH_ID)) return 0;

  var rows = unscoredJobs_(book, CONFIG.MAX_NEW_JOBS_PER_RUN);
  if (!rows.length) return 0;

  var facts = readKeyValues_(TABS.FACTS, 1);
  var system = scoreSystemPrompt_(profile, facts);
  var requests = [];
  var estimated = estimateTokens_(system) * rows.length;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var job = {
      company: row[J_COMPANY],
      title: row[J_POSITION],
      location: row[J_LOCATION],
      salary: row[J_SALARY],
      ageHours: row[J_AGE],
      description: row[J_NOTES]
    };
    estimated += estimateTokens_(job.description);
    requests.push({
      custom_id: jobCustomId_(String(row[J_KEY])),
      params: scoreRequestParams_(job, system)
    });
  }

  var batchId = submitBatch_(requests);
  props.setProperty(PROP_BATCH_ID, batchId);
  props.setProperty(PROP_BATCH_AT, String(Date.now()));

  logRun_(book, {
    step: 'submit',
    submitted: requests.length,
    batchId: batchId,
    estInputTokens: estimated,
    note: 'queue had ' + (unscoredJobs_(book, 100000).length) + ' unscored row(s)'
  });
  return requests.length;
}

// ------------------------------------------------------------------ collection

/**
 * Pick up a finished batch. The hourly trigger; a no-op when nothing is pending.
 *
 * A batch that is not ready is left alone for the next poll — not waited on,
 * not cancelled, not treated as a failure. That is the whole reason this is a
 * second trigger and not a loop.
 */
function collectScores() {
  var props = PropertiesService.getScriptProperties();
  var batchId = props.getProperty(PROP_BATCH_ID);
  if (!batchId) return { skipped: 'nothing pending' };

  var profile, book;
  try {
    profile = readProfile_();
    book = openBook_();
  } catch (err) {
    logError_(null, 'collectScores', String(err.message || err),
              'Fix the Profile tab. The batch is still waiting and will be ' +
              'collected on the next run.');
    sendFailure_('scoring', err, 'the Profile tab');
    throw err;
  }

  try {
    var envelope = pollBatch_(batchId);

    if (envelope.processing_status !== 'ended') {
      if (batchIsStale_(props)) {
        abandonBatch_(book, batchId, envelope.processing_status);
        flushBook_(book);
        return { abandoned: batchId };
      }
      Logger.log('batch ' + batchId + ' is ' + envelope.processing_status +
                 '; leaving it for the next poll');
      return { pending: batchId };
    }

    var results = batchResults_(envelope.results_url);
    var outcome = applyScores_(book, profile, results);

    props.deleteProperty(PROP_BATCH_ID);
    props.deleteProperty(PROP_BATCH_AT);

    var matches = rebuildReport_(book, profile);
    logRun_(book, {
      step: 'collect',
      scored: outcome.scored,
      batchId: batchId,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.cost,
      note: outcome.failed + ' row(s) could not be scored'
    });

    // Submitted before the digest goes out, so the note can say what is still
    // queued rather than leaving a backlog invisible until tomorrow.
    var nextChunk = submitPending_(book, profile);
    flushBook_(book);

    deliverDigest_(book, profile, matches, digestSummary_(outcome, nextChunk));
    return { scored: outcome.scored, matches: matches.length };

  } catch (err) {
    try { flushBook_(book); } catch (flushErr) { Logger.log('flush failed: ' + flushErr); }
    sendFailure_('scoring', err, 'batch ' + batchId, profile);
    throw err;
  }
}

function digestSummary_(outcome, nextChunk) {
  var parts = [outcome.scored + ' job(s) scored'];
  if (outcome.failed) parts.push(outcome.failed + ' could not be scored');
  if (nextChunk) parts.push(nextChunk + ' more submitted and scoring now');
  return parts.join('; ') + '.';
}

/**
 * Write one batch's results onto their rows.
 *
 * Keyed by custom_id throughout. Results arrive in whatever order they finished
 * — position in the file means nothing, and a result read positionally would
 * put one job's score on another job's row, which is the kind of wrong that
 * looks entirely plausible in a report.
 *
 * A row whose result never arrived keeps its empty Score, which puts it back in
 * the queue rather than leaving it silently unfinished.
 */
function applyScores_(book, profile, results) {
  var scored = 0, failed = 0, inputTokens = 0, outputTokens = 0, cost = 0;
  var before = spendToday_();
  var all = book.rows.concat(book.appended);

  for (var i = 0; i < all.length; i++) {
    var row = all[i];
    if (row[J_SCORE] !== '' && row[J_SCORE] !== null) continue;

    var key = String(row[J_KEY] || '');
    var result = results[jobCustomId_(key)];
    if (!result) continue;

    try {
      var parsed = scoreFromResult_(result);
      var dims = {};
      for (var w = 0; w < WEIGHTS.length; w++) {
        dims[WEIGHTS[w].dim] = parsed[WEIGHTS[w].dim];
      }
      var total = totalScore_(dims, profile);

      row[J_SCORE] = total;
      row[J_INDUSTRY] = dims.industry_fit;
      row[J_EXPERIENCE] = dims.experience;
      row[J_COMPENSATION] = dims.compensation;
      row[J_LOCATION_FIT] = dims.location;
      row[J_INTERVIEW] = dims.interview_odds;
      row[J_WHY] = safeCell_(parsed.why, 900);
      if (parsed.salary_text) row[J_SALARY] = safeCell_(parsed.salary_text, 120);
      if (parsed.concerns) row[J_NOTES] = safeCell_(parsed.concerns, 900);
      row[J_SCORED_AT] = new Date();

      inputTokens += (parsed.usage.input_tokens || 0);
      outputTokens += (parsed.usage.output_tokens || 0);
      scored++;
      touchJob_(book, key);

    } catch (err) {
      failed++;
      // A permanent failure is written onto the row so it stops being retried
      // forever; a transient one leaves the score empty so it is.
      if (err.permanent) {
        row[J_STATUS] = 'BLOCKED';
        row[J_NOTES] = safeCell_('could not be scored: ' + err.message, 900);
        row[J_SCORE] = 0;
        touchJob_(book, key);
      }
      logError_(book, row[J_COMPANY] + ' / ' + row[J_POSITION],
                String(err.message || err),
                err.permanent
                  ? 'This job will not be scored again. Delete its row to try once more.'
                  : 'Left unscored; the next run picks it up automatically.');
    }
  }

  cost = spendToday_() - before;
  return { scored: scored, failed: failed, inputTokens: inputTokens,
           outputTokens: outputTokens, cost: cost };
}

/**
 * Has this batch been pending longer than a batch can live?
 *
 * The API's own ceiling is 24 hours. Past that the results are never arriving,
 * and holding the pending slot would stop every future run from submitting
 * anything at all — the failure would present as scores quietly stopping while
 * discovery kept finding jobs.
 */
function batchIsStale_(props) {
  var at = Number(props.getProperty(PROP_BATCH_AT)) || 0;
  if (!at) return false;
  return (Date.now() - at) > CONFIG.BATCH_MAX_AGE_HOURS * 36e5;
}

function abandonBatch_(book, batchId, status) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_BATCH_ID);
  props.deleteProperty(PROP_BATCH_AT);

  logError_(book, 'batch ' + batchId,
            'still "' + status + '" after ' + CONFIG.BATCH_MAX_AGE_HOURS +
            ' hours, which is past the API\'s own 24-hour limit',
            'Nothing was lost: those jobs are still unscored, so the next run ' +
            'submits them again. If this repeats, check the API key and the ' +
            'account\'s credit balance.');
  logRun_(book, { step: 'collect', batchId: batchId, note: 'abandoned as stale' });
  sendFailure_('scoring', new Error('batch ' + batchId + ' expired unfinished'),
               'the batch has been abandoned and its jobs requeued');
}

/**
 * Send the digest, and do not let a mail problem fail a run that worked.
 *
 * The jobs are found, the scores are written and the book is flushed by the
 * time this is called. An unsendable digest is worth a loud row in _Errors —
 * it is the heartbeat, and a heartbeat nobody receives is the failure this
 * design is most afraid of — but it is not worth throwing away a successful
 * run's exit status and telling the deployer that scoring broke when it did
 * not.
 */
function deliverDigest_(book, profile, matches, summary) {
  try {
    sendDigest_(profile, matches, summary);
  } catch (mailErr) {
    logError_(null, 'digest', String(mailErr.message || mailErr),
              'The jobs were found and scored — only the email failed. Add a ' +
              '"report_email" row to the Profile tab with your address.');
  }
}

// ---------------------------------------------------------------- menu entries

/** Menu: run discovery now rather than waiting for tomorrow morning. */
function findJobsNow() {
  var result = runDiscovery();
  toast_(result.newJobs + ' new job(s) found, ' + result.submitted + ' submitted.');
}

/** Menu: poll now rather than waiting for the hour. */
function collectNow() {
  var result = collectScores();
  toast_(result.skipped ? 'Nothing pending.'
    : result.pending ? 'The batch is not finished yet.'
    : (result.scored || 0) + ' job(s) scored.');
}
