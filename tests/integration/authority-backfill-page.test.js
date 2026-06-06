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

let app;
let db;
let adminAgent;

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
      username: 'bf-admin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'bf-admin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('/admin/knowledge/authorities/backfill', () => {
  it('lists collections in sentiment-priority order with entity counts', async () => {
    const cSent = await db.collectionsAsync.create({
      name: 'Sentiment Test 1', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    await db.collectionsAsync.setSentimentEnabled(cSent, true);
    const cNoSent = await db.collectionsAsync.create({
      name: 'Sentiment Test 2', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });

    const res = await adminAgent.get('/admin/knowledge/authorities/backfill').expect(200);
    expect(res.text).toMatch(/Sentiment Test 1/);
    expect(res.text).toMatch(/Sentiment Test 2/);
    const idxSent = res.text.indexOf('Sentiment Test 1');
    const idxNoSent = res.text.indexOf('Sentiment Test 2');
    expect(idxSent).toBeLessThan(idxNoSent);
    expect(res.text).toMatch(/entities/);
    expect(res.text).toMatch(/\/admin\/knowledge\/authorities\/suggestion-jobs\/collection\//);
  });

  it('shows a pending-job indicator when one is queued for a collection', async () => {
    const c = await db.collectionsAsync.create({
      name: 'Has Pending Job', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    await db.authoritySuggestionJobsAsync.create({ collection_id: c });
    const res = await adminAgent.get('/admin/knowledge/authorities/backfill').expect(200);
    expect(res.text).toMatch(/Has Pending Job[\s\S]*?(pending|queued|running)/i);
  });
});
