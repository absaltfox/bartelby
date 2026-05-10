'use strict';

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createStorageMock } = require('../helpers/storage-mock');

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

async function bootApp({ presignTtl = '300' } = {}) {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_PRESIGNED_GET_TTL_SECONDS = presignTtl;

  const storageMock = createStorageMock();
  jest.doMock('../../utils/storage', () => storageMock);

  const server = require('../../server');
  await server.initApp();

  return {
    app: server.app,
    db: require('../../database/db'),
    storageMock
  };
}

describe('collection image delivery', () => {
  afterEach(() => {
    delete process.env.S3_PRESIGNED_GET_TTL_SECONDS;
  });

  it('uses presigned thumbnail URLs on the authorized public collections landing page', async () => {
    const { app, db, storageMock } = await bootApp();
    const collectionId = await db.collectionsAsync.create({
      name: 'World Public Presigned',
      description: 'Visible without login',
      is_public: false,
      is_world_public: true,
      createdBy: null
    });
    const docId = await db.documentsAsync.create({
      title: 'World Preview',
      image_path: '/uploads/world-preview.png',
      date_created: null,
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, collectionId);
    await db.collectionsAsync.setPreviewDocument(collectionId, docId);

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('https://signed.example.test/uploads/world-preview.png?sig=test');
    expect(storageMock.getPresignedUploadUrl).toHaveBeenCalledWith('/uploads/world-preview.png', 300);
  });

  it('uses presigned document URLs for authenticated users with collection access', async () => {
    const { app, db, storageMock } = await bootApp();
    const userId = await db.usersAsync.create({
      username: 'presign-member',
      email: 'presign-member@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active'
    });
    const collectionId = await db.collectionsAsync.create({
      name: 'Private Presigned',
      description: 'Private',
      is_public: false,
      is_world_public: false,
      createdBy: null
    });
    await db.userCollectionAccessAsync.grant(userId, collectionId, 'viewer');
    const docId = await db.documentsAsync.create({
      title: 'Private Preview',
      image_path: '/uploads/private-preview.png',
      date_created: null,
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, collectionId);

    const agent = request.agent(app);
    await login(agent, 'presign-member', 'password123!');
    const res = await agent.get(`/collections/${collectionId}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('https://signed.example.test/uploads/private-preview.png?sig=test');
    expect(storageMock.getPresignedUploadUrl).toHaveBeenCalledWith('/uploads/private-preview.png', 300);
  });

  it('falls back to proxied upload URLs when presigned delivery is disabled', async () => {
    const { app, db, storageMock } = await bootApp({ presignTtl: '0' });
    const collectionId = await db.collectionsAsync.create({
      name: 'World Public Proxy',
      description: 'Visible without login',
      is_public: false,
      is_world_public: true,
      createdBy: null
    });
    const docId = await db.documentsAsync.create({
      title: 'Proxy Preview',
      image_path: '/uploads/proxy-preview.png',
      date_created: null,
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, collectionId);
    await db.collectionsAsync.setPreviewDocument(collectionId, docId);

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('/uploads/proxy-preview.png');
    expect(res.text).not.toContain('https://signed.example.test/uploads/proxy-preview.png?sig=test');
    expect(storageMock.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('does not presign private collection assets for unauthorized visitors', async () => {
    const { app, db, storageMock } = await bootApp();
    const collectionId = await db.collectionsAsync.create({
      name: 'Private Denied Presigned',
      description: 'Private',
      is_public: false,
      is_world_public: false,
      createdBy: null
    });
    const docId = await db.documentsAsync.create({
      title: 'Denied Preview',
      image_path: '/uploads/denied-preview.png',
      date_created: null,
      description: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(docId, collectionId);

    const res = await request(app).get(`/collections/${collectionId}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
    expect(storageMock.getPresignedUploadUrl).not.toHaveBeenCalledWith('/uploads/denied-preview.png', 300);
  });
});
