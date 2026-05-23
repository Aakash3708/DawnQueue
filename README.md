# DawnQueue

**Production Gmail outbound queue for Google Workspace** — built on Google Apps Script, Google Sheets, and Drive.

DawnQueue lets teams stage draft emails under a `HOLD` label, then releases them on a **deterministic schedule** that respects professional communication windows, send spacing, daily caps, and automatic retry for transient failures.

---

## Table of contents

1. [Project purpose and architecture](#1-project-purpose-and-architecture)
2. [Google Sheets setup](#2-google-sheets-setup)
3. [Hands-free deployment](#3-hands-free-deployment)
4. [Trigger layout](#4-trigger-layout)
5. [Troubleshooting and resilience design](#5-troubleshooting-and-resilience-design)
6. [Source file map](#6-source-file-map)
7. [Operational limits (reference)](#7-operational-limits-reference)

---

## 1. Project purpose and architecture

### Purpose

Professional email should not blast recipients at random times or in uncontrolled bursts. DawnQueue:

- **Protects communication windows** — sends only within **Asia/Kolkata business hours (09:45–18:00, Monday–Friday)** unless a computed slot is forward-scheduled to the next valid morning.
- **Spaces outbound traffic** — **5 minutes** between different recipients/threads; **15 minutes** when the same recipient or thread was scheduled recently.
- **Preserves intent** — each queue row stores an **immutable snapshot** (recipients, subject, body, attachments via Drive) at ingest time.
- **Stays observable** — every pipeline step writes structured rows to the **Logs** sheet.
- **Recovers safely** — transient Gmail/Apps Script failures use **exponential backoff** instead of silent drops.

### Flat-namespace architecture

All modules live in a single `src/` folder (no nested packages). Apps Script merges them into one global project scope. Configuration is centralized in `config_*.js`; behavior is split by pipeline stage.

### Data lifecycle

```
┌──────────────┐     ┌───────────────┐     ┌─────────────┐     ┌──────────────┐
│   INGEST     │ ──► │   SCHEDULE    │ ──► │    SEND     │ ──► │    RETRY     │
│ queue_enqueue│     │queue_scheduler│     │  mail_send  │     │  mail_retry  │
└──────────────┘     └───────────────┘     └─────────────┘     └──────────────┘
       │                    │                    │                    │
       ▼                    ▼                    ▼                    ▼
  Gmail drafts         Queue sheet           Gmail delivery      failed_retry_pending
  label: HOLD          scheduledSendAt       label: SENT_*       → scheduled (retry)
  → Queue rows         status: scheduled     or failed         terminal: failed
```

| Stage | Entry point | Input | Output |
|-------|-------------|-------|--------|
| **Ingest** | `triggerEnqueuePipeline` → `queue_enqueue` | Drafts with `HOLD` | New rows: `DRAFT_CAPTURED`, snapshot in Sheet + Drive |
| **Schedule** | `triggerSchedulerPipeline` → `queue_scheduler` | `pending`, `DRAFT_CAPTURED` | `scheduled` + `scheduledSendAt` (never reshuffled once set) |
| **Send** | `triggerSendWorkerPipeline` → `mail_send` | `scheduled` due now | `sent` + `SENT_BY_DAWNQUEUE`, or failure → retry engine |
| **Retry** | `mail_retry` (inside send pipeline) | Transient send errors | `failed_retry_pending` → promoted back to `scheduled`, or terminal `failed` + `FAILED_SEND` |

**Status flow (simplified):**

```
DRAFT_CAPTURED / pending → scheduled → sending → sent
                              ↓           ↓
                    failed_retry_pending  failed (terminal)
                              ↓
                         scheduled (after backoff)
```

Orchestration, locks, and setup live in `main.js` (`setupSystem`, trigger wrappers).

---

## 2. Google Sheets setup

You do **not** need to create a spreadsheet manually. On first `setupSystem()` run, DawnQueue calls `SpreadsheetApp.create("DawnQueue Database")`, saves the ID to Script Properties (`DAWN_QUEUE_SPREADSHEET_ID`), and provisions the tabs below.

If you already have a bound spreadsheet, `setupSystem()` reuses it and only fills in missing tabs/headers.

Column order **must** match `src/queue_schema.js` (enforced automatically by setup).

### Tab: `Queue`

| Column | Description |
|--------|-------------|
| `queueEntryId` | UUID for the queue row |
| `draftId` | Gmail draft / thread ID |
| `threadId` | Originating Gmail thread ID |
| `status` | Lifecycle status (`DRAFT_CAPTURED`, `scheduled`, `sending`, `sent`, `failed_retry_pending`, `failed`, …) |
| `capturedAt` | When the snapshot was taken |
| `toRecipients` | Frozen To field |
| `ccRecipients` | Frozen Cc field |
| `bccRecipients` | Frozen Bcc field |
| `subject` | Frozen subject |
| `plainBody` | Plain-text body (truncated for cell limits) |
| `htmlBodyDriveFileId` | Drive file ID for HTML body snapshot |
| `attachmentManifestJson` | JSON array of Drive attachment metadata |
| `snapshotHash` | SHA-256 hash of snapshot fields |
| `sendToken` | Idempotency token (`X-DawnQueue-Send-Token`) |
| `scheduledSendAt` | When the send worker may deliver |
| `retryCount` | Number of send retries attempted |
| `lastError` | Most recent error message |

### Tab: `Logs`

| Column | Description |
|--------|-------------|
| `loggedAt` | Timestamp |
| `level` | `INFO`, `WARN`, or `ERROR` |
| `component` | Module name (e.g. `mail_send`, `queue_scheduler`) |
| `event` | Event code (e.g. `SEND_SUCCESS`, `RETRY_SCHEDULED`) |
| `queueEntryId` | Related queue row (if any) |
| `draftId` | Related draft (if any) |
| `message` | Human-readable summary |
| `detailsJson` | JSON context (PII redacted by policy) |

---

## 3. Hands-free deployment

### Prerequisites

- Google Workspace account with **Gmail**, **Drive**, **Sheets**, and **Apps Script** access
- Permission to create time-driven triggers

No manual spreadsheet creation or Script Property copy-paste is required.

### Step 1 — Create the Apps Script project

1. Open [script.google.com](https://script.google.com) → **New project**.
2. Name the project **DawnQueue**.
3. Remove the default `Code.gs` content (or delete the file).
4. For **each file** listed in [Source file map](#6-source-file-map) below:
   - Click **+** → **Script**.
   - Name the file to match the repo (e.g. `main.gs`, `config_timing.gs`).
   - Paste the full contents from the matching file under `src/`.
5. **Save** the project.

> Copy files **flatly** — one Apps Script file per repo file. Apps Script does not support a `src/` folder in the editor.

### Step 2 — Run autonomous setup

1. Select function **`setupSystem`** in the toolbar.
2. Click **Run** and **authorize** when prompted (Gmail, Drive, Sheets, Script properties).
3. Open **Executions** (left sidebar) and select the latest `setupSystem` run.
4. In the **Execution log**, click the dashboard URL logged as:  
   `Created DawnQueue Database. Open your queue dashboard: https://docs.google.com/spreadsheets/d/.../edit`
5. The same URL is persisted on the spreadsheet **Logs** tab (`SETUP_SPREADSHEET_CREATED`).

**What `setupSystem()` does automatically:**

| Step | Action |
|------|--------|
| 1 | Checks `DAWN_QUEUE_SPREADSHEET_ID` in Script Properties |
| 2 | If missing/empty → `SpreadsheetApp.create("DawnQueue Database")` |
| 3 | Saves the new spreadsheet ID to `DAWN_QUEUE_SPREADSHEET_ID` |
| 4 | Creates **`Queue`** and **`Logs`** tabs with correct headers |
| 5 | Removes the empty default `Sheet1` tab when safe |
| 6 | Creates Gmail labels: `HOLD`, `SENT_BY_DAWNQUEUE`, `FAILED_SEND` |
| 7 | Logs the dashboard URL via `logDawnQueueInfo()` (+ `Logger.log` for Executions) |

**Using the queue:** Compose a Gmail draft → apply label **`HOLD`** → pipelines ingest on the next enqueue trigger.

### Step 3 — (Optional) Use an existing spreadsheet

To bind a spreadsheet you already own instead of auto-creating one:

1. Apps Script → **Project Settings** → **Script Properties**.
2. Add `DAWN_QUEUE_SPREADSHEET_ID` = your spreadsheet ID (from the URL).
3. Run **`setupSystem()`** again — it will initialize `Queue` / `Logs` on that file without creating a new one.

### Step 4 — (Optional) Spreadsheet menu

If the script is **container-bound** to the DawnQueue spreadsheet, reload the sheet to see the **DawnQueue** custom menu. Standalone projects use the Apps Script **Run** button.

### Step 5 — Configure triggers

See [Trigger layout](#4-trigger-layout) below.

---

## 4. Trigger layout

Use **time-driven** triggers so pipelines do not overlap (each trigger acquires a **script lock**).

In Apps Script: **Triggers** (clock icon) → **Add Trigger**

| Function | Event | Interval | Notes |
|----------|-------|----------|-------|
| `triggerEnqueuePipeline` | Time-driven | Every **5** minutes | Ingests `HOLD` drafts |
| `triggerSchedulerPipeline` | Time-driven | Every **5** minutes | Assigns `scheduledSendAt` |
| `triggerSendWorkerPipeline` | Time-driven | Every **5** minutes | Promotes retries + sends due mail |

**Recommended settings for each trigger:**

- **Choose which function to run:** (as above)
- **Select event source:** Time-driven
- **Select type of time based trigger:** Minutes timer
- **Select minute interval:** Every 5 minutes (or “Every 5 minutes” in new UI)
- **Failure notification settings:** Notify daily (recommended)

### Why all three at 5 minutes?

- Keeps ingest, schedule, and send cadence aligned with `SEND_WORKER_TRIGGER_MINUTES` and operational expectations.
- Send worker promotes `failed_retry_pending` → `scheduled` before attempting delivery on the same run.
- Staggering is optional; **LockService** prevents concurrent pipelines from corrupting state.

### Manual execution (testing)

| Function | Action |
|----------|--------|
| `setupSystem` | One-time / repeat setup |
| `triggerEnqueuePipeline` | Force ingest |
| `triggerSchedulerPipeline` | Force scheduling |
| `triggerSendWorkerPipeline` | Force send + retry promotion |

---

## 5. Troubleshooting and resilience design

### 5.5-minute execution safety threshold

Google Apps Script hard-stops executions at **6 minutes**. DawnQueue exits proactively at **5 minutes 30 seconds (330,000 ms)** (`ENQUEUE_EXECUTION_CUTOFF_MS`).

**Where it applies:**

| Pipeline | Behavior when cutoff hits |
|----------|---------------------------|
| **Ingest** | Stops scanning drafts; saves **last successful draft ID** in Script Properties (`DAWN_QUEUE_ENQUEUE_CURSOR_DRAFT_ID`); next run resumes without skip/duplicate |
| **Scheduler** | Stops assigning new slots; already-written `scheduledSendAt` values are never changed |
| **Send worker** | Stops after current item; in-flight `sending` row remains guarded; next trigger continues |

All cutoff events are logged to the **Logs** sheet via `utils_logger.js`.

### Locking and overlap

`trigger*` functions acquire a **script lock** (`util_lock.js`). If a previous run is still active, the new run logs `LOCK_UNAVAILABLE` and exits — preventing duplicate sends and schedule corruption.

### Exponential backoff retry engine

When `mail_send` fails with a **transient** error (rate limits, lock timeouts, backend errors, quota wording, etc.):

1. `retryCount` increments.
2. If `retryCount <= 3` (`MAX_RETRY_ATTEMPTS`):
   - Status → `failed_retry_pending`
   - Backoff delay = **15 × 2^(retryCount − 1)** minutes  
     (15 min → 30 min → 60 min)
   - `scheduledSendAt` set after delay, aligned to business hours
3. When `scheduledSendAt` elapses, `promoteReadyRetryEntries()` moves the row back to `scheduled`.
4. If retries are exhausted (or error is non-transient) → status **`failed`**, **`FAILED_SEND`** label on thread, terminal **`TERMINAL_FAILURE`** log.

### Daily and per-run caps

| Limit | Value |
|-------|-------|
| Sends per trigger run | 5 |
| Sends per calendar day (Asia/Kolkata) | 200 |

Daily count is stored in Script Properties (`DAWN_QUEUE_DAILY_SEND_COUNT_<date>`).

### Common issues

| Symptom | Check |
|---------|--------|
| Drafts not ingested | Draft has `HOLD` label; enqueue trigger enabled; Logs for `ENQUEUE_*` |
| Rows stuck in `DRAFT_CAPTURED` | Scheduler trigger enabled; inside business hours policy for slot assignment |
| Rows not sending | `scheduledSendAt` in the past; status is `scheduled`; daily cap not reached |
| `LOCK_UNAVAILABLE` in Logs | Normal under overlap; widen trigger spacing if persistent |
| Setup did not create a sheet | Re-run `setupSystem()`; check authorization for Sheets/Drive; inspect Executions log |
| Need a custom spreadsheet | Pre-set `DAWN_QUEUE_SPREADSHEET_ID`, then run `setupSystem()` |
| Send fails permanently | Logs `TERMINAL_FAILURE`; thread labeled `FAILED_SEND`; inspect `lastError` column |

### Tuning configuration

Edit these files in Apps Script (then save):

- `config_timing.js` — gaps, jitter, backoff, cutoff
- `config_limits.js` — daily cap, max retries, batch sizes
- `config_policies.js` — business hours, labels, status rules

**Do not scatter magic numbers** in other files; keep policy in config modules.

---

## 6. Source file map

Copy **only** these files into Apps Script for a full deployment:

| File | Role |
|------|------|
| `config_timing.js` | Timing, gaps, jitter, cutoff, backoff constants |
| `config_limits.js` | Daily cap, per-run cap, retry max, batch limits |
| `config_policies.js` | Business hours, labels, status machine |
| `queue_schema.js` | Sheet column definitions, property keys |
| `util_lock.js` | LockService wrappers |
| `sheet_queue_store.js` | Sheet read/write |
| `utils_time.js` | Timezone, business hours, jitter, cutoff helpers |
| `utils_logger.js` | Logs sheet writer |
| `queue_enqueue.js` | HOLD draft ingestion |
| `queue_scheduler.js` | Scheduling engine |
| `mail_send.js` | Send worker |
| `mail_retry.js` | Retry and promotion |
| `main.js` | Triggers, `setupSystem`, menu |

Legacy placeholders (`scheduler_engine.js`, `send_worker.js`, `retry_engine.js`, `util_time.js`, etc.) are **not** required.

---

## 7. Operational limits (reference)

| Setting | Value |
|---------|-------|
| Business hours | Asia/Kolkata, **09:45–18:00**, Mon–Fri |
| Different recipient/thread gap | 5 minutes |
| Same recipient or thread gap | 15 minutes |
| Schedule jitter | ±90 seconds |
| Max sends per run | 5 |
| Max sends per day | 200 |
| Max retry attempts | 3 |
| Execution safety cutoff | 5 min 30 sec (330,000 ms) |
| Ingest search query | `in:drafts label:HOLD` |

---

## License and ownership

Internal engineering tool — configure triggers and quotas to match your organization’s Gmail and compliance policies before production use.

**DawnQueue** — deterministic dawn delivery for professional email.
