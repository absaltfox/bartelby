'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment cluster derived state', () => {
  let db;
  let sentimentAsync;
  let tmpDir;
  let runId;
  let clusterId;
  let phraseA, phraseB, phraseC, phraseD, phraseE;
  let labelJoy, labelSorrow;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-state-'));
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    sentimentAsync = db.sentimentAsync;

    // Seed: a run with one cluster containing 5 phrases
    const runInsert = await db.runAsync(
      `INSERT INTO sentiment_phrase_cluster_runs (status, params_json, cluster_count, noise_count, phrase_count, noise_phrase_ids_json)
       VALUES ('done', '{}', 1, 0, 5, '[]')`
    );
    runId = runInsert.lastInsertRowid;
    const clusterInsert = await db.runAsync(
      `INSERT INTO sentiment_phrase_clusters (run_id, cluster_index, size) VALUES (?, 0, 5)`,
      [runId]
    );
    clusterId = clusterInsert.lastInsertRowid;
    phraseA = await sentimentAsync.upsertEmotionPhrase('happiness');
    phraseB = await sentimentAsync.upsertEmotionPhrase('delight');
    phraseC = await sentimentAsync.upsertEmotionPhrase('elation');
    phraseD = await sentimentAsync.upsertEmotionPhrase('grief');
    phraseE = await sentimentAsync.upsertEmotionPhrase('sorrow-phrase');
    for (const [i, p] of [phraseA, phraseB, phraseC, phraseD, phraseE].entries()) {
      await db.runAsync(
        `INSERT INTO sentiment_phrase_cluster_members (cluster_id, phrase_id, distance_to_centroid) VALUES (?, ?, ?)`,
        [clusterId, p.id, i * 0.1]
      );
    }
    labelJoy = (await sentimentAsync.createOrFetchLabel('joy')).row;
    labelSorrow = (await sentimentAsync.createOrFetchLabel('sorrow')).row;
  });

  afterEach(async () => {
    if (db?.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getClustersWithLabelState', () => {
    test('all unlabeled members → state = unlabeled', async () => {
      const rows = await sentimentAsync.getClustersWithLabelState(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0].label_state).toBe('unlabeled');
      expect(rows[0].labeled_count).toBe(0);
      expect(rows[0].size).toBe(5);
    });

    test('all members labeled same → state = full', async () => {
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [phraseA.id, phraseB.id, phraseC.id, phraseD.id, phraseE.id]);
      const rows = await sentimentAsync.getClustersWithLabelState(runId);
      expect(rows[0].label_state).toBe('full');
      expect(rows[0].labeled_count).toBe(5);
      expect(rows[0].dominant_label_id).toBe(labelJoy.id);
      expect(rows[0].dominant_label_name).toBe('joy');
    });

    test('some members labeled same, some unlabeled → state = partial', async () => {
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [phraseA.id, phraseB.id, phraseC.id]);
      const rows = await sentimentAsync.getClustersWithLabelState(runId);
      expect(rows[0].label_state).toBe('partial');
      expect(rows[0].labeled_count).toBe(3);
      expect(rows[0].dominant_label_id).toBe(labelJoy.id);
    });

    test('members labeled differently → state = mixed', async () => {
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [phraseA.id, phraseB.id]);
      await sentimentAsync.applyLabelToPhrases(labelSorrow.id, [phraseD.id, phraseE.id]);
      const rows = await sentimentAsync.getClustersWithLabelState(runId);
      expect(rows[0].label_state).toBe('mixed');
      expect(rows[0].distinct_label_count).toBe(2);
    });
  });

  describe('getClusterMembersWithLabels', () => {
    test('returns all members sorted by distance_to_centroid ASC', async () => {
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [phraseA.id, phraseC.id]);
      const result = await sentimentAsync.getClusterMembersWithLabels(clusterId);
      expect(result.cluster_id).toBe(clusterId);
      expect(result.size).toBe(5);
      expect(result.members).toHaveLength(5);
      expect(result.members[0].phrase_id).toBe(phraseA.id); // distance 0.0
      expect(result.members[0].canonical_label_id).toBe(labelJoy.id);
      expect(result.members[0].canonical_label_name).toBe('joy');
      expect(result.members[1].canonical_label_id).toBeNull(); // phraseB unlabeled
    });

    test('returns null for non-existent cluster', async () => {
      const result = await sentimentAsync.getClusterMembersWithLabels(99999);
      expect(result).toBeNull();
    });
  });

  describe('getNoisePhrasesForRun', () => {
    test('returns paginated noise phrases with current labels', async () => {
      // Set noise IDs on the run
      await db.runAsync(
        `UPDATE sentiment_phrase_cluster_runs SET noise_phrase_ids_json = ? WHERE id = ?`,
        [JSON.stringify([phraseD.id, phraseE.id]), runId]
      );
      await sentimentAsync.applyLabelToPhrases(labelSorrow.id, [phraseD.id]);

      const result = await sentimentAsync.getNoisePhrasesForRun(runId, { page: 1, pageSize: 10 });
      expect(result.total_noise_count).toBe(2);
      expect(result.phrases).toHaveLength(2);
      const labeled = result.phrases.find((p) => p.phrase_id === phraseD.id);
      expect(labeled.canonical_label_name).toBe('sorrow');
    });

    test('handles NULL noise_phrase_ids_json gracefully (returns empty)', async () => {
      await db.runAsync(`UPDATE sentiment_phrase_cluster_runs SET noise_phrase_ids_json = NULL WHERE id = ?`, [runId]);
      const result = await sentimentAsync.getNoisePhrasesForRun(runId, { page: 1, pageSize: 10 });
      expect(result.total_noise_count).toBe(0);
      expect(result.phrases).toEqual([]);
    });

    test('paginates correctly', async () => {
      const ids = [phraseA.id, phraseB.id, phraseC.id, phraseD.id, phraseE.id];
      await db.runAsync(
        `UPDATE sentiment_phrase_cluster_runs SET noise_phrase_ids_json = ? WHERE id = ?`,
        [JSON.stringify(ids), runId]
      );
      const page1 = await sentimentAsync.getNoisePhrasesForRun(runId, { page: 1, pageSize: 2 });
      expect(page1.phrases).toHaveLength(2);
      expect(page1.total_pages).toBe(3);
      const page3 = await sentimentAsync.getNoisePhrasesForRun(runId, { page: 3, pageSize: 2 });
      expect(page3.phrases).toHaveLength(1);
    });
  });

  describe('getClusterIdsContainingLabel', () => {
    test('returns Set of cluster IDs in the run whose members include the label', async () => {
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [phraseA.id, phraseC.id]);
      const result = await sentimentAsync.getClusterIdsContainingLabel(runId, labelJoy.id);
      expect(result).toBeInstanceOf(Set);
      expect(result.has(clusterId)).toBe(true);
      expect(result.size).toBe(1);
    });

    test('returns empty Set when no clusters in the run contain the label', async () => {
      const result = await sentimentAsync.getClusterIdsContainingLabel(runId, labelJoy.id);
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    test('does not return cluster IDs from other runs (run scope correctness)', async () => {
      // Create a second run with its own cluster + members + label assignment
      const run2Insert = await db.runAsync(
        `INSERT INTO sentiment_phrase_cluster_runs (status, params_json, cluster_count, noise_count, phrase_count, noise_phrase_ids_json)
         VALUES ('done', '{}', 1, 0, 1, '[]')`
      );
      const runId2 = run2Insert.lastInsertRowid;
      const cluster2Insert = await db.runAsync(
        `INSERT INTO sentiment_phrase_clusters (run_id, cluster_index, size) VALUES (?, 0, 1)`,
        [runId2]
      );
      const clusterId2 = cluster2Insert.lastInsertRowid;
      const isolated = await sentimentAsync.upsertEmotionPhrase('isolated-phrase');
      await db.runAsync(
        `INSERT INTO sentiment_phrase_cluster_members (cluster_id, phrase_id, distance_to_centroid) VALUES (?, ?, 0)`,
        [clusterId2, isolated.id]
      );
      await sentimentAsync.applyLabelToPhrases(labelJoy.id, [isolated.id, phraseA.id]);

      const result1 = await sentimentAsync.getClusterIdsContainingLabel(runId, labelJoy.id);
      expect(result1.has(clusterId)).toBe(true);
      expect(result1.has(clusterId2)).toBe(false);

      const result2 = await sentimentAsync.getClusterIdsContainingLabel(runId2, labelJoy.id);
      expect(result2.has(clusterId2)).toBe(true);
      expect(result2.has(clusterId)).toBe(false);
    });
  });
});
