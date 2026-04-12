'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username: 'testadmin', password: 'testpassword99!', _csrf: csrf });
  expect(res.status).toBe(302);
}

describe('admin destructive operations', () => {
  let app;
  let db;
  let audit;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    audit = { log: jest.fn(), reqContext: jest.fn((req) => ({ actorId: req.user?.id || null })) };
    jest.doMock('../../utils/audit-log', () => audit);

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
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: setupCsrf
      });

    agent = request.agent(app);
    await loginAsAdmin(agent);
  }, 30_000);

  it('bulk deletes documents and records an audit event', async () => {
    const docId = await db.documentsAsync.create({
      title: 'Delete me',
      description: null,
      date_created: null,
      image_path: '/uploads/delete-me.png',
      metadata: {}
    });

    const page = await agent.get('/admin/documents');
    const csrf = extractCsrfToken(page.text);
    const res = await agent
      .post('/admin/documents/bulk/delete')
      .set('x-csrf-token', csrf)
      .send({ ids: [docId] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 1 });
    expect(await db.documentsAsync.getById(docId)).toBeFalsy();
    expect(audit.log).toHaveBeenCalledWith('admin.documents_bulk_deleted', expect.objectContaining({
      documentIds: [docId],
      deletedCount: 1
    }));
  });

  it('retries and deletes jobs through admin APIs with audit logging', async () => {
    const docId = await db.documentsAsync.create({
      title: 'Job doc',
      description: null,
      date_created: null,
      image_path: '/uploads/job-doc.png',
      metadata: {}
    });
    const jobId = await db.transcriptionJobsAsync.create({
      document_id: docId,
      provider: 'openai',
      model: null,
      temperature: 0.2,
      initiated_by: 'test',
      image_path: '/uploads/job-doc.png'
    });
    await db.transcriptionJobsAsync.markFailed(jobId, 'simulated failure');

    const page = await agent.get('/admin/jobs');
    const csrf = extractCsrfToken(page.text);

    const retryRes = await agent
      .post(`/admin/jobs/api/${jobId}/retry`)
      .type('form')
      .send({ _csrf: csrf });
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.success).toBe(true);

    const deleteRes = await agent
      .delete(`/admin/jobs/api/${jobId}`)
      .set('x-csrf-token', csrf);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    expect(audit.log).toHaveBeenCalledWith('admin.job_retried', expect.objectContaining({
      jobId,
      jobType: 'transcription'
    }));
    expect(audit.log).toHaveBeenCalledWith('admin.job_deleted', expect.objectContaining({
      jobId,
      jobType: 'transcription'
    }));
  });

  it('deletes collections and records an audit event', async () => {
    const collectionId = await db.collectionsAsync.create({
      name: 'Delete collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: 1
    });

    const page = await agent.get('/admin/collections');
    const csrf = extractCsrfToken(page.text);
    const res = await agent
      .post(`/admin/collections/${collectionId}/delete`)
      .type('form')
      .send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(await db.collectionsAsync.getById(collectionId)).toBeFalsy();
    expect(audit.log).toHaveBeenCalledWith('admin.collection_deleted', expect.objectContaining({
      collectionId
    }));
  });
});
