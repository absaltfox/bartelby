'use strict';

// Regression test for #87.
//
// The MFA failure counter lived on req.session.pendingLogin — state the
// attacker controls — and the 10-minute lock it set never existed at all: the
// handler assigned `lockedUntil` onto the pending object and then deleted that
// object on the very next line, so both readers of it were dead code.
//
// The counter and lock are now columns on the user row, so dropping the session
// cookie and re-authenticating does not reset them. Keying by account is safe
// here because a pendingLogin is only minted after the password check passes.
//
// HTTP is used sparingly and deliberately. `authLimiter` (server.js) is a single
// IP-keyed instance shared by /login, /register, /setup and /reset-password, and
// it prefix-matches /login/mfa — so a sign-in round costs three of a
// twenty-request budget (GET /login, POST /login, POST /login/mfa), and the
// setup in beforeAll draws two more from the same bucket. The counter semantics
// are exercised against the model; HTTP covers only the parts where route
// wiring is the thing under test. Adding HTTP cases here needs that budget
// checked.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const cheerio = require('cheerio');
const request = require('supertest');

const PASSWORD = 'testpassword99!';
const WRONG_CODE = '000000';

const sendEmailOtp = jest.fn(async () => {});
jest.doMock('../../utils/email', () => ({
  isSmtpConfigured: () => true,
  sendEmailOtp,
  sendInviteEmail: jest.fn(async () => {}),
  sendPasswordResetEmail: jest.fn(async () => {})
}));

function csrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="_csrf"]').first().attr('value')
    || $('meta[name="csrf-token"]').first().attr('content');
}

let app;
let db;
let userId;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  await setupAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'testadmin',
      password: PASSWORD,
      confirm: PASSWORD,
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: csrf(setupPage.text)
    });

  userId = await db.usersAsync.create({
    username: 'mfauser',
    email: 'mfauser@example.test',
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });
  await db.usersAsync.setMfaMethod(userId, 'email');
}, 30_000);

beforeEach(async () => {
  await db.usersAsync.clearMfaFailures(userId);
  sendEmailOtp.mockClear();
});

describe('MFA failure state lives on the user row (#87)', () => {
  it('has the columns on an initialised database', async () => {
    const cols = await db.getDb().all('PRAGMA table_info(users)');
    const names = cols.map((c) => c.name);
    expect(names).toContain('mfa_failed_attempts');
    expect(names).toContain('mfa_locked_until');
  });

  it('counts failures and trips a lock at the threshold', async () => {
    for (let i = 1; i <= 4; i++) {
      const { attempts, lockedUntil } = await db.usersAsync.recordMfaFailure(userId);
      expect(attempts).toBe(i);
      expect(lockedUntil).toBeNull();
    }

    const fifth = await db.usersAsync.recordMfaFailure(userId);
    expect(fifth.attempts).toBe(5);
    expect(fifth.lockedUntil).toBeGreaterThan(Date.now());

    const row = await db.usersAsync.findById(userId);
    // The counter keeps climbing across lockouts — see the escalation test.
    expect(Number(row.mfa_failed_attempts)).toBe(5);
    expect(Number(row.mfa_locked_until)).toBe(fifth.lockedUntil);
  });

  it('escalates each successive lock instead of granting a fresh budget', async () => {
    const durations = [];
    for (let trip = 1; trip <= 3; trip++) {
      let result;
      for (let i = 0; i < 5; i++) result = await db.usersAsync.recordMfaFailure(userId);
      expect(result.lockedUntil).toBeGreaterThan(Date.now());
      durations.push(result.lockedUntil - Date.now());
      // Clear only the lock, not the counter — that is what an attacker gets by
      // waiting out the window.
      await db.getDb().run('UPDATE users SET mfa_locked_until = NULL WHERE id = ?', [userId]);
    }

    // Doubling: without this an attacker has 5 guesses every 10 minutes,
    // forever, which is ~720/day against a six-digit code.
    expect(durations[1]).toBeGreaterThan(durations[0] * 1.9);
    expect(durations[2]).toBeGreaterThan(durations[1] * 1.9);
  });

  it('caps the escalation so an account is never locked out permanently', async () => {
    const { MFA_LOCK_MAX_MS } = db;
    await db.getDb().run('UPDATE users SET mfa_failed_attempts = ? WHERE id = ?', [995, userId]);
    const result = await db.usersAsync.recordMfaFailure(userId);
    expect(result.lockedUntil - Date.now()).toBeLessThanOrEqual(MFA_LOCK_MAX_MS + 1000);
  });

  it('leaves an outstanding email OTP alone when the lock trips', async () => {
    // Burning it would only ever punish the legitimate user: the attacker holds
    // the password by construction and can mint a new code from POST /login.
    // The code's own 10-minute TTL already matches the base lock.
    await db.usersAsync.storeEmailOtp(userId, '123456', new Date(Date.now() + 600_000).toISOString());
    for (let i = 0; i < 5; i++) await db.usersAsync.recordMfaFailure(userId);

    expect((await db.usersAsync.findById(userId)).mfa_email_otp_hash).toBeTruthy();
  });

  it('reports remaining lock time and lets it expire', async () => {
    await db.getDb().run('UPDATE users SET mfa_locked_until = ? WHERE id = ?', [Date.now() + 60_000, userId]);
    expect(await db.usersAsync.getMfaLockRemaining(userId)).toBeGreaterThan(0);

    await db.getDb().run('UPDATE users SET mfa_locked_until = ? WHERE id = ?', [Date.now() - 1000, userId]);
    expect(await db.usersAsync.getMfaLockRemaining(userId)).toBe(0);

    await db.getDb().run('UPDATE users SET mfa_locked_until = NULL WHERE id = ?', [userId]);
    expect(await db.usersAsync.getMfaLockRemaining(userId)).toBe(0);
  });

  it('clearMfaFailures resets both columns', async () => {
    for (let i = 0; i < 5; i++) await db.usersAsync.recordMfaFailure(userId);
    await db.usersAsync.clearMfaFailures(userId);

    const row = await db.usersAsync.findById(userId);
    expect(Number(row.mfa_failed_attempts)).toBe(0);
    expect(row.mfa_locked_until).toBeFalsy();
  });
});

describe('the MFA route reads and writes that state (#87)', () => {
  async function loginToMfa() {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'mfauser', password: PASSWORD, _csrf: csrf(page.text) });
    expect(res.status).toBe(302);
    return { agent, location: res.headers.location, csrfToken: csrf(page.text) };
  }

  it('records a failed code against the user row, not the session', async () => {
    const { agent, location, csrfToken } = await loginToMfa();
    expect(location).toBe('/login/mfa');

    const res = await agent
      .post('/login/mfa')
      .type('form')
      .send({ code: WRONG_CODE, _csrf: csrfToken });
    expect(res.headers.location).toBe('/login/mfa');

    // The whole point: the attacker's session is gone but the count is not.
    expect(Number((await db.usersAsync.findById(userId)).mfa_failed_attempts)).toBe(1);
  });

  it('refuses a CORRECT code while locked', async () => {
    // The load-bearing case. If the lock check were moved below `if (!valid)`
    // — a plausible refactor — a locked account would be fully bypassable by
    // anyone holding a live code, and a wrong-code test would stay green.
    const { agent, csrfToken } = await loginToMfa();
    const code = sendEmailOtp.mock.calls.at(-1)[1];

    await db.getDb().run('UPDATE users SET mfa_locked_until = ? WHERE id = ?', [
      Date.now() + 60_000, userId
    ]);

    const res = await agent
      .post('/login/mfa')
      .type('form')
      .send({ code, _csrf: csrfToken });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('refuses to start a new sign-in — and send another code — while locked', async () => {
    // Without this the lock is close to useless: the attacker holds the
    // password by construction, so re-POSTing /login would hand them a fresh
    // live OTP, and from many IPs would pump mail at the victim.
    await db.getDb().run('UPDATE users SET mfa_locked_until = ? WHERE id = ?', [
      Date.now() + 60_000, userId
    ]);
    sendEmailOtp.mockClear();

    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'mfauser', password: PASSWORD, _csrf: csrf(page.text) });

    expect(res.headers.location).toBe('/login');
    expect(sendEmailOtp).not.toHaveBeenCalled();
  });

  it('clears the counter on a successful verification', async () => {
    await db.usersAsync.recordMfaFailure(userId);
    expect(Number((await db.usersAsync.findById(userId)).mfa_failed_attempts)).toBe(1);

    const { agent, csrfToken } = await loginToMfa();
    const code = sendEmailOtp.mock.calls.at(-1)[1];
    const res = await agent
      .post('/login/mfa')
      .type('form')
      .send({ code, _csrf: csrfToken });

    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/login/mfa');

    const row = await db.usersAsync.findById(userId);
    expect(Number(row.mfa_failed_attempts)).toBe(0);
    expect(row.mfa_locked_until).toBeFalsy();
  });
});
