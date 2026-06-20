'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent.post('/login').type('form').send({ username, password, _csrf: csrf });
  expect(res.status).toBe(302);
}

describe('document knowledge tab relationship-count notice', () => {
  let app;
  let db;
  let documentId;
  let adminAgent;
  let viewerAgent;

  beforeAll(async () => {
    jest.resetModules();
    const server = require('../../server');
    await server.initApp();
    app = server.app;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    const setupCsrf = extractCsrfToken(setupPage.text);
    await setupAgent.post('/setup').type('form').send({
      username: 'docgraphadmin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

    await db.usersAsync.create({
      username: 'docgraphviewer',
      email: 'docgraphviewer@example.com',
      passwordHash: bcrypt.hashSync('pw-abcdefgh99!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });

    const collectionId = await db.collectionsAsync.create({
      name: 'Document Graph Notice Collection',
      description: null,
      is_public: true,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false
    });
    documentId = await db.documentsAsync.create({
      title: 'Document Graph Notice Doc',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(documentId, collectionId);
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Alice appointed Bob.',
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1
    });
    const sourceId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Alice',
      description: null,
      properties: {},
      authority_id: null
    });
    const targetId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Bob',
      description: null,
      properties: {},
      authority_id: null
    });
    const relationshipId = await db.relationshipsAsync.create({
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: 'associated_with',
      label: null,
      properties: {},
      confidence: 0.7
    });
    await db.citationsAsync.create({
      relationship_id: relationshipId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 20,
      passage_text: 'Alice appointed Bob.',
      extraction_method: 'llm_auto',
      extraction_model: 'fixture',
      confidence: 0.7,
      approval_status: 'pending'
    });

    adminAgent = request.agent(app);
    await login(adminAgent, 'docgraphadmin', 'pw-abcdefgh99!');
    viewerAgent = request.agent(app);
    await login(viewerAgent, 'docgraphviewer', 'pw-abcdefgh99!');
  }, 60_000);

  it('renders document detail successfully and shows admin review link for pending relationships', async () => {
    const res = await adminAgent.get(`/documents/${documentId}`).expect(200);
    expect(res.text).toContain('1 pending relationship hidden from this view.');
    expect(res.text).toContain('/admin/knowledge/review-extractions?kind=relationship');
  });

  it('does not expose the admin review link to non-admin readers', async () => {
    const res = await viewerAgent.get(`/documents/${documentId}`).expect(200);
    expect(res.text).not.toContain('/admin/knowledge/review-extractions?kind=relationship');
    expect(res.text).not.toContain('pending relationship hidden from this view');
    expect(res.text).toContain('From approved transcript evidence');
  });
});
