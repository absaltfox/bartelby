'use strict';

// Regression test for #94.
//
// POST /account/mfa/email/enable refuses to turn on email MFA without an email
// address, but POST /account/profile had no mirror of that guard — so clearing
// the address while email MFA was active wrote NULL and permanently locked the
// account. The next sign-in dispatches on mfa_method === 'email' and reaches
// sendEmailOtp, which throws on a missing address; recovery is impossible
// through the UI because the admin password-reset flow refuses an account with
// no email, no route lets an admin edit another user's email, and no route
// lets an admin clear mfa_method.
//
// No attacker is required — an ordinary user can do this to themselves.
//
// utils/email is mocked (as in auth-email-flows.test.js) so the sign-in path
// can be driven end to end: the point of the guard is that the account can
// still complete an email-MFA sign-in afterwards, which DB columns alone
// cannot demonstrate.

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
const ADDRESS = 'curator@example.test';

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

describe('POST /account/profile cannot strand an email-MFA account (#94)', () => {
  let app;
  let db;
  let agent;
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

    const me = await db.usersAsync.findByUsername('testadmin');
    userId = me.id;

    // Occupies an address, for the duplicate-rejection case. Created once so
    // the file stays re-runnable — username and email are both UNIQUE.
    await db.usersAsync.create({
      username: 'someone-else',
      email: 'taken@example.test',
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: PASSWORD, _csrf: csrf(page.text) });
    expect(res.status).toBe(302);
  }, 30_000);

  // One session for the whole file. `authLimiter` (server.js) allows 20
  // requests per 15 minutes to /login and has no test-env skip, so logging in
  // per test exhausts it and later cases 429. The session is not stale state:
  // deserializeUser re-reads the user row on every request, so each test still
  // sees the mfa_method its own setup wrote.
  beforeEach(async () => {
    sendEmailOtp.mockClear();
    await db.usersAsync.setMfaMethod(userId, 'none');
    await db.usersAsync.updateEmail(userId, ADDRESS);
  });

  async function postProfile(email) {
    const account = await agent.get('/account');
    return agent
      .post('/account/profile')
      .type('form')
      .send({ email, _csrf: csrf(account.text) });
  }

  function errorFrom(res) {
    const loc = res.headers.location || '';
    const q = loc.includes('?') ? loc.slice(loc.indexOf('?') + 1) : '';
    return new URLSearchParams(q).get('error');
  }

  it('refuses to clear the address while email MFA is active', async () => {
    await db.usersAsync.setMfaMethod(userId, 'email');

    const res = await postProfile('');
    expect(res.status).toBe(302);
    expect(errorFrom(res)).toBe('Turn off email MFA before removing your email address.');

    const after = await db.usersAsync.findById(userId);
    expect(after.email).toBe(ADDRESS);
    expect(after.mfa_method).toBe('email');
  });

  it('treats a whitespace-only address as clearing it', async () => {
    await db.usersAsync.setMfaMethod(userId, 'email');

    const res = await postProfile('   ');
    expect(errorFrom(res)).toBe('Turn off email MFA before removing your email address.');
    expect((await db.usersAsync.findById(userId)).email).toBe(ADDRESS);
  });

  it('leaves the account able to complete an email-MFA sign-in afterwards', async () => {
    // The assertion the guard exists for. Without it the account reaches
    // sendEmailOtp with no address, which throws and bounces to /login.
    await db.usersAsync.setMfaMethod(userId, 'email');
    await postProfile('');

    const fresh = request.agent(app);
    const page = await fresh.get('/login');
    const res = await fresh
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: PASSWORD, _csrf: csrf(page.text) });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login/mfa');
    expect(sendEmailOtp).toHaveBeenCalledTimes(1);
    expect(sendEmailOtp.mock.calls[0][0].email).toBe(ADDRESS);
  });

  it('still allows clearing the address when email MFA is off', async () => {
    const res = await postProfile('');
    expect(errorFrom(res)).toBeNull();
    expect((await db.usersAsync.findById(userId)).email).toBeNull();
  });

  it('still allows changing to a different address while email MFA is active', async () => {
    await db.usersAsync.setMfaMethod(userId, 'email');

    const res = await postProfile('moved@example.test');
    expect(errorFrom(res)).toBeNull();
    expect((await db.usersAsync.findById(userId)).email).toBe('moved@example.test');
  });

  it('still rejects an address already in use', async () => {
    const res = await postProfile('taken@example.test');
    expect(errorFrom(res)).toBe('That email address is already in use.');
    expect((await db.usersAsync.findById(userId)).email).toBe(ADDRESS);
  });

  it('does not 500 on a non-string email body', async () => {
    const account = await agent.get('/account');
    const res = await agent
      .post('/account/profile')
      .type('form')
      .send(`email[]=a&email[]=b&_csrf=${encodeURIComponent(csrf(account.text))}`);

    expect(res.status).toBe(302);
    // Coerced to empty, so with MFA off this is a legitimate clear.
    expect((await db.usersAsync.findById(userId)).email).toBeNull();
  });

  it('enforces the invariant atomically, not just in the route', async () => {
    // The two-tab race: both requests pass their own check against a stale
    // snapshot. The conditional write is what actually holds the line.
    await db.usersAsync.setMfaMethod(userId, 'email');

    const cleared = await db.usersAsync.updateEmail(userId, null);
    expect(cleared).toBe(false);
    expect((await db.usersAsync.findById(userId)).email).toBe(ADDRESS);
  });

  it('will not switch email MFA on for an account with no address', async () => {
    await db.usersAsync.updateEmail(userId, null);

    const enabled = await db.usersAsync.setMfaMethod(userId, 'email');
    expect(enabled).toBe(false);
    expect((await db.usersAsync.findById(userId)).mfa_method).toBe('none');
  });
});
