'use strict';

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username, password) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrf });

  expect(res.status).toBe(302);
  return res;
}

async function bootApp() {
  jest.resetModules();

  process.env.NODE_ENV = 'test';

  const server = require('../../server');
  await server.initApp();

  return {
    app: server.app,
    db: require('../../database/db')
  };
}

describe('Graph citation access control', () => {
  let app;
  let db;
  let authorizedUsername;
  let unauthorizedUsername;
  let entityId;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    // ── Public collection (world-readable) ────────────────────────────────────
    const publicCollectionId = await db.collectionsAsync.create({
      name: 'World-Public Graph Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    // ── Private collection ────────────────────────────────────────────────────
    const privateCollectionId = await db.collectionsAsync.create({
      name: 'Private Graph Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    // ── Authorized user (has access to private collection) ───────────────────
    const authorizedUserId = await db.usersAsync.create({
      username: 'graph_authorized_user',
      email: 'graph-authorized@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    authorizedUsername = 'graph_authorized_user';

    // ── Unauthorized user (no access to private collection) ──────────────────
    await db.usersAsync.create({
      username: 'graph_unauthorized_user',
      email: 'graph-unauthorized@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    unauthorizedUsername = 'graph_unauthorized_user';

    // Grant authorized user access to private collection only
    await db.userCollectionAccessAsync.grant(authorizedUserId, privateCollectionId, 'viewer');

    // ── Public document ───────────────────────────────────────────────────────
    const publicDocumentId = await db.documentsAsync.create({
      title: 'Public Graph Document',
      date_created: null,
      description: null,
      image_path: '/uploads/public-graph-doc.pdf',
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(publicDocumentId, [publicCollectionId]);

    // ── Private document ──────────────────────────────────────────────────────
    const privateDocumentId = await db.documentsAsync.create({
      title: 'Private Graph Document',
      date_created: null,
      description: null,
      image_path: '/uploads/private-graph-doc.pdf',
      metadata: {}
    });
    await db.documentCollectionsAsync.setForDocument(privateDocumentId, [privateCollectionId]);

    // ── Shared entity ─────────────────────────────────────────────────────────
    entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Test Graph Person',
      description: null,
      properties: {}
    });

    // ── Transcripts ───────────────────────────────────────────────────────────
    const publicTranscriptId = await db.transcriptsAsync.create({
      document_id: publicDocumentId,
      content: 'Public passage text',
      transcriber: 'manual',
      version: 1,
      notes: null,
      is_best: true,
      created_by_user_id: null
    });

    const privateTranscriptId = await db.transcriptsAsync.create({
      document_id: privateDocumentId,
      content: 'Secret private passage text',
      transcriber: 'manual',
      version: 1,
      notes: null,
      is_best: true,
      created_by_user_id: null
    });

    // ── Public citation — both users can see this ─────────────────────────────
    await db.citationsAsync.create({
      entity_id: entityId,
      relationship_id: null,
      transcript_id: publicTranscriptId,
      document_id: publicDocumentId,
      passage_start: 0,
      passage_end: 6,
      passage_text: 'Public passage text',
      extraction_method: 'manual',
      extraction_model: null,
      confidence: 1.0,
      approval_status: 'approved',
      approval_method: 'manual'
    });

    // ── Private citation — only authorized user should see this ───────────────
    await db.citationsAsync.create({
      entity_id: entityId,
      relationship_id: null,
      transcript_id: privateTranscriptId,
      document_id: privateDocumentId,
      passage_start: 0,
      passage_end: 6,
      passage_text: 'Secret private passage text',
      extraction_method: 'manual',
      extraction_model: null,
      confidence: 1.0,
      approval_status: 'approved',
      approval_method: 'manual'
    });
  }, 30_000);

  it('unauthorized user cannot see citations from a private document', async () => {
    const agent = request.agent(app);
    await login(agent, unauthorizedUsername, 'password123!');

    const res = await agent.get(`/graph/entities/${entityId}`);

    // The entity IS visible (cited in the public document), so we expect 200.
    // After the fix, citations must not include the private document citation.
    expect(res.status).toBe(200);
    expect(res.body.citations).toBeDefined();

    const passageTexts = res.body.citations.map(c => c.passage_text);
    expect(passageTexts).not.toContain('Secret private passage text');
  });

  it('authorized user can see citations from both public and private documents', async () => {
    const agent = request.agent(app);
    await login(agent, authorizedUsername, 'password123!');

    const res = await agent.get(`/graph/entities/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.body.citations).toBeDefined();

    const passageTexts = res.body.citations.map(c => c.passage_text);
    expect(passageTexts).toContain('Public passage text');
    expect(passageTexts).toContain('Secret private passage text');
  });
});
