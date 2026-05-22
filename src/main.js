/**
 * DawnQueue — primary entry points, setup, and trigger orchestration (Step 8).
 */

var DAWN_QUEUE_MAIN_COMPONENT = 'main';

/**
 * Time-driven trigger: ingestion pipeline.
 * @returns {Object|null}
 */
function triggerEnqueuePipeline() {
  return runPipelineWithSafety_(
    DAWN_QUEUE_MAIN_COMPONENT,
    'TRIGGER_ENQUEUE',
    function (startedAtMs) {
      return runQueueEnqueueCore(startedAtMs);
    }
  );
}

/**
 * Time-driven trigger: scheduler pipeline.
 * @returns {Object|null}
 */
function triggerSchedulerPipeline() {
  return runPipelineWithSafety_(
    DAWN_QUEUE_MAIN_COMPONENT,
    'TRIGGER_SCHEDULER',
    function (startedAtMs) {
      return runQueueSchedulerCore(startedAtMs);
    }
  );
}

/**
 * Time-driven trigger: send worker pipeline (retry promotion + delivery).
 * @returns {Object|null}
 */
function triggerSendWorkerPipeline() {
  return runPipelineWithSafety_(
    DAWN_QUEUE_MAIN_COMPONENT,
    'TRIGGER_SEND_WORKER',
    function (startedAtMs) {
      var retrySummary = promoteReadyRetryEntries(startedAtMs);
      if (hasExecutionCutoffElapsed(startedAtMs)) {
        return {
          retryPromotion: retrySummary,
          send: null,
          cutoffReached: true,
        };
      }

      var sendSummary = runMailSendCore(startedAtMs);
      return {
        retryPromotion: retrySummary,
        send: sendSummary,
        cutoffReached: hasExecutionCutoffElapsed(startedAtMs),
      };
    }
  );
}

/**
 * One-time (or repeatable) installation: Gmail labels, spreadsheet provisioning, tab headers.
 * Creates "DawnQueue Database" automatically when DAWN_QUEUE_SPREADSHEET_ID is unset.
 * @returns {Object}
 */
function setupSystem() {
  var startedAtMs = Date.now();
  var summary = {
    labelsCreated: [],
    sheetsInitialized: [],
    spreadsheetBound: false,
    spreadsheetCreated: false,
    spreadsheetId: '',
    spreadsheetUrl: '',
  };

  Logger.log('DawnQueue setupSystem() started.');

  try {
    summary.labelsCreated = setupRequiredGmailLabels_();

    var binding = ensureSpreadsheetBound_();
    summary.spreadsheetCreated = binding.created;
    summary.spreadsheetId = binding.spreadsheetId;
    summary.spreadsheetUrl = binding.spreadsheetUrl;
    summary.spreadsheetBound = Boolean(binding.spreadsheetId);

    summary.sheetsInitialized = setupQueueSpreadsheetTabs_();
    removeDefaultSheetIfPresent_(SpreadsheetApp.openById(binding.spreadsheetId));

    logDawnQueueInfo(
      DAWN_QUEUE_MAIN_COMPONENT,
      'SETUP_START',
      'DawnQueue setupSystem() started.',
      { startedAtMs: startedAtMs, spreadsheetId: binding.spreadsheetId }
    );

    logSpreadsheetDashboardUrl_(binding);

    logDawnQueueInfo(
      DAWN_QUEUE_MAIN_COMPONENT,
      'SETUP_COMPLETE',
      'DawnQueue setupSystem() finished.',
      summary
    );

    return summary;
  } catch (error) {
    Logger.log('DawnQueue setupSystem() failed: ' + error);
    try {
      logDawnQueueError(
        DAWN_QUEUE_MAIN_COMPONENT,
        'SETUP_FAILED',
        'DawnQueue setupSystem() failed.',
        { error: String(error) }
      );
    } catch (logError) {
      Logger.log('Could not write setup failure to Logs sheet: ' + logError);
    }
    throw error;
  }
}

/**
 * @param {string} component
 * @param {string} event
 * @param {Function} workerFn
 * @returns {Object|null}
 */
function runPipelineWithSafety_(component, event, workerFn) {
  var startedAtMs = Date.now();
  var lock = acquireQueueLock();

  if (!lock) {
    logDawnQueueWarn(
      component,
      event + '_LOCK_UNAVAILABLE',
      'Pipeline skipped because the script lock could not be acquired.',
      { startedAtMs: startedAtMs }
    );
    return null;
  }

  logDawnQueueInfo(component, event + '_START', 'Pipeline trigger started.', {
    startedAtMs: startedAtMs,
    cutoffMs: DAWN_QUEUE_TIMING.ENQUEUE_EXECUTION_CUTOFF_MS,
  });

  try {
    var result = workerFn(startedAtMs);

    if (hasExecutionCutoffElapsed(startedAtMs)) {
      logDawnQueueWarn(
        component,
        event + '_CUTOFF_ELAPSED',
        'Pipeline completed near/after the 5m 30s safety cutoff.',
        {
          elapsedMs: getEnqueueElapsedMs(startedAtMs),
          cutoffMs: DAWN_QUEUE_TIMING.ENQUEUE_EXECUTION_CUTOFF_MS,
        }
      );
    }

    logDawnQueueInfo(component, event + '_COMPLETE', 'Pipeline trigger finished.', {
      elapsedMs: getEnqueueElapsedMs(startedAtMs),
      result: result,
    });

    return result;
  } catch (error) {
    logDawnQueueError(component, event + '_FAILED', 'Pipeline trigger failed.', {
      elapsedMs: getEnqueueElapsedMs(startedAtMs),
      error: truncateLogText_(String(error), DAWN_QUEUE_LIMITS.MAX_ERROR_MESSAGE_LENGTH),
    });
    throw error;
  } finally {
    releaseQueueLock(lock);
  }
}

/**
 * @returns {string[]}
 */
function setupRequiredGmailLabels_() {
  var requiredLabels = [
    DAWN_QUEUE_POLICIES.GMAIL_LABELS.HOLD,
    DAWN_QUEUE_POLICIES.GMAIL_LABELS.SENT_BY_DAWNQUEUE,
    DAWN_QUEUE_POLICIES.GMAIL_LABELS.FAILED_SEND,
  ];
  var created = [];

  for (var i = 0; i < requiredLabels.length; i++) {
    var labelName = requiredLabels[i];
    if (!GmailApp.getUserLabelByName(labelName)) {
      GmailApp.createLabel(labelName);
      created.push(labelName);
    }
  }

  return created;
}

/**
 * Ensures DAWN_QUEUE_SPREADSHEET_ID exists; creates the database spreadsheet when missing.
 *
 * @returns {{ created: boolean, spreadsheetId: string, spreadsheetUrl: string }}
 */
function ensureSpreadsheetBound_() {
  var properties = PropertiesService.getScriptProperties();
  var propertyKey = DAWN_QUEUE_PROPERTIES.SPREADSHEET_ID;
  var existingId = properties.getProperty(propertyKey);

  if (existingId && String(existingId).trim()) {
    var trimmedId = String(existingId).trim();
    return {
      created: false,
      spreadsheetId: trimmedId,
      spreadsheetUrl: buildSpreadsheetUrl_(trimmedId),
    };
  }

  var spreadsheet = SpreadsheetApp.create('DawnQueue Database');
  var spreadsheetId = spreadsheet.getId();
  properties.setProperty(propertyKey, spreadsheetId);

  return {
    created: true,
    spreadsheetId: spreadsheetId,
    spreadsheetUrl: buildSpreadsheetUrl_(spreadsheetId),
  };
}

/**
 * @param {string} spreadsheetId
 * @returns {string}
 */
function buildSpreadsheetUrl_(spreadsheetId) {
  return 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit';
}

/**
 * @param {{ created: boolean, spreadsheetId: string, spreadsheetUrl: string }} binding
 */
function logSpreadsheetDashboardUrl_(binding) {
  var dashboardMessage = binding.created
    ? 'Created DawnQueue Database. Open your queue dashboard: ' + binding.spreadsheetUrl
    : 'DawnQueue database ready. Open your queue dashboard: ' + binding.spreadsheetUrl;

  Logger.log(dashboardMessage);

  logDawnQueueInfo(
    DAWN_QUEUE_MAIN_COMPONENT,
    binding.created ? 'SETUP_SPREADSHEET_CREATED' : 'SETUP_SPREADSHEET_BOUND',
    dashboardMessage,
    {
      spreadsheetId: binding.spreadsheetId,
      spreadsheetUrl: binding.spreadsheetUrl,
      spreadsheetCreated: binding.created,
      propertyKey: DAWN_QUEUE_PROPERTIES.SPREADSHEET_ID,
    }
  );
}

/**
 * Removes the blank default "Sheet1" tab after Queue and Logs are provisioned.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 */
function removeDefaultSheetIfPresent_(spreadsheet) {
  var queueSheet = spreadsheet.getSheetByName(DAWN_QUEUE_SCHEMA.SHEET_QUEUE);
  var logsSheet = spreadsheet.getSheetByName(DAWN_QUEUE_SCHEMA.SHEET_LOGS);
  var defaultSheet = spreadsheet.getSheetByName('Sheet1');

  if (queueSheet && logsSheet && defaultSheet && spreadsheet.getSheets().length > 2) {
    spreadsheet.deleteSheet(defaultSheet);
  }
}

/**
 * @returns {string[]}
 */
function setupQueueSpreadsheetTabs_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    DAWN_QUEUE_PROPERTIES.SPREADSHEET_ID
  );

  if (!spreadsheetId) {
    return [];
  }

  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var initialized = [];

  initialized.push(
    initializeSheetTabIfBlank_(
      spreadsheet,
      DAWN_QUEUE_SCHEMA.SHEET_QUEUE,
      DAWN_QUEUE_SCHEMA.QUEUE_HEADERS
    )
  );

  initialized.push(
    initializeSheetTabIfBlank_(
      spreadsheet,
      DAWN_QUEUE_SCHEMA.SHEET_LOGS,
      DAWN_QUEUE_SCHEMA.LOG_HEADERS
    )
  );

  return initialized.filter(function (name) {
    return Boolean(name);
  });
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @param {string[]} headers
 * @returns {string}
 */
function initializeSheetTabIfBlank_(spreadsheet, sheetName, headers) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    ensureSheetHeaders_(sheet, headers);
    return sheetName;
  }

  var existingHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsHeaders = false;

  for (var i = 0; i < headers.length; i++) {
    if (String(existingHeaders[i] || '') !== headers[i]) {
      needsHeaders = true;
      break;
    }
  }

  if (needsHeaders && sheet.getLastRow() === 1 && !existingHeaders[0]) {
    ensureSheetHeaders_(sheet, headers);
    return sheetName;
  }

  return '';
}

/**
 * Optional Spreadsheet UI menu for manual operations.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DawnQueue')
    .addItem('Setup system', 'setupSystem')
    .addItem('Run enqueue', 'triggerEnqueuePipeline')
    .addItem('Run scheduler', 'triggerSchedulerPipeline')
    .addItem('Run send worker', 'triggerSendWorkerPipeline')
    .addToUi();
}
