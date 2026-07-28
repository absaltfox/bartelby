// Poll Scheduler — shared visibility-aware polling primitives.
//
// Every poll in the app used a bare setTimeout/setInterval, so a backgrounded
// tab kept issuing requests indefinitely. Each tick pays the fixed
// per-request middleware cost (session, Passport, application settings), so a
// forgotten jobs tab is a steady load on the app for nobody's benefit.
//
// These helpers never fire while document.visibilityState === 'hidden'. A
// deadline reached in the background is deferred and runs immediately when
// the tab comes back, so returning to a page shows fresh data at once rather
// than waiting out another interval.
//
// Shared behavior, so it lives here rather than being re-implemented per page
// (docs/ui-template-standards.md, Script Ownership Standards).
(function() {
  'use strict';

  function isHidden() {
    return typeof document.visibilityState === 'string' && document.visibilityState === 'hidden';
  }

  /**
   * Runs `fn` once, `delayMs` from now, but never while the tab is hidden.
   * Returns a handle with `cancel()`.
   */
  function schedule(fn, delayMs) {
    var cancelled = false;
    var timer = null;
    var waitingForVisibility = false;

    function onVisibilityChange() {
      if (cancelled || isHidden()) return;
      detach();
      fn();
    }

    function detach() {
      if (!waitingForVisibility) return;
      waitingForVisibility = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    timer = window.setTimeout(function() {
      timer = null;
      if (cancelled) return;
      if (isHidden()) {
        waitingForVisibility = true;
        document.addEventListener('visibilitychange', onVisibilityChange);
        return;
      }
      fn();
    }, delayMs);

    return {
      cancel: function() {
        cancelled = true;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        detach();
      }
    };
  }

  /**
   * Repeating, visibility-aware replacement for setInterval. Unlike
   * setInterval, the next tick is only scheduled once the previous one
   * settles, so a slow or hung request cannot stack up overlapping polls.
   * `fn` may return a promise. Returns a handle with `cancel()`.
   */
  function every(fn, intervalMs) {
    var cancelled = false;
    var pending = null;

    function armNext() {
      if (cancelled) return;
      pending = schedule(tick, intervalMs);
    }

    function tick() {
      if (cancelled) return;
      var result;
      try {
        result = fn();
      } catch (err) {
        armNext();
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(armNext, armNext);
      } else {
        armNext();
      }
    }

    pending = schedule(tick, intervalMs);

    return {
      cancel: function() {
        cancelled = true;
        if (pending) pending.cancel();
        pending = null;
      }
    };
  }

  /**
   * Capped exponential backoff for poll error paths, which otherwise retry at
   * a flat interval forever.
   */
  function createBackoff(baseMs, maxMs) {
    var current = baseMs;
    return {
      next: function() {
        var value = current;
        current = Math.min(current * 2, maxMs);
        return value;
      },
      reset: function() {
        current = baseMs;
      }
    };
  }

  window.PollScheduler = {
    schedule: schedule,
    every: every,
    createBackoff: createBackoff,
    isHidden: isHidden
  };
})();
