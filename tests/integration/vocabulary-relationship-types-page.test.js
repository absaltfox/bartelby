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
      username: 'vocabadmin',
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
    .send({ username: 'vocabadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  const formPage = await adminAgent.get('/admin/knowledge/vocabularies/relationship-types');
  csrfToken = extractCsrfToken(formPage.text);
  expect(csrfToken).toBeTruthy();
}, 60_000);

describe('GET /admin/knowledge/vocabularies/relationship-types — C4', () => {
  it('renders the Types tab by default with seeded canonical types', async () => {
    const res = await adminAgent.get('/admin/knowledge/vocabularies/relationship-types');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Relationship Vocabulary');
    expect(res.text).toContain('parent_of'); // seeded
    expect(res.text).toContain('spouse_of'); // seeded
  });

  it('?tab=aliases renders the aliases tab', async () => {
    const res = await adminAgent.get('/admin/knowledge/vocabularies/relationship-types?tab=aliases');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Aliases');
    expect(res.text).toContain('canonical_type');
  });
});

describe('POST /admin/knowledge/vocabularies/relationship-types — create', () => {
  it('creates a new relationship type', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types')
      .type('form')
      .send({
        _csrf: csrfToken,
        name: 'c4_create_test_alpha',
        label: 'C4 Create Test Alpha',
        category: 'general',
        frequency: 'rare',
        source_type: 'person',
        target_type: 'organization',
        inverse_name: ''
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const row = await db.getAsync(`SELECT * FROM relationship_types WHERE name = 'c4_create_test_alpha'`);
    expect(row).toBeTruthy();
    expect(row.label).toBe('C4 Create Test Alpha');
    expect(row.frequency).toBe('rare');
    expect(row.source_type).toBe('person');
    expect(row.target_type).toBe('organization');
  });

  it('rejects a duplicate name', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types')
      .type('form')
      .send({
        _csrf: csrfToken,
        name: 'c4_create_test_alpha',
        label: 'Duplicate'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('rejects a non-snake_case name', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types')
      .type('form')
      .send({
        _csrf: csrfToken,
        name: 'NotSnakeCase',
        label: 'Bad name'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
    const row = await db.getAsync(`SELECT * FROM relationship_types WHERE name = 'NotSnakeCase'`);
    expect(row).toBeFalsy();
  });

  it('rejects an invalid frequency', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types')
      .type('form')
      .send({
        _csrf: csrfToken,
        name: 'c4_freq_test',
        label: 'Freq Test',
        frequency: 'bogus'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });
});

describe('POST /admin/knowledge/vocabularies/relationship-types/:name/edit — update', () => {
  it('updates label / category / frequency / source / target / inverse', async () => {
    // Seed
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_edit_target', 'Original Label', 'general', 'common')`
    );

    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types/c4_edit_target/edit')
      .type('form')
      .send({
        _csrf: csrfToken,
        label: 'New Label',
        category: 'familial',
        frequency: 'medium',
        source_type: 'person',
        target_type: 'person',
        inverse_name: 'c4_edit_target_inv'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const row = await db.getAsync(`SELECT * FROM relationship_types WHERE name = 'c4_edit_target'`);
    expect(row.label).toBe('New Label');
    expect(row.category).toBe('familial');
    expect(row.frequency).toBe('medium');
    expect(row.source_type).toBe('person');
    expect(row.target_type).toBe('person');
    expect(row.inverse_name).toBe('c4_edit_target_inv');
  });

  it('returns 404-via-error-redirect when name does not exist', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types/c4_does_not_exist/edit')
      .type('form')
      .send({ _csrf: csrfToken, label: 'Anything' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('rejects an invalid frequency in update', async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_freq_update', 'Freq Update', 'general', 'common')`
    );
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types/c4_freq_update/edit')
      .type('form')
      .send({ _csrf: csrfToken, label: 'OK', frequency: 'bogus' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });
});
