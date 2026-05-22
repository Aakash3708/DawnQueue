/**
 * DawnQueue — exponential backoff retry engine (Step 7).
 */

var DAWN_QUEUE_MAIL_RETRY_COMPONENT = 'mail_retry';

/**
 * Handles a send-worker failure: transient errors backoff and retry;
 * terminal failures mark the row failed and label the Gmail thread.
 *
 * @param {Object} entry
 * @param {Error|string} error
 * @returns {Object}
 */
function handleQueueEntrySendFailure(entry, error) {
  var errorMessage = truncateLogText_(
    String(error),
    DAWN_QUEUE_LIMITS.MAX_ERROR_MESSAGE_LENGTH
  );

  if (!isTransientSendFailure_(error)) {
    return markTerminalSendFailure_(entry, errorMessage, 'NON_TRANSIENT');
  }

  var nextRetryCount = (parseInt(entry.retryCount, 10) || 0) + 1;

  if (nextRetryCount <= DAWN_QUEUE_LIMITS.MAX_RETRY_ATTEMPTS) {
    return scheduleRetryForQueueEntry_(entry, nextRetryCount, errorMessage);
  }

  return markTerminalSendFailure_(entry, errorMessage, 'MAX_RETRIES_EXCEEDED');
}

/**
 * Promotes retry rows whose backoff window has elapsed back to scheduled.
 *
 * @param {number} startedAtMs
 * @returns {Object}
 */
function promoteReadyRetryEntries(startedAtMs) {
  var summary = { promoted: 0, timedOut: false };
  var now = new Date();
  var entries = readAllQueueEntries();

  for (var i = 0; i < entries.length; i++) {
    if (hasExecutionCutoffElapsed(startedAtMs)) {
      summary.timedOut = true;
      logDawnQueueWarn(
        DAWN_QUEUE_MAIL_RETRY_COMPONENT,
        'RETRY_PROMOTION_TIMEOUT',
        'Retry promotion stopped due to execution cutoff.',
        { promoted: summary.promoted }
      );
      break;
    }

    var entry = entries[i];
    if (String(entry.status) !== DAWN_QUEUE_POLICIES.QUEUE_STATUS.FAILED_RETRY_PENDING) {
      continue;
    }

    if (!entry.scheduledSendAt || entry.scheduledSendAt.getTime() > now.getTime()) {
      continue;
    }

    updateQueueEntry(entry, {
      status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.SCHEDULED,
      lastError: '',
    });
    summary.promoted++;

    logDawnQueueInfo(
      DAWN_QUEUE_MAIL_RETRY_COMPONENT,
      'RETRY_PROMOTED',
      'Retry entry promoted back to scheduled.',
      {
        queueEntryId: entry.queueEntryId,
        draftId: entry.draftId,
        retryCount: entry.retryCount,
      }
    );
  }

  return summary;
}

/**
 * @param {Object} entry
 * @param {number} nextRetryCount
 * @param {string} errorMessage
 * @returns {Object}
 */
function scheduleRetryForQueueEntry_(entry, nextRetryCount, errorMessage) {
  var delayMinutes = calculateRetryBackoffMinutes_(nextRetryCount);
  var retryAt = alignToBusinessHoursWindow(addMinutesToDate(new Date(), delayMinutes));

  updateQueueEntry(entry, {
    status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.FAILED_RETRY_PENDING,
    retryCount: nextRetryCount,
    scheduledSendAt: retryAt,
    lastError: errorMessage,
  });

  logDawnQueueWarn(
    DAWN_QUEUE_MAIL_RETRY_COMPONENT,
    'RETRY_SCHEDULED',
    'Transient failure — entry queued for retry with exponential backoff.',
    {
      queueEntryId: entry.queueEntryId,
      draftId: entry.draftId,
      retryCount: nextRetryCount,
      delayMinutes: delayMinutes,
      retryAt: formatDateInTimezone(retryAt),
      maxRetryAttempts: DAWN_QUEUE_LIMITS.MAX_RETRY_ATTEMPTS,
    }
  );

  return {
    terminal: false,
    retryCount: nextRetryCount,
    scheduledSendAt: retryAt,
  };
}

/**
 * Backoff: 15 minutes × 2^(retryCount - 1)
 *
 * @param {number} retryCount
 * @returns {number}
 */
function calculateRetryBackoffMinutes_(retryCount) {
  return (
    DAWN_QUEUE_TIMING.RETRY_BASE_DELAY_MINUTES *
    Math.pow(DAWN_QUEUE_TIMING.RETRY_BACKOFF_MULTIPLIER, retryCount - 1)
  );
}

/**
 * @param {Object} entry
 * @param {string} errorMessage
 * @param {string} reason
 * @returns {Object}
 */
function markTerminalSendFailure_(entry, errorMessage, reason) {
  updateQueueEntry(entry, {
    status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.FAILED,
    lastError: errorMessage,
  });

  applyFailedSendLabel_(entry.threadId);

  logDawnQueueError(
    DAWN_QUEUE_MAIL_RETRY_COMPONENT,
    'TERMINAL_FAILURE',
    'Queue entry permanently failed; no further retries will be attempted.',
    {
      queueEntryId: entry.queueEntryId,
      draftId: entry.draftId,
      threadId: entry.threadId,
      reason: reason,
      retryCount: entry.retryCount,
      error: errorMessage,
    }
  );

  return { terminal: true, reason: reason };
}

/**
 * @param {Error|string} error
 * @returns {boolean}
 */
function isTransientSendFailure_(error) {
  if (!DAWN_QUEUE_POLICIES.RETRY_ON_TRANSIENT_ERRORS) {
    return false;
  }

  var message = String(error).toLowerCase();

  var transientSignals = [
    'rate limit',
    'quota',
    'timeout',
    'timed out',
    'lock',
    'service invoked too many times',
    'urlfetch',
    'backend error',
    'internal error',
    'temporarily unavailable',
    'try again',
    'exception: address unavailable',
    'user rate limit',
  ];

  for (var i = 0; i < transientSignals.length; i++) {
    if (message.indexOf(transientSignals[i]) !== -1) {
      return true;
    }
  }

  if (!DAWN_QUEUE_POLICIES.RETRY_ON_AUTH_ERRORS && message.indexOf('auth') !== -1) {
    return false;
  }

  if (!DAWN_QUEUE_POLICIES.RETRY_ON_VALIDATION_ERRORS) {
    var validationSignals = ['invalid', 'validation', 'required', 'missing recipient'];
    for (var j = 0; j < validationSignals.length; j++) {
      if (message.indexOf(validationSignals[j]) !== -1) {
        return false;
      }
    }
  }

  return false;
}

/**
 * @param {string} threadId
 */
function applyFailedSendLabel_(threadId) {
  if (!threadId) {
    return;
  }

  try {
    var label = getOrCreateGmailLabelForRetry_(DAWN_QUEUE_POLICIES.GMAIL_LABELS.FAILED_SEND);
    GmailApp.getThreadById(String(threadId)).addLabel(label);
  } catch (error) {
    logDawnQueueWarn(
      DAWN_QUEUE_MAIL_RETRY_COMPONENT,
      'FAILED_LABEL_SKIPPED',
      'Could not apply FAILED_SEND label to thread.',
      { threadId: threadId, error: String(error) }
    );
  }
}

/**
 * @param {string} labelName
 * @returns {GoogleAppsScript.Gmail.GmailLabel}
 */
function getOrCreateGmailLabelForRetry_(labelName) {
  var existing = GmailApp.getUserLabelByName(labelName);
  if (existing) {
    return existing;
  }
  return GmailApp.createLabel(labelName);
}
