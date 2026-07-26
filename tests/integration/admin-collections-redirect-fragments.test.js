'use strict';

// Regression test for backlog issue #56 — the `#collection-<id>` hash used to
// open the Access panel for ANY collection redirect, which was correct for the
// access grant/revoke flows but wrong for the set-preview redirect (should open
// the Preview panel) and the re-extract returnTo (should land on the top flash).
//
// The fix differentiates redirect fragments by intent: access flows target
// `#access-<id>`, the preview flow targets `#preview-<id>`, and `#collection-`
// is reserved for scroll-only flows. This asserts the redirect Location on each
// admin-collections route carries the right fragment.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

describe('admin-collections redirect fragments (issue #56)', () => {
  let app;
  let db;
  let agent;
  let collectionId;
  let adminId;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    await setupAgent
      .post('/setup')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: extractCsrfToken(setupPage.text)
      });

    agent = request.agent(app);
    const loginPage = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword99!', _csrf: extractCsrfToken(loginPage.text) });

    const adminRow = await db.getAsync('SELECT id FROM users WHERE username = ?', ['testadmin']);
    adminId = adminRow.id;

    collectionId = await db.collectionsAsync.create({
      name: 'Fragment test collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: adminId
    });
  }, 30_000);

  async function csrf() {
    const page = await agent.get('/admin/collections');
    return extractCsrfToken(page.text);
  }

  it('access grant redirects to the #access- fragment', async () => {
    const res = await agent
      .post(`/admin/collections/${collectionId}/access/grant`)
      .type('form')
      .send({ user_id: String(adminId), role: 'viewer', _csrf: await csrf() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/collections?saved=1#access-${collectionId}`);
  });

  it('access revoke redirects to the #access- fragment', async () => {
    const res = await agent
      .post(`/admin/collections/${collectionId}/access/revoke/${adminId}`)
      .type('form')
      .send({ _csrf: await csrf() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/collections#access-${collectionId}`);
  });

  it('set-preview redirects to the #preview- fragment (not #access-)', async () => {
    // Clearing the preview (no document id) is enough to exercise the redirect.
    const res = await agent
      .post(`/admin/collections/${collectionId}/preview`)
      .type('form')
      .send({ _csrf: await csrf() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/collections?saved=1#preview-${collectionId}`);
    expect(res.headers.location).not.toContain('#access-');
    expect(res.headers.location).not.toContain('#collection-');
  });

  it('re-extract returnTo has no #collection- fragment (lands on the top flash)', async () => {
    const page = await agent.get('/admin/collections');
    // The re-extract form for this collection posts returnTo=/admin/collections
    // with no fragment, so the queued-confirmation flash at the top is visible.
    expect(page.text).toMatch(/name="returnTo" value="\/admin\/collections"/);
    expect(page.text).not.toMatch(new RegExp(`returnTo" value="/admin/collections#collection-${collectionId}"`));
  });
});
