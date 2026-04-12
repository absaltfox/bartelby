'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function bootstrapAdmin(app) {
  const agent = request.agent(app);
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
      _csrf: csrf
    });
  return agent;
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf });
  expect(res.status).toBe(302);
  return res;
}

describe('auth and email-driven flows', () => {
  let app;
  let db;
  let email;

  beforeAll(async () => {
    jest.resetModules();
    email = {
      sendEmailOtp: jest.fn(async () => {}),
      sendInviteEmail: jest.fn(async () => {}),
      sendPasswordResetEmail: jest.fn(async () => {}),
      isSmtpConfigured: jest.fn(() => true)
    };
    jest.doMock('../../utils/email', () => email);

    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');
    await bootstrapAdmin(app);
  }, 30_000);

  it('sends and verifies email MFA codes during login', async () => {
    const userId = await db.usersAsync.create({
      username: 'mfa-user',
      email: 'mfa@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.usersAsync.setMfaMethod(userId, 'email');

    const agent = request.agent(app);
    const loginRes = await login(agent, 'mfa-user', 'password123!');
    expect(loginRes.headers.location).toBe('/login/mfa');
    expect(email.sendEmailOtp).toHaveBeenCalledTimes(1);
    expect(email.sendEmailOtp).toHaveBeenCalledWith(expect.objectContaining({
      id: userId,
      email: 'mfa@example.com'
    }), expect.any(String));

    const mfaPage = await agent.get('/login/mfa');
    const csrf = extractCsrfToken(mfaPage.text);
    const issuedCode = email.sendEmailOtp.mock.calls[0][1];

    const verifyRes = await agent
      .post('/login/mfa')
      .type('form')
      .send({ code: issuedCode, _csrf: csrf });

    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.location).toBe('/');
  });

  it('creates and emails invitations from the admin user flow', async () => {
    const adminAgent = request.agent(app);
    await login(adminAgent, 'testadmin', 'testpassword99!');

    const invitePage = await adminAgent.get('/admin/users/invite');
    const csrf = extractCsrfToken(invitePage.text);
    const res = await adminAgent
      .post('/admin/users/invite')
      .type('form')
      .send({
        email: 'invitee@example.com',
        role: 'user',
        _csrf: csrf
      });

    expect(res.status).toBe(302);
    expect(email.sendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: 'invitee@example.com'
    }));

    const invites = await db.userInvitesAsync.getActive();
    expect(invites.some((invite) => invite.email === 'invitee@example.com')).toBe(true);
  });

  it('creates and emails password reset links from the admin user flow', async () => {
    const resetUserId = await db.usersAsync.create({
      username: 'reset-user',
      email: 'reset@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    const adminAgent = request.agent(app);
    await login(adminAgent, 'testadmin', 'testpassword99!');

    const adminUsersPage = await adminAgent.get('/admin/users');
    const csrf = extractCsrfToken(adminUsersPage.text);
    const res = await adminAgent
      .post(`/admin/users/${resetUserId}/password-reset`)
      .type('form')
      .send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(email.sendPasswordResetEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: 'reset@example.com',
      username: 'reset-user'
    }));
  });

  it('accepts admin-generated password reset tokens and updates the password', async () => {
    const resetUserId = await db.usersAsync.create({
      username: 'token-reset-user',
      email: 'token-reset@example.com',
      passwordHash: bcrypt.hashSync('oldpassword123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    const rawToken = 'manual-reset-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await db.passwordResetTokensAsync.create({
      userId: resetUserId,
      tokenHash,
      createdBy: 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });

    const agent = request.agent(app);
    const page = await agent.get(`/reset-password/${rawToken}`);
    const csrf = extractCsrfToken(page.text);

    const res = await agent
      .post(`/reset-password/${rawToken}`)
      .type('form')
      .send({
        password: 'newpassword123!',
        confirm: 'newpassword123!',
        _csrf: csrf
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    const loginRes = await login(agent, 'token-reset-user', 'newpassword123!');
    expect(loginRes.headers.location).toBe('/');
  });
});
