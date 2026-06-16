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
const TRANSCRIPT_ID = 9930;
const TRANSCRIPT_CONTENT = 'In 1872 Mr. Jessop served as Superintendent of the Charterhouse for the duration of the year.';

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
      username: 'entitynewadmin',
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
    .send({ username: 'entitynewadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  // Seed transcript with known content
  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [TRANSCRIPT_ID, 'Entity New Test Doc']);
  await db.runAsync(
    `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
    [TRANSCRIPT_ID, TRANSCRIPT_ID, TRANSCRIPT_CONTENT]
  );

  // Grab a CSRF token from the form GET
  const formPage = await adminAgent.get('/admin/knowledge/entities/new');
  csrfToken = extractCsrfToken(formPage.text);
  expect(csrfToken).toBeTruthy();
}, 60_000);

describe('POST /admin/knowledge/entities/new — C1.1/C1.2', () => {
  it('creates entity + manual citation on valid evidence', async () => {
    const verbatim = 'Mr. Jessop served as Superintendent';
    const res = await adminAgent
      .post('/admin/knowledge/entities/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        entity_type: 'person',
        canonical_name: 'Edmund Jessop (entity-new-test)',
        description: 'Test description.',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim,
        passageStart: ''
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/entities\/\d+/);

    const entityRow = await db.getAsync(
      `SELECT * FROM entities WHERE canonical_name = 'Edmund Jessop (entity-new-test)'`
    );
    expect(entityRow).toBeTruthy();
    expect(entityRow.entity_type).toBe('person');
    expect(entityRow.description).toBe('Test description.');

    const citationRow = await db.getAsync(
      `SELECT * FROM citations WHERE entity_id = ?`,
      [entityRow.id]
    );
    expect(citationRow).toBeTruthy();
    expect(citationRow.extraction_method).toBe('manual');
    expect(citationRow.extraction_model).toBeNull();
    expect(Number(citationRow.confidence)).toBe(1.0);
    expect(citationRow.approval_status).toBe('approved');
    expect(citationRow.passage_text).toBe(verbatim);
    expect(citationRow.transcript_id).toBe(TRANSCRIPT_ID);
    expect(citationRow.document_id).toBe(TRANSCRIPT_ID);
    expect(citationRow.passage_start).toBe(TRANSCRIPT_CONTENT.indexOf(verbatim));
  });

  it('rejects when verbatim is NOT in transcript', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/entities/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        entity_type: 'person',
        canonical_name: 'Nonexistent Verbatim Entity',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'this text is definitely not in the transcript'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/entities\/new\?error=/);

    const entityRow = await db.getAsync(
      `SELECT * FROM entities WHERE canonical_name = 'Nonexistent Verbatim Entity'`
    );
    expect(entityRow).toBeFalsy();
  });

  it('rejects when canonical_name is missing', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/entities/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        entity_type: 'person',
        canonical_name: '',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'Mr. Jessop'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/entities\/new\?error=/);
  });

  it('rejects invalid entity_type', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/entities/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        entity_type: 'not-a-real-type',
        canonical_name: 'Bad Type Entity',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'Mr. Jessop'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/entities\/new\?error=/);

    const entityRow = await db.getAsync(
      `SELECT * FROM entities WHERE canonical_name = 'Bad Type Entity'`
    );
    expect(entityRow).toBeFalsy();
  });

  it('persists authority_id when supplied', async () => {
    const authority = await db.runAsync(
      `INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Authority for Entity New Test')`
    );
    const authorityId = authority.lastInsertRowid;

    const res = await adminAgent
      .post('/admin/knowledge/entities/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        entity_type: 'person',
        canonical_name: 'Entity With Authority Link',
        authority_id: String(authorityId),
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'Charterhouse'
      });

    expect(res.status).toBe(302);

    const entityRow = await db.getAsync(
      `SELECT * FROM entities WHERE canonical_name = 'Entity With Authority Link'`
    );
    expect(entityRow).toBeTruthy();
    expect(entityRow.authority_id).toBe(authorityId);
  });
});
