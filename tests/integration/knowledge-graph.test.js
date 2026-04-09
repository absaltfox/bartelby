'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let graphDocumentId;
let graphEntityId;
let pendingDocumentId;
let pendingTranscriptId;
let pendingEntityId;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  return agent
    .post('/login')
    .type('form')
    .send({ username: 'graphadmin', password: 'testpassword99!', _csrf: csrf });
}

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  const db = require('../../database/db');

  await server.initApp();
  app = server.app;

  const bootstrapAgent = request.agent(app);
  const setupPage = await bootstrapAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await bootstrapAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'graphadmin',
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  const collectionId = await db.collectionsAsync.create({
    name: 'Knowledge Graph Test Collection',
    description: 'Collection for KG tests',
    is_public: 1,
    is_world_public: 0,
    allow_export: 0,
    auto_group_pages: 0,
    createdBy: 1
  });

  graphDocumentId = await db.documentsAsync.create({
    title: 'Knowledge Graph Source Document',
    date_created: '1872-03-14',
    description: 'A test document for entity extraction.',
    image_path: '/uploads/test-graph-doc.png',
    metadata: { author: 'Jane Smith' }
  });
  await db.documentCollectionsAsync.add(graphDocumentId, collectionId);

  const transcriptId = await db.transcriptsAsync.create({
    document_id: graphDocumentId,
    content: 'Jane Smith wrote from Victoria about the harbour.',
    transcriber: 'Test',
    version: 1,
    notes: null,
    is_best: true
  });

  graphEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'Jane Smith',
    description: 'Test entity',
    properties: {}
  });

  await db.entityAliases.create({
    entity_id: graphEntityId,
    alias: 'J. Smith',
    source: 'test'
  });

  await db.citations.create({
    entity_id: graphEntityId,
    relationship_id: null,
    transcript_id: transcriptId,
    document_id: graphDocumentId,
    passage_start: 0,
    passage_end: 10,
    passage_text: 'Jane Smith',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 1
  });

  pendingDocumentId = await db.documentsAsync.create({
    title: 'Pending Knowledge Graph Source Document',
    date_created: '1872-03-15',
    description: 'A test document with pending graph evidence.',
    image_path: '/uploads/test-graph-pending.png',
    metadata: { author: 'John Doe' }
  });
  await db.documentCollectionsAsync.add(pendingDocumentId, collectionId);

  pendingTranscriptId = await db.transcriptsAsync.create({
    document_id: pendingDocumentId,
    content: 'John Doe appears in a low-confidence extraction.',
    transcriber: 'Test',
    version: 1,
    notes: null,
    is_best: true
  });

  pendingEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'John Doe',
    description: 'Pending test entity',
    properties: {}
  });

  await db.citations.create({
    entity_id: pendingEntityId,
    relationship_id: null,
    transcript_id: pendingTranscriptId,
    document_id: pendingDocumentId,
    passage_start: 0,
    passage_end: 8,
    passage_text: 'John Doe',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 0.2
  });
}, 30_000);

describe('knowledge graph routes', () => {
  it('returns document entities for an authenticated user', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/graph/documents/${graphDocumentId}/entities`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entities)).toBe(true);
    expect(res.body.entities.some((entity) => entity.id === graphEntityId)).toBe(true);
  });

  it('hides pending extraction evidence until it is approved', async () => {
    const db = require('../../database/db');
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const hiddenRes = await agent.get(`/graph/documents/${pendingDocumentId}/entities`);
    expect(hiddenRes.status).toBe(200);
    expect(hiddenRes.body.entities.some((entity) => entity.id === pendingEntityId)).toBe(false);
    expect(hiddenRes.body.pendingCount).toBeGreaterThan(0);

    const pendingCitation = (await db.citationsAsync.getByDocumentId(pendingDocumentId, { approvalStatus: 'pending' }))[0];
    await db.citationsAsync.approve(pendingCitation.id, 1, 'manual');

    const visibleRes = await agent.get(`/graph/documents/${pendingDocumentId}/entities`);
    expect(visibleRes.status).toBe(200);
    expect(visibleRes.body.entities.some((entity) => entity.id === pendingEntityId)).toBe(true);
  });

  it('exposes entity matches through the graph search API and renders the search panel shell', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const graphRes = await agent.get('/graph/search').query({ q: 'Jane' });
    expect(graphRes.status).toBe(200);
    expect(Array.isArray(graphRes.body.results)).toBe(true);
    expect(graphRes.body.results.some((entity) => entity.canonical_name === 'Jane Smith')).toBe(true);

    const pageRes = await agent.get('/search').query({ q: 'Jane' });
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain('Matching entities');
  });
});
