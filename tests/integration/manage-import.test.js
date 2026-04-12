'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

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

describe('Manager import routes', () => {
  let app;
  let db;
  let manager;
  let collectionId;
  let agent;
  let csrf;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');

    manager = await db.usersAsync.create({
      username: 'manager_user',
      email: 'manager@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    collectionId = await db.collectionsAsync.create({
      name: 'Managed Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: true,
      createdBy: null
    });

    await db.userCollectionAccessAsync.grant(manager, collectionId, 'manager');

    agent = request.agent(app);
    await login(agent, 'manager_user', 'password123!');

    const importPage = await agent.get(`/manage/collections/${collectionId}/import`);
    expect(importPage.status).toBe(200);
    csrf = extractCsrfToken(importPage.text);
  }, 30_000);

  it('supports manager upload, resume, and save through /manage/api', async () => {
    const uploadRes = await agent
      .post('/manage/api/upload')
      .field('_csrf', csrf)
      .attach('file', Buffer.from('fake png payload'), {
        filename: 'page1.png',
        contentType: 'image/png'
      });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.success).toBe(true);
    expect(uploadRes.body.type).toBe('image');
    expect(typeof uploadRes.body.tempFile).toBe('string');

    const importJobId = await db.importJobsAsync.create({
      original_name: 'page1.png',
      file_path: uploadRes.body.tempFile,
      user_id: manager
    });
    await db.importJobsAsync.markDone(importJobId, [{ filename: uploadRes.body.tempFile }]);

    const resumePage = await agent.get(`/manage/collections/${collectionId}/import?importJobId=${importJobId}`);
    expect(resumePage.status).toBe(200);
    expect(resumePage.text).toContain('page1.png');

    const jobRes = await agent.get(`/manage/api/import-job/${importJobId}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe('done');
    expect(jobRes.body.pages).toHaveLength(1);
    expect(jobRes.body.pages[0].filename).toBe(uploadRes.body.tempFile);

    const saveRes = await agent
      .post('/manage/api/save-document')
      .set('x-csrf-token', csrf)
      .send({
        tempFiles: [uploadRes.body.tempFile],
        originalName: 'page1.png',
        title: 'Manager Imported Document',
        description: 'Imported by manager flow',
        transcription: 'Manual transcription body',
        transcriptionMode: 'manual',
        collectionIds: [collectionId]
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);
    expect(Number.isInteger(saveRes.body.documentId)).toBe(true);

    const savedDoc = await db.documentsAsync.getById(saveRes.body.documentId);
    expect(savedDoc).toBeTruthy();
    expect(savedDoc.title).toBe('Manager Imported Document');

    const assignedCollections = await db.documentCollectionsAsync.getByDocumentId(saveRes.body.documentId);
    expect(assignedCollections.map((collection) => collection.id)).toContain(collectionId);
  });
});
