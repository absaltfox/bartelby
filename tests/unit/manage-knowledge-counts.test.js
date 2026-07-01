'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  citationsAsync,
  entitiesAsync,
  relationshipsAsync,
  dateExpressionsAsync,
  authoritiesAsync,
  authorityLinkSuggestionsAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  usersAsync,
  sentimentAsync,
  extractionJobsAsync,
  runAsync
} = require('../../database/db');
const { initApp } = require('../../server');

async function createCollectionWithDoc({ user } = {}) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const userId = user || await usersAsync.create({
    username: `u-${unique}`,
    email: `${unique}@x.test`,
    passwordHash: 'unused',
    role: 'user',
    status: 'active'
  });
  const collectionId = await collectionsAsync.create({
    name: `c-${unique}`,
    is_public: 0,
    createdBy: userId
  });
  const documentId = await documentsAsync.create({
    title: `d-${unique}`,
    date_created: null,
    description: null,
    image_path: null,
    metadata: {}
  });
  await documentCollectionsAsync.add(documentId, collectionId);
  const transcriptId = await transcriptsAsync.create({
    document_id: documentId,
    content: 'fixture',
    transcriber: 'fixture',
    notes: null
  });
  return { userId, collectionId, documentId, transcriptId };
}

describe('manage-knowledge dashboard count helpers', () => {
  beforeAll(async () => { await initApp(); });

  test('citationsAsync.countPendingByCollection returns split by kind', async () => {
    const ctx = await createCollectionWithDoc();
    const entityId = await entitiesAsync.create({ canonical_name: `E-${Math.random()}`, entity_type: 'person' });
    const targetEntityId = await entitiesAsync.create({ canonical_name: `T-${Math.random()}`, entity_type: 'person' });
    const relId = await relationshipsAsync.create({
      source_entity_id: entityId,
      target_entity_id: targetEntityId,
      relationship_type: 'knows',
      label: null,
      properties: {},
      confidence: 1
    });
    const dateId = await dateExpressionsAsync.create({
      entity_id: entityId,
      label: 'fixture date',
      earliest: '1900-01-01',
      latest: '1900-12-31',
      precision: 'year',
      qualifier: null,
      calendar: 'gregorian'
    });
    // Two entity-only pending citations
    await citationsAsync.create({
      entity_id: entityId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'a', passage_start: 0, passage_end: 1,
      extraction_method: 'llm_auto',
      approval_status: 'pending'
    });
    await citationsAsync.create({
      entity_id: entityId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'b', passage_start: 1, passage_end: 2,
      extraction_method: 'llm_auto',
      approval_status: 'pending'
    });
    // One relationship pending citation
    await citationsAsync.create({
      relationship_id: relId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'c', passage_start: 2, passage_end: 3,
      extraction_method: 'llm_auto',
      approval_status: 'pending'
    });
    // One date pending citation
    await citationsAsync.create({
      date_expression_id: dateId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'd', passage_start: 3, passage_end: 4,
      extraction_method: 'llm_auto',
      approval_status: 'pending'
    });
    // One approved citation that should NOT be counted
    await citationsAsync.create({
      entity_id: entityId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'e', passage_start: 4, passage_end: 5,
      extraction_method: 'llm_auto',
      approval_status: 'approved'
    });

    const result = await citationsAsync.countPendingByCollection(ctx.collectionId);
    expect(result).toEqual(expect.objectContaining({
      entity: 2,
      relationship: 1,
      date: 1,
      total: 4
    }));
  });

  test('authorityLinkSuggestionsAsync.countPendingByCollection includes disambiguation groups', async () => {
    const ctx = await createCollectionWithDoc();
    const entityId = await entitiesAsync.create({ canonical_name: `E-${Math.random()}`, entity_type: 'person' });
    await citationsAsync.create({
      entity_id: entityId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'p', passage_start: 0, passage_end: 1,
      extraction_method: 'manual',
      approval_status: 'approved'
    });
    const auth1 = await authoritiesAsync.create({
      authority_type: 'person', canonical_name: `A1-${Math.random()}`,
      description: null, properties: {}, external_source: null, external_key: null
    });
    const auth2 = await authoritiesAsync.create({
      authority_type: 'person', canonical_name: `A2-${Math.random()}`,
      description: null, properties: {}, external_source: null, external_key: null
    });
    // Two suggestions for the same entity -> disambiguation group of 1
    await authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: auth1,
      confidence: 0.8, match_method: 'fixture', status: 'pending'
    });
    await authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: auth2,
      confidence: 0.7, match_method: 'fixture', status: 'pending'
    });

    const result = await authorityLinkSuggestionsAsync.countPendingByCollection(ctx.collectionId);
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.disambiguationGroups).toBeGreaterThanOrEqual(1);
  });

  test('sentimentAsync.countPendingPhraseTargetsByCollection counts distinct phrases', async () => {
    const ctx = await createCollectionWithDoc();
    const insertAnnotation = async (phrase) => {
      await runAsync(`
        INSERT INTO sentiment_annotations (
          transcript_id, document_id, span_start, span_end, evidence_excerpt,
          polarity, intensity, confidence, voice_role, target_kind,
          target_phrase, emotion_phrase_verbatim, approval_status
        ) VALUES (?, ?, 0, 1, 'fixture', 'positive', 'low', 0.5, 'author', 'phrase', ?, 'love', 'approved')
      `, [ctx.transcriptId, ctx.documentId, phrase]);
    };
    await insertAnnotation('the schoolhouse');
    await insertAnnotation('the schoolhouse'); // duplicate -> still one distinct
    await insertAnnotation('another phrase');

    const result = await sentimentAsync.countPendingPhraseTargetsByCollection(ctx.collectionId);
    expect(result.total).toBe(2);
  });

  test('entitiesAsync.countByCollection returns total and byType', async () => {
    const ctx = await createCollectionWithDoc();
    const person = await entitiesAsync.create({ canonical_name: `P-${Math.random()}`, entity_type: 'person' });
    const place = await entitiesAsync.create({ canonical_name: `Pl-${Math.random()}`, entity_type: 'place' });
    for (const eId of [person, place]) {
      await citationsAsync.create({
        entity_id: eId,
        transcript_id: ctx.transcriptId,
        document_id: ctx.documentId,
        passage_text: `c-${eId}`, passage_start: 0, passage_end: 1,
        extraction_method: 'manual',
        approval_status: 'approved'
      });
    }
    const result = await entitiesAsync.countByCollection(ctx.collectionId);
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.byType.person).toBeGreaterThanOrEqual(1);
    expect(result.byType.place).toBeGreaterThanOrEqual(1);
  });

  test('authoritiesAsync.countDistinctTouchedByCollection returns total', async () => {
    const ctx = await createCollectionWithDoc();
    const auth = await authoritiesAsync.create({
      authority_type: 'person', canonical_name: `A-${Math.random()}`,
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await entitiesAsync.create({
      canonical_name: `E-${Math.random()}`, entity_type: 'person', authority_id: auth
    });
    await citationsAsync.create({
      entity_id: entityId,
      transcript_id: ctx.transcriptId,
      document_id: ctx.documentId,
      passage_text: 'x', passage_start: 0, passage_end: 1,
      extraction_method: 'manual',
      approval_status: 'approved'
    });

    const result = await authoritiesAsync.countDistinctTouchedByCollection(ctx.collectionId);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  test('entitiesAsync.countUnresolvedByCollection returns total and byType', async () => {
    const ctx = await createCollectionWithDoc();
    const unresolved = await entitiesAsync.create({ canonical_name: `U-${Math.random()}`, entity_type: 'person' });
    const auth = await authoritiesAsync.create({
      authority_type: 'person', canonical_name: `A-${Math.random()}`,
      description: null, properties: {}, external_source: null, external_key: null
    });
    const resolved = await entitiesAsync.create({ canonical_name: `R-${Math.random()}`, entity_type: 'person', authority_id: auth });
    for (const eId of [unresolved, resolved]) {
      await citationsAsync.create({
        entity_id: eId,
        transcript_id: ctx.transcriptId,
        document_id: ctx.documentId,
        passage_text: `c-${eId}`, passage_start: 0, passage_end: 1,
        extraction_method: 'manual',
        approval_status: 'approved'
      });
    }
    const result = await entitiesAsync.countUnresolvedByCollection(ctx.collectionId);
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.byType.person).toBeGreaterThanOrEqual(1);
  });

  test('extractionJobsAsync.sumQualityCountersByCollection sums counters and counts failed/running jobs', async () => {
    const ctx = await createCollectionWithDoc();
    // Insert one completed job with quality counters
    await runAsync(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, status, log, attempts,
        dropped_verbatim_mismatch_count, unresolved_relationship_count, unresolved_date_count
      ) VALUES (?, ?, 'completed', '', 1, 3, 2, 1)
    `, [ctx.transcriptId, ctx.documentId]);
    // Insert one failed job
    await runAsync(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, status, log, attempts
      ) VALUES (?, ?, 'failed', '', 1)
    `, [ctx.transcriptId, ctx.documentId]);
    // Insert one running job
    await runAsync(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, status, log, attempts
      ) VALUES (?, ?, 'running', '', 1)
    `, [ctx.transcriptId, ctx.documentId]);

    const result = await extractionJobsAsync.sumQualityCountersByCollection(ctx.collectionId);
    expect(result.verbatim_mismatch).toBeGreaterThanOrEqual(3);
    expect(result.unresolved_rel).toBeGreaterThanOrEqual(2);
    expect(result.unresolved_date).toBeGreaterThanOrEqual(1);
    expect(result.failed_jobs).toBeGreaterThanOrEqual(1);
    expect(result.running_jobs).toBeGreaterThanOrEqual(1);
  });
});
