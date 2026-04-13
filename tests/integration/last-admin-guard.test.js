'use strict';

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

const bcrypt = require('bcryptjs');
const request = require('supertest');

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const server = require('../../server');
  await server.initApp();
  return { app: server.app, db: require('../../database/db') };
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  await agent.post('/login').type('form').send({ username, password, _csrf: csrf });
}

describe('last-admin guard', () => {
  let app, db, adminId, agent;

  beforeAll(async () => {
    ({ app, db } = await bootApp());
    const hash = await bcrypt.hash('Password1!', 10);
    adminId = await db.usersAsync.create({
      username: 'soloadmin',
      email: 'solo@example.com',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      accessAll: true,
      canUseSystemApiKeys: false
    });
    agent = request.agent(app);
    await login(agent, 'soloadmin', 'Password1!');
  });

  it('blocks demotion of the last active admin', async () => {
    const page = await agent.get('/admin/users');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
    const res = await agent
      .post(`/admin/users/${adminId}/role`)
      .type('form')
      .send({ role: 'user', _csrf: csrf });
    // Should redirect back (not apply the change)
    expect(res.status).toBe(302);
    const user = await db.usersAsync.findById(adminId);
    expect(user.role).toBe('admin');
  });

  it('blocks deletion of the last active admin', async () => {
    const page = await agent.get('/admin/users');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
    const res = await agent
      .post(`/admin/users/${adminId}/delete`)
      .type('form')
      .send({ _csrf: csrf });
    expect(res.status).toBe(302);
    const user = await db.usersAsync.findById(adminId);
    expect(user).not.toBeNull();
  });
});
