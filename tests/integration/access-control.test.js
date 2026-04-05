'use strict';

/**
 * Integration tests — Access Control
 *
 * Verifies that protected routes reject unauthenticated and
 * unauthorised requests with the correct HTTP status codes.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const request = require('supertest');

let app;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
}, 30_000);

describe('Unauthenticated access to admin routes', () => {
  const adminRoutes = [
    '/admin',
    '/admin/users',
    '/admin/collections',
    '/admin/jobs',
    '/admin/documents',
  ];

  adminRoutes.forEach(route => {
    it(`GET ${route} → redirects to /login`, async () => {
      const res = await request(app).get(route);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
    });
  });
});

describe('Unauthenticated access to auth-protected routes', () => {
  it('GET /transcripts/:id → 302 redirect to login (auth required)', async () => {
    // Transcripts require authentication in this branch
    const res = await request(app).get('/transcripts/999');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  it('POST /api/annotations without auth → 401 or 403 (CSRF/auth rejection)', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ transcript_id: 1, user_name: 'hacker', content: 'test' }));
    // CSRF check (403) runs before auth check (401); either is a valid rejection
    expect([401, 403]).toContain(res.status);
  });
});

describe('Unauthenticated access to manage routes', () => {
  it('GET /manage → redirects to /login', async () => {
    const res = await request(app).get('/manage');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });
});

describe('Public routes are accessible', () => {
  it('GET /login → 200', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
  });

  it('GET /setup → 200 (bootstrap required before registration)', async () => {
    // On a fresh DB with no users, /register redirects to /setup
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
  });

  it('GET /healthz → 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});
