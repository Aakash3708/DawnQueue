/**
 * DawnQueue — Google Sheets persistence for the queue database tab.
 */

/**
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getDawnQueueSpreadsheet() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty(DAWN_QUEUE_PROPERTIES.SPREADSHEET_ID);
  if (!spreadsheetId) {
    throw new Error(
      'Missing script property "' +
        DAWN_QUEUE_PROPERTIES.SPREADSHEET_ID +
        '". Run setup to bind the queue spreadsheet.'
    );
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

/**
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getDawnQueueSheet() {
  var spreadsheet = getDawnQueueSpreadsheet();
  var sheet = spreadsheet.getSheetByName(DAWN_QUEUE_SCHEMA.SHEET_QUEUE);
  if (!sheet) {
    throw new Error('Queue sheet "' + DAWN_QUEUE_SCHEMA.SHEET_QUEUE + '" was not found.');
  }
  return sheet;
}

/**
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getDawnQueueLogsSheet() {
  var spreadsheet = getDawnQueueSpreadsheet();
  var sheet = spreadsheet.getSheetByName(DAWN_QUEUE_SCHEMA.SHEET_LOGS);
  if (!sheet) {
    throw new Error('Logs sheet "' + DAWN_QUEUE_SCHEMA.SHEET_LOGS + '" was not found.');
  }
  return sheet;
}

/**
 * Ensures header row exists on first use.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} headers
 */
function ensureSheetHeaders_(sheet, headers) {
  if (sheet.getLastRow() > 0) {
    return;
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

/**
 * @param {string} draftId
 * @returns {boolean}
 */
function isDraftIdAlreadyQueued(draftId) {
  var sheet = getDawnQueueSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }

  var draftIdColumn = DAWN_QUEUE_SHEET_COLUMN_INDEX.draftId + 1;
  var draftIds = sheet
    .getRange(2, draftIdColumn, lastRow, draftIdColumn)
    .getValues()
    .flat();

  for (var i = 0; i < draftIds.length; i++) {
    if (String(draftIds[i]) === String(draftId)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Object} queueEntry
 */
function appendQueueEntry(queueEntry) {
  var sheet = getDawnQueueSheet();
  ensureSheetHeaders_(sheet, DAWN_QUEUE_SCHEMA.QUEUE_HEADERS);

  var row = DAWN_QUEUE_SCHEMA.QUEUE_HEADERS.map(function (headerName) {
    var value = queueEntry[headerName];
    return value === undefined || value === null ? '' : value;
  });

  sheet.appendRow(row);
}

/**
 * @returns {Object[]}
 */
function readAllQueueEntries() {
  var sheet = getDawnQueueSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var columnCount = DAWN_QUEUE_SCHEMA.QUEUE_HEADERS.length;
  var values = sheet.getRange(2, 1, lastRow, columnCount).getValues();
  var entries = [];

  for (var i = 0; i < values.length; i++) {
    entries.push(mapSheetRowToQueueEntry_(values[i], i + 2));
  }

  return entries;
}

/**
 * @param {Object} entry
 * @param {Object} updates
 */
function updateQueueEntry(entry, updates) {
  var sheet = getDawnQueueSheet();
  var mergedEntry = mergeQueueEntry_(entry, updates);
  var rowValues = DAWN_QUEUE_SCHEMA.QUEUE_HEADERS.map(function (headerName) {
    return formatQueueCellValue_(headerName, mergedEntry[headerName]);
  });

  sheet
    .getRange(entry.sheetRow, 1, entry.sheetRow, rowValues.length)
    .setValues([rowValues]);
}

/**
 * Immediately persists pending sheet writes (in-flight send guard).
 * @param {Object} entry
 * @param {Object} updates
 */
function updateQueueEntryAndFlush(entry, updates) {
  updateQueueEntry(entry, updates);
  SpreadsheetApp.flush();
}

/**
 * @param {string} status
 * @returns {Object[]}
 */
function readQueueEntriesByStatus(status) {
  return readAllQueueEntries().filter(function (entry) {
    return String(entry.status) === String(status);
  });
}

/**
 * @param {Array[]} values
 * @param {number} sheetRow
 * @returns {Object}
 */
function mapSheetRowToQueueEntry_(values, sheetRow) {
  var entry = { sheetRow: sheetRow };

  DAWN_QUEUE_SCHEMA.QUEUE_HEADERS.forEach(function (headerName, index) {
    if (headerName === 'capturedAt' || headerName === 'scheduledSendAt') {
      entry[headerName] = parseSheetDateCell_(values[index]);
      return;
    }
    entry[headerName] = values[index];
  });

  return entry;
}

/**
 * @param {*} cellValue
 * @returns {Date|null}
 */
function parseSheetDateCell_(cellValue) {
  if (cellValue === '' || cellValue === null || cellValue === undefined) {
    return null;
  }
  if (cellValue instanceof Date && !isNaN(cellValue.getTime())) {
    return cellValue;
  }
  var parsed = new Date(cellValue);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  return null;
}

/**
 * @param {string} headerName
 * @param {*} value
 * @returns {*}
 */
function formatQueueCellValue_(headerName, value) {
  if (value === undefined || value === null) {
    return '';
  }
  if ((headerName === 'capturedAt' || headerName === 'scheduledSendAt') && value instanceof Date) {
    return value;
  }
  return value;
}

/**
 * @param {Object} entry
 * @param {Object} updates
 * @returns {Object}
 */
function mergeQueueEntry_(entry, updates) {
  var merged = {};
  var keys = Object.keys(entry);
  for (var i = 0; i < keys.length; i++) {
    merged[keys[i]] = entry[keys[i]];
  }

  var updateKeys = Object.keys(updates);
  for (var j = 0; j < updateKeys.length; j++) {
    merged[updateKeys[j]] = updates[updateKeys[j]];
  }
  return merged;
}
