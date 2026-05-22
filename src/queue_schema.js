/**
 * DawnQueue — spreadsheet tabs, column headers, and Script Property keys.
 */

const DAWN_QUEUE_SCHEMA = {
  SHEET_QUEUE: 'Queue',
  SHEET_LOGS: 'Logs',

  QUEUE_HEADERS: [
    'queueEntryId',
    'draftId',
    'threadId',
    'status',
    'capturedAt',
    'toRecipients',
    'ccRecipients',
    'bccRecipients',
    'subject',
    'plainBody',
    'htmlBodyDriveFileId',
    'attachmentManifestJson',
    'snapshotHash',
    'sendToken',
    'scheduledSendAt',
    'retryCount',
    'lastError',
  ],

  LOG_HEADERS: [
    'loggedAt',
    'level',
    'component',
    'event',
    'queueEntryId',
    'draftId',
    'message',
    'detailsJson',
  ],
};

const DAWN_QUEUE_PROPERTIES = {
  SPREADSHEET_ID: 'DAWN_QUEUE_SPREADSHEET_ID',
  ENQUEUE_CURSOR_DRAFT_ID: 'DAWN_QUEUE_ENQUEUE_CURSOR_DRAFT_ID',
  ATTACHMENT_DRIVE_FOLDER_ID: 'DAWN_QUEUE_ATTACHMENT_DRIVE_FOLDER_ID',
  DAILY_SEND_COUNT_PREFIX: 'DAWN_QUEUE_DAILY_SEND_COUNT_',
};

const DAWN_QUEUE_SHEET_COLUMN_INDEX = {
  queueEntryId: 0,
  draftId: 1,
  threadId: 2,
  status: 3,
  capturedAt: 4,
  toRecipients: 5,
  ccRecipients: 6,
  bccRecipients: 7,
  subject: 8,
  plainBody: 9,
  htmlBodyDriveFileId: 10,
  attachmentManifestJson: 11,
  snapshotHash: 12,
  sendToken: 13,
  scheduledSendAt: 14,
  retryCount: 15,
  lastError: 16,
};
