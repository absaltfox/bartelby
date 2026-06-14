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
}, 60_000);

describe('sentiment_annotations emotion_about_* schema (S2.1)', () => {
  it('accepts NULL emotion_about_phrase_verbatim (the default for existing rows)', async () => {
    await db.runAsync(`
      INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)
    `, [9100, 'S2 schema test doc']);
    await db.runAsync(`
      INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)
    `, [9100, 9100, 'I felt grieved when I heard of his death last spring.']);
    const result = await db.runAsync(`
      INSERT INTO sentiment_annotations (
        transcript_id, document_id, polarity, intensity, voice_role,
        target_kind, emotion_phrase_verbatim
      ) VALUES (?, ?, 'negative', 'moderate', 'author', 'phrase', 'grieved')
    `, [9100, 9100]);
    expect(result?.lastInsertRowid).toEqual(expect.any(Number));
  });

  it('accepts populated emotion_about_phrase_verbatim + earliest/latest/precision/qualifier', async () => {
    const r = await db.runAsync(`
      INSERT INTO sentiment_annotations (
        transcript_id, document_id, polarity, intensity, voice_role,
        target_kind, emotion_phrase_verbatim,
        emotion_about_phrase_verbatim, emotion_about_earliest,
        emotion_about_latest, emotion_about_precision, emotion_about_qualifier
      ) VALUES (?, ?, 'negative', 'strong', 'author', 'phrase', 'grieved',
                'his death last spring', '1873-03-01', '1873-05-31',
                'season', 'died_in')
    `, [9100, 9100]);
    expect(r?.lastInsertRowid).toEqual(expect.any(Number));

    const row = await db.getAsync(`
      SELECT emotion_about_phrase_verbatim, emotion_about_earliest,
             emotion_about_latest, emotion_about_precision, emotion_about_qualifier
      FROM sentiment_annotations WHERE id = ?
    `, [r.lastInsertRowid]);
    expect(row.emotion_about_phrase_verbatim).toBe('his death last spring');
    expect(row.emotion_about_earliest).toBe('1873-03-01');
    expect(row.emotion_about_latest).toBe('1873-05-31');
    expect(row.emotion_about_precision).toBe('season');
    expect(row.emotion_about_qualifier).toBe('died_in');
  });

  it('existing rows (created before migration) have NULL emotion_about_* (forward-only per S2.3)', async () => {
    const r = await db.runAsync(`
      INSERT INTO sentiment_annotations (
        transcript_id, document_id, polarity, intensity, voice_role,
        target_kind, emotion_phrase_verbatim
      ) VALUES (?, ?, 'neutral', 'low', 'author', 'phrase', 'observed')
    `, [9100, 9100]);
    const row = await db.getAsync(`
      SELECT emotion_about_phrase_verbatim, emotion_about_earliest,
             emotion_about_latest, emotion_about_precision, emotion_about_qualifier
      FROM sentiment_annotations WHERE id = ?
    `, [r.lastInsertRowid]);
    expect(row.emotion_about_phrase_verbatim).toBeNull();
    expect(row.emotion_about_earliest).toBeNull();
    expect(row.emotion_about_latest).toBeNull();
    expect(row.emotion_about_precision).toBeNull();
    expect(row.emotion_about_qualifier).toBeNull();
  });
});
