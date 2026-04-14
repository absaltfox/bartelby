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

async function bootstrapAdmin(app) {
  const agent = request.agent(app);
  const setupPage = await agent.get('/setup');
  const csrf = extractCsrfToken(setupPage.text);
  const res = await agent
    .post('/setup')
    .type('form')
    .send({
      username: 'jobs-admin',
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: csrf
    });
  expect(res.status).toBe(302);

  const loginPage = await agent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await agent
    .post('/login')
    .type('form')
    .send({
      username: 'jobs-admin',
      password: 'testpassword99!',
      _csrf: loginCsrf
    });
  expect(loginRes.status).toBe(302);
  return agent;
}

describe('admin job deletion safety', () => {
  let app;
  let db;
  let adminAgent;
  let csrf;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');
    adminAgent = await bootstrapAdmin(app);

    const jobsPage = await adminAgent.get('/admin/jobs');
    csrf = extractCsrfToken(jobsPage.text);
  }, 30_000);

  it('blocks deletion of active jobs and still deletes terminal jobs', async () => {
    const documentId = await db.documentsAsync.create({
      title: 'Job Safety Document',
      date_created: null,
      description: null,
      image_path: '/uploads/job-safety.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Job safety transcript',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });

    const activeTranscriptionId = await db.transcriptionJobsAsync.create({
      document_id: documentId,
      provider: 'openai',
      model: null,
      temperature: null,
      initiated_by: 'test',
      image_path: '/uploads/job-safety.png',
      additional_image_paths: null,
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: 1
    });
    const activeImportId = await db.importJobsAsync.create({
      original_name: 'active-import.pdf',
      file_path: 'active-import.pdf',
      user_id: 1
    });
    const activeExtractionId = await db.extractionJobsAsync.create({
      transcript_id: transcriptId,
      document_id: documentId,
      provider: 'openai',
      model: null,
      temperature: null,
      initiated_by: 'test',
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: 1,
      reset_existing: false
    });

    const terminalTranscriptionId = await db.transcriptionJobsAsync.create({
      document_id: documentId,
      provider: 'openai',
      model: null,
      temperature: null,
      initiated_by: 'test',
      image_path: '/uploads/job-safety.png',
      additional_image_paths: null,
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: 1
    });
    await db.transcriptionJobsAsync.markFailed(terminalTranscriptionId, 'expected failure');

    await adminAgent
      .delete(`/admin/jobs/api/${activeTranscriptionId}`)
      .set('x-csrf-token', csrf)
      .expect(409);
    await adminAgent
      .delete(`/admin/jobs/api/import/${activeImportId}`)
      .set('x-csrf-token', csrf)
      .expect(409);
    await adminAgent
      .delete(`/admin/jobs/api/extraction/${activeExtractionId}`)
      .set('x-csrf-token', csrf)
      .expect(409);

    const deleteTerminalRes = await adminAgent
      .delete(`/admin/jobs/api/${terminalTranscriptionId}`)
      .set('x-csrf-token', csrf);
    expect(deleteTerminalRes.status).toBe(200);
    expect(deleteTerminalRes.body.success).toBe(true);

    await expect(db.transcriptionJobsAsync.getById(activeTranscriptionId)).resolves.toBeTruthy();
    await expect(db.importJobsAsync.getById(activeImportId)).resolves.toBeTruthy();
    await expect(db.extractionJobsAsync.getById(activeExtractionId)).resolves.toBeTruthy();
    await expect(db.transcriptionJobsAsync.getById(terminalTranscriptionId)).resolves.toBeFalsy();
  });
});
