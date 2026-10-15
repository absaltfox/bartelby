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

function extractSubmitToken(html) {
  const match = html.match(/name="_once"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

// Hidden fields a real browser would send from the given form page: the CSRF
// token and the single-use submit token.
async function formFields(agent, formPage) {
  const html = (await agent.get(formPage)).text;
  return { _csrf: extractCsrfToken(html), _once: extractSubmitToken(html) };
}

const inviteFields = (agent) => formFields(agent, '/admin/users/invite');
const usersPageFields = (agent) => formFields(agent, '/admin/users');

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
      email: 'invitee1@example.test', role: 'user', ...(await inviteFields(agent))
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
      email: 'invitee2@example.test', role: 'user', ...(await inviteFields(agent))
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
      email: 'invitee3@example.test', role: 'user', ...(await inviteFields(agent))
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
      ...(await usersPageFields(agent))
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
      ...(await usersPageFields(agent))
    });
    expect(res.status).toBe(302);
    expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1);

    const next = await agent.get('/admin/users');
    expect(next.text).toContain('Password reset email sent to resettarget2@example.test');
    expect(next.text).not.toMatch(RESET_LINK);
  });
});

// Rendering the link in the POST response means the POST is the page's last
// navigation, so a browser refresh sends it again. Each form therefore carries
// a single-use submit token: a repeat is answered with a redirect and creates
// nothing. Without it a refresh would mint a second invitation, or a second
// reset token that revokes the link the admin had just copied.
describe('resubmitting the form', () => {
  it('a repeated invite POST creates no second invitation', async () => {
    const agent = await newAdminAgent('tokenadmin6');
    const fields = { email: 'invitee6@example.test', role: 'user', ...(await inviteFields(agent)) };

    const first = await agent.post('/admin/users/invite').type('form').send(fields);
    expect(first.status).toBe(200);
    expect(first.text).toMatch(INVITE_LINK);

    const repeat = await agent.post('/admin/users/invite').type('form').send(fields);
    expect(repeat.status).toBe(302);
    expect(repeat.headers.location).toBe('/admin/users');

    const invites = (await db.userInvitesAsync.getActive()).filter((i) => i.email === 'invitee6@example.test');
    expect(invites.length).toBe(1);

    const landing = await agent.get('/admin/users');
    expect(landing.text).toMatch(/class="alert alert-error"[^>]*>\s*<p>That form was already submitted\./);
    expect(landing.text).not.toMatch(INVITE_LINK);
  });

  it('a repeated reset POST leaves the first link valid', async () => {
    const agent = await newAdminAgent('tokenadmin7');
    const targetId = await newActiveUser('resettarget3');
    const fields = await usersPageFields(agent);

    const first = await agent.post(`/admin/users/${targetId}/password-reset`).type('form').send(fields);
    expect(first.status).toBe(200);
    const link = first.text.match(RESET_LINK)[0];

    const repeat = await agent.post(`/admin/users/${targetId}/password-reset`).type('form').send(fields);
    expect(repeat.status).toBe(302);
    expect(repeat.headers.location).toBe('/admin/users');

    expect((await request(app).get(link)).status).toBe(200);
  });

  // The last two cases share one admin: the shared per-IP limiter on /login
  // leaves this file no room for another sign-in.
  let sharedAgent;

  it('the page that shows the link carries a fresh token, so the next action works', async () => {
    const agent = sharedAgent = await newAdminAgent('tokenadmin8');
    const firstTarget = await newActiveUser('resettarget4');
    const secondTarget = await newActiveUser('resettarget5');

    const first = await agent.post(`/admin/users/${firstTarget}/password-reset`).type('form')
      .send(await usersPageFields(agent));
    const next = await agent.post(`/admin/users/${secondTarget}/password-reset`).type('form')
      .send({ _csrf: extractCsrfToken(first.text), _once: extractSubmitToken(first.text) });
    expect(next.status).toBe(200);
    expect(next.text).toMatch(RESET_LINK);
  });

  it('a POST with no submit token creates nothing', async () => {
    const agent = sharedAgent;
    const { _csrf } = await inviteFields(agent);
    const res = await agent.post('/admin/users/invite').type('form').send({
      email: 'invitee9@example.test', role: 'user', _csrf
    });
    expect(res.status).toBe(302);
    const invites = (await db.userInvitesAsync.getActive()).filter((i) => i.email === 'invitee9@example.test');
    expect(invites.length).toBe(0);
  });
});
