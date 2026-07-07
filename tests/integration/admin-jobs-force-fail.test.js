// tests/integration/admin-jobs-force-fail.test.js
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

let app; let db; let adminAgent; let csrf;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  await setupAgent.post('/setup').type('form').send({
    username: 'failadmin', password: 'pw-abcdefgh99!', confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN, _csrf: extractCsrfToken(setupPage.text)
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  await adminAgent.post('/login').type('form').send({
    username: 'failadmin', password: 'pw-abcdefgh99!', _csrf: extractCsrfToken(loginPage.text)
  });
  const jobsPage = await adminAgent.get('/admin/jobs');
  csrf = extractCsrfToken(jobsPage.text);
}, 60_000);

async function makeRunningBatchTranscriptionJob() {
  const docId = await db.documentsAsync.create({
    title: 'Force Fail Doc', date_created: null, description: null,
    image_path: '/uploads/force-fail.png', metadata: {}
  });
  const r = await db.runAsync(`
    INSERT INTO transcription_jobs (document_id, provider, status, job_kind, batch_remote_id, started_at, image_path)
    VALUES (?, 'openai', 'running', 'batch', 'pending-force-fail-1', CURRENT_TIMESTAMP, 'stub.png')
  `, [docId]);
  return r.lastInsertRowid;
}

describe('POST /admin/jobs/api/:id/fail', () => {
  it('fails a running batch transcription job', async () => {
    const jobId = await makeRunningBatchTranscriptionJob();
    await adminAgent.post(`/admin/jobs/api/${jobId}/fail`)
      .set('X-CSRF-Token', csrf).expect(200);
    const job = await db.getAsync('SELECT status FROM transcription_jobs WHERE id = ?', [jobId]);
    expect(job.status).toBe('failed');
  });

  it('409s for a job that is not a running batch', async () => {
    const jobId = await makeRunningBatchTranscriptionJob();
    await db.runAsync("UPDATE transcription_jobs SET status = 'done' WHERE id = ?", [jobId]);
    await adminAgent.post(`/admin/jobs/api/${jobId}/fail`)
      .set('X-CSRF-Token', csrf).expect(409);
  });
});
