'use strict';

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

const fs = require('fs');
const path = require('path');
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
  return res;
}

async function bootApp(storageDriver) {
  jest.resetModules();

  process.env.NODE_ENV = 'test';
  process.env.STORAGE_DRIVER = storageDriver;

  if (storageDriver === 's3') {
    jest.doMock('../../utils/storage', () => {
      const local = jest.requireActual('../../utils/storage/local');
      return {
        ...local,
        readUploadByUrl: jest.fn(async (url) => Buffer.from(`mock:${url}`)),
        getUploadSizeByUrl: jest.fn(async () => 17)
      };
    });
  }

  const server = require('../../server');
  await server.initApp();

  return {
    app: server.app,
    db: require('../../database/db'),
    config: require('../../config')
  };
}

async function seedProtectedDocument(db, filename) {
  const collectionId = await db.collectionsAsync.create({
    name: `Protected ${filename}`,
    description: null,
    is_public: false,
    is_world_public: false,
    allow_export: false,
    auto_group_pages: false,
    createdBy: null
  });

  const authorizedUserId = await db.usersAsync.create({
    username: `authorized_${filename}`,
    email: `${filename}-authorized@example.com`,
    passwordHash: bcrypt.hashSync('password123!', 10),
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });

  const unauthorizedUserId = await db.usersAsync.create({
    username: `unauthorized_${filename}`,
    email: `${filename}-unauthorized@example.com`,
    passwordHash: bcrypt.hashSync('password123!', 10),
    role: 'user',
    status: 'active',
    accessAll: false,
    canUseSystemApiKeys: false
  });

  await db.userCollectionAccessAsync.grant(authorizedUserId, collectionId, 'viewer');

  const documentId = await db.documentsAsync.create({
    title: `Protected ${filename}`,
    date_created: null,
    description: null,
    image_path: `/uploads/${filename}`,
    metadata: {}
  });
  await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);

  return {
    collectionId,
    documentId,
    uploadUrl: `/uploads/${filename}`,
    authorizedUsername: `authorized_${filename}`,
    unauthorizedUsername: `unauthorized_${filename}`
  };
}

describe.each(['local', 's3'])('Protected upload access (%s)', (storageDriver) => {
  let app;
  let db;
  let config;
  let seeded;
  let expectedBody;

  beforeAll(async () => {
    ({ app, db, config } = await bootApp(storageDriver));
    seeded = await seedProtectedDocument(db, `${storageDriver}-protected.png`);
    expectedBody = storageDriver === 'local'
      ? Buffer.from('local-protected-content')
      : Buffer.from(`mock:${seeded.uploadUrl}`);

    if (storageDriver === 'local') {
      fs.mkdirSync(config.app.uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(config.app.uploadsDir, path.basename(seeded.uploadUrl)), expectedBody);
    }
  }, 30_000);

  it('redirects unauthenticated users to login', async () => {
    const res = await request(app).get(seeded.uploadUrl);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  it('returns 403 for authenticated users without access', async () => {
    const agent = request.agent(app);
    await login(agent, seeded.unauthorizedUsername, 'password123!');

    const res = await agent.get(seeded.uploadUrl);
    expect(res.status).toBe(403);
  });

  it('streams the asset for authorized users', async () => {
    const agent = request.agent(app);
    await login(agent, seeded.authorizedUsername, 'password123!');

    const res = await agent.get(seeded.uploadUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.compare(res.body, expectedBody)).toBe(0);
  });
});
