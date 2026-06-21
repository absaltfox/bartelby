'use strict';

const request = require('supertest');
const {
  bootCuratorApp,
  createAdminAgent,
  createStandardUserAgent
} = require('../helpers/curator-ui');

describe('public graph reader contracts', () => {
  let app;
  let db;
  let adminAgent;
  let viewerAgent;
  let publicCollectionId;
  let privateCollectionId;
  let publicDocumentId;
  let privateDocumentId;
  let relatedDocumentId;
  let sourceEntityId;
  let targetEntityId;
  let privateEntityId;

  async function createDocumentGraphFixture() {
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types
        (name, label, category, frequency, source_type, target_type)
       VALUES ('mentioned_in', 'Mentioned In', 'general', 'common', '', '')`
    );

    publicCollectionId = await db.collectionsAsync.create({
      name: 'World Public Reader Graph',
      description: 'Visible without login',
      is_public: false,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    privateCollectionId = await db.collectionsAsync.create({
      name: 'Private Reader Graph',
      description: 'Private graph fixture',
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    publicDocumentId = await db.documentsAsync.create({
      title: 'Public Reader Graph Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    relatedDocumentId = await db.documentsAsync.create({
      title: 'Relationship Only Related Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    privateDocumentId = await db.documentsAsync.create({
      title: 'Private Reader Graph Document',
      date_created: null,
      description: null,
      image_path: null,
      metadata: {}
    });
    await db.documentCollectionsAsync.add(publicDocumentId, publicCollectionId);
    await db.documentCollectionsAsync.add(relatedDocumentId, publicCollectionId);
    await db.documentCollectionsAsync.add(privateDocumentId, privateCollectionId);

    const publicTranscriptId = await db.transcriptsAsync.create({
      document_id: publicDocumentId,
      content: 'Ada collaborates with Charles in public evidence.',
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1
    });
    const relatedTranscriptId = await db.transcriptsAsync.create({
      document_id: relatedDocumentId,
      content: 'A relationship-only citation also connects Ada and Charles.',
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1
    });
    const privateTranscriptId = await db.transcriptsAsync.create({
      document_id: privateDocumentId,
      content: 'Private graph evidence.',
      transcriber: 'Manual',
      version: 1,
      notes: null,
      is_best: 1
    });

    sourceEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Ada Public Reader',
      description: null,
      properties: {}
    });
    targetEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Charles Public Reader',
      description: null,
      properties: {}
    });
    privateEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Private Reader Entity',
      description: null,
      properties: {}
    });
    const relationshipId = await db.relationshipsAsync.create({
      source_entity_id: sourceEntityId,
      target_entity_id: targetEntityId,
      relationship_type: 'mentioned_in',
      label: null,
      properties: {},
      confidence: 0.94
    });

    for (const entityId of [sourceEntityId, targetEntityId]) {
      await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: publicTranscriptId,
        document_id: publicDocumentId,
        passage_start: 0,
        passage_end: 44,
        passage_text: 'Ada collaborates with Charles in public evidence.',
        extraction_method: 'manual',
        extraction_model: null,
        confidence: 1,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    }

    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relationshipId,
      transcript_id: publicTranscriptId,
      document_id: publicDocumentId,
      passage_start: 0,
      passage_end: 44,
      passage_text: 'Ada collaborates with Charles in public evidence.',
      extraction_method: 'manual',
      extraction_model: null,
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relationshipId,
      transcript_id: relatedTranscriptId,
      document_id: relatedDocumentId,
      passage_start: 0,
      passage_end: 58,
      passage_text: 'A relationship-only citation also connects Ada and Charles.',
      extraction_method: 'manual',
      extraction_model: null,
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: null,
      relationship_id: relationshipId,
      transcript_id: publicTranscriptId,
      document_id: publicDocumentId,
      passage_start: 0,
      passage_end: 44,
      passage_text: 'Pending curator-only graph evidence.',
      extraction_method: 'llm_auto',
      extraction_model: 'fixture',
      confidence: 0.5,
      approval_status: 'pending',
      approval_method: null
    });
    await db.citationsAsync.create({
      entity_id: privateEntityId,
      relationship_id: null,
      transcript_id: privateTranscriptId,
      document_id: privateDocumentId,
      passage_start: 0,
      passage_end: 23,
      passage_text: 'Private graph evidence.',
      extraction_method: 'manual',
      extraction_model: null,
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
  }

  beforeAll(async () => {
    ({ app, db } = await bootCuratorApp());
    adminAgent = await createAdminAgent(app, 'publicgraphadmin');
    viewerAgent = await createStandardUserAgent(app, db, 'publicgraphviewer');
    await createDocumentGraphFixture();
  }, 60_000);

  it('lets anonymous readers load a world-public document graph and approved graph JSON', async () => {
    const page = await request(app).get(`/documents/${publicDocumentId}`).expect(200);
    expect(page.text).toContain('data-tab="knowledge"');
    expect(page.text).toContain('Public Reader Graph Document');

    const graph = await request(app).get(`/graph/documents/${publicDocumentId}/entities`).expect(200);
    expect(graph.body.entities.map((row) => row.id).sort((a, b) => a - b)).toEqual([sourceEntityId, targetEntityId].sort((a, b) => a - b));
    expect(graph.body.relationships).toHaveLength(1);
    expect(graph.body.pendingCount).toBeUndefined();
  });

  it('lets anonymous readers load a world-public collection graph scoped to public evidence', async () => {
    const page = await request(app).get(`/collections/${publicCollectionId}/graph`).expect(200);
    expect(page.text).toContain('World Public Reader Graph');
    expect(page.text).toContain('data-graph-explorer');

    const graph = await request(app).get('/graph/entities').query({ collectionId: publicCollectionId }).expect(200);
    const names = graph.body.entities.map((entity) => entity.canonical_name);
    expect(names).toContain('Ada Public Reader');
    expect(names).toContain('Charles Public Reader');
    expect(names).not.toContain('Private Reader Entity');
  });

  it('denies anonymous readers private graph pages and JSON', async () => {
    const page = await request(app).get(`/collections/${privateCollectionId}/graph`).expect(302);
    expect(page.headers.location).toMatch(/\/login/);

    await request(app).get(`/graph/documents/${privateDocumentId}/entities`).expect(404);
    const graph = await request(app).get('/graph/entities').query({ collectionId: privateCollectionId }).expect(200);
    expect(graph.body.entities).toEqual([]);
  });

  it('keeps pending counts curator-only in graph JSON', async () => {
    const viewerGraph = await viewerAgent.get(`/graph/documents/${publicDocumentId}/entities`).expect(200);
    expect(viewerGraph.body.pendingCount).toBeUndefined();

    const anonymousGraph = await request(app).get(`/graph/documents/${publicDocumentId}/entities`).expect(200);
    expect(anonymousGraph.body.pendingCount).toBeUndefined();

    const adminGraph = await adminAgent.get(`/graph/documents/${publicDocumentId}/entities`).expect(200);
    expect(adminGraph.body.pendingCount).toBeGreaterThan(0);
  });

  it('finds related documents through relationship-only citations', async () => {
    const related = await request(app).get(`/graph/documents/${publicDocumentId}/related`).expect(200);
    expect(related.body.related.map((entry) => entry.documentId)).toContain(relatedDocumentId);
    const match = related.body.related.find((entry) => entry.documentId === relatedDocumentId);
    expect(match.sharedEntities.map((entity) => entity.canonical_name).sort()).toEqual([
      'Ada Public Reader',
      'Charles Public Reader'
    ]);
  });
});
