'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment label model', () => {
  let db;
  let sentimentAsync;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-model-'));
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    sentimentAsync = db.sentimentAsync;
  });

  afterEach(async () => {
    if (db?.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createOrFetchLabel', () => {
    test('creates a new label with normalized name', async () => {
      const result = await sentimentAsync.createOrFetchLabel('Joy', { description: 'positive emotion' });
      expect(result.row.name).toBe('joy');
      expect(result.row.description).toBe('positive emotion');
      expect(result.created).toBe(true);
    });

    test('returns existing label when name matches (idempotent)', async () => {
      const first = await sentimentAsync.createOrFetchLabel('joy');
      const second = await sentimentAsync.createOrFetchLabel('Joy');
      expect(second.row.id).toBe(first.row.id);
      expect(second.created).toBe(false);
    });

    test('throws if normalized name is empty', async () => {
      await expect(
        sentimentAsync.createOrFetchLabel('   ')
      ).rejects.toThrow(/empty/i);
    });
  });

  describe('listLabels', () => {
    test('returns labels with phrase counts sorted by count DESC then name ASC', async () => {
      const joy = (await sentimentAsync.createOrFetchLabel('joy')).row;
      const sorrow = (await sentimentAsync.createOrFetchLabel('sorrow')).row;
      // Plant some phrases with labels
      const a = await sentimentAsync.upsertEmotionPhrase('happiness');
      const b = await sentimentAsync.upsertEmotionPhrase('delight');
      const c = await sentimentAsync.upsertEmotionPhrase('grief');
      await sentimentAsync.applyLabelToPhrases(joy.id, [a.id, b.id]);
      await sentimentAsync.applyLabelToPhrases(sorrow.id, [c.id]);

      const list = await sentimentAsync.listLabels();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ id: joy.id, name: 'joy', phrase_count: 2 });
      expect(list[1]).toMatchObject({ id: sorrow.id, name: 'sorrow', phrase_count: 1 });
    });

    test('returns labels with phrase_count = 0 when no phrases reference them', async () => {
      await sentimentAsync.createOrFetchLabel('unused');
      const list = await sentimentAsync.listLabels();
      expect(list).toHaveLength(1);
      expect(list[0].phrase_count).toBe(0);
    });
  });

  describe('renameLabel', () => {
    test('updates name and updated_at, returns updated row', async () => {
      const { row } = await sentimentAsync.createOrFetchLabel('joy');
      const originalUpdatedAt = row.updated_at;
      await new Promise((r) => setTimeout(r, 1100)); // ensure updated_at changes
      const result = await sentimentAsync.renameLabel(row.id, 'gladness');
      expect(result.row.name).toBe('gladness');
      expect(result.row.updated_at).not.toBe(originalUpdatedAt);
    });

    test('returns conflict when rename collides with existing label', async () => {
      const { row: joy } = await sentimentAsync.createOrFetchLabel('joy');
      const { row: existing } = await sentimentAsync.createOrFetchLabel('gladness');
      const result = await sentimentAsync.renameLabel(joy.id, 'gladness');
      expect(result.conflict).toBe(true);
      expect(result.existing_label_id).toBe(existing.id);
      // Original row unchanged
      const unchanged = await db.getAsync(`SELECT name FROM sentiment_phrase_labels WHERE id = ?`, [joy.id]);
      expect(unchanged.name).toBe('joy');
    });

    test('throws when renaming to empty string', async () => {
      const { row } = await sentimentAsync.createOrFetchLabel('joy');
      await expect(
        sentimentAsync.renameLabel(row.id, '   ')
      ).rejects.toThrow(/empty/i);
    });
  });

  describe('deleteLabel', () => {
    test('returns unlabeled_phrase_count and unlabels member phrases', async () => {
      const { row: joy } = await sentimentAsync.createOrFetchLabel('joy');
      const a = await sentimentAsync.upsertEmotionPhrase('happiness');
      const b = await sentimentAsync.upsertEmotionPhrase('delight');
      await sentimentAsync.applyLabelToPhrases(joy.id, [a.id, b.id]);

      const result = await sentimentAsync.deleteLabel(joy.id);
      expect(result.unlabeled_phrase_count).toBe(2);

      const unlabeledA = await db.getAsync(`SELECT canonical_label_id FROM sentiment_emotion_phrases WHERE id = ?`, [a.id]);
      const unlabeledB = await db.getAsync(`SELECT canonical_label_id FROM sentiment_emotion_phrases WHERE id = ?`, [b.id]);
      expect(unlabeledA.canonical_label_id).toBeNull();
      expect(unlabeledB.canonical_label_id).toBeNull();
    });

    test('returns unlabeled_phrase_count = 0 for unused label', async () => {
      const { row } = await sentimentAsync.createOrFetchLabel('unused');
      const result = await sentimentAsync.deleteLabel(row.id);
      expect(result.unlabeled_phrase_count).toBe(0);
    });
  });
});
