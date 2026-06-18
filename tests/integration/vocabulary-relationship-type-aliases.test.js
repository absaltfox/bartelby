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
  await setupAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'aliasadmin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'aliasadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  const formPage = await adminAgent.get('/admin/knowledge/vocabularies/relationship-types?tab=aliases');
  csrfToken = extractCsrfToken(formPage.text);
  expect(csrfToken).toBeTruthy();
}, 60_000);

describe('relationship_type_aliases CRUD — C4', () => {
  it('POST adds a new alias', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-type-aliases')
      .type('form')
      .send({
        _csrf: csrfToken,
        alias_type: 'c4_alias_test_input',
        canonical_type: 'mentioned_in',
        notes: 'test alias'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const row = await db.getAsync(`SELECT * FROM relationship_type_aliases WHERE alias_type = 'c4_alias_test_input'`);
    expect(row).toBeTruthy();
    expect(row.canonical_type).toBe('mentioned_in');
    expect(row.notes).toBe('test alias');
  });

  it('POST rejects a duplicate alias (UNIQUE on alias_type)', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-type-aliases')
      .type('form')
      .send({
        _csrf: csrfToken,
        alias_type: 'c4_alias_test_input',
        canonical_type: 'mentioned_in'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('POST rejects an empty alias_type or canonical_type', async () => {
    let res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-type-aliases')
      .type('form')
      .send({ _csrf: csrfToken, alias_type: '', canonical_type: 'mentioned_in' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);

    res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-type-aliases')
      .type('form')
      .send({ _csrf: csrfToken, alias_type: 'some_alias', canonical_type: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('POST :id/delete removes an alias', async () => {
    const ins = await db.runAsync(
      `INSERT INTO relationship_type_aliases (canonical_type, alias_type) VALUES ('mentioned_in', 'c4_alias_to_delete')`
    );
    const id = ins.lastInsertRowid;

    const res = await adminAgent
      .post(`/admin/knowledge/vocabularies/relationship-type-aliases/${id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const row = await db.getAsync(`SELECT * FROM relationship_type_aliases WHERE id = ?`, [id]);
    expect(row).toBeFalsy();
  });
});
