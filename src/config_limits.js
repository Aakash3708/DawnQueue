/**
 * DawnQueue — centralized capacity and quota guardrails.
 *
 * Conservative limits relative to Gmail / Apps Script constraints.
 * Tune per workspace after observing real send volume and quotas.
 */

const DAWN_QUEUE_LIMITS = {
  // --- Per execution (6-minute Apps Script ceiling) ---
  MAX_SENDS_PER_RUN: 5,
  MAX_SHEET_ROWS_READ_PER_RUN: 500,
  MAX_SHEET_ROWS_WRITE_PER_RUN: 50,
  SCRIPT_EXECUTION_BUDGET_MS: 5 * 60 * 1000,
  SCRIPT_EXECUTION_HEADROOM_MS: 45 * 1000,
  ENQUEUE_EXECUTION_CUTOFF_MS: 330 * 1000,

  // --- Daily / queue capacity ---
  MAX_SENDS_PER_DAY: 200,
  MAX_ACTIVE_QUEUE_ENTRIES: 1000,
  MAX_PENDING_RETRIES: 100,

  // --- Retry bounds (pairs with config_timing backoff) ---
  MAX_RETRY_ATTEMPTS: 3,

  // --- Ingestion ---
  MAX_INGEST_BATCH_SIZE: 25,
  MAX_DRAFT_SNAPSHOT_BYTES: 5 * 1024 * 1024,

  // --- Gmail API interaction ---
  MAX_RECIPIENTS_PER_MESSAGE: 50,
  MAX_ATTACHMENT_COUNT: 10,

  // --- Duplicate prevention window ---
  DUPLICATE_SEND_GUARD_HOURS: 24,

  // --- Logging ---
  MAX_AUDIT_LOG_ROWS_PER_APPEND: 20,
  MAX_ERROR_MESSAGE_LENGTH: 2000,
};
