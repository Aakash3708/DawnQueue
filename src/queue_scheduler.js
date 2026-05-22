/**
 * DawnQueue — deterministic scheduler (Step 5).
 *
 * Assigns scheduledSendAt once for eligible rows; never reshuffles existing schedules.
 */

var DAWN_QUEUE_SCHEDULER_COMPONENT = 'queue_scheduler';

/**
 * Sequential trigger entrypoint.
 * @returns {Object}
 */
function runQueueScheduler() {
  var startedAtMs = Date.now();
  var lock = acquireQueueLock();

  if (!lock) {
    logDawnQueueWarn(
      DAWN_QUEUE_SCHEDULER_COMPONENT,
      'LOCK_UNAVAILABLE',
      'Scheduler skipped because the script lock could not be acquired.',
      { startedAtMs: startedAtMs }
    );
    return null;
  }

  try {
    return runQueueSchedulerCore(startedAtMs);
  } finally {
    releaseQueueLock(lock);
  }
}

/**
 * @param {number} startedAtMs
 * @returns {Object}
 */
function runQueueSchedulerCore(startedAtMs) {
  var summary = {
    scheduled: 0,
    skippedAlreadyScheduled: 0,
    skippedIneligible: 0,
    failed: 0,
    timedOut: false,
  };

  try {
    logDawnQueueInfo(
      DAWN_QUEUE_SCHEDULER_COMPONENT,
      'SCHEDULER_START',
      'Queue scheduler run started.',
      { startedAtMs: startedAtMs }
    );

    var allEntries = readAllQueueEntries();
    var scheduleAnchors = buildScheduleAnchors_(allEntries);
    var eligibleEntries = selectSchedulerEligibleEntries_(allEntries);

    for (var i = 0; i < eligibleEntries.length; i++) {
      if (hasExecutionCutoffElapsed(startedAtMs)) {
        summary.timedOut = true;
        logDawnQueueWarn(
          DAWN_QUEUE_SCHEDULER_COMPONENT,
          'SCHEDULER_TIMEOUT',
          'Scheduler cutoff reached; exiting without reshuffling existing schedules.',
          {
            elapsedMs: getEnqueueElapsedMs(startedAtMs),
            scheduled: summary.scheduled,
          }
        );
        break;
      }

      var entry = eligibleEntries[i];

      if (isQueueEntryAlreadyScheduled_(entry)) {
        summary.skippedAlreadyScheduled++;
        continue;
      }

      try {
        var scheduledSendAt = calculateScheduledSendAt_(entry, scheduleAnchors);
        updateQueueEntry(entry, {
          status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.SCHEDULED,
          scheduledSendAt: scheduledSendAt,
        });

        registerScheduleAnchor_(scheduleAnchors, entry, scheduledSendAt);
        summary.scheduled++;

        logDawnQueueInfo(
          DAWN_QUEUE_SCHEDULER_COMPONENT,
          'ENTRY_SCHEDULED',
          'Queue entry assigned scheduledSendAt.',
          {
            queueEntryId: entry.queueEntryId,
            draftId: entry.draftId,
            scheduledSendAt: formatDateInTimezone(scheduledSendAt),
          }
        );
      } catch (error) {
        summary.failed++;
        updateQueueEntry(entry, {
          lastError: truncateLogText_(String(error), DAWN_QUEUE_LIMITS.MAX_ERROR_MESSAGE_LENGTH),
        });
        logDawnQueueError(
          DAWN_QUEUE_SCHEDULER_COMPONENT,
          'SCHEDULE_FAILED',
          'Failed to schedule queue entry.',
          {
            queueEntryId: entry.queueEntryId,
            draftId: entry.draftId,
            error: String(error),
          }
        );
      }
    }

    logDawnQueueInfo(
      DAWN_QUEUE_SCHEDULER_COMPONENT,
      'SCHEDULER_COMPLETE',
      'Queue scheduler run finished.',
      summary
    );

    return summary;
  } catch (error) {
    logDawnQueueError(
      DAWN_QUEUE_SCHEDULER_COMPONENT,
      'SCHEDULER_CORE_FAILED',
      'Scheduler core execution failed.',
      { error: String(error), elapsedMs: getEnqueueElapsedMs(startedAtMs) }
    );
    throw error;
  }
}

/**
 * @param {Object[]} allEntries
 * @returns {Object}
 */
function buildScheduleAnchors_(allEntries) {
  var anchors = {
    globalLatest: null,
    byRecipientKey: {},
    byThreadId: {},
  };

  for (var i = 0; i < allEntries.length; i++) {
    var entry = allEntries[i];
    if (!entry.scheduledSendAt) {
      continue;
    }

    if (!isCommittedScheduleStatus_(entry.status)) {
      continue;
    }

    registerScheduleAnchor_(anchors, entry, entry.scheduledSendAt);
  }

  return anchors;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isCommittedScheduleStatus_(status) {
  var normalized = String(status);
  return (
    normalized === DAWN_QUEUE_POLICIES.QUEUE_STATUS.SCHEDULED ||
    normalized === DAWN_QUEUE_POLICIES.QUEUE_STATUS.SENDING ||
    normalized === DAWN_QUEUE_POLICIES.QUEUE_STATUS.SENT ||
    normalized === 'SCHEDULED' ||
    normalized === 'SENDING' ||
    normalized === 'SENT'
  );
}

/**
 * @param {Object} entry
 * @returns {boolean}
 */
function isQueueEntryAlreadyScheduled_(entry) {
  return (
    String(entry.status) === DAWN_QUEUE_POLICIES.QUEUE_STATUS.SCHEDULED &&
    entry.scheduledSendAt instanceof Date &&
    !isNaN(entry.scheduledSendAt.getTime())
  );
}

/**
 * @param {Object[]} allEntries
 * @returns {Object[]}
 */
function selectSchedulerEligibleEntries_(allEntries) {
  var eligibleStatuses = DAWN_QUEUE_POLICIES.SCHEDULER_ELIGIBLE_STATUSES;

  return allEntries
    .filter(function (entry) {
      if (isQueueEntryAlreadyScheduled_(entry)) {
        return false;
      }
      for (var i = 0; i < eligibleStatuses.length; i++) {
        if (String(entry.status) === eligibleStatuses[i]) {
          return true;
        }
      }
      return false;
    })
    .sort(compareSchedulerEntries_);
}

/**
 * @param {Object} left
 * @param {Object} right
 * @returns {number}
 */
function compareSchedulerEntries_(left, right) {
  var leftCaptured = left.capturedAt ? left.capturedAt.getTime() : 0;
  var rightCaptured = right.capturedAt ? right.capturedAt.getTime() : 0;
  if (leftCaptured !== rightCaptured) {
    return leftCaptured - rightCaptured;
  }
  return String(left.queueEntryId).localeCompare(String(right.queueEntryId));
}

/**
 * @param {Object} entry
 * @param {Object} anchors
 * @returns {Date}
 */
function calculateScheduledSendAt_(entry, anchors) {
  var now = new Date();
  var candidate = new Date(now.getTime());

  if (anchors.globalLatest) {
    candidate = maxDate(
      candidate,
      addMinutesToDate(
        anchors.globalLatest,
        DAWN_QUEUE_TIMING.DIFFERENT_TARGET_SEND_GAP_MINUTES
      )
    );
  }

  var recipientKey = buildRecipientKey_(entry);
  var threadId = String(entry.threadId || '');
  var hasSameRecipient = Boolean(
    recipientKey && anchors.byRecipientKey[recipientKey]
  );
  var hasSameThread = Boolean(threadId && anchors.byThreadId[threadId]);

  if (hasSameRecipient || hasSameThread) {
    if (hasSameRecipient) {
      candidate = maxDate(
        candidate,
        addMinutesToDate(
          anchors.byRecipientKey[recipientKey],
          DAWN_QUEUE_TIMING.SAME_RECIPIENT_OR_THREAD_GAP_MINUTES
        )
      );
    }
    if (hasSameThread) {
      candidate = maxDate(
        candidate,
        addMinutesToDate(
          anchors.byThreadId[threadId],
          DAWN_QUEUE_TIMING.SAME_RECIPIENT_OR_THREAD_GAP_MINUTES
        )
      );
    }
  }

  candidate = alignToBusinessHoursWindow(candidate);

  var jitterMs = calculateScheduleJitterMs();
  candidate = applyJitterToDate(candidate, jitterMs);
  candidate = alignToBusinessHoursWindow(candidate);

  return candidate;
}

/**
 * @param {Object} anchors
 * @param {Object} entry
 * @param {Date} scheduledSendAt
 */
function registerScheduleAnchor_(anchors, entry, scheduledSendAt) {
  anchors.globalLatest = maxDate(anchors.globalLatest, scheduledSendAt);

  var recipientKey = buildRecipientKey_(entry);
  if (recipientKey) {
    anchors.byRecipientKey[recipientKey] = maxDate(
      anchors.byRecipientKey[recipientKey],
      scheduledSendAt
    );
  }

  var threadId = String(entry.threadId || '');
  if (threadId) {
    anchors.byThreadId[threadId] = maxDate(anchors.byThreadId[threadId], scheduledSendAt);
  }
}

/**
 * @param {Object} entry
 * @returns {string}
 */
function buildRecipientKey_(entry) {
  return normalizeRecipientKey_(
    entry.toRecipients,
    entry.ccRecipients,
    entry.bccRecipients
  );
}

/**
 * @param {string} toRecipients
 * @param {string} ccRecipients
 * @param {string} bccRecipients
 * @returns {string}
 */
function normalizeRecipientKey_(toRecipients, ccRecipients, bccRecipients) {
  var combined = [toRecipients, ccRecipients, bccRecipients].join(',');
  var matches = combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  var normalized = [];

  for (var i = 0; i < matches.length; i++) {
    normalized.push(String(matches[i]).toLowerCase());
  }

  normalized.sort();
  return normalized.join('|');
}
