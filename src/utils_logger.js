/**
 * DawnQueue — operational logging to the Google Sheet Logs tab.
 */

var DAWN_QUEUE_LOG_LEVEL = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

/**
 * @param {string} level
 * @param {string} component
 * @param {string} event
 * @param {string} message
 * @param {Object} [context]
 */
function writeDawnQueueLog(level, component, event, message, context) {
  if (!DAWN_QUEUE_POLICIES.AUDIT_LOG_ENABLED) {
    return;
  }

  var safeMessage = truncateLogText_(message, DAWN_QUEUE_LIMITS.MAX_ERROR_MESSAGE_LENGTH);
  var detailsJson = buildLogDetailsJson_(context);

  var sheet = getDawnQueueLogsSheet();
  ensureSheetHeaders_(sheet, DAWN_QUEUE_SCHEMA.LOG_HEADERS);

  var row = [
    new Date(),
    level,
    component,
    event,
    context && context.queueEntryId ? context.queueEntryId : '',
    context && context.draftId ? context.draftId : '',
    safeMessage,
    detailsJson,
  ];

  sheet.appendRow(row);
}

/**
 * @param {string} component
 * @param {string} event
 * @param {string} message
 * @param {Object} [context]
 */
function logDawnQueueInfo(component, event, message, context) {
  writeDawnQueueLog(DAWN_QUEUE_LOG_LEVEL.INFO, component, event, message, context);
}

/**
 * @param {string} component
 * @param {string} event
 * @param {string} message
 * @param {Object} [context]
 */
function logDawnQueueWarn(component, event, message, context) {
  writeDawnQueueLog(DAWN_QUEUE_LOG_LEVEL.WARN, component, event, message, context);
}

/**
 * @param {string} component
 * @param {string} event
 * @param {string} message
 * @param {Object} [context]
 */
function logDawnQueueError(component, event, message, context) {
  writeDawnQueueLog(DAWN_QUEUE_LOG_LEVEL.ERROR, component, event, message, context);
}

/**
 * @param {Object} [context]
 * @returns {string}
 */
function buildLogDetailsJson_(context) {
  if (!context) {
    return '';
  }

  var sanitized = {};
  var keys = Object.keys(context);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!DAWN_QUEUE_POLICIES.LOG_PII_IN_AUDIT && isPotentialPiiField_(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }
    sanitized[key] = context[key];
  }

  try {
    return JSON.stringify(sanitized);
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
}

/**
 * @param {string} fieldName
 * @returns {boolean}
 */
function isPotentialPiiField_(fieldName) {
  var normalized = String(fieldName).toLowerCase();
  return (
    normalized.indexOf('recipient') !== -1 ||
    normalized.indexOf('email') !== -1 ||
    normalized.indexOf('body') !== -1 ||
    normalized.indexOf('subject') !== -1
  );
}

/**
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncateLogText_(value, maxLength) {
  var text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
