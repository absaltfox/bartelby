'use strict';

/**
 * Integration tests — escalating delay on password-phase sign-in attempts
 * (issue #101, Phase 1).
 *
 * The shared per-IP limiter on /login allows 20 requests per 15 minutes and
 * has no test-env skip, so each case fetches the form once and most failures
 * are recorded straight on the model rather than by posting.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

const PASSWORD = 'testpassword99!';
const THROTTLED = /^Too many sign-in attempts\. Try again in \d+ seconds?\.$/;

let app;
let db;
let bcrypt;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

function flashFrom(html) {
  const match = html.match(/class="alert alert-error"[^>]*>\s*([^<]*)</);
  return match ? match[1].trim() : null;
}

// One agent, one CSRF token, any number of sign-in posts.
async function signInForm() {
  const agent = request.agent(app);
  const csrf = extractCsrfToken((await agent.get('/login')).text);
  return {
    agent,
    post: (username, password) => agent.post('/login').type('form').send({ username, password, _csrf: csrf })
  };
}

async function recordFailures(username, times) {
  const key = db.loginThrottlesAsync.keyForUsername(username);
  for (let i = 0; i < times; i += 1) {
    await db.loginThrottlesAsync.recordFailure(key);
  }
}

async function newUser(username) {
  const { hashPassword } = require('../../utils/passwords');
  return db.usersAsync.create({
    username,
    email: `${username}@example.test`,
    passwordHash: await hashPassword(PASSWORD),
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });
}

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');
  bcrypt = require('bcryptjs');
  // Any user at all, so /login does not redirect to first-run setup.
  await newUser('throttleseed');
}, 60_000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /login escalating delay', () => {
  it('a wrong password is counted against the submitted username', async () => {
    await newUser('throttlecount');
    const form = await signInForm();
    await form.post('throttlecount', 'wrong-password');
    const key = db.loginThrottlesAsync.keyForUsername('throttlecount');
    expect((await db.loginThrottlesAsync.recordFailure(key)).attempts).toBe(2);
  });

  it('refuses even the correct password while the wait is running', async () => {
    await newUser('throttlewait');
    await recordFailures('throttlewait', db.LOGIN_THROTTLE_FREE_ATTEMPTS + 4);

    const compare = jest.spyOn(bcrypt, 'compare');
    const form = await signInForm();
    const res = await form.post('throttlewait', PASSWORD);

    expect(res.headers.location).toBe('/login');
    expect(flashFrom((await form.agent.get('/login')).text)).toMatch(THROTTLED);
    // Refused on arrival: no hash is spent, and the request does not sit open.
    expect(compare).not.toHaveBeenCalled();
  });

  it('treats an unknown username exactly like a real one', async () => {
    await recordFailures('nobody-by-this-name', db.LOGIN_THROTTLE_FREE_ATTEMPTS + 4);

    const form = await signInForm();
    const res = await form.post('nobody-by-this-name', 'whatever-password');

    expect(res.headers.location).toBe('/login');
    expect(flashFrom((await form.agent.get('/login')).text)).toMatch(THROTTLED);
  });

  it('a successful sign-in clears the count', async () => {
    await newUser('throttleclear');
    await recordFailures('throttleclear', db.LOGIN_THROTTLE_FREE_ATTEMPTS);

    const form = await signInForm();
    expect((await form.post('throttleclear', PASSWORD)).headers.location).toBe('/');

    const key = db.loginThrottlesAsync.keyForUsername('throttleclear');
    expect((await db.loginThrottlesAsync.recordFailure(key)).attempts).toBe(1);
  });

  it('does not delay a user who mistypes once or twice', async () => {
    await newUser('throttletypo');
    const form = await signInForm();
    await form.post('throttletypo', 'wrong-password');
    await form.post('throttletypo', 'wrong-password');
    expect((await form.post('throttletypo', PASSWORD)).headers.location).toBe('/');
  });
});
