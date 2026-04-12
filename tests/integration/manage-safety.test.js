'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
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
  return res;
}

describe('manage route safety fixes', () => {
  let app;
  let db;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');
  }, 30_000);

  async function createManager(username) {
    const userId = await db.usersAsync.create({
      username,
      email: `${username}@example.com`,
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    return userId;
  }

  async function createCollection(name) {
    return await db.collectionsAsync.create({
      name,
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
  }

  it('manager delete removes the document from the current collection without deleting shared data', async () => {
    const managerId = await createManager('manager-delete-user');
    const primaryCollectionId = await createCollection('Managed Delete Collection');
    const secondaryCollectionId = await createCollection('Shared Collection');
    await db.userCollectionAccessAsync.grant(managerId, primaryCollectionId, 'manager');

    const documentId = await db.documentsAsync.create({
      title: 'Shared Document',
      date_created: null,
      description: null,
      image_path: '/uploads/shared-doc.png',
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(documentId, [primaryCollectionId, secondaryCollectionId]);

    const agent = request.agent(app);
    await login(agent, 'manager-delete-user', 'password123!');
    const managePage = await agent.get(`/manage/collections/${primaryCollectionId}/documents`);
    const csrf = extractCsrfToken(managePage.text);

    const res = await agent
      .post(`/manage/collections/${primaryCollectionId}/documents/${documentId}/delete`)
      .type('form')
      .send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('removed=1');

    const doc = await db.documentsAsync.getById(documentId);
    expect(doc).toBeTruthy();

    const collections = await db.documentCollectionsAsync.getByDocumentId(documentId);
    expect(collections.map((collection) => collection.id)).toEqual([secondaryCollectionId]);
  });

  it('manage jobs hides other collections submission jobs and labels user-scoped imports clearly', async () => {
    const managerId = await createManager('manager-jobs-user');
    const visibleCollectionId = await createCollection('Managed Jobs Collection');
    const otherCollectionId = await createCollection('Other Jobs Collection');
    await db.userCollectionAccessAsync.grant(managerId, visibleCollectionId, 'manager');

    await db.importJobsAsync.createSubmissionJob({
      original_name: 'visible-collection.pdf',
      user_id: managerId,
      total_count: 1,
      payload: {
        authorizedCollectionIds: [visibleCollectionId],
        remainingGroups: [],
        createdDocs: [],
        batchManifest: [],
        batchJobCreated: false,
        processedCount: 0
      }
    });
    await db.importJobsAsync.createSubmissionJob({
      original_name: 'hidden-other-collection.pdf',
      user_id: managerId,
      total_count: 1,
      payload: {
        authorizedCollectionIds: [otherCollectionId],
        remainingGroups: [],
        createdDocs: [],
        batchManifest: [],
        batchJobCreated: false,
        processedCount: 0
      }
    });
    await db.importJobsAsync.create({
      original_name: 'resume-anywhere.pdf',
      file_path: 'resume-anywhere.pdf',
      user_id: managerId
    });

    const agent = request.agent(app);
    await login(agent, 'manager-jobs-user', 'password123!');
    const res = await agent.get(`/manage/collections/${visibleCollectionId}/jobs`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('visible-collection.pdf');
    expect(res.text).toContain('resume-anywhere.pdf');
    expect(res.text).toContain('Your import job');
    expect(res.text).not.toContain('hidden-other-collection.pdf');
  });

  it('rejects multipart manager uploads without a CSRF token', async () => {
    const managerId = await createManager('manager-upload-user');
    const collectionId = await createCollection('Managed Upload Collection');
    await db.userCollectionAccessAsync.grant(managerId, collectionId, 'manager');

    const agent = request.agent(app);
    await login(agent, 'manager-upload-user', 'password123!');

    const res = await agent
      .post('/manage/api/upload')
      .attach('file', Buffer.from('fake png payload'), {
        filename: 'page1.png',
        contentType: 'image/png'
      });

    expect([302, 403]).toContain(res.status);
  });
});
