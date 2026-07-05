'use strict';

// F1 of docs/2026-07-05-epistolary-register-design.md — schema + write-path
// tests for sentiment_annotations.register (migration v76). Mirrors
// tests/unit/sentiment-emotion-about-schema.test.js and the
// sentiment-insert-emotion-about.test.js write-path pattern.

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
  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [9400, 'Register schema doc']);
  await db.runAsync(
    `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
    [9400, 9400, 'I have the honour to be, Sir, your obedient servant.']
  );
}, 60_000);

describe('sentiment_annotations.register schema (F1, v76)', () => {
  it('accepts NULL register (the default for pre-existing rows)', async () => {
    const r = await db.runAsync(`
      INSERT INTO sentiment_annotations (
        transcript_id, document_id, polarity, intensity, voice_role,
        target_kind, emotion_phrase_verbatim
      ) VALUES (?, ?, 'positive', 'low', 'author', 'phrase', 'your obedient servant')
    `, [9400, 9400]);
    const row = await db.getAsync(
      `SELECT register FROM sentiment_annotations WHERE id = ?`, [r.lastInsertRowid]
    );
    expect(row.register).toBeNull();
  });

  it('accepts both allowed register values', async () => {
    for (const value of ['conventional', 'personal']) {
      const r = await db.runAsync(`
        INSERT INTO sentiment_annotations (
          transcript_id, document_id, polarity, intensity, voice_role,
          target_kind, emotion_phrase_verbatim, register
        ) VALUES (?, ?, 'positive', 'low', 'author', 'phrase', 'your obedient servant', ?)
      `, [9400, 9400, value]);
      const row = await db.getAsync(
        `SELECT register FROM sentiment_annotations WHERE id = ?`, [r.lastInsertRowid]
      );
      expect(row.register).toBe(value);
    }
  });

  it('rejects values outside the CHECK constraint', async () => {
    await expect(db.runAsync(`
      INSERT INTO sentiment_annotations (
        transcript_id, document_id, polarity, intensity, voice_role,
        target_kind, emotion_phrase_verbatim, register
      ) VALUES (?, ?, 'positive', 'low', 'author', 'phrase', 'x', 'formulaic')
    `, [9400, 9400])).rejects.toThrow();
  });

  it('writeAnnotationsForJob round-trips register and defaults it to NULL', async () => {
    const base = {
      transcript_id: 9400, document_id: 9400,
      span_start: 0, span_end: 21, evidence_excerpt: 'your obedient servant',
      polarity: 'positive', intensity: 'low', confidence: 0.85,
      voice_role: 'author', target_kind: 'phrase', target_phrase: 'the recipient',
      approval_status: 'pending', auto_approved: 0,
      extracted_at: new Date().toISOString()
    };
    await db.sentimentAsync.writeAnnotationsForJob(null, [
      { ...base, emotion_phrase_verbatim: 'register roundtrip conventional', register: 'conventional' },
      { ...base, emotion_phrase_verbatim: 'register roundtrip absent' }
    ]);

    const conventional = await db.getAsync(
      `SELECT register FROM sentiment_annotations WHERE emotion_phrase_verbatim = ?`,
      ['register roundtrip conventional']
    );
    expect(conventional.register).toBe('conventional');

    const absent = await db.getAsync(
      `SELECT register FROM sentiment_annotations WHERE emotion_phrase_verbatim = ?`,
      ['register roundtrip absent']
    );
    expect(absent.register).toBeNull();
  });
});
