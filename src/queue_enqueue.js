/**
 * DawnQueue — HOLD-labeled draft ingestion with resumable, time-bounded execution.
 */

var DAWN_QUEUE_ENQUEUE_COMPONENT = 'queue_enqueue';

/**
 * Time-driven entrypoint: scans HOLD drafts, snapshots immutably, appends queue rows.
 * Resumes via PropertiesService cursor; exits cleanly before the 6-minute platform limit.
 *
 * @returns {Object} run summary
 */
function runQueueEnqueue() {
  var startedAtMs = Date.now();
  var lock = acquireQueueLock();

  if (!lock) {
    logDawnQueueWarn(
      DAWN_QUEUE_ENQUEUE_COMPONENT,
      'LOCK_UNAVAILABLE',
      'Enqueue skipped because the script lock could not be acquired.',
      { startedAtMs: startedAtMs }
    );
    return null;
  }

  try {
    return runQueueEnqueueCore(startedAtMs);
  } finally {
    releaseQueueLock(lock);
  }
}

/**
 * @param {number} startedAtMs
 * @returns {Object}
 */
function runQueueEnqueueCore(startedAtMs) {
  var summary = {
    processed: 0,
    skippedDuplicate: 0,
    skippedCursor: 0,
    failed: 0,
    timedOut: false,
    resumedFromCursor: false,
  };

  try {
    var cursorDraftId = getEnqueueCursorDraftId_();
    summary.resumedFromCursor = Boolean(cursorDraftId);

    logDawnQueueInfo(
      DAWN_QUEUE_ENQUEUE_COMPONENT,
      'ENQUEUE_START',
      'HOLD draft enqueue run started.',
      {
        startedAtMs: startedAtMs,
        cursorDraftId: cursorDraftId || '',
        cutoffMs: DAWN_QUEUE_TIMING.ENQUEUE_EXECUTION_CUTOFF_MS,
      }
    );

    var drafts = discoverHoldLabelDrafts_();
    drafts = sortDraftsDeterministically_(drafts);

    for (var i = 0; i < drafts.length; i++) {
      if (hasExecutionCutoffElapsed(startedAtMs)) {
        summary.timedOut = true;
        logDawnQueueWarn(
          DAWN_QUEUE_ENQUEUE_COMPONENT,
          'ENQUEUE_TIMEOUT',
          'Execution cutoff reached; persisting cursor and exiting for next trigger.',
          {
            elapsedMs: getEnqueueElapsedMs(startedAtMs),
            cutoffMs: DAWN_QUEUE_TIMING.ENQUEUE_EXECUTION_CUTOFF_MS,
            processed: summary.processed,
            cursorDraftId: getEnqueueCursorDraftId_() || '',
          }
        );
        break;
      }

      var draft = drafts[i];
      var draftId = draft.getId();

      // Cursor is the last successfully enqueued draft; skip it and all earlier IDs.
      if (cursorDraftId && String(draftId).localeCompare(String(cursorDraftId)) <= 0) {
        summary.skippedCursor++;
        continue;
      }

      if (isDraftIdAlreadyQueued(draftId)) {
        setEnqueueCursorDraftId_(draftId);
        summary.skippedDuplicate++;
        continue;
      }

      try {
        var queueEntry = buildQueueEntryFromDraft_(draft);
        appendQueueEntry(queueEntry);
        setEnqueueCursorDraftId_(draftId);
        summary.processed++;

        logDawnQueueInfo(
          DAWN_QUEUE_ENQUEUE_COMPONENT,
          'DRAFT_ENQUEUED',
          'Draft snapshot written to queue sheet.',
          {
            queueEntryId: queueEntry.queueEntryId,
            draftId: draftId,
            elapsedMs: getEnqueueElapsedMs(startedAtMs),
          }
        );
      } catch (error) {
        summary.failed++;
        logDawnQueueError(
          DAWN_QUEUE_ENQUEUE_COMPONENT,
          'DRAFT_ENQUEUE_FAILED',
          'Failed to enqueue draft; cursor not advanced.',
          {
            draftId: draftId,
            error: truncateLogText_(String(error), DAWN_QUEUE_LIMITS.MAX_ERROR_MESSAGE_LENGTH),
            elapsedMs: getEnqueueElapsedMs(startedAtMs),
          }
        );
      }
    }

    logDawnQueueInfo(
      DAWN_QUEUE_ENQUEUE_COMPONENT,
      'ENQUEUE_COMPLETE',
      'HOLD draft enqueue run finished.',
      {
        elapsedMs: getEnqueueElapsedMs(startedAtMs),
        processed: summary.processed,
        skippedDuplicate: summary.skippedDuplicate,
        skippedCursor: summary.skippedCursor,
        failed: summary.failed,
        timedOut: summary.timedOut,
        cursorDraftId: getEnqueueCursorDraftId_() || '',
      }
    );

    return summary;
  } catch (error) {
    logDawnQueueError(
      DAWN_QUEUE_ENQUEUE_COMPONENT,
      'ENQUEUE_CORE_FAILED',
      'Enqueue core execution failed.',
      { error: String(error), elapsedMs: getEnqueueElapsedMs(startedAtMs) }
    );
    throw error;
  }
}

/**
 * @returns {GoogleAppsScript.Gmail.GmailDraft[]}
 */
function discoverHoldLabelDrafts_() {
  var query = DAWN_QUEUE_POLICIES.ENQUEUE_GMAIL_SEARCH_QUERY;
  var maxResults = DAWN_QUEUE_LIMITS.MAX_INGEST_BATCH_SIZE;
  var threads = GmailApp.search(query, 0, maxResults);
  var drafts = [];

  for (var i = 0; i < threads.length; i++) {
    try {
      var draft = GmailApp.getDraft(threads[i].getId());
      if (draft) {
        drafts.push(draft);
      }
    } catch (error) {
      logDawnQueueWarn(
        DAWN_QUEUE_ENQUEUE_COMPONENT,
        'DRAFT_RESOLVE_FAILED',
        'Could not resolve Gmail draft from search thread.',
        {
          threadId: threads[i].getId(),
          error: String(error),
        }
      );
    }
  }

  return drafts;
}

/**
 * @param {GoogleAppsScript.Gmail.GmailDraft[]} drafts
 * @returns {GoogleAppsScript.Gmail.GmailDraft[]}
 */
function sortDraftsDeterministically_(drafts) {
  return drafts.sort(function (left, right) {
    return String(left.getId()).localeCompare(String(right.getId()));
  });
}

/**
 * @param {GoogleAppsScript.Gmail.GmailDraft} draft
 * @returns {Object}
 */
function buildQueueEntryFromDraft_(draft) {
  var message = draft.getMessage();
  var snapshot = buildImmutableDraftSnapshot_(message);
  var queueEntryId = generateQueueEntryId_();
  var sendToken = generateSendToken_(queueEntryId);
  var capturedAt = new Date();

  var attachmentManifest = persistAttachmentBlobs_(
    snapshot.attachments,
    queueEntryId
  );
  var htmlBodyDriveFileId = persistHtmlBodyIfNeeded_(
    snapshot.htmlBody,
    queueEntryId
  );

  var snapshotHash = computeSnapshotHash_({
    toRecipients: snapshot.toRecipients,
    ccRecipients: snapshot.ccRecipients,
    bccRecipients: snapshot.bccRecipients,
    subject: snapshot.subject,
    plainBody: snapshot.plainBody,
    htmlBodyDriveFileId: htmlBodyDriveFileId,
    attachmentManifestJson: JSON.stringify(attachmentManifest),
  });

  return {
    queueEntryId: queueEntryId,
    draftId: draft.getId(),
    threadId: message.getThread().getId(),
    status: DAWN_QUEUE_POLICIES.QUEUE_STATUS.DRAFT_CAPTURED,
    capturedAt: capturedAt,
    toRecipients: snapshot.toRecipients,
    ccRecipients: snapshot.ccRecipients,
    bccRecipients: snapshot.bccRecipients,
    subject: snapshot.subject,
    plainBody: snapshot.plainBody,
    htmlBodyDriveFileId: htmlBodyDriveFileId,
    attachmentManifestJson: JSON.stringify(attachmentManifest),
    snapshotHash: snapshotHash,
    sendToken: sendToken,
    scheduledSendAt: '',
    retryCount: 0,
    lastError: '',
  };
}

/**
 * Captures recipients, subject, body, and attachment blobs at ingest time.
 *
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @returns {Object}
 */
function buildImmutableDraftSnapshot_(message) {
  var attachments = message.getAttachments();

  validateAttachmentBatch_(attachments);

  return {
    toRecipients: message.getTo() || '',
    ccRecipients: message.getCc() || '',
    bccRecipients: message.getBcc() || '',
    subject: message.getSubject() || '',
    plainBody: truncatePlainBodyForSheet_(message.getPlainBody() || ''),
    htmlBody: message.getBody() || '',
    attachments: attachments,
  };
}

/**
 * @param {GoogleAppsScript.Base.Blob[]} attachments
 * @param {string} queueEntryId
 * @returns {Object[]}
 */
function persistAttachmentBlobs_(attachments, queueEntryId) {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  var folder = getOrCreateAttachmentDriveFolder_();
  var manifest = [];

  for (var i = 0; i < attachments.length; i++) {
    var blob = attachments[i];
    var fileName = buildAttachmentFileName_(queueEntryId, i, blob.getName());
    var file = folder.createFile(blob.copyBlob().setName(fileName));

    manifest.push({
      name: blob.getName() || fileName,
      mimeType: blob.getContentType() || '',
      driveFileId: file.getId(),
      sizeBytes: blob.getBytes().length,
    });
  }

  return manifest;
}

/**
 * @param {string} htmlBody
 * @param {string} queueEntryId
 * @returns {string} Drive file ID or empty when not persisted
 */
function persistHtmlBodyIfNeeded_(htmlBody, queueEntryId) {
  if (!htmlBody) {
    return '';
  }

  var folder = getOrCreateAttachmentDriveFolder_();
  var htmlBlob = Utilities.newBlob(htmlBody, 'text/html', queueEntryId + '-body.html');
  var file = folder.createFile(htmlBlob);
  return file.getId();
}

/**
 * @param {GoogleAppsScript.Base.Blob[]} attachments
 */
function validateAttachmentBatch_(attachments) {
  if (!attachments) {
    return;
  }

  if (attachments.length > DAWN_QUEUE_LIMITS.MAX_ATTACHMENT_COUNT) {
    throw new Error(
      'Draft exceeds MAX_ATTACHMENT_COUNT (' + DAWN_QUEUE_LIMITS.MAX_ATTACHMENT_COUNT + ').'
    );
  }

  var totalBytes = 0;
  for (var i = 0; i < attachments.length; i++) {
    totalBytes += attachments[i].getBytes().length;
  }

  if (totalBytes > DAWN_QUEUE_LIMITS.MAX_DRAFT_SNAPSHOT_BYTES) {
    throw new Error(
      'Draft attachment payload exceeds MAX_DRAFT_SNAPSHOT_BYTES (' +
        DAWN_QUEUE_LIMITS.MAX_DRAFT_SNAPSHOT_BYTES +
        ').'
    );
  }
}

/**
 * @param {string} plainBody
 * @returns {string}
 */
function truncatePlainBodyForSheet_(plainBody) {
  var maxCellLength = 45000;
  if (plainBody.length <= maxCellLength) {
    return plainBody;
  }
  return plainBody.substring(0, maxCellLength - 3) + '...';
}

/**
 * @param {Object} snapshotParts
 * @returns {string}
 */
function computeSnapshotHash_(snapshotParts) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(snapshotParts)
  );
  return Utilities.base64Encode(digest);
}

/**
 * @returns {string}
 */
function generateQueueEntryId_() {
  return Utilities.getUuid();
}

/**
 * @param {string} queueEntryId
 * @returns {string}
 */
function generateSendToken_(queueEntryId) {
  return Utilities.getUuid() + ':' + queueEntryId;
}

/**
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function getOrCreateAttachmentDriveFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(DAWN_QUEUE_PROPERTIES.ATTACHMENT_DRIVE_FOLDER_ID);

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (error) {
      logDawnQueueWarn(
        DAWN_QUEUE_ENQUEUE_COMPONENT,
        'ATTACHMENT_FOLDER_MISSING',
        'Configured attachment folder ID is invalid; creating a new folder.',
        { folderId: folderId, error: String(error) }
      );
    }
  }

  var folder = DriveApp.createFolder('DawnQueue Snapshots');
  properties.setProperty(
    DAWN_QUEUE_PROPERTIES.ATTACHMENT_DRIVE_FOLDER_ID,
    folder.getId()
  );
  return folder;
}

/**
 * @param {string} queueEntryId
 * @param {number} index
 * @param {string} originalName
 * @returns {string}
 */
function buildAttachmentFileName_(queueEntryId, index, originalName) {
  var safeOriginal = String(originalName || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
  return queueEntryId + '-' + index + '-' + safeOriginal;
}

/**
 * @returns {string}
 */
function getEnqueueCursorDraftId_() {
  return (
    PropertiesService.getScriptProperties().getProperty(
      DAWN_QUEUE_PROPERTIES.ENQUEUE_CURSOR_DRAFT_ID
    ) || ''
  );
}

/**
 * @param {string} draftId
 */
function setEnqueueCursorDraftId_(draftId) {
  PropertiesService.getScriptProperties().setProperty(
    DAWN_QUEUE_PROPERTIES.ENQUEUE_CURSOR_DRAFT_ID,
    String(draftId)
  );
}
