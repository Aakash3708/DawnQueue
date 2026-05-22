/**
 * DawnQueue — LockService wrappers for script-level mutual exclusion.
 */

/**
 * @returns {GoogleAppsScript.Lock.Lock | null}
 */
function acquireQueueLock() {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(DAWN_QUEUE_TIMING.LOCK_WAIT_MS);
  if (!acquired) {
    return null;
  }
  return lock;
}

/**
 * @param {GoogleAppsScript.Lock.Lock | null} lock
 */
function releaseQueueLock(lock) {
  if (!lock) {
    return;
  }
  try {
    lock.releaseLock();
  } catch (error) {
    // Lock may have expired; enqueue must still proceed to exit cleanly.
  }
}
