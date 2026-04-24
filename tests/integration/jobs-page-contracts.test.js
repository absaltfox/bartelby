'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf });

  expect(res.status).toBe(302);
}

describe('jobs page UI contracts', () => {
  let app;
  let db;
  let adminAgent;
  let managerAgent;
  let collectionId;
  let adminJobId;

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
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: setupCsrf
      });

    const docId = await db.documentsAsync.create({
      title: 'Jobs contract document',
      description: null,
      date_created: null,
      image_path: '/uploads/jobs-contract.png',
      metadata: {}
    });
    adminJobId = await db.transcriptionJobsAsync.create({
      document_id: docId,
      provider: 'openai',
      model: null,
      temperature: 0.2,
      initiated_by: 'test',
      image_path: '/uploads/jobs-contract.png'
    });
    await db.transcriptionJobsAsync.appendLog(adminJobId, 'admin jobs log line\n');

    const managerId = await db.usersAsync.create({
      username: 'jobs_manager',
      email: 'manager@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    collectionId = await db.collectionsAsync.create({
      name: 'Jobs Contract Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: true,
      createdBy: null
    });
    await db.userCollectionAccessAsync.grant(managerId, collectionId, 'manager');
    const collectionDocId = await db.documentsAsync.create({
      title: 'Manage jobs contract document',
      description: null,
      date_created: null,
      image_path: '/uploads/manage-jobs-contract.png',
      metadata: {}
    });
    await db.documentCollectionsAsync.add(collectionDocId, collectionId);
    for (let i = 0; i < 51; i++) {
      await db.transcriptionJobsAsync.create({
        document_id: collectionDocId,
        provider: 'openai',
        model: null,
        temperature: 0.2,
        initiated_by: 'test',
        image_path: '/uploads/manage-jobs-contract.png'
      });
    }
    await db.importJobsAsync.create({
      original_name: 'jobs-contract.pdf',
      file_path: '/tmp/jobs-contract.pdf',
      user_id: managerId
    });

    adminAgent = request.agent(app);
    await login(adminAgent, 'testadmin', 'testpassword99!');

    managerAgent = request.agent(app);
    await login(managerAgent, 'jobs_manager', 'password123!');
  }, 30_000);

  it('renders the admin jobs page with named subject cells and mode-aware endpoints', async () => {
    const res = await adminAgent.get('/admin/jobs');

    expect(res.status).toBe(200);
    expect(res.text).toContain('data-job-cell="subject"');
    expect(res.text).toContain('"apiBasesByType":{"transcription":"/admin/jobs/api/"');
    expect(res.text).toContain('"pollUrl":"/admin/jobs/api/all"');
    expect(res.text).toContain('(open log to load)');
    expect(res.text).not.toContain('admin jobs log line');
  });

  it('renders the manage jobs page with named subject cells and collection-scoped endpoints', async () => {
    const res = await managerAgent.get(`/manage/collections/${collectionId}/jobs`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('data-job-cell="subject"');
    expect(res.text).toContain(`"apiBasesByType":{"transcription":"/manage/collections/${collectionId}/jobs/api/"`);
    expect(res.text).toContain(`"pollUrl":"/manage/collections/${collectionId}/jobs/api"`);
    expect(res.text).toContain('Page 1 of 2');
  });

  it('serves hydrated logs from the job detail endpoint', async () => {
    const res = await adminAgent.get(`/admin/jobs/api/${adminJobId}`);

    expect(res.status).toBe(200);
    expect(res.body.log).toContain('admin jobs log line');
  });
});
