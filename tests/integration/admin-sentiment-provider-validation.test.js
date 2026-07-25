'use strict';

// Regression test for backlog issue #55 — the Admin → Settings "Sentiment
// default provider" field used to be free text, so a model name (e.g.
// "gemini-3.1-flash-lite") saved silently and only failed at job runtime with
// "Sentiment provider '…' is not configured". The fix validates
// `sentiment.provider.default` in saveLlmSettings (routes/admin.js) and renders
// the field as a <select> of the supported providers (views/admin/settings.ejs).
//
// This test drives the real POST /admin/llm-settings route (with admin auth +
// CSRF) to assert: an unsupported value is rejected with a redirect-to-error
// and is NOT persisted; a supported value is accepted and persisted; blank is
// accepted (inherit). It also asserts the settings page renders the field as a
// <select>, not a free-text input.

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

describe('Sentiment default provider validation (issue #55)', () => {
  let app;
  let db;
  let agent;

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
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: setupCsrf
      });

    agent = request.agent(app);
    const loginPage = await agent.get('/login');
    const loginCsrf = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'testadmin', password: 'testpassword99!', _csrf: loginCsrf });
    expect(res.status).toBe(302);
  }, 30_000);

  async function postSettings(value) {
    const page = await agent.get('/admin/llm-settings');
    const csrf = extractCsrfToken(page.text);
    return agent
      .post('/admin/llm-settings')
      .type('form')
      .send({ 'sentiment.provider.default': value, _csrf: csrf });
  }

  it('renders the sentiment default provider as a <select>, not free text', async () => {
    const page = await agent.get('/admin/llm-settings');
    expect(page.status).toBe(200);
    // The field is now a select with the supported provider options.
    expect(page.text).toMatch(/<select[^>]*name="sentiment\.provider\.default"/);
    expect(page.text).not.toMatch(/<input[^>]*name="sentiment\.provider\.default"/);
  });

  it('rejects an unsupported provider value (a model name) and does not persist it', async () => {
    const res = await postSettings('gemini-3.1-flash-lite');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/llm-settings\?error=/);
    expect(decodeURIComponent(res.headers.location)).toContain('is not a supported provider');

    const stored = await db.settingsAsync.get('sentiment.provider.default');
    expect(stored).not.toBe('gemini-3.1-flash-lite');
  });

  it('accepts a supported provider value and persists it', async () => {
    const res = await postSettings('openai');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/llm-settings\?saved=1/);

    const stored = await db.settingsAsync.get('sentiment.provider.default');
    expect(stored).toBe('openai');
  });

  it('accepts a blank value (inherit the global default)', async () => {
    const res = await postSettings('');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/llm-settings\?saved=1/);

    const stored = await db.settingsAsync.get('sentiment.provider.default');
    expect(stored === '' || stored == null).toBe(true);
  });
});
