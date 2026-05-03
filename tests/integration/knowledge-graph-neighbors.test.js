'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let focusEntityId;
let neighborEntityId;
let relationshipId;

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
    .send({ username: 'neighboradmin', password: 'testpassword99!', _csrf: csrf });
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
      username: 'neighboradmin',
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  const collectionId = await db.collectionsAsync.create({
    name: 'Neighbor Evidence Test Collection',
    description: 'Collection for neighbor evidence tests',
    is_public: 1,
    is_world_public: 0,
    allow_export: 0,
    auto_group_pages: 0,
    createdBy: 1
  });

  const documentId = await db.documentsAsync.create({
    title: 'Neighbor Evidence Source Document',
    date_created: '1880-05-02',
    description: 'Doc for neighbor evidence test',
    image_path: '/uploads/test-neighbor-doc.png',
    metadata: { author: 'Test' }
  });
  await db.documentCollectionsAsync.add(documentId, collectionId);

  const transcriptId = await db.transcriptsAsync.create({
    document_id: documentId,
    content: 'Alice wrote to Bob about the harbour proposal.',
    transcriber: 'Test',
    version: 1,
    notes: null,
    is_best: true
  });

  focusEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'Alice Reed',
    description: 'Focus entity',
    properties: {}
  });

  neighborEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'Bob Grant',
    description: 'Neighbour entity',
    properties: {}
  });

  // Entity-level citations so canAccessEntity passes for both the focus
  // entity and the neighbour. The route handler checks access per entity id
  // before returning neighbours; without these, the endpoint returns 404
  // before the relationship evidence logic runs.
  const focusCitationId = await db.citations.create({
    entity_id: focusEntityId,
    relationship_id: null,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_start: 0,
    passage_end: 11,
    passage_text: 'Alice Reed',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 1
  });
  await db.citationsAsync.approve(focusCitationId, 1, 'manual');

  const neighborCitationId = await db.citations.create({
    entity_id: neighborEntityId,
    relationship_id: null,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_start: 12,
    passage_end: 21,
    passage_text: 'Bob Grant',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 1
  });
  await db.citationsAsync.approve(neighborCitationId, 1, 'manual');

  relationshipId = await db.relationships.create({
    source_entity_id: focusEntityId,
    target_entity_id: neighborEntityId,
    relationship_type: 'authored',
    confidence: 0.9,
    properties: {}
  });

  const relationshipCitationId = await db.citations.create({
    entity_id: null,
    relationship_id: relationshipId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_start: 0,
    passage_end: 46,
    passage_text: 'Alice wrote to Bob about the harbour proposal.',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 0.9
  });

  await db.citationsAsync.approve(relationshipCitationId, 1, 'manual');
}, 30_000);

describe('GET /graph/entities/:id/neighbors', () => {
  it('returns direction and a relationship evidence excerpt per row', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/graph/entities/${focusEntityId}/neighbors?depth=1`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.neighbors)).toBe(true);

    const row = res.body.neighbors.find((n) => Number(n.id) === neighborEntityId);
    expect(row).toBeDefined();
    expect(row.direction).toBe('outgoing');
    expect(row.relationship_id).toBe(relationshipId);
    expect(row.relationship_type).toBe('authored');
    expect(row.evidence_text).toBe('Alice wrote to Bob about the harbour proposal.');
  });

  it('supports ranked neighbor pagination metadata for high-degree graph views', async () => {
    const db = require('../../database/db');
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const extraIds = [];
    for (let i = 0; i < 3; i++) {
      const entityId = await db.entities.create({
        entity_type: 'person',
        canonical_name: `Neighbor Extra ${i}`,
        description: 'Additional neighbor',
        properties: {}
      });
      extraIds.push(entityId);
      const entityCitationId = await db.citations.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: 1,
        document_id: 1,
        passage_start: 0,
        passage_end: 16,
        passage_text: `Neighbor Extra ${i}`,
        extraction_method: 'test',
        extraction_model: 'jest',
        confidence: 1
      });
      await db.citationsAsync.approve(entityCitationId, 1, 'manual');

      const relId = await db.relationships.create({
        source_entity_id: focusEntityId,
        target_entity_id: entityId,
        relationship_type: i === 0 ? 'member_of' : 'mentioned_in',
        confidence: 0.9,
        properties: {}
      });
      const relCitationId = await db.citations.create({
        entity_id: null,
        relationship_id: relId,
        transcript_id: 1,
        document_id: 1,
        passage_start: 0,
        passage_end: 32,
        passage_text: `Alice mentioned Neighbor Extra ${i}.`,
        extraction_method: 'test',
        extraction_model: 'jest',
        confidence: 0.9
      });
      await db.citationsAsync.approve(relCitationId, 1, 'manual');
    }

    const firstPage = await agent.get(`/graph/entities/${focusEntityId}/neighbors?depth=1&limit=2`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.neighbors).toHaveLength(2);
    expect(firstPage.body.total).toBeGreaterThanOrEqual(4);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextOffset).toBe(2);
    expect(firstPage.body.overflow).toBe(firstPage.body.total - 2);

    const secondPage = await agent.get(`/graph/entities/${focusEntityId}/neighbors?depth=1&limit=2&offset=2`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.neighbors.length).toBeGreaterThan(0);
    expect(secondPage.body.offset).toBe(2);
    expect(secondPage.body.neighbors.map((row) => row.id)).not.toEqual(firstPage.body.neighbors.map((row) => row.id));
  });
});
