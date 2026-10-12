'use strict';

/**
 * Integration tests — step-up authentication on account-security changes and
 * self-serve password change (issue #86).
 *
 * A session cookie plus a CSRF token used to be enough to disable MFA, bind a
 * new authenticator, or repoint the account email. Each of those now also
 * needs the current password, so a borrowed session cannot be turned into a
 * lockout or a captured recovery channel. Users can also change their own
 * password, which signs out every other session.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DATA_ENCRYPTION_KEY = 'test-data-encryption-key-for-jest-only';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const cheerio = require('cheerio');
const request = require('supertest');

const PASSWORD = 'testpassword99!';
const ADDRESS = 'stepup@example.test';
const NEEDS_PASSWORD = 'Enter your current password to make this change.';

let app;
let db;
let mfa;
let userId;
let agent;

function csrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="_csrf"]').first().attr('value')
    || $('meta[name="csrf-token"]').first().attr('content');
}

function errorFrom(res) {
  const loc = res.headers.location || '';
  const q = loc.includes('?') ? loc.slice(loc.indexOf('?') + 1) : '';
  return new URLSearchParams(q).get('error');
}

async function login(username, password) {
  const a = request.agent(app);
  const page = await a.get('/login');
  const res = await a.post('/login').type('form').send({ username, password, _csrf: csrf(page.text) });
  return { agent: a, res };
}

async function post(a, path, fields = {}) {
  const account = await a.get('/account');
  return a.post(path).type('form').send({ ...fields, _csrf: csrf(account.text) });
}

async function currentUser() {
  return db.usersAsync.findById(userId);
}

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');
  mfa = require('../../utils/mfa');
  const { hashPassword } = require('../../utils/passwords');

  userId = await db.usersAsync.create({
    username: 'stepupuser',
    email: ADDRESS,
    passwordHash: await hashPassword(PASSWORD),
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });
  ({ agent } = await login('stepupuser', PASSWORD));
}, 60_000);

// The session outlives each case; deserializeUser re-reads the row per request.
beforeEach(async () => {
  await db.usersAsync.setMfaMethod(userId, 'none');
  await db.usersAsync.setTotpSecret(userId, null);
  await db.usersAsync.updateEmail(userId, ADDRESS);
});

describe('POST /account/mfa/disable', () => {
  beforeEach(async () => { await db.usersAsync.setMfaMethod(userId, 'totp'); });

  it('is refused without the current password', async () => {
    const res = await post(agent, '/account/mfa/disable');
    expect(errorFrom(res)).toBe(NEEDS_PASSWORD);
    expect((await currentUser()).mfa_method).toBe('totp');
  });

  it('is refused with a wrong current password', async () => {
    const res = await post(agent, '/account/mfa/disable', { current_password: 'not-the-password' });
    expect(errorFrom(res)).toBe(NEEDS_PASSWORD);
    expect((await currentUser()).mfa_method).toBe('totp');
  });

  it('succeeds with the current password', async () => {
    const res = await post(agent, '/account/mfa/disable', { current_password: PASSWORD });
    expect(res.headers.location).toBe('/account?saved=1');
    expect((await currentUser()).mfa_method).toBe('none');
  });
});

describe('POST /account/mfa/totp/confirm', () => {
  async function startSetupAndGetCode() {
    await post(agent, '/account/mfa/totp/setup');
    const page = await agent.get('/account');
    const secret = cheerio.load(page.text)('.account-totp-copy input').attr('value');
    return mfa.totpAt(secret);
  }

  it('does not bind an authenticator on a valid code alone', async () => {
    const code = await startSetupAndGetCode();
    const res = await post(agent, '/account/mfa/totp/confirm', { code });
    expect(errorFrom(res)).toBe(NEEDS_PASSWORD);
    expect((await currentUser()).mfa_method).toBe('none');
  });

  it('binds the authenticator with a valid code and the current password', async () => {
    const code = await startSetupAndGetCode();
    const res = await post(agent, '/account/mfa/totp/confirm', { code, current_password: PASSWORD });
    expect(res.headers.location).toBe('/account?saved=1');
    expect((await currentUser()).mfa_method).toBe('totp');
  });
});

describe('POST /account/profile', () => {
  it('does not change the email without the current password', async () => {
    const res = await post(agent, '/account/profile', { email: 'attacker@example.test' });
    expect(errorFrom(res)).toBe(NEEDS_PASSWORD);
    expect((await currentUser()).email).toBe(ADDRESS);
  });

  it('changes the email with the current password', async () => {
    const res = await post(agent, '/account/profile', {
      email: 'moved@example.test', current_password: PASSWORD
    });
    expect(res.headers.location).toBe('/account?saved=1');
    expect((await currentUser()).email).toBe('moved@example.test');
  });
});

describe('GET /account', () => {
  it('asks for the current password on each protected form', async () => {
    await db.usersAsync.setMfaMethod(userId, 'totp');
    const $ = cheerio.load((await agent.get('/account')).text);
    for (const action of ['/account/profile', '/account/mfa/disable', '/account/password']) {
      expect($(`form[action="${action}"] input[name="current_password"]`).length).toBe(1);
    }
  });

  it('hides Disable MFA when no method is active', async () => {
    const $ = cheerio.load((await agent.get('/account')).text);
    expect($('form[action="/account/mfa/disable"]').length).toBe(0);
  });
});

describe('POST /account/password', () => {
  const NEW_PASSWORD = 'a-brand-new-password-1';

  async function passwordHash() {
    return (await currentUser()).password_hash;
  }

  it('is refused with a wrong current password', async () => {
    const before = await passwordHash();
    const res = await post(agent, '/account/password', {
      current_password: 'not-the-password', new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD
    });
    expect(errorFrom(res)).toBe(NEEDS_PASSWORD);
    expect(await passwordHash()).toBe(before);
  });

  it('is refused when the confirmation does not match', async () => {
    const before = await passwordHash();
    const res = await post(agent, '/account/password', {
      current_password: PASSWORD, new_password: NEW_PASSWORD, confirm_password: 'something-else-1'
    });
    expect(errorFrom(res)).toBe('New passwords do not match.');
    expect(await passwordHash()).toBe(before);
  });

  it('is refused when the new password is too short', async () => {
    const before = await passwordHash();
    const res = await post(agent, '/account/password', {
      current_password: PASSWORD, new_password: 'short', confirm_password: 'short'
    });
    expect(errorFrom(res)).toBe('Password must be at least 8 characters.');
    expect(await passwordHash()).toBe(before);
  });

  // Last: it changes the password the other cases sign in with.
  it('changes the password, keeps this session, and signs out the others', async () => {
    const other = (await login('stepupuser', PASSWORD)).agent;
    expect((await other.get('/account')).status).toBe(200);

    const res = await post(agent, '/account/password', {
      current_password: PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD
    });
    expect(res.headers.location).toBe('/account?saved=1');

    expect((await agent.get('/account')).status).toBe(200);
    const evicted = await other.get('/account');
    expect(evicted.status).toBe(302);
    expect(evicted.headers.location).toBe('/login');

    expect((await login('stepupuser', PASSWORD)).res.headers.location).toBe('/login');
    expect((await login('stepupuser', NEW_PASSWORD)).res.headers.location).toBe('/');
  });
});
