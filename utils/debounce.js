// =============================================================================
// utils/debounce.js
// Lightweight debounce and throttle utilities.
// Imported by popup.js for slider inputs, and inlined in injected.js
// (which can't safely use ES imports from the page context).
// =============================================================================

/**
 * Returns a debounced version of `fn` that fires only after `wait` ms
 * have elapsed since its last invocation.
 *
 * Use for: seek bar mouseup, settings input fields.
 *
 * @param {Function} fn   - The function to debounce.
 * @param {number}   wait - Quiet period in milliseconds. Default: 150ms.
 * @returns {Function}
 */
export function debounce(fn, wait = 150) {
  let timerId;
  return function debounced(...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      fn.apply(this, args);
    }, wait);
  };
}

/**
 * Returns a throttled version of `fn` that fires at most once per `limit` ms.
 * Unlike debounce, the function fires immediately on the FIRST call, then
 * is silenced until the interval has passed.
 *
 * Use for: volume slider drag, seek bar live preview (while dragging).
 *
 * @param {Function} fn    - The function to throttle.
 * @param {number}   limit - Minimum interval in milliseconds. Default: 100ms.
 * @returns {Function}
 */
export function throttle(fn, limit = 100) {
  let lastCall = 0;
  let timerId = null;

  return function throttled(...args) {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      // Enough time has passed — fire immediately
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      lastCall = now;
      fn.apply(this, args);
    } else if (!timerId) {
      // Schedule a trailing call so the final value is always flushed
      timerId = setTimeout(() => {
        lastCall = Date.now();
        timerId = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}
