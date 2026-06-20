'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

describe('relationships.countByDocumentId', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('returns zeros when the document has no relationships', async () => {
    const counts = await db.relationships.countByDocumentId(999999);
    expect(counts).toEqual({ pending: 0, approved: 0, rejected: 0 });
  });

  test('returns zeros for a non-integer documentId', async () => {
    const counts = await db.relationships.countByDocumentId('not-an-id');
    expect(counts).toEqual({ pending: 0, approved: 0, rejected: 0 });
  });

  test('counts distinct relationships grouped by approval_status (single relationship, mixed citations)', async () => {
    // One document, one relationship, 4 citations: 2 pending + 1 approved + 1 rejected
    const documentId = await db.documentsAsync.create({
      title: 'Rel Counts Doc A',
      date_created: null,
      description: null,
      image_path: '/uploads/rel-counts-a.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Alice knew Bob well.',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });

    const entityAlice = await db.entities.create({
      entity_type: 'person',
      canonical_name: 'Alice',
      description: null,
      properties: {},
      authority_id: null
    });
    const entityBob = await db.entities.create({
      entity_type: 'person',
      canonical_name: 'Bob',
      description: null,
      properties: {},
      authority_id: null
    });

    const relId = await db.relationships.create({
      source_entity_id: entityAlice,
      target_entity_id: entityBob,
      relationship_type: 'associated_with',
      label: null,
      properties: {},
      confidence: 0.5
    });

    // 2 pending citations
    await db.citations.create({
      relationship_id: relId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 5,
      passage_text: 'Alice',
      extraction_method: 'manual',
      approval_status: 'pending'
    });
    await db.citations.create({
      relationship_id: relId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 6,
      passage_end: 9,
      passage_text: 'knew',
      extraction_method: 'manual',
      approval_status: 'pending'
    });

    // 1 approved citation
    await db.citations.create({
      relationship_id: relId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 10,
      passage_end: 13,
      passage_text: 'Bob',
      extraction_method: 'manual',
      approval_status: 'approved'
    });

    // 1 rejected citation
    await db.citations.create({
      relationship_id: relId,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 14,
      passage_end: 18,
      passage_text: 'well',
      extraction_method: 'manual',
      approval_status: 'rejected'
    });

    // COUNT(DISTINCT r.id) grouped by status: one relationship appears in each
    // status bucket, so each count is 1.
    const counts = await db.relationships.countByDocumentId(documentId);
    expect(counts).toEqual({ pending: 1, approved: 1, rejected: 1 });
  });

  test('counts two distinct relationships with disjoint statuses', async () => {
    // Two relationships: rel1 has only pending citations, rel2 has only approved citations
    const documentId = await db.documentsAsync.create({
      title: 'Rel Counts Doc B',
      date_created: null,
      description: null,
      image_path: '/uploads/rel-counts-b.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Carol met Dave and Eve.',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });

    const entityCarol = await db.entities.create({
      entity_type: 'person',
      canonical_name: 'Carol',
      description: null,
      properties: {},
      authority_id: null
    });
    const entityDave = await db.entities.create({
      entity_type: 'person',
      canonical_name: 'Dave',
      description: null,
      properties: {},
      authority_id: null
    });
    const entityEve = await db.entities.create({
      entity_type: 'person',
      canonical_name: 'Eve',
      description: null,
      properties: {},
      authority_id: null
    });

    const rel1Id = await db.relationships.create({
      source_entity_id: entityCarol,
      target_entity_id: entityDave,
      relationship_type: 'associated_with',
      label: null,
      properties: {},
      confidence: 0.5
    });
    const rel2Id = await db.relationships.create({
      source_entity_id: entityCarol,
      target_entity_id: entityEve,
      relationship_type: 'associated_with',
      label: null,
      properties: {},
      confidence: 0.9
    });

    // rel1 gets only pending citations
    await db.citations.create({
      relationship_id: rel1Id,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 5,
      passage_text: 'Carol',
      extraction_method: 'manual',
      approval_status: 'pending'
    });

    // rel2 gets only approved citations
    await db.citations.create({
      relationship_id: rel2Id,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 6,
      passage_end: 9,
      passage_text: 'met',
      extraction_method: 'manual',
      approval_status: 'approved'
    });

    const counts = await db.relationships.countByDocumentId(documentId);
    expect(counts).toEqual({ pending: 1, approved: 1, rejected: 0 });
  });
});
