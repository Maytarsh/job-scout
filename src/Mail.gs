/**
 * Mail.gs — the morning digest, and the mail that says the morning failed.
 *
 * The Report tab is the source of truth; this is a view of it. The mail exists
 * because a tab nobody opens is a tab that can stop being written to without
 * anyone noticing, and this thing is supposed to run unattended for months.
 *
 * A digest goes out on every run, including runs that found nothing. Silence
 * cannot distinguish "no jobs matched today" from "the trigger stopped firing
 * three weeks ago", and of the two, only one of them looks exactly like
 * everything being fine.
 */

/** Who the mail goes to: whoever owns the Sheet and authorised the script. */
function reportRecipient_() {
  var email = Session.getActiveUser().getEmail();
  if (!email) {
    // Time-driven triggers run as the person who installed them, so this is
    // effectively unreachable in production. It is reachable in a shared
    // Sheet opened by someone else, where sending anywhere would be wrong.
    throw new Error('cannot determine the Sheet owner\'s email address');
  }
  return email;
}

function sheetUrl_() {
  return SpreadsheetApp.getActive().getUrl();
}

/**
 * The daily digest. matches is what rebuildReport_ returned.
 *
 * The count is in the subject because that is the part read from a phone
 * without opening anything, and "0 new matches" arriving on schedule is the
 * signal that the whole pipeline is alive.
 */
function sendDigest_(profile, matches, summary) {
  if (!profile.email_report) return false;

  var count = matches.length;
  var subject = 'job-scout: ' + count + ' new match' + (count === 1 ? '' : 'es');
  var lines = [];

  if (count) {
    for (var i = 0; i < matches.length; i++) {
      var row = matches[i];
      lines.push(
        row[0] + '  ' + row[1] + ' — ' + row[2],
        '    ' + (row[3] || 'location not stated') +
        '   ' + (row[4] || 'no salary stated') +
        '   posted ' + row[6] +
        '   via ' + row[5],
        '    ' + row[7],
        '    ' + row[9] + '   ' + row[8],
        '');
    }
  } else {
    lines.push(
      'Nothing scored above the report threshold this morning.',
      '',
      'This mail is also the heartbeat: it arriving at all means the triggers',
      'ran, the sources answered and the scoring pass completed.',
      '');
  }

  if (summary) lines.push(summary, '');
  lines.push('Full rows, including everything below the threshold: ' + sheetUrl_());

  MailApp.sendEmail(reportRecipient_(), subject, lines.join('\n'));
  Logger.log('sent the digest: ' + count + ' match(es)');
  return true;
}

/**
 * The mail that says a run did not finish.
 *
 * Sent regardless of the email_report setting. Someone who turned the digest
 * off turned off a convenience; they did not ask to stop being told that the
 * thing is broken.
 */
function sendFailure_(step, err, where) {
  var subject = 'job-scout: ' + step + ' failed';
  var lines = [
    'The ' + step + ' step stopped with an error.',
    '',
    String(err && err.message || err),
    ''
  ];
  if (where) lines.push('Where: ' + where, '');
  lines.push(
    'Nothing was lost — jobs already found keep their rows, and unscored rows',
    'are picked up by the next run once this is fixed.',
    '',
    'The _Errors tab has the detail: ' + sheetUrl_());

  try {
    MailApp.sendEmail(reportRecipient_(), subject, lines.join('\n'));
  } catch (mailErr) {
    // A failure to report a failure is where this would go quiet, so it at
    // least reaches the execution log.
    Logger.log('could not send the failure mail: ' + mailErr);
  }
}
