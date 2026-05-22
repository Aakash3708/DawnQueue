/**
 * DawnQueue — timezone normalization, business-hours checks, schedule jitter.
 */

/**
 * @param {Date} [referenceDate]
 * @returns {Date}
 */
function getReferenceDateOrNow(referenceDate) {
  return referenceDate instanceof Date ? referenceDate : new Date();
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {{ hour: number, minute: number, dayOfWeek: number }}
 */
function getZonedTimeParts(date, timezone) {
  var hour = parseInt(Utilities.formatDate(date, timezone, 'H'), 10);
  var minute = parseInt(Utilities.formatDate(date, timezone, 'm'), 10);
  var dayOfWeek = parseInt(Utilities.formatDate(date, timezone, 'u'), 10);
  return {
    hour: hour,
    minute: minute,
    dayOfWeek: dayOfWeek,
  };
}

/**
 * @returns {number}
 */
function getBusinessHoursStartMinutes_() {
  return (
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_HOUR * 60 +
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_MINUTE
  );
}

/**
 * @returns {number}
 */
function getBusinessHoursEndMinutes_() {
  return (
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_END_HOUR * 60 +
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_END_MINUTE
  );
}

/**
 * @param {Date} [referenceDate]
 * @returns {boolean}
 */
function isBusinessDay(referenceDate) {
  var date = getReferenceDateOrNow(referenceDate);
  var parts = getZonedTimeParts(date, DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE);
  var allowedDays = DAWN_QUEUE_POLICIES.BUSINESS_DAYS;
  for (var i = 0; i < allowedDays.length; i++) {
    if (allowedDays[i] === parts.dayOfWeek) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when referenceDate falls within Asia/Kolkata business window (09:45–18:00)
 * on an allowed business day. When business hours are disabled in policy, always true.
 *
 * @param {Date} [referenceDate]
 * @returns {boolean}
 */
function isWithinBusinessHours(referenceDate) {
  if (!DAWN_QUEUE_POLICIES.SCHEDULING_RESPECT_BUSINESS_HOURS) {
    return true;
  }

  var date = getReferenceDateOrNow(referenceDate);
  if (!isBusinessDay(date)) {
    return false;
  }

  var parts = getZonedTimeParts(date, DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE);
  var nowMinutes = parts.hour * 60 + parts.minute;
  var startMinutes = getBusinessHoursStartMinutes_();
  var endMinutes = getBusinessHoursEndMinutes_();

  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

/**
 * Uniform random jitter in [-JITTER_MAX_SECONDS, +JITTER_MAX_SECONDS].
 *
 * @returns {number} milliseconds
 */
function calculateScheduleJitterMs() {
  if (!DAWN_QUEUE_TIMING.JITTER_ENABLED) {
    return 0;
  }

  if (DAWN_QUEUE_POLICIES.JITTER_DISTRIBUTION === 'NONE') {
    return 0;
  }

  var maxMs = DAWN_QUEUE_TIMING.JITTER_MAX_SECONDS * 1000;
  var randomFactor = Math.random() * 2 - 1;
  return Math.round(randomFactor * maxMs);
}

/**
 * @param {Date} baseDate
 * @param {number} gapMinutes
 * @returns {Date}
 */
function addMinutesToDate(baseDate, gapMinutes) {
  var result = new Date(baseDate.getTime());
  result.setMinutes(result.getMinutes() + gapMinutes);
  return result;
}

/**
 * @param {Date} baseDate
 * @param {number} jitterMs
 * @returns {Date}
 */
function applyJitterToDate(baseDate, jitterMs) {
  return new Date(baseDate.getTime() + jitterMs);
}

/**
 * @param {Date} date
 * @param {string} [timezone]
 * @returns {string}
 */
function formatDateInTimezone(date, timezone) {
  var tz = timezone || DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE;
  return Utilities.formatDate(date, tz, "yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * @returns {number}
 */
function getEnqueueElapsedMs(startedAtMs) {
  return Date.now() - startedAtMs;
}

/**
 * @param {number} startedAtMs
 * @returns {boolean}
 */
function hasEnqueueExecutionCutoffElapsed(startedAtMs) {
  return hasExecutionCutoffElapsed(startedAtMs);
}

/**
 * Shared Apps Script safety cutoff (5m 30s) for enqueue, scheduler, and send worker.
 * @param {number} startedAtMs
 * @returns {boolean}
 */
function hasExecutionCutoffElapsed(startedAtMs) {
  return (
    getEnqueueElapsedMs(startedAtMs) >= DAWN_QUEUE_TIMING.ENQUEUE_EXECUTION_CUTOFF_MS
  );
}

/**
 * If candidate is outside business hours or on a non-business day, forward-schedule
 * to the next valid 09:45 Asia/Kolkata window.
 *
 * @param {Date} candidate
 * @returns {Date}
 */
function alignToBusinessHoursWindow(candidate) {
  var date = getReferenceDateOrNow(candidate);
  if (isWithinBusinessHours(date)) {
    return date;
  }
  return getNextBusinessWindowStart(date);
}

/**
 * @param {Date} fromDate
 * @returns {Date}
 */
function getNextBusinessWindowStart(fromDate) {
  var timezone = DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE;
  var cursor = getReferenceDateOrNow(fromDate);

  for (var safety = 0; safety < 400; safety++) {
    if (isBusinessDay(cursor)) {
      var parts = getZonedTimeParts(cursor, timezone);
      var nowMinutes = parts.hour * 60 + parts.minute;
      var startMinutes = getBusinessHoursStartMinutes_();
      var endMinutes = getBusinessHoursEndMinutes_();

      if (nowMinutes < startMinutes) {
        return buildZonedDateTime_(
          cursor,
          DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_HOUR,
          DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_MINUTE
        );
      }

      if (nowMinutes > endMinutes) {
        cursor = advanceToNextCalendarDay_(cursor, timezone);
        continue;
      }

      return cursor;
    }

    cursor = advanceToNextCalendarDay_(cursor, timezone);
  }

  throw new Error('Unable to resolve the next business window within safety bounds.');
}

/**
 * @param {Date} baseDate
 * @param {string} timezone
 * @returns {Date}
 */
function advanceToNextCalendarDay_(baseDate, timezone) {
  var year = parseInt(Utilities.formatDate(baseDate, timezone, 'yyyy'), 10);
  var month = parseInt(Utilities.formatDate(baseDate, timezone, 'MM'), 10);
  var day = parseInt(Utilities.formatDate(baseDate, timezone, 'dd'), 10);
  var nextDay = new Date(year, month - 1, day + 1, 12, 0, 0);
  return buildZonedDateTime_(
    nextDay,
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_HOUR,
    DAWN_QUEUE_POLICIES.BUSINESS_HOURS_START_MINUTE
  );
}

/**
 * @param {Date} baseDate
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
function buildZonedDateTime_(baseDate, hour, minute) {
  var timezone = DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE;
  var year = parseInt(Utilities.formatDate(baseDate, timezone, 'yyyy'), 10);
  var month = parseInt(Utilities.formatDate(baseDate, timezone, 'MM'), 10);
  var day = parseInt(Utilities.formatDate(baseDate, timezone, 'dd'), 10);
  var dateString = Utilities.formatString(
    '%04d-%02d-%02d %02d:%02d:00',
    year,
    month,
    day,
    hour,
    minute
  );
  return Utilities.parseDate(dateString, timezone, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * @param {Date} left
 * @param {Date} right
 * @returns {Date}
 */
function maxDate(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
}

/**
 * @returns {string}
 */
function getBusinessDateKeyInTimezone() {
  var timezone = DAWN_QUEUE_POLICIES.BUSINESS_HOURS_TIMEZONE;
  return Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
}
