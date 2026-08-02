'use strict';

// Covers public/js/poll-scheduler.js, the shared visibility-aware polling
// primitives introduced so a backgrounded tab stops issuing requests. Every
// poll tick pays the fixed per-request middleware cost, so an abandoned jobs
// tab was steady load for nobody's benefit.
//
// Mirrors the hand-rolled vm.runInNewContext DOM-mock style used by the other
// page-JS tests (the project has no jsdom dependency).
//
// Motivated by the 2026-07-27 front-end performance review
// (docs/reviews/2026-07-27-front-end-performance-review.md, finding P19).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPollScheduler() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'js', 'poll-scheduler.js'),
    'utf8'
  );

  const listeners = new Map();
  const documentMock = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const current = listeners.get(type) || [];
      listeners.set(type, current.filter((entry) => entry !== fn));
    }
  };

  const windowMock = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args)
  };

  const sandbox = { window: windowMock, document: documentMock };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);

  return {
    PollScheduler: windowMock.PollScheduler,
    documentMock,
    setVisibility(state) {
      documentMock.visibilityState = state;
      for (const fn of (listeners.get('visibilitychange') || []).slice()) fn();
    },
    listenerCount() {
      return (listeners.get('visibilitychange') || []).length;
    }
  };
}

describe('PollScheduler.schedule', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs the callback after the delay when the tab is visible', () => {
    const { PollScheduler } = loadPollScheduler();
    const fn = jest.fn();

    PollScheduler.schedule(fn, 5000);
    jest.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not run while the tab is hidden, and runs immediately on return', () => {
    const harness = loadPollScheduler();
    const fn = jest.fn();

    harness.documentMock.visibilityState = 'hidden';
    harness.PollScheduler.schedule(fn, 5000);

    jest.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();

    harness.setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    // The one-shot visibility listener is detached once it fires.
    expect(harness.listenerCount()).toBe(0);
  });

  it('cancel() prevents a pending run and detaches the visibility listener', () => {
    const harness = loadPollScheduler();
    const fn = jest.fn();

    harness.documentMock.visibilityState = 'hidden';
    const handle = harness.PollScheduler.schedule(fn, 1000);
    jest.advanceTimersByTime(1000);
    expect(harness.listenerCount()).toBe(1);

    handle.cancel();
    expect(harness.listenerCount()).toBe(0);

    harness.setVisibility('visible');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('PollScheduler.every', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('repeats on the interval while visible and stops on cancel', () => {
    const { PollScheduler } = loadPollScheduler();
    const fn = jest.fn();

    const handle = PollScheduler.every(fn, 1000);
    jest.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);

    handle.cancel();
    jest.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops ticking while hidden and resumes on return', () => {
    const harness = loadPollScheduler();
    const fn = jest.fn();

    harness.PollScheduler.every(fn, 1000);
    jest.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);

    harness.setVisibility('hidden');
    jest.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(2);

    harness.setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not stack overlapping ticks when the callback is slow', async () => {
    const { PollScheduler } = loadPollScheduler();
    let resolveTick;
    const fn = jest.fn(() => new Promise((resolve) => { resolveTick = resolve; }));

    PollScheduler.every(fn, 1000);
    jest.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // The in-flight tick has not settled, so no second tick is scheduled.
    jest.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveTick();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('PollScheduler.createBackoff', () => {
  it('doubles up to the cap and resets', () => {
    const { PollScheduler } = loadPollScheduler();
    const backoff = PollScheduler.createBackoff(15000, 120000);

    expect(backoff.next()).toBe(15000);
    expect(backoff.next()).toBe(30000);
    expect(backoff.next()).toBe(60000);
    expect(backoff.next()).toBe(120000);
    expect(backoff.next()).toBe(120000);

    backoff.reset();
    expect(backoff.next()).toBe(15000);
  });
});
