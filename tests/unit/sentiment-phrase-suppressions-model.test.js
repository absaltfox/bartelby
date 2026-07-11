'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  const { initApp } = require('../../server');
  await initApp();
  db = require('../../database/db');
}, 60_000);

describe('sentimentPhraseSuppressions model — S3', () => {
  const m = () => db.sentimentPhraseSuppressionsAsync;

  it('normalize trims whitespace and lowercases', () => {
    expect(m().normalize('  The School House  ')).toBe('the school house');
    expect(m().normalize('the   school   house')).toBe('the school house');
  });

  it('normalize strips trailing punctuation, matching the shared phrase normalizer (D6)', () => {
    // Before D6 the model owned a fork without the punctuation strip:
    // suppressing a display phrase like 'the school house.' wrote a key the
    // listing's normalizePhraseSql join never produced — a silent no-op.
    expect(m().normalize('The School House.')).toBe('the school house');
    expect(m().normalize('my position!?')).toBe('my position');
    expect(m().normalize('The School House.')).toBe(db.normalizeSentimentPhrase('The School House.'));
  });

  it('add with trailing punctuation is found by isSuppressed on the clean form (D6)', async () => {
    await m().add({ phrase: 'the west corridor.', userId: null });
    expect(await m().isSuppressed('the west corridor')).toBe(true);
    expect(await m().isSuppressed('The West Corridor.')).toBe(true);
  });

  it('add inserts using normalized form and preserves display', async () => {
    await m().add({ phrase: '  The School House ', notes: 'too generic', userId: null });
    const row = await db.getAsync(`SELECT * FROM sentiment_phrase_suppressions WHERE target_phrase_normalized = 'the school house'`);
    expect(row).toBeTruthy();
    expect(row.target_phrase_display).toBe('The School House');
    expect(row.notes).toBe('too generic');
  });

  it('isSuppressed returns true for a normalized hit', async () => {
    await m().add({ phrase: 'My Position', userId: null });
    expect(await m().isSuppressed('my position')).toBe(true);
    expect(await m().isSuppressed('My Position')).toBe(true);
    expect(await m().isSuppressed('not in the table')).toBe(false);
  });

  it('list returns all suppressions ordered by created_at DESC', async () => {
    await m().add({ phrase: 'a phrase', userId: null });
    await m().add({ phrase: 'b phrase', userId: null });
    const rows = await m().list();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    const created = rows.map((r) => new Date(r.created_at).getTime());
    for (let i = 1; i < created.length; i++) {
      expect(created[i - 1]).toBeGreaterThanOrEqual(created[i]);
    }
  });

  it('add throws on duplicate normalized phrase', async () => {
    await m().add({ phrase: 'unique-once', userId: null });
    await expect(m().add({ phrase: 'unique-once', userId: null })).rejects.toThrow();
  });

  it('delete removes by id', async () => {
    const inserted = await m().add({ phrase: 'phrase-to-delete', userId: null });
    await m().delete(inserted);
    const row = await db.getAsync(`SELECT * FROM sentiment_phrase_suppressions WHERE id = ?`, [inserted]);
    expect(row).toBeFalsy();
  });
});
