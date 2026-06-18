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
  await setupAgent.post('/setup').type('form').send({
    username: 'docssearchadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'docssearchadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });
}, 60_000);

describe('GET /admin/knowledge/api/documents/search — includes transcripts', () => {
  it('returns a transcripts array per document with id, version, is_best', async () => {
    const docId = 9870;
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [docId, 'Velocity Test Doc Letter']);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content, version, is_best, transcriber) VALUES (?, ?, ?, ?, ?, ?)`,
      [docId * 10 + 1, docId, 'v1 content', 1, 0, 'tester']
    );
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content, version, is_best, transcriber) VALUES (?, ?, ?, ?, ?, ?)`,
      [docId * 10 + 2, docId, 'v2 content', 2, 1, 'tester']
    );

    const res = await adminAgent
      .get('/admin/knowledge/api/documents/search?q=Velocity')
      .set('Accept', 'application/json')
      .expect(200);

    const body = res.body;
    expect(Array.isArray(body.results)).toBe(true);
    const match = body.results.find((r) => r.id === docId);
    expect(match).toBeTruthy();
    expect(Array.isArray(match.transcripts)).toBe(true);
    expect(match.transcripts.length).toBeGreaterThanOrEqual(2);
    const best = match.transcripts.find((t) => t.is_best === 1 || t.is_best === true);
    expect(best).toBeTruthy();
    expect(best.version).toBe(2);
    expect(best.transcriber).toBe('tester');
  });
});
