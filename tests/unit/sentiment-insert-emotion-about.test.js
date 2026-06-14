'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [9200, 'S2 insert doc']);
  await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
    [9200, 9200, 'When I heard of his death last spring, I was greatly grieved.']);
}, 60_000);

describe('sentiment model persists emotion_about_* (S2.1)', () => {
  it('writes all five emotion_about_* fields through to the row', async () => {
    const annotations = [{
      transcript_id: 9200,
      document_id: 9200,
      span_start: 0,
      span_end: 15,
      evidence_excerpt: 'greatly grieved',
      polarity: 'negative',
      intensity: 'strong',
      confidence: 0.9,
      voice_role: 'author',
      target_kind: 'phrase',
      target_entity_id: null,
      target_phrase: 'my brother',
      expressed_by_entity_id: null,
      described_subject_entity_id: null,
      emotion_phrase_verbatim: 'greatly grieved',
      emotion_about_phrase_verbatim: 'his death last spring',
      emotion_about_earliest: '1873-03-01',
      emotion_about_latest: '1873-05-31',
      emotion_about_precision: 'season',
      emotion_about_qualifier: 'died_in',
      approval_status: 'pending',
      auto_approved: 0,
      extracted_at: new Date().toISOString()
    }];

    // The method is writeAnnotationsForJob(jobId, annotations) on db.sentimentAsync
    const written = await db.sentimentAsync.writeAnnotationsForJob(null, annotations);
    expect(written).toBeGreaterThanOrEqual(1);

    const row = await db.getAsync(`
      SELECT emotion_about_phrase_verbatim, emotion_about_earliest,
             emotion_about_latest, emotion_about_precision, emotion_about_qualifier
      FROM sentiment_annotations
      WHERE transcript_id = ? AND emotion_about_phrase_verbatim = ?
    `, [9200, 'his death last spring']);
    expect(row.emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(row.emotion_about_earliest).toBe('1873-03-01');
    expect(row.emotion_about_latest).toBe('1873-05-31');
    expect(row.emotion_about_precision).toBe('season');
    expect(row.emotion_about_qualifier).toBe('died_in');
  });

  it('persists NULL when emotion_about_* keys are absent on the input object', async () => {
    const annotations = [{
      transcript_id: 9200,
      document_id: 9200,
      span_start: 0,
      span_end: 15,
      evidence_excerpt: 'greatly grieved',
      polarity: 'neutral',
      intensity: 'low',
      confidence: 0.6,
      voice_role: 'author',
      target_kind: 'phrase',
      target_entity_id: null,
      target_phrase: 'observed',
      expressed_by_entity_id: null,
      described_subject_entity_id: null,
      emotion_phrase_verbatim: 'observed',
      approval_status: 'pending',
      auto_approved: 0,
      extracted_at: new Date().toISOString()
    }];

    const written = await db.sentimentAsync.writeAnnotationsForJob(null, annotations);
    expect(written).toBeGreaterThanOrEqual(1);

    const row = await db.getAsync(`
      SELECT emotion_about_phrase_verbatim, emotion_about_earliest
      FROM sentiment_annotations
      WHERE transcript_id = ? AND emotion_phrase_verbatim = ?
    `, [9200, 'observed']);
    expect(row.emotion_about_phrase_verbatim).toBeNull();
    expect(row.emotion_about_earliest).toBeNull();
  });
});
