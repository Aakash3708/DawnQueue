/**
 * DawnQueue — behavioral policies (scheduling, retry, labels, state rules).
 *
 * Timing numbers live in config_timing.js; capacity in config_limits.js.
 */

const DAWN_QUEUE_POLICIES = {
  // --- Scheduling mode ---
  SCHEDULING_MODE: 'FIFO_GAP', // sequential queue with fixed gap + jitter
  SCHEDULING_RESPECT_BUSINESS_HOURS: true,
  BUSINESS_HOURS_TIMEZONE: 'Asia/Kolkata',
  BUSINESS_HOURS_START_HOUR: 9,
  BUSINESS_HOURS_START_MINUTE: 45, // 09:45 local
  BUSINESS_HOURS_END_HOUR: 18,
  BUSINESS_HOURS_END_MINUTE: 0, // 18:00 local (inclusive through 18:00)
  BUSINESS_DAYS: [1, 2, 3, 4, 5], // Mon–Fri (Utilities.formatDate 'u': Mon=1)

  // --- Jitter application ---
  JITTER_DISTRIBUTION: 'UNIFORM', // UNIFORM | NONE
  JITTER_APPLY_TO: 'SCHEDULED_SEND_AT', // only mutate scheduledSendAt at schedule time

  // --- Idempotency & immutability ---
  IMMUTABLE_AFTER_STATUS: 'QUEUED', // snapshot fields frozen once queued
  IDEMPOTENT_SEND_TOKEN_HEADER: 'X-DawnQueue-Send-Token',
  REQUIRE_SEND_TOKEN_MATCH: true,

  // --- Queue state machine (allowed transitions) ---
  QUEUE_STATUS: {
    PENDING: 'pending',
    DRAFT_CAPTURED: 'DRAFT_CAPTURED',
    QUEUED: 'QUEUED',
    SCHEDULED: 'scheduled',
    SENDING: 'sending',
    SENT: 'sent',
    FAILED_RETRY_PENDING: 'failed_retry_pending',
    FAILED: 'failed',
    CANCELLED: 'CANCELLED',
    DEAD_LETTER: 'DEAD_LETTER',
  },
  SCHEDULER_ELIGIBLE_STATUSES: ['pending', 'DRAFT_CAPTURED'],
  ALLOWED_STATUS_TRANSITIONS: {
    pending: ['scheduled', 'CANCELLED'],
    DRAFT_CAPTURED: ['scheduled', 'QUEUED', 'CANCELLED'],
    QUEUED: ['scheduled', 'CANCELLED'],
    scheduled: ['sending', 'failed_retry_pending', 'failed', 'CANCELLED'],
    sending: ['sent', 'failed_retry_pending', 'failed'],
    failed_retry_pending: ['scheduled', 'failed'],
    failed: [],
    sent: [],
    CANCELLED: [],
    DEAD_LETTER: [],
  },

  // --- Retry policy ---
  RETRY_ON_TRANSIENT_ERRORS: true,
  RETRY_ON_QUOTA_ERRORS: true,
  RETRY_ON_AUTH_ERRORS: false,
  RETRY_ON_VALIDATION_ERRORS: false,
  MOVE_TO_DEAD_LETTER_AFTER_MAX_RETRIES: true,

  // --- Gmail labels (created during setup step) ---
  GMAIL_LABELS: {
    HOLD: 'HOLD',
    SENT_BY_DAWNQUEUE: 'SENT_BY_DAWNQUEUE',
    FAILED_SEND: 'FAILED_SEND',
    QUEUE_ROOT: 'DawnQueue',
    QUEUED: 'DawnQueue/Queued',
    SENDING: 'DawnQueue/Sending',
    SENT: 'DawnQueue/Sent',
    FAILED: 'DawnQueue/Failed',
    RETRY: 'DawnQueue/Retry',
  },
  ENQUEUE_GMAIL_SEARCH_QUERY: 'in:drafts label:HOLD',

  // --- Duplicate send prevention ---
  DUPLICATE_CHECK_FIELDS: ['messageId', 'draftId', 'sendToken'],
  BLOCK_RESEND_IF_STATUS_IN: ['sent', 'sending', 'SENT', 'SENDING'],

  // --- Operational visibility ---
  AUDIT_LOG_ENABLED: true,
  AUDIT_LOG_INCLUDE_SNAPSHOT_HASH: true,
  LOG_PII_IN_AUDIT: false,
};
