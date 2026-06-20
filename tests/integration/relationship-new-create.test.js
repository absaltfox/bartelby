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
let sourceEntityId;
let targetEntityId;

const TRANSCRIPT_ID = 9940;
const TRANSCRIPT_CONTENT = 'In 1872 Mr. Jessop took up the post of Superintendent at the Charterhouse, holding office through 1878.';

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
      username: 'relnewadmin',
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
    .send({ username: 'relnewadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [TRANSCRIPT_ID, 'Relationship New Test Doc']);
  await db.runAsync(
    `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
    [TRANSCRIPT_ID, TRANSCRIPT_ID, TRANSCRIPT_CONTENT]
  );

  const source = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Source Entity (rel-test)')`
  );
  sourceEntityId = source.lastInsertRowid;
  const target = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name) VALUES ('role', 'Superintendent (rel-test)')`
  );
  targetEntityId = target.lastInsertRowid;

  // Seed a relationship_type so the dropdown has at least one entry; the form
  // also accepts free text when the table is empty, so this is non-essential.
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types (name, label, category) VALUES ('holds_position', 'holds position', 'role')`
  );
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types (name, label, category) VALUES ('voiced_in', 'voiced in', 'document')`
  );
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types (name, label, category) VALUES ('date_bounded', 'date bounded', 'temporal')`
  );

  const formPage = await adminAgent.get('/admin/knowledge/relationships/new');
  csrfToken = extractCsrfToken(formPage.text);
  expect(csrfToken).toBeTruthy();
}, 60_000);

describe('POST /admin/knowledge/relationships/new — C2.1/C2.3', () => {
  it('creates relationship + manual citation on valid evidence', async () => {
    const verbatim = 'Mr. Jessop took up the post of Superintendent';
    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: String(sourceEntityId),
        target_entity_id: String(targetEntityId),
        relationship_type: 'holds_position',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/entities\/\d+/);

    const relRow = await db.getAsync(
      `SELECT * FROM relationships
       WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = 'holds_position'`,
      [sourceEntityId, targetEntityId]
    );
    expect(relRow).toBeTruthy();
    expect(Number(relRow.confidence)).toBe(1.0);

    const citationRow = await db.getAsync(
      `SELECT * FROM citations WHERE relationship_id = ?`,
      [relRow.id]
    );
    expect(citationRow).toBeTruthy();
    expect(citationRow.extraction_method).toBe('manual');
    expect(citationRow.extraction_model).toBeNull();
    expect(Number(citationRow.confidence)).toBe(1.0);
    expect(citationRow.approval_status).toBe('approved');
    expect(citationRow.passage_text).toBe(verbatim);
    expect(citationRow.transcript_id).toBe(TRANSCRIPT_ID);
    expect(citationRow.document_id).toBe(TRANSCRIPT_ID);
  });

  it('rejects when verbatim is NOT in transcript', async () => {
    const before = await db.getAsync(
      `SELECT COUNT(*) AS n FROM relationships WHERE source_entity_id = ? AND target_entity_id = ?`,
      [sourceEntityId, targetEntityId]
    );

    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: String(sourceEntityId),
        target_entity_id: String(targetEntityId),
        relationship_type: 'mentioned_in',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'this text is definitely not in the transcript'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/relationships\/new\?error=/);

    const after = await db.getAsync(
      `SELECT COUNT(*) AS n FROM relationships WHERE source_entity_id = ? AND target_entity_id = ?`,
      [sourceEntityId, targetEntityId]
    );
    expect(after.n).toBe(before.n);
  });

  it('persists voice_role when supplied', async () => {
    const verbatim = 'office through 1878';
    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: String(sourceEntityId),
        target_entity_id: String(targetEntityId),
        relationship_type: 'voiced_in',
        voice_role: 'speaker',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim
      });

    expect(res.status).toBe(302);

    const relRow = await db.getAsync(
      `SELECT * FROM relationships
       WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = 'voiced_in'`,
      [sourceEntityId, targetEntityId]
    );
    expect(relRow).toBeTruthy();
    expect(relRow.voice_role).toBe('speaker');
  });

  it('persists optional start_date and end_date', async () => {
    const verbatim = 'In 1872 Mr. Jessop';
    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: String(sourceEntityId),
        target_entity_id: String(targetEntityId),
        relationship_type: 'date_bounded',
        start_date: '1872',
        end_date: '1878',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim
      });

    expect(res.status).toBe(302);

    const relRow = await db.getAsync(
      `SELECT * FROM relationships
       WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = 'date_bounded'`,
      [sourceEntityId, targetEntityId]
    );
    expect(relRow).toBeTruthy();
    expect(relRow.start_date).toBe('1872');
    expect(relRow.end_date).toBe('1878');
  });

  it('rejects when source entity does not exist', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: '9999999',
        target_entity_id: String(targetEntityId),
        relationship_type: 'holds_position',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'Mr. Jessop'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/relationships\/new\?error=/);
  });

  it('rejects when relationship_type is empty', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/relationships/new')
      .type('form')
      .send({
        _csrf: csrfToken,
        source_entity_id: String(sourceEntityId),
        target_entity_id: String(targetEntityId),
        relationship_type: '',
        transcriptId: String(TRANSCRIPT_ID),
        verbatim: 'Mr. Jessop'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/knowledge\/relationships\/new\?error=/);
  });
});
