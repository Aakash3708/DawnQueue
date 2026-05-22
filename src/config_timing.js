/**
 * DawnQueue — centralized timing configuration.
 *
 * All durations are explicit; consumers must not hard-code intervals elsewhere.
 * Units are encoded in property names (MS, SECONDS, MINUTES, HOURS).
 *
 * Assumption: no separate specification document was present in the repo at
 * implementation time. Values below follow .cursorrules guidance (e.g. 5-minute
 * send gap) and production-safe Apps Script defaults. Adjust after spec review.
 */

const DAWN_QUEUE_TIMING = {
  // --- Core send pacing (spec example: DEFAULT_SEND_GAP_MINUTES = 5) ---
  DEFAULT_SEND_GAP_MINUTES: 5,
  DIFFERENT_TARGET_SEND_GAP_MINUTES: 5,
  SAME_RECIPIENT_OR_THREAD_GAP_MINUTES: 15,
  MIN_SEND_GAP_MINUTES: 3,
  MAX_SEND_GAP_MINUTES: 60,

  // --- Send worker trigger cadence (time-driven) ---
  SEND_WORKER_TRIGGER_MINUTES: 5,

  // --- Scheduler / trigger cadence ---
  // How often the time-driven worker wakes to evaluate due items.
  SCHEDULER_TICK_MINUTES: 1,
  // Grace window: item is eligible if scheduledSendAt <= now + this slack.
  SCHEDULER_DUE_SLACK_MS: 30 * 1000,

  // --- Jitter (spreads load; mitigates trigger bunching) ---
  JITTER_ENABLED: true,
  JITTER_MAX_SECONDS: 90,

  // --- Locking (LockService lease semantics) ---
  LOCK_WAIT_MS: 5 * 1000,
  LOCK_TTL_MS: 30 * 1000,

  // --- Per-send operational timeouts ---
  GMAIL_SEND_TIMEOUT_MS: 45 * 1000,

  // --- Error / quota cooldowns (pause scheduling after hard failures) ---
  COOLDOWN_AFTER_TRANSIENT_ERROR_MINUTES: 15,
  COOLDOWN_AFTER_QUOTA_ERROR_MINUTES: 60,
  COOLDOWN_AFTER_AUTH_ERROR_MINUTES: 24 * 60,

  // --- Retry backoff (used by retry engine; base → cap exponential) ---
  RETRY_BASE_DELAY_MINUTES: 15,
  RETRY_MAX_DELAY_MINUTES: 8 * 60,
  RETRY_BACKOFF_MULTIPLIER: 2,

  // --- Ingestion / enqueue worker (6-minute Apps Script hard limit) ---
  ENQUEUE_EXECUTION_CUTOFF_MS: 330 * 1000, // 5m 30s — exit before platform kill
  INGEST_DEBOUNCE_MS: 2 * 1000,
  SHEET_WRITE_FLUSH_INTERVAL_MS: 5 * 1000,

  // --- Audit / log retention hints (operational, not Gmail) ---
  AUDIT_LOG_RETENTION_DAYS: 90,
};
