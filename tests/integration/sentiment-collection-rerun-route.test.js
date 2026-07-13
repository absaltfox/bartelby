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

let app, db, adminAgent, csrfToken;

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
    username: 'rerunadmin', password: 'pw-abcdefgh99!', confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN, _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'rerunadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });
  const formPage = await adminAgent.get('/admin/collections');
  csrfToken = extractCsrfToken(formPage.text);
}, 60_000);

let seedSeq = 0;
async function seedCollection() {
  const collectionId = await db.collectionsAsync.create({ name: `rerun-route-${++seedSeq}`, createdBy: null });
  // done transcript with one approved annotation
  const doneDoc = (await db.runAsync(`INSERT INTO documents (title) VALUES ('done')`)).lastInsertRowid;
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`, [doneDoc, collectionId]);
  const doneTx = (await db.runAsync(`INSERT INTO transcripts (document_id, content, is_best) VALUES (?, 'x', 1)`, [doneDoc])).lastInsertRowid;
  const doneJobId = (await db.runAsync(
    `INSERT INTO sentiment_extraction_jobs (document_id, transcript_id, reset_existing, status, kind, created_at)
     VALUES (?, ?, 0, 'done', 'singleton', CURRENT_TIMESTAMP)`, [doneDoc, doneTx]
  )).lastInsertRowid;
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (transcript_id, document_id, polarity, intensity, voice_role, target_kind, emotion_phrase_verbatim, approval_status)
     VALUES (?, ?, 'positive','low','author','phrase','x','approved')`, [doneTx, doneDoc]
  );
  // fresh transcript, no job
  const freshDoc = (await db.runAsync(`INSERT INTO documents (title) VALUES ('fresh')`)).lastInsertRowid;
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`, [freshDoc, collectionId]);
  const freshTx = (await db.runAsync(`INSERT INTO transcripts (document_id, content, is_best) VALUES (?, 'x', 1)`, [freshDoc])).lastInsertRowid;
  return { collectionId, doneJobId, freshTx };
}

describe('collection sentiment re-run routes', () => {
  it('GET confirm.json returns counts and a message', async () => {
    const { collectionId } = await seedCollection();
    const res = await adminAgent.get(`/admin/knowledge/sentiment/rerun/collection/${collectionId}/confirm.json`);
    expect(res.status).toBe(200);
    expect(res.body.resetCount).toBe(1);
    expect(res.body.queueCount).toBe(1);
    expect(res.body.annotationsApproved).toBe(1);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('POST re-run resets done jobs and queues fresh ones', async () => {
    const { collectionId, doneJobId, freshTx } = await seedCollection();
    const res = await adminAgent
      .post(`/admin/knowledge/sentiment/rerun/collection/${collectionId}`)
      .type('form').send({ _csrf: csrfToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('queuedMode=sentiment-rerun');

    const doneJob = await db.getAsync(`SELECT status, reset_existing FROM sentiment_extraction_jobs WHERE id = ?`, [doneJobId]);
    expect(doneJob.status).toBe('queued');
    expect(doneJob.reset_existing).toBe(1);
    const freshJob = await db.getAsync(`SELECT status FROM sentiment_extraction_jobs WHERE transcript_id = ?`, [freshTx]);
    expect(freshJob.status).toBe('queued');
  });

  it('rejects a non-admin', async () => {
    const anon = request.agent(app);
    const res = await anon.get(`/admin/knowledge/sentiment/rerun/collection/1/confirm.json`);
    expect([302, 401, 403]).toContain(res.status);
  });

  it('GET confirm.json with non-numeric id returns 400 with error string', async () => {
    const res = await adminAgent.get('/admin/knowledge/sentiment/rerun/collection/notanid/confirm.json');
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('POST re-run with non-numeric id redirects with error= in location', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/rerun/collection/notanid')
      .type('form').send({ _csrf: csrfToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=');
  });
});
