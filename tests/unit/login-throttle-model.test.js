'use strict';

// Per-account escalating delay for password-phase sign-in attempts (issue
// #101, Phase 1). The first few failures are free, then each further failure
// doubles a short wait, capped — a delay rather than a lockout, because at the
// password phase anyone can submit any username and a lockout would let them
// deny service to a named user.
//
// State is keyed by a hash of the submitted username, not by users.id, so an
// unknown username is throttled exactly like a real one and the delay cannot
// be used to tell them apart. Migration v92; per docs/db-migrations.md.

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const {
  initializeSchema,
  getAsync,
  loginThrottlesAsync,
  loginThrottleDelayMs,
  LOGIN_THROTTLE_FREE_ATTEMPTS,
  LOGIN_THROTTLE_MAX_MS,
  LOGIN_THROTTLE_WINDOW_MS
} = require('../../database/db');

let seq = 0;
function freshKey() {
  seq += 1;
  return loginThrottlesAsync.keyForUsername(`throttle-user-${seq}`);
}

async function fail(key, times, now) {
  let last;
  for (let i = 0; i < times; i += 1) {
    last = await loginThrottlesAsync.recordFailure(key, now);
  }
  return last;
}

beforeAll(async () => { await initializeSchema(); });

describe('v92 login_throttles migration', () => {
  test('creates the login_throttles table', async () => {
    const table = await getAsync(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_throttles'"
    );
    expect(table).toBeTruthy();
  });
});

describe('loginThrottleDelayMs', () => {
  test('the first failures carry no delay', () => {
    for (let n = 0; n <= LOGIN_THROTTLE_FREE_ATTEMPTS; n += 1) {
      expect(loginThrottleDelayMs(n)).toBe(0);
    }
  });

  test('doubles from one second after the free attempts', () => {
    const first = LOGIN_THROTTLE_FREE_ATTEMPTS + 1;
    expect(loginThrottleDelayMs(first)).toBe(1000);
    expect(loginThrottleDelayMs(first + 1)).toBe(2000);
    expect(loginThrottleDelayMs(first + 2)).toBe(4000);
    expect(loginThrottleDelayMs(first + 3)).toBe(8000);
  });

  test('is capped', () => {
    expect(loginThrottleDelayMs(LOGIN_THROTTLE_FREE_ATTEMPTS + 40)).toBe(LOGIN_THROTTLE_MAX_MS);
  });
});

describe('loginThrottlesAsync', () => {
  test('keys are case- and whitespace-insensitive and do not contain the username', () => {
    const key = loginThrottlesAsync.keyForUsername('  Some.User ');
    expect(key).toBe(loginThrottlesAsync.keyForUsername('some.user'));
    expect(key).not.toContain('some.user');
  });

  test('an untouched key has nothing to wait for', async () => {
    expect(await loginThrottlesAsync.getRemainingMs(freshKey())).toBe(0);
  });

  test('the free attempts do not start a wait', async () => {
    const key = freshKey();
    const now = 1_000_000;
    await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS, now);
    expect(await loginThrottlesAsync.getRemainingMs(key, now)).toBe(0);
  });

  test('the next failure starts a one-second wait that then expires', async () => {
    const key = freshKey();
    const now = 1_000_000;
    const result = await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS + 1, now);
    expect(result.attempts).toBe(LOGIN_THROTTLE_FREE_ATTEMPTS + 1);
    expect(await loginThrottlesAsync.getRemainingMs(key, now)).toBe(1000);
    expect(await loginThrottlesAsync.getRemainingMs(key, now + 400)).toBe(600);
    expect(await loginThrottlesAsync.getRemainingMs(key, now + 1000)).toBe(0);
  });

  test('further failures escalate the wait', async () => {
    const key = freshKey();
    const now = 1_000_000;
    await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS + 3, now);
    expect(await loginThrottlesAsync.getRemainingMs(key, now)).toBe(4000);
  });

  test('clear removes the wait and the count', async () => {
    const key = freshKey();
    const now = 1_000_000;
    await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS + 3, now);
    await loginThrottlesAsync.clear(key);
    expect(await loginThrottlesAsync.getRemainingMs(key, now)).toBe(0);
    expect((await loginThrottlesAsync.recordFailure(key, now)).attempts).toBe(1);
  });

  test('the count starts over once the window has passed without a failure', async () => {
    const key = freshKey();
    const now = 1_000_000;
    await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS + 3, now);
    const later = now + LOGIN_THROTTLE_WINDOW_MS + 1;
    expect((await loginThrottlesAsync.recordFailure(key, later)).attempts).toBe(1);
    expect(await loginThrottlesAsync.getRemainingMs(key, later)).toBe(0);
  });

  // Guesses sent at the same moment must each count. A read-then-write
  // increment lets every one of them read the same stale count and write the
  // same low number, so the wait would grow more slowly than the schedule says.
  test('concurrent failures are all counted', async () => {
    const key = freshKey();
    const now = 1_000_000;
    const burst = LOGIN_THROTTLE_FREE_ATTEMPTS + 3;
    await Promise.all(Array.from({ length: burst }, () => loginThrottlesAsync.recordFailure(key, now)));
    expect(await loginThrottlesAsync.getRemainingMs(key, now)).toBe(4000);
    expect((await loginThrottlesAsync.recordFailure(key, now)).attempts).toBe(burst + 1);
  });

  test('a concurrent burst after the window has passed starts one fresh run', async () => {
    const key = freshKey();
    const now = 1_000_000;
    await fail(key, LOGIN_THROTTLE_FREE_ATTEMPTS + 3, now);
    const later = now + LOGIN_THROTTLE_WINDOW_MS + 1;
    await Promise.all([1, 2].map(() => loginThrottlesAsync.recordFailure(key, later)));
    expect((await loginThrottlesAsync.recordFailure(key, later)).attempts).toBe(3);
  });

  // The wait is computed in SQL so the increment can stay atomic; this pins it
  // to the JavaScript schedule, including the cap.
  test('the stored wait matches loginThrottleDelayMs for every attempt count', async () => {
    const key = freshKey();
    const now = 1_000_000;
    for (let n = 1; n <= LOGIN_THROTTLE_FREE_ATTEMPTS + 12; n += 1) {
      const { attempts, throttledUntil } = await loginThrottlesAsync.recordFailure(key, now);
      const expected = loginThrottleDelayMs(n);
      expect(attempts).toBe(n);
      expect(throttledUntil).toBe(expected > 0 ? now + expected : null);
    }
  });

  test('one key does not affect another', async () => {
    const a = freshKey();
    const b = freshKey();
    const now = 1_000_000;
    await fail(a, LOGIN_THROTTLE_FREE_ATTEMPTS + 2, now);
    expect(await loginThrottlesAsync.getRemainingMs(b, now)).toBe(0);
  });
});
