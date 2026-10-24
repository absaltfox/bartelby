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

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_PRESIGNED_GET_TTL_SECONDS = '300';

  jest.doMock('../../utils/storage', () => createStorageMock());

  const server = require('../../server');
  await server.initApp();

  return { app: server.app, db: require('../../database/db') };
}

async function createCollection(db, fields) {
  return db.collectionsAsync.create({
    description: null,
    is_public: false,
    is_world_public: false,
    createdBy: null,
    ...fields
  });
}

async function addDocument(db, collectionId, fields) {
  const docId = await db.documentsAsync.create({
    title: 'Page 1',
    image_path: '/uploads/shelf-preview.png',
    date_created: null,
    description: null,
    metadata: {},
    ...fields
  });
  await db.documentCollectionsAsync.add(docId, collectionId);
  return docId;
}

function rowFor(html, name) {
  const rows = html.split('<tr').filter((chunk) => chunk.includes(`>${name}</a>`));
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('collections landing shelf list', () => {
  afterEach(() => {
    delete process.env.S3_PRESIGNED_GET_TTL_SECONDS;
  });

  it('renders a world-public collection as a shelf row for anonymous visitors', async () => {
    const { app, db } = await bootApp();
    const publicId = await createCollection(db, {
      name: 'Shelf Public Letters',
      description: 'Open correspondence',
      is_world_public: true
    });
    const docId = await addDocument(db, publicId, { date_created: '1885-03-01' });
    await db.collectionsAsync.setPreviewDocument(publicId, docId);
    await createCollection(db, { name: 'Shelf Hidden Letters' });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('data-collections-shelf');
    expect(res.text).not.toContain('Shelf Hidden Letters');

    const row = rowFor(res.text, 'Shelf Public Letters');
    expect(row).toContain(`href="/collections/${publicId}"`);
    expect(row).toContain('data-sort-documents="1"');
    expect(row).toContain('data-sort-dated="1885"');
    expect(row).toMatch(/data-sort-added="\d+"/);
    expect(row).toContain('class="shelf-vis">Public<');
    expect(row).toContain('Open correspondence');
    expect(row).toContain('class="shelf-thumb"');
    expect(row).toContain('data-hide-on-image-error');
  });

  it('drops the featured band, numerals, tiles and rail', async () => {
    const { app, db } = await bootApp();
    const id = await createCollection(db, { name: 'Shelf Only', is_world_public: true });
    await addDocument(db, id, {});

    const res = await request(app).get('/');

    expect(res.text).not.toContain('featured-band');
    expect(res.text).not.toContain('stacks-card');
    expect(res.text).not.toContain('Featured collection');
    expect(res.text).not.toContain('Lately added');
    expect(res.text).not.toContain('No. I');
    expect(res.text).not.toContain('All years');
    expect(res.text).not.toContain('No recent additions');
  });

  it('shows admins every collection, quiet private rows, empty rows and linked header counts', async () => {
    const { app, db } = await bootApp();
    await db.usersAsync.create({
      username: 'shelf-admin',
      email: 'shelf-admin@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'admin',
      status: 'active'
    });
    const fullId = await createCollection(db, { name: 'Shelf Closed Full' });
    await addDocument(db, fullId, {});
    await createCollection(db, { name: 'Shelf Closed Empty' });
    await db.documentsAsync.create({
      title: 'Loose page',
      image_path: '/uploads/loose.png',
      date_created: null,
      description: null,
      metadata: {}
    });

    const agent = request.agent(app);
    await login(agent, 'shelf-admin', 'password123!');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/collections/all"');
    expect(res.text).toContain('href="/collections/uncollected"');
    expect(res.text).toMatch(/1 uncollected/);

    const full = rowFor(res.text, 'Shelf Closed Full');
    expect(full).not.toContain('shelf-vis');
    expect(full).not.toContain('Private');
    expect(full).toContain('data-sort-dated=""');
    expect(full).not.toContain('shelf-desc');

    const empty = rowFor(res.text, 'Shelf Closed Empty');
    expect(empty).toContain('class="is-empty"');
    expect(empty).toContain('None yet');
    expect(empty).toContain('data-sort-documents="0"');
    expect(empty).toContain('data-sort-added=""');
    expect(empty).not.toContain('shelf-thumb"');
  });

  it('escapes a collection name with markup in the cell and the sort key', async () => {
    const { app, db } = await bootApp();
    const id = await createCollection(db, {
      name: 'Smith & "Sons" <b>',
      is_world_public: true
    });
    await addDocument(db, id, {});

    const res = await request(app).get('/');

    expect(res.text).not.toContain('<b></a>');
    expect(res.text).toContain('data-sort-name="Smith &amp; &#34;Sons&#34; &lt;b&gt;"');
    expect(res.text).toContain('>Smith &amp; &#34;Sons&#34; &lt;b&gt;</a>');
  });

  it('keeps the empty state and renders no table when nothing is visible', async () => {
    const { app, db } = await bootApp();
    await createCollection(db, { name: 'Shelf Hidden Only' });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('No collections yet');
    expect(res.text).not.toContain('data-collections-shelf');
  });
});
