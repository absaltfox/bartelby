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
  let app, db, actorAdminId, targetAdminId, agent;

  beforeAll(async () => {
    ({ app, db } = await bootApp());
    const hash = await bcrypt.hash('Password1!', 10);
    actorAdminId = await db.usersAsync.create({
      username: 'actoradmin',
      email: 'actor@example.com',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      accessAll: true,
      canUseSystemApiKeys: false
    });
    targetAdminId = await db.usersAsync.create({
      username: 'targetadmin',
      email: 'target@example.com',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      accessAll: true,
      canUseSystemApiKeys: false
    });
    agent = request.agent(app);
    await login(agent, 'actoradmin', 'Password1!');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('blocks demotion of the last active admin via the role endpoint', async () => {
    jest.spyOn(db.usersAsync, 'countActiveAdmins').mockResolvedValue(1);

    const page = await agent.get('/admin/users');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
    const res = await agent
      .post(`/admin/users/${targetAdminId}/role`)
      .type('form')
      .send({ role: 'user', _csrf: csrf });
    expect(res.status).toBe(302);
    const user = await db.usersAsync.findById(targetAdminId);
    expect(user.role).toBe('admin');
  });

  it('blocks demotion of the last active admin via the access update endpoint', async () => {
    jest.spyOn(db.usersAsync, 'countActiveAdmins').mockResolvedValue(1);

    const page = await agent.get('/admin/users');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
    const before = await db.usersAsync.findById(targetAdminId);
    const res = await agent
      .post(`/admin/users/${targetAdminId}/access`)
      .type('form')
      .send({
        role: 'user',
        access_all: before.access_all ? '1' : '0',
        _csrf: csrf
      });

    expect(res.status).toBe(302);
    const user = await db.usersAsync.findById(targetAdminId);
    expect(user.role).toBe('admin');
  });

  it('blocks deletion of the last active admin', async () => {
    jest.spyOn(db.usersAsync, 'countActiveAdmins').mockResolvedValue(1);

    const page = await agent.get('/admin/users');
    const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
    const res = await agent
      .post(`/admin/users/${targetAdminId}/delete`)
      .type('form')
      .send({ _csrf: csrf });
    expect(res.status).toBe(302);
    const user = await db.usersAsync.findById(targetAdminId);
    expect(user).not.toBeNull();
  });
});
