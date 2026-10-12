'use strict';

/**
 * Integration tests — account enumeration and login cost (issue #90)
 *
 * - An unknown username must cost a bcrypt comparison, the same as a known
 *   one, so response time does not reveal which usernames exist.
 * - Login must use the asynchronous comparison so one attempt cannot hold the
 *   event loop for the whole hash.
 * - Public registration must not confirm that a username or email is already
 *   in use.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let db;
let bcrypt;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function postForm(agent, formPath, fields) {
  const page = await agent.get(formPath);
  return agent.post(formPath).type('form').send({ ...fields, _csrf: extractCsrfToken(page.text) });
}

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');
  bcrypt = require('bcryptjs');

  await postForm(request.agent(app), '/setup', {
    username: 'enumadmin',
    email: 'enumadmin@example.test',
    password: 'testpassword99!',
    confirm: 'testpassword99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN
  });
}, 60_000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /login cost is independent of whether the username exists', () => {
  it('runs a bcrypt comparison for an unknown username', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    const res = await postForm(request.agent(app), '/login', {
      username: 'no-such-user', password: 'whatever-password'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('runs exactly one bcrypt comparison for a known username', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    await postForm(request.agent(app), '/login', {
      username: 'enumadmin', password: 'wrong-password'
    });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('does not use the blocking comparison', async () => {
    const compareSync = jest.spyOn(bcrypt, 'compareSync');
    await postForm(request.agent(app), '/login', {
      username: 'enumadmin', password: 'wrong-password'
    });
    expect(compareSync).not.toHaveBeenCalled();
  });

  it('still signs in with the correct password', async () => {
    const res = await postForm(request.agent(app), '/login', {
      username: 'enumadmin', password: 'testpassword99!'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('POST /register does not confirm existing accounts', () => {
  it('answers a taken username exactly like a new registration', async () => {
    const res = await postForm(request.agent(app), '/register', {
      username: 'enumadmin', password: 'another-password1', confirm: 'another-password1'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pending');
  });

  it('answers a taken email exactly like a new registration', async () => {
    const res = await postForm(request.agent(app), '/register', {
      username: 'enumfresh1',
      email: 'enumadmin@example.test',
      password: 'another-password1',
      confirm: 'another-password1'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pending');
    expect(await db.usersAsync.findByUsername('enumfresh1')).toBeFalsy();
  });

  it('leaves the existing account untouched when its username is re-registered', async () => {
    const before = await db.usersAsync.findByUsername('enumadmin');
    await postForm(request.agent(app), '/register', {
      username: 'enumadmin', password: 'another-password1', confirm: 'another-password1'
    });
    const after = await db.usersAsync.findByUsername('enumadmin');
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.role).toBe('admin');
  });

  it('still creates a pending account for a new username', async () => {
    const res = await postForm(request.agent(app), '/register', {
      username: 'enumfresh2', password: 'another-password1', confirm: 'another-password1'
    });
    expect(res.headers.location).toBe('/pending');
    const created = await db.usersAsync.findByUsername('enumfresh2');
    expect(created.status).toBe('pending');
  });

  it('tells the visitor on the pending page that an in-use name creates no request', async () => {
    const res = await request(app).get('/pending');
    expect(res.text).toMatch(/already in use/i);
  });
});
