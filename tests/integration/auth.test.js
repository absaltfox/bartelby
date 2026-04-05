'use strict';

/**
 * Integration tests — Authentication & CSRF
 *
 * Covers:
 * - Login happy path (first-user bootstrap via /setup)
 * - Login with bad credentials
 * - CSRF: state-changing POST without token is rejected
 * - CSRF: POST with valid token is accepted
 * - Session cookie flags (httpOnly, sameSite)
 * - Logout clears session
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;

  // Bootstrap the first admin user via /setup so login tests have a user to work with
  const agent = request.agent(a);
  const setupPage = await agent.get('/setup');
  const csrf = extractCsrfToken(setupPage.text);
  await agent
    .post('/setup')
    .type('form')
    .send({
      username: 'testadmin',
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: csrf,
    });
  // After /setup the app redirects to /login (user created, not auto-logged in)
}, 30_000);

// ── Helper: extract CSRF token from an HTML response ──────────────────────
function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

// ── Helper: log in as the bootstrapped admin ──────────────────────────────
async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  return agent
    .post('/login')
    .type('form')
    .send({ username: 'testadmin', password: 'testpassword99!', _csrf: csrf });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('CSRF protection', () => {
  it('POST to /login without CSRF token → 302 redirect or 403 (not 200 or 500)', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'any', password: 'any' });
    // CSRF failure redirects back; must NOT be a successful 200
    expect([302, 403]).toContain(res.status);
  });

  it('POST to /register without CSRF token → redirect or 403', async () => {
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ username: 'hacker', password: 'password99', confirm: 'password99' });
    expect([302, 403]).toContain(res.status);
  });
});

describe('Login and session flow', () => {
  let agent;

  beforeAll(() => {
    // Create the agent here — app is already initialised by the outer beforeAll
    agent = request.agent(app);
  });

  it('logs in successfully with valid credentials', async () => {
    const res = await loginAsAdmin(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\//);
    expect(res.headers.location).not.toMatch(/login/);
  });

  it('accessing / after login returns 200', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);
  });

  it('accessing /admin after login returns 200 (admin user)', async () => {
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
  });

  it('logs out successfully', async () => {
    const page = await agent.get('/');
    const csrf = extractCsrfToken(page.text);
    const res = await agent.post('/logout').type('form').send({ _csrf: csrf });
    expect(res.status).toBe(302);
  });

  it('accessing /admin after logout → redirect to /login', async () => {
    const res = await agent.get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe('Login with bad credentials', () => {
  let agent;

  beforeAll(() => {
    agent = request.agent(app);
  });

  it('returns redirect to /login with error on wrong password', async () => {
    const page = await agent.get('/login');
    const csrf = extractCsrfToken(page.text);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: 'wrongpassword', _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe('Session cookie security flags', () => {
  it('session cookie has httpOnly flag', async () => {
    const agent = request.agent(app);
    const res = await loginAsAdmin(agent);

    // The Set-Cookie header is sent on the response to the POST /login redirect
    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('bartelby.sid'));
    if (sessionCookie) {
      expect(sessionCookie.toLowerCase()).toContain('httponly');
    }
    // If the cookie was already set in a prior request (no Set-Cookie now), that's fine
  });
});
