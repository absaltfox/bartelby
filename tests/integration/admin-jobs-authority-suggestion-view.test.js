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
      username: 'a1viewadmin',
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
    .send({ username: 'a1viewadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('/admin/jobs renders authority_suggestion type', () => {
  it('shows the Authority Suggestion type tab', async () => {
    const res = await adminAgent.get('/admin/jobs').expect(200);
    expect(res.text).toMatch(/Authority Suggestion/);
    expect(res.text).toMatch(/type=authority_suggestion/);
  });

  it('renders a failed authority_suggestion row with subject, inline error, and Retry', async () => {
    const failedId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'Load model Xenova/all-MiniLM-L6-v2 — Protobuf parsing failed.');

    const res = await adminAgent.get('/admin/jobs?filter=failed&type=authority_suggestion').expect(200);
    expect(res.text).toMatch(new RegExp(`data-id="${failedId}"`));
    expect(res.text).toMatch(/Full corpus/);
    expect(res.text).toMatch(/Protobuf parsing failed\./);
    expect(res.text).toMatch(new RegExp(`retry-btn[^>]*data-id="${failedId}"`));
  });
});
