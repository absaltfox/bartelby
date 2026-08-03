'use strict';

// Regression test for #89.
//
// Rejecting a user was a bare `UPDATE users SET status='rejected'`. Nothing
// purged their session, `deserializeUser` returns the row regardless of status,
// and `/uploads/:filename` is registered directly on `app` — outside every
// mounted router's middleware — so it read `req.user.id` and kept authorizing
// image reads against grants the account was supposed to have lost. The account
// could go on streaming documents indefinitely as long as it never touched an
// HTML route.
//
// Two defences, and each gets an isolated test, because they produce different
// status codes and which one fires depends on wall-clock timing:
//
//   * buildAccessOpts downgrades a non-active account to anonymous → 403.
//   * reject() stamps the session-invalidation column → `locals` evicts → 302.
//
// The buildAccessOpts test rejects via raw SQL (status only, no stamp) so the
// eviction path cannot fire and the 403 is unambiguous. Asserting merely
// `not.toBe(200)` would let either defence satisfy the other's test.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const cheerio = require('cheerio');
const request = require('supertest');
const { Readable } = require('stream');

const PASSWORD = 'testpassword99!';
const UPLOAD = '/uploads/private-page.png';

jest.doMock('../../utils/storage', () => ({
  init: () => {},
  streamUploadByUrl: async () => Readable.from([Buffer.from('PNGDATA')]),
  sanitizeTempName: (n) => String(n || ''),
  getTempFilePath: () => null
}));

function csrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="_csrf"]').first().attr('value')
    || $('meta[name="csrf-token"]').first().attr('content');
}

describe('rejected users lose access immediately (#89)', () => {
  let app;
  let db;
  let collectionId;

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

    collectionId = await db.collectionsAsync.create({
      name: 'Restricted papers',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      createdBy: null
    });
    const docId = await db.documentsAsync.create({
      title: 'Private page',
      date_created: null,
      description: null,
      image_path: UPLOAD,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(docId, [collectionId]);
  }, 30_000);

  // Each case gets its own granted user and session, so nothing depends on
  // execution order.
  let seq = 0;
  async function seedReader() {
    const username = `reader${++seq}`;
    const id = await db.usersAsync.create({
      username,
      email: `${username}@example.test`,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.userCollectionAccessAsync.setForUserWithRoles(id, { [collectionId]: 'viewer' });

    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username, password: PASSWORD, _csrf: csrf(page.text) });
    expect(res.status).toBe(302);
    return { id, agent };
  }

  it('serves the upload while the account is active', async () => {
    const { agent } = await seedReader();
    const res = await agent.get(UPLOAD);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('denies the upload on status alone, with no session eviction involved', async () => {
    const { id, agent } = await seedReader();

    // Status only — deliberately not usersAsync.reject(), so the
    // password_changed_at stamp is absent and `locals` cannot evict. Any
    // denial here is buildAccessOpts refusing to hand out the account's grants.
    await db.getDb().run("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
    const row = await db.usersAsync.findById(id);
    expect(row.password_changed_at).toBeFalsy();

    const res = await agent.get(UPLOAD);
    expect(res.status).toBe(403);
  });

  it('evicts the live session when reject() stamps the invalidation column', async () => {
    const { id, agent } = await seedReader();

    await db.usersAsync.reject(id);
    const row = await db.usersAsync.findById(id);
    expect(row.status).toBe('rejected');
    expect(row.password_changed_at).toBeTruthy();

    const res = await agent.get('/account');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('stamps with sub-second precision so a same-second reject still evicts', async () => {
    // CURRENT_TIMESTAMP floors to the second, while req.session.authenticatedAt
    // is Date.now() in milliseconds — so a reject landing in the same wall-clock
    // second as the login used to write a stamp EARLIER than the session it was
    // meant to kill, and never fired for it at all.
    const { id, agent } = await seedReader();
    await db.usersAsync.reject(id);

    const row = await db.usersAsync.findById(id);
    expect(row.password_changed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+$/);

    const res = await agent.get('/account');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('denies a rejected admin the admin surface', async () => {
    const username = `tempadmin${++seq}`;
    const id = await db.usersAsync.create({
      username,
      email: `${username}@example.test`,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: 'admin',
      status: 'active',
      accessAll: true,
      canUseSystemApiKeys: true
    });
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ username, password: PASSWORD, _csrf: csrf(page.text) });

    expect((await agent.get('/admin/users')).status).toBe(200);

    // Status only, so requireAdmin's own check is what must deny.
    await db.getDb().run("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
    const res = await agent.get('/admin/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('admin cannot reject themselves or the last admin (#89)', () => {
  let db;
  let agent;

  beforeAll(async () => {
    const { app } = require('../../server');
    db = require('../../database/db');
    agent = request.agent(app);
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: PASSWORD, _csrf: csrf(page.text) });
  }, 30_000);

  it('refuses a self-reject', async () => {
    const me = await db.usersAsync.findByUsername('testadmin');
    const account = await agent.get('/admin/users');
    const res = await agent
      .post(`/admin/users/${me.id}/reject`)
      .type('form')
      .send({ _csrf: csrf(account.text) });

    expect(res.status).toBe(302);
    // Rejection now evicts sessions and LocalStrategy refuses a rejected
    // account, so a self-reject would be unrecoverable without DB access.
    expect((await db.usersAsync.findById(me.id)).status).toBe('active');
  });
});

describe('buildAccessOpts treats a non-active account as anonymous (#89)', () => {
  const { buildAccessOpts, isUsableAccount } = require('../../middleware/auth');

  it.each(['rejected', 'pending', 'suspended'])('downgrades status=%s', (status) => {
    const opts = buildAccessOpts({
      user: { id: 7, role: 'admin', access_all: true, status }
    });
    expect(opts).toEqual({ userId: null, isAdmin: false, accessAll: false });
  });

  it('passes an active account through unchanged', () => {
    const opts = buildAccessOpts({
      user: { id: 7, role: 'admin', access_all: true, status: 'active' }
    });
    expect(opts).toEqual({ userId: 7, isAdmin: true, accessAll: true });
  });

  it('treats an absent user as anonymous', () => {
    expect(buildAccessOpts({})).toEqual({ userId: null, isAdmin: false, accessAll: false });
    expect(buildAccessOpts(null)).toEqual({ userId: null, isAdmin: false, accessAll: false });
  });

  it('recognises only active as usable', () => {
    expect(isUsableAccount({ status: 'active' })).toBe(true);
    for (const status of ['pending', 'rejected', 'suspended', '', null, undefined]) {
      expect(isUsableAccount({ status })).toBe(false);
    }
    expect(isUsableAccount(null)).toBe(false);
  });
});
