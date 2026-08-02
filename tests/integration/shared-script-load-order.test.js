'use strict';

/**
 * Page-specific scripts are loaded by the page template, which sits *ahead of*
 * the shared footer include (docs/ui-template-standards.md, Page Shell order).
 * So a shared script that page JS calls synchronously at load cannot live in
 * the footer — it would be fetched after its consumers had already thrown.
 *
 * `public/js/poll-scheduler.js` is exactly that kind of dependency:
 * `jobs-page.js` calls `PollScheduler.createBackoff` and `document-page.js`
 * calls `PollScheduler.every` inside their top-level IIFEs. This test pins the
 * emitted order rather than the file it happens to be declared in, so moving
 * it anywhere that still loads late fails here.
 */

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password: 'password123!', _csrf: csrf });
  expect(res.status).toBe(302);
}

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const server = require('../../server');
  await server.initApp();
  return { app: server.app, db: require('../../database/db') };
}

const SHARED_SCRIPT = '/js/poll-scheduler.js';

function scriptOrder(html) {
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}

describe('shared script load order', () => {
  let app;
  let db;
  let documentId;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    const collectionId = await db.collectionsAsync.create({
      name: 'Script Order Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    await db.usersAsync.create({
      username: 'script_order_reader',
      email: 'script-order-reader@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    documentId = await db.documentsAsync.create({
      title: 'Script Order Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);
    await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Script order transcript body.',
      transcriber: 'manual',
      version: 1,
      notes: null,
      is_best: true,
      created_by_user_id: null
    });
  }, 60_000);

  it('every page JS file that uses PollScheduler is covered by this guard', () => {
    // Keeps the list below honest: if another page script starts calling the
    // shared scheduler, it must be added here.
    const jsDir = path.join(__dirname, '..', '..', 'public', 'js');
    const consumers = fs.readdirSync(jsDir)
      .filter((name) => name.endsWith('.js') && name !== 'poll-scheduler.js')
      .filter((name) => fs.readFileSync(path.join(jsDir, name), 'utf8').includes('PollScheduler'));

    expect(consumers.sort()).toEqual([
      'document-page.js',
      'jobs-page.js',
      'sentiment-clusters-page.js'
    ]);
  });

  it('loads the shared scheduler before the document page script', async () => {
    const agent = request.agent(app);
    await login(agent, 'script_order_reader');

    const res = await agent.get(`/documents/${documentId}`);
    expect(res.status).toBe(200);

    const order = scriptOrder(res.text);
    expect(order).toContain(SHARED_SCRIPT);
    expect(order).toContain('/js/document-page.js');
    expect(order.indexOf(SHARED_SCRIPT)).toBeLessThan(order.indexOf('/js/document-page.js'));
  });

  it('loads the shared scheduler before any page script on a plain page too', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);

    const order = scriptOrder(res.text);
    expect(order).toContain(SHARED_SCRIPT);
    // It ships in the head, ahead of every other script on the page.
    expect(order.indexOf(SHARED_SCRIPT)).toBe(0);
  });
});
