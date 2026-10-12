'use strict';

/**
 * Integration tests — invite and password-reset links are not kept in the
 * session (issue #91).
 *
 * The raw token only exists at creation time (the database holds its hash), so
 * the link has to be shown once. It must not be parked in the session flash to
 * do that: an admin who never loads /admin/users would leave a live bearer
 * token in the session store for the cookie's whole lifetime.
 *
 * - Email delivered: the link is not shown or stored at all.
 * - No SMTP (or delivery failed): the link is rendered straight into the POST
 *   response and is gone on the next page load.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

const INVITE_LINK = /\/invite\/[0-9a-f]{48}/;
const RESET_LINK = /\/reset-password\/[0-9a-f]{48}/;

let app;
let db;
let email;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(username, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ username, password, _csrf: extractCsrfToken(page.text) });
  return agent;
}

async function csrfFor(agent) {
  return extractCsrfToken((await agent.get('/admin/users/invite')).text);
}

// The token-generation limiter allows three per admin per hour, so each test
// acts as its own admin.
async function newAdminAgent(name) {
  const { hashPassword } = require('../../utils/passwords');
  await db.usersAsync.create({
    username: name,
    email: `${name}@example.test`,
    passwordHash: await hashPassword('testpassword99!'),
    role: 'admin',
    status: 'active',
    accessAll: true,
    canUseSystemApiKeys: true
  });
  return login(name, 'testpassword99!');
}

async function newActiveUser(name) {
  return db.usersAsync.create({
    username: name,
    email: `${name}@example.test`,
    passwordHash: 'unused',
    role: 'user',
    status: 'active'
  });
}

beforeAll(async () => {
  jest.resetModules();
  jest.doMock('../../utils/email', () => ({
    ...jest.requireActual('../../utils/email'),
    isSmtpConfigured: jest.fn(() => false),
    sendInviteEmail: jest.fn(async () => {}),
    sendPasswordResetEmail: jest.fn(async () => {})
  }));
  email = require('../../utils/email');
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  await setupAgent.post('/setup').type('form').send({
    username: 'tokenlinkroot',
    password: 'testpassword99!',
    confirm: 'testpassword99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: extractCsrfToken(setupPage.text)
  });
}, 60_000);

beforeEach(() => {
  email.isSmtpConfigured.mockReturnValue(false);
  email.sendInviteEmail.mockReset().mockResolvedValue(undefined);
  email.sendPasswordResetEmail.mockReset().mockResolvedValue(undefined);
});

describe('invite link', () => {
  it('without SMTP, is shown once in the response and not on the next page load', async () => {
    const agent = await newAdminAgent('tokenadmin1');
    const res = await agent.post('/admin/users/invite').type('form').send({
      email: 'invitee1@example.test', role: 'user', _csrf: await csrfFor(agent)
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(INVITE_LINK);
    expect(res.headers['cache-control']).toMatch(/no-store/);

    const next = await agent.get('/admin/users');
    expect(next.text).not.toMatch(INVITE_LINK);
  });

  it('when the email is delivered, is never shown or stored', async () => {
    email.isSmtpConfigured.mockReturnValue(true);
    const agent = await newAdminAgent('tokenadmin2');
    const res = await agent.post('/admin/users/invite').type('form').send({
      email: 'invitee2@example.test', role: 'user', _csrf: await csrfFor(agent)
    });
    expect(res.status).toBe(302);
    expect(email.sendInviteEmail).toHaveBeenCalledTimes(1);

    const next = await agent.get('/admin/users');
    expect(next.text).toContain('emailed to invitee2@example.test');
    expect(next.text).not.toMatch(INVITE_LINK);
  });

  it('when delivery fails, is shown once in the response so the admin can pass it on', async () => {
    email.isSmtpConfigured.mockReturnValue(true);
    email.sendInviteEmail.mockRejectedValue(new Error('smtp down'));
    const agent = await newAdminAgent('tokenadmin3');
    const res = await agent.post('/admin/users/invite').type('form').send({
      email: 'invitee3@example.test', role: 'user', _csrf: await csrfFor(agent)
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(INVITE_LINK);

    const next = await agent.get('/admin/users');
    expect(next.text).not.toMatch(INVITE_LINK);
  });
});

describe('password reset link', () => {
  it('without SMTP, is shown once in the response and not on the next page load', async () => {
    const agent = await newAdminAgent('tokenadmin4');
    const targetId = await newActiveUser('resettarget1');
    const res = await agent.post(`/admin/users/${targetId}/password-reset`).type('form').send({
      _csrf: await csrfFor(agent)
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(RESET_LINK);
    expect(res.headers['cache-control']).toMatch(/no-store/);

    const next = await agent.get('/admin/users');
    expect(next.text).not.toMatch(RESET_LINK);
  });

  it('when the email is delivered, is never shown or stored', async () => {
    email.isSmtpConfigured.mockReturnValue(true);
    const agent = await newAdminAgent('tokenadmin5');
    const targetId = await newActiveUser('resettarget2');
    const res = await agent.post(`/admin/users/${targetId}/password-reset`).type('form').send({
      _csrf: await csrfFor(agent)
    });
    expect(res.status).toBe(302);
    expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1);

    const next = await agent.get('/admin/users');
    expect(next.text).toContain('Password reset email sent to resettarget2@example.test');
    expect(next.text).not.toMatch(RESET_LINK);
  });
});
