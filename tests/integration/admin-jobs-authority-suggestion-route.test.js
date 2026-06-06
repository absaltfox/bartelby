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
let csrf;

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
      username: 'a1admin',
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
    .send({ username: 'a1admin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  const jobsPage = await adminAgent.get('/admin/jobs');
  csrf = extractCsrfToken(jobsPage.text);
}, 60_000);

describe('admin-jobs authority_suggestion routes', () => {
  it('GET /api/authority-suggestion/:id returns the job with log', async () => {
    const id = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(id, 'Server restarted during processing');

    const res = await adminAgent.get(`/admin/jobs/api/authority-suggestion/${id}`).expect(200);
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toBe('Server restarted during processing');
  });

  it('GET on missing id returns 404', async () => {
    await adminAgent.get('/admin/jobs/api/authority-suggestion/999999').expect(404);
  });

  it('POST /api/authority-suggestion/:id/retry queues a new job and preserves the failed row', async () => {
    const failedId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'boom');

    const res = await adminAgent
      .post(`/admin/jobs/api/authority-suggestion/${failedId}/retry`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.newJobId).toEqual(expect.any(Number));
    expect(res.body.newJobId).not.toBe(failedId);

    const failed = await db.authoritySuggestionJobsAsync.getById(failedId);
    expect(failed.status).toBe('failed');
  });

  it('POST retry on non-failed job returns 409', async () => {
    const id = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await adminAgent
      .post(`/admin/jobs/api/authority-suggestion/${id}/retry`)
      .set('x-csrf-token', csrf)
      .expect(409);
  });

  it('DELETE removes a failed authority_suggestion job; refuses active ones', async () => {
    const failedId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'boom');
    await adminAgent
      .delete(`/admin/jobs/api/authority-suggestion/${failedId}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    const runningId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await adminAgent
      .delete(`/admin/jobs/api/authority-suggestion/${runningId}`)
      .set('x-csrf-token', csrf)
      .expect(409);
  });
});
