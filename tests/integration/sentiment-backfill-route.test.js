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
    username: 'backfilladmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'backfilladmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  // Pull a CSRF token off any admin form page.
  const formPage = await adminAgent.get('/admin/collections');
  csrfToken = extractCsrfToken(formPage.text);
}, 60_000);

async function setupCollectionWithBestTranscripts(name, n) {
  const collectionId = await db.collectionsAsync.create({ name, createdBy: null });
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const docId = (await db.runAsync(`INSERT INTO documents (title) VALUES (?)`, [`${name}-doc-${i}`])).lastInsertRowid;
    await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`, [docId, collectionId]);
    const transcriptId = (await db.runAsync(
      `INSERT INTO transcripts (document_id, content, is_best) VALUES (?, 'x', 1)`,
      [docId]
    )).lastInsertRowid;
    ids.push({ docId, transcriptId });
  }
  return { collectionId, ids };
}

describe('POST /admin/knowledge/sentiment/backfill/collection/:id', () => {
  it('enqueues one sentiment job per eligible best transcript', async () => {
    const { collectionId, ids } = await setupCollectionWithBestTranscripts('backfill-route-a', 2);

    const res = await adminAgent
      .post(`/admin/knowledge/sentiment/backfill/collection/${collectionId}`)
      .type('form')
      .send({ _csrf: csrfToken });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('queuedCount=2');

    const jobs = await db.allAsync(
      `SELECT transcript_id, document_id, status FROM sentiment_extraction_jobs
        WHERE transcript_id IN (${ids.map(() => '?').join(',')})
        ORDER BY transcript_id ASC`,
      ids.map((i) => i.transcriptId)
    );
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.status === 'queued')).toBe(true);
  });

  it('is idempotent: re-running enqueues no duplicates', async () => {
    const { collectionId, ids } = await setupCollectionWithBestTranscripts('backfill-route-b', 1);

    await adminAgent
      .post(`/admin/knowledge/sentiment/backfill/collection/${collectionId}`)
      .type('form')
      .send({ _csrf: csrfToken });

    const res2 = await adminAgent
      .post(`/admin/knowledge/sentiment/backfill/collection/${collectionId}`)
      .type('form')
      .send({ _csrf: csrfToken });

    expect(res2.status).toBe(302);
    expect(res2.headers.location).toContain('queuedCount=0');

    const jobs = await db.allAsync(
      `SELECT id FROM sentiment_extraction_jobs WHERE transcript_id = ?`,
      [ids[0].transcriptId]
    );
    expect(jobs.length).toBe(1);
  });

  it('rejects requests without an authenticated admin session', async () => {
    const { collectionId } = await setupCollectionWithBestTranscripts('backfill-route-c', 1);

    const res = await request(app)
      .post(`/admin/knowledge/sentiment/backfill/collection/${collectionId}`)
      .type('form')
      .send({ _csrf: csrfToken });

    expect([302, 401, 403]).toContain(res.status);
    // If 302, it must redirect to login, not to /admin.
    if (res.status === 302) {
      expect(res.headers.location).not.toMatch(/^\/admin\/collections/);
    }
  });
});
