/**
 * DawnQueue — send worker (Step 6).
 *
 * Time-driven (every 5 minutes): lock, send due scheduled entries, enforce caps.
 */

var DAWN_QUEUE_MAIL_SEND_COMPONENT = 'mail_send';

/**
 * @returns {Object}
 */
function runMailSend() {
  var startedAtMs = Date.now();
  var lock = acquireQueueLock();

  if (!lock) {
    logDawnQueueWarn(
      DAWN_QUEUE_MAIL_SEND_COMPONENT,
      'LOCK_UNAVAILABLE',
      'Send worker skipped because the script lock could not be acquired.',
      { startedAtMs: startedAtMs }
    );
    return null;
  }

  try {
    var retrySummary = promoteReadyRetryEntries(startedAtMs);
    var sendSummary = runMailSendCore(startedAtMs);
    return { retryPromotion: retrySummary, send: sendSummary };
  } finally {
    releaseQueueLock(lock);
  }
}

/**
 * @param {number} startedAtMs
 * @returns {Object}
 */
function runMailSendCore(startedAtMs) {
  var summary = {
    attempted: 0,
    sent: 0,
    failed: 0,
    retried: 0,
    terminalFailures: 0,
    skippedNotDue: 0,
    skippedDailyCap: 0,
    skippedPerRunCap: 0,
    timedOut: false,
  };

  try {
    logDawnQueueInfo(
      DAWN_QUEUE_MAIL_SEND_COMPONENT,
      'SEND_WORKER_START',
      'Mail send worker run started.',
      {
        startedAtMs: startedAtMs,
        dailySendCount: getDailySendCount_(),
        dailyCap: DAWN_QUEUE_LIMITS.MAX_SENDS_PER_DAY,
        perRunCap: DAWN_QUEUE_LIMITS.MAX_SENDS_PER_RUN,
      }
    );

    var dueEntries = selectDueScheduledEntries_(readAllQueueEntries());
    var remainingDaily = getRemainingDailySendCapacity_();

    if (remainingDaily <= 0) {
      summary.skippedDailyCap = dueEntries.length;
      logDawnQueueWarn(
        DAWN_QUEUE_MAIL_SEND_COMPONENT,
        'DAILY_CAP_REACHED',
        'Daily send cap reached; skipping all due entries.',
        { dailyCap: DAWN_QUEUE_LIMITS.MAX_SENDS_PER_DAY }
      );
      return summary;
    }

    var perRunLimit = Math.min(
      DAWN_QUEUE_LIMITS.MAX_SENDS_PER_RUN,
      remainingDaily
    );

    for (var i = 0; i < dueEntries.length; i++) {
      if (hasExecutionCutoffElapsed(startedAtMs)) {
        summary.timedOut = true;
        logDawnQueueWarn(
          DAWN_QUEUE_MAIL_SEND_COMPONENT,
          'SEND_WORKER_TIMEOUT',
          'Send worker cutoff reached; exiting for next trigger.',
          {
            elapsedMs: getEnqueueElapsedMs(startedAtMs),
            sent: summary.sent,
            attempted: summary.attempted,
          }
        );
        break;
      }

      if (summary.sent >= perRunLimit) {
        summary.skippedPerRunCap = dueEntries.length - i;
        break;
      }

      if (getRemainingDailySendCapacity_() <= 0) {
        summary.skippedDailyCap = dueEntries.length - i;
        break;
      }

      var entry = dueEntries[i];
      summary.attempted++;

      try {
        processDueQueueEntry_(entry);
        incrementDailySendCount_();
        summary.sent++;
      } catch (error) {
        summary.failed++;
        var retryResult = handleQueueEntrySendFailure(entry, error);
        if (retryResult && retryResult.terminal) {
          summary.terminalFailures++;
        } else {
          summary.retried++;
        }
      }
    }

    logDawnQueueInfo(
      DAWN_QUEUE_MAIL_SEND_COMPONENT,
      'SEND_WORKER_COMPLETE',
      'Mail send worker run finished.',
      summary
    );

    return summary;
  } catch (error) {
    logDawnQueueError(
      DAWN_QUEUE_MAIL_SEND_COMPONENT,
      'SEND_CORE_FAILED',
      'Send worker core execution failed.',
      { error: String(error), elapsedMs: getEnqueueElapsedMs(startedAtMs) }
    );
    throw error;
  }
}

/**
 * @param {Object[]} allEntries
 * @returns {Object[]}
 */
function selectDueScheduledEntries_(allEntries) {
  var now = new Date();
  var slackMs = DAWN_QUEUE_TIMING.SCHEDULER_DUE_SLACK_MS;

  return allEntries
    .filter(function (entry) {
      return String(entry.status) === DAWN_QUEUE_POLICIES.QUEUE_STATUS.SCHEDULED;
    })
    .filter(function (entry) {
      if (!entry.scheduledSendAt) {
        return false;
      }
      return entry.scheduledSendAt.getTime() <= now.getTime() + slackMs;
    })
    .sort(function (left, right) {
      return left.scheduledSendAt.getTime() - right.scheduledSendAt.getTime();
    });
}

/**
 * @param {Object} entry
 */
function processDueQueueEntry_(entry) {
  if (isQueueEntryBlockedFromSend_(entry)) {
    throw new Error('Queue entry is blocked from send by duplicate-prevention policy.');
  }

  updateQueueEntryAndFlush(entry, {
    status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.SENDING,
  });

  logDawnQueueInfo(
    DAWN_QUEUE_MAIL_SEND_COMPONENT,
    'SEND_IN_FLIGHT',
    'Queue entry marked sending and flushed to sheet.',
    { queueEntryId: entry.queueEntryId, draftId: entry.draftId }
  );

  var payload = loadFrozenSnapshotPayload_(entry);
  transmitQueueEntryEmail_(entry, payload);

  applySentByDawnQueueLabel_(entry.threadId);
  cleanupOriginatingDraft_(entry.draftId);

  updateQueueEntry(entry, {
    status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.SENT,
    lastError: '',
  });

  logDawnQueueInfo(
    DAWN_QUEUE_MAIL_SEND_COMPONENT,
    'SEND_SUCCESS',
    'Queue entry sent successfully.',
    {
      queueEntryId: entry.queueEntryId,
      draftId: entry.draftId,
      threadId: entry.threadId,
    }
  );
}

/**
 * @param {Object} entry
 * @returns {boolean}
 */
function isQueueEntryBlockedFromSend_(entry) {
  var blockedStatuses = DAWN_QUEUE_POLICIES.BLOCK_RESEND_IF_STATUS_IN;
  for (var i = 0; i < blockedStatuses.length; i++) {
    if (String(entry.status) === blockedStatuses[i]) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Object} entry
 * @returns {Object}
 */
function loadFrozenSnapshotPayload_(entry) {
  var htmlBody = '';
  if (entry.htmlBodyDriveFileId) {
    htmlBody = DriveApp.getFileById(String(entry.htmlBodyDriveFileId)).getBlob().getDataAsString();
  }

  return {
    to: String(entry.toRecipients || ''),
    cc: String(entry.ccRecipients || ''),
    bcc: String(entry.bccRecipients || ''),
    subject: String(entry.subject || ''),
    plainBody: String(entry.plainBody || ''),
    htmlBody: htmlBody,
    attachments: loadAttachmentBlobsFromManifest_(entry.attachmentManifestJson),
  };
}

/**
 * @param {string} manifestJson
 * @returns {GoogleAppsScript.Base.Blob[]}
 */
function loadAttachmentBlobsFromManifest_(manifestJson) {
  if (!manifestJson) {
    return [];
  }

  var manifest = JSON.parse(String(manifestJson));
  var blobs = [];

  for (var i = 0; i < manifest.length; i++) {
    var item = manifest[i];
    if (!item.driveFileId) {
      continue;
    }
    blobs.push(DriveApp.getFileById(String(item.driveFileId)).getBlob());
  }

  return blobs;
}

/**
 * @param {Object} entry
 * @param {Object} payload
 */
function transmitQueueEntryEmail_(entry, payload) {
  var sendToken = String(entry.sendToken || '');
  var htmlBody = buildHtmlBodyWithSendToken_(payload.htmlBody, sendToken);
  var plainBody = buildPlainBodyWithSendToken_(payload.plainBody, sendToken);

  GmailApp.sendEmail(payload.to, payload.subject, plainBody, {
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    htmlBody: htmlBody,
    attachments: payload.attachments,
    name: 'DawnQueue',
  });
}

/**
 * GmailApp.sendEmail cannot set arbitrary MIME headers; embed the send token in
 * the HTML part (and plain-text prefix) for downstream idempotency correlation.
 *
 * @param {string} htmlBody
 * @param {string} sendToken
 * @returns {string}
 */
function buildHtmlBodyWithSendToken_(htmlBody, sendToken) {
  var headerName = DAWN_QUEUE_POLICIES.IDEMPOTENT_SEND_TOKEN_HEADER;
  var tokenComment = '<!-- ' + headerName + ': ' + sendToken + ' -->';
  if (!htmlBody) {
    return tokenComment;
  }
  return tokenComment + '\n' + htmlBody;
}

/**
 * @param {string} plainBody
 * @param {string} sendToken
 * @returns {string}
 */
function buildPlainBodyWithSendToken_(plainBody, sendToken) {
  var headerName = DAWN_QUEUE_POLICIES.IDEMPOTENT_SEND_TOKEN_HEADER;
  var prefix = headerName + ': ' + sendToken + '\n\n';
  return prefix + (plainBody || '');
}

/**
 * @param {string} threadId
 */
function applySentByDawnQueueLabel_(threadId) {
  if (!threadId) {
    return;
  }

  var label = getOrCreateGmailLabel_(DAWN_QUEUE_POLICIES.GMAIL_LABELS.SENT_BY_DAWNQUEUE);
  var thread = GmailApp.getThreadById(String(threadId));
  thread.addLabel(label);
}

/**
 * @param {string} draftId
 */
function cleanupOriginatingDraft_(draftId) {
  if (!draftId) {
    return;
  }

  try {
    GmailApp.getDraft(String(draftId)).deleteDraft();
  } catch (error) {
    logDawnQueueWarn(
      DAWN_QUEUE_MAIL_SEND_COMPONENT,
      'DRAFT_CLEANUP_SKIPPED',
      'Originating draft could not be deleted after send.',
      { draftId: draftId, error: String(error) }
    );
  }
}

/**
 * @param {string} labelName
 * @returns {GoogleAppsScript.Gmail.GmailLabel}
 */
function getOrCreateGmailLabel_(labelName) {
  var existing = GmailApp.getUserLabelByName(labelName);
  if (existing) {
    return existing;
  }
  return GmailApp.createLabel(labelName);
}

/**
 * @returns {number}
 */
function getDailySendCount_() {
  var properties = PropertiesService.getScriptProperties();
  var key = DAWN_QUEUE_PROPERTIES.DAILY_SEND_COUNT_PREFIX + getBusinessDateKeyInTimezone();
  return parseInt(properties.getProperty(key) || '0', 10);
}

/**
 * @returns {number}
 */
function getRemainingDailySendCapacity_() {
  return Math.max(0, DAWN_QUEUE_LIMITS.MAX_SENDS_PER_DAY - getDailySendCount_());
}

function incrementDailySendCount_() {
  var properties = PropertiesService.getScriptProperties();
  var key = DAWN_QUEUE_PROPERTIES.DAILY_SEND_COUNT_PREFIX + getBusinessDateKeyInTimezone();
  var nextCount = getDailySendCount_() + 1;
  properties.setProperty(key, String(nextCount));
}
