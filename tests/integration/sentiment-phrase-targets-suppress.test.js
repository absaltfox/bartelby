'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

let app;
let db;
let adminAgent;
let csrfToken;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent.post('/setup').type('form').send({
    username: 's3suppressadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 's3suppressadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  const formPage = await adminAgent.get('/admin/knowledge/sentiment/phrase-targets');
  csrfToken = extractCsrfToken(formPage.text);
}, 60_000);

describe('Suppression CRUD — S3', () => {
  it('POST /suppressions adds a row', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/suppressions')
      .type('form')
      .send({
        _csrf: csrfToken,
        phrase: 'My Position',
        notes: 'too generic',
        q: 'position',
        collectionId: 42,
        polarity: 'mixed',
        minFrequency: 3,
        page: 2
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('saved=1');
    expect(res.headers.location).toContain('q=position');
    expect(res.headers.location).toContain('collectionId=42');
    expect(res.headers.location).toContain('polarity=mixed');
    expect(res.headers.location).toContain('minFrequency=3');
    expect(res.headers.location).toContain('page=2');
    const row = await db.getAsync(`SELECT * FROM sentiment_phrase_suppressions WHERE target_phrase_normalized = 'my position'`);
    expect(row).toBeTruthy();
    expect(row.notes).toBe('too generic');
  });

  it('POST /suppressions rejects empty phrase', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/suppressions')
      .type('form')
      .send({ _csrf: csrfToken, phrase: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('POST /suppressions rejects a duplicate (UNIQUE constraint)', async () => {
    await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/suppressions')
      .type('form')
      .send({ _csrf: csrfToken, phrase: 'duplicate-target' });
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/suppressions')
      .type('form')
      .send({ _csrf: csrfToken, phrase: 'duplicate-target' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('POST /suppressions/:id/delete removes the row', async () => {
    const inserted = await db.runAsync(
      `INSERT INTO sentiment_phrase_suppressions (target_phrase_normalized, target_phrase_display) VALUES ('to-delete', 'to-delete')`
    );
    const res = await adminAgent
      .post(`/admin/knowledge/sentiment/phrase-targets/suppressions/${inserted.lastInsertRowid}/delete`)
      .type('form')
      .send({ _csrf: csrfToken, tab: 'suppressed', page: 2 });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('tab=suppressed');
    expect(res.headers.location).toContain('saved=1');
    expect(res.headers.location).toContain('page=2');
    const row = await db.getAsync(`SELECT * FROM sentiment_phrase_suppressions WHERE id = ?`, [inserted.lastInsertRowid]);
    expect(row).toBeFalsy();
  });
});
