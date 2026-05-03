'use strict';

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

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username: 'testadmin', password: 'testpassword99!', _csrf: csrf });
  expect(res.status).toBe(302);
}

describe('authority generic terms data workflow', () => {
  let app;
  let db;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: initializedApp, initApp } = require('../../server');
    await initApp();
    app = initializedApp;
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
    await loginAsAdmin(agent);
  }, 180_000);

  it('creates, approves, rejects, and disables generic terms', async () => {
    const createdId = await db.authorityGenericTermsAsync.createManual({
      term: 'Admin Generic High School',
      entity_type: 'organization',
      notes: 'Bare institutional label',
      userId: null
    });

    await expect(db.authorityGenericTermsAsync.getById(createdId)).resolves.toMatchObject({
      normalized_term: 'admin generic high school',
      entity_type: 'organization',
      status: 'active',
      source: 'manual'
    });
    await expect(db.authorityGenericTermsAsync.isGenericName('Admin Generic High School', 'organization')).resolves.toBe(true);
    await expect(db.authorityGenericTermsAsync.isGenericName('Victoria Admin Generic High School', 'organization')).resolves.toBe(false);

    await db.authorityGenericTermsAsync.setStatus(createdId, 'disabled', null);
    await expect(db.authorityGenericTermsAsync.isGenericName('Admin Generic High School', 'organization')).resolves.toBe(false);

    const suggestedId = await db.authorityGenericTermsAsync.upsert({
      term: 'Admin Suggested School Board',
      entity_type: 'organization',
      source: 'review_pattern',
      status: 'suggested',
      seenIncrement: 5,
      rejectedIncrement: 3
    });
    await db.authorityGenericTermsAsync.setStatus(suggestedId, 'active', null);
    await expect(db.authorityGenericTermsAsync.getById(suggestedId)).resolves.toMatchObject({ status: 'active' });

    const rejectId = await db.authorityGenericTermsAsync.upsert({
      term: 'Admin Reject Committee',
      source: 'extraction',
      status: 'suggested',
      seenIncrement: 5
    });
    await db.authorityGenericTermsAsync.setStatus(rejectId, 'rejected', null);
    await expect(db.authorityGenericTermsAsync.getById(rejectId)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('learns a suggested term after repeated rejected exact-name suggestions', async () => {
    await db.settingsAsync.set('authority_generic_learning_min_rejections', '3');
    await db.settingsAsync.set('authority_generic_learning_min_seen', '3');

    for (let i = 0; i < 3; i++) {
      const authorityId = await db.authoritiesAsync.create({
        authority_type: 'organization',
        canonical_name: 'Learned Generic School Board',
        description: null,
        properties: {}
      });
      const entityId = await db.entitiesAsync.create({
        entity_type: 'organization',
        canonical_name: 'Learned Generic School Board',
        description: null,
        properties: {}
      });
      const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
        entity_id: entityId,
        suggested_authority_id: authorityId,
        confidence: 0.84,
        match_method: 'embedding',
        status: 'pending'
      });
      await db.authorityLinkSuggestionsAsync.reject(suggestionId, null);
    }

    const suggested = await db.authorityGenericTermsAsync.list('suggested', { limit: 100 });
    expect(suggested).toEqual(expect.arrayContaining([
      expect.objectContaining({
        normalized_term: 'learned generic school board',
        entity_type: 'organization',
        source: 'review_pattern',
        rejected_link_count: 3
      })
    ]));
  });

  it('renders settings-adjacent pages without decrypting unrelated secret settings', async () => {
    await db.runAsync(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['openai_api_key', 'enc:v1:not:a:real:secret']
    );
    await db.authorityGenericTermsAsync.createManual({
      term: 'Admin Route Generic School',
      entity_type: 'organization',
      notes: 'Route coverage',
      userId: null
    });

    const res = await agent.get('/admin/knowledge/authorities/generic-terms?status=active');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Generic Authority Terms');
    expect(res.text).toContain('Admin Route Generic School');

    const llmSettings = await agent.get('/admin/llm-settings');
    expect(llmSettings.status).toBe(200);
    expect(llmSettings.text).toContain('LLM Settings');
    expect(llmSettings.text).toContain('Key saved');

    const appSettings = await agent.get('/admin/application-settings');
    expect(appSettings.status).toBe(200);
    expect(appSettings.text).toContain('Application Settings');

    const loggingSettings = await agent.get('/admin/logging/settings');
    expect(loggingSettings.status).toBe(200);
    expect(loggingSettings.text).toContain('Logging Settings');

    const terms = await agent.get('/terms');
    expect(terms.status).toBe(200);
    expect(terms.text).toContain('Terms of Service');
  });
});
