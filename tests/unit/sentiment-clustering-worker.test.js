'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

describe('worker-sentiment-clustering', () => {
  let db;
  let processQueuedClusteringRun;
  let tmpDir;
  let mockSpawn;
  let spawnedProc;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-worker-'));
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.SENTIMENT_CLUSTER_TIMEOUT_SEC = '60';

    jest.resetModules();

    // Mock child_process.spawn to return a controllable EventEmitter
    spawnedProc = null;
    mockSpawn = jest.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: jest.fn(), end: jest.fn() };
      proc.kill = jest.fn();
      proc.pid = 99999;
      spawnedProc = proc;
      return proc;
    });
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
    jest.doMock('../../utils/python-runtime', () => ({
      resolvePythonBin: () => '/fake/python3'
    }));

    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });

    // Seed: insert a phrase with an embedding so reads work
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'D')`);
    const result = await db.sentimentAsync.upsertEmotionPhrase('weariness');
    const vec = new Float32Array(384).fill(0.5);
    await db.sentimentAsync.setPhraseEmbedding(result.id, {
      embedding: Array.from(vec), embedding_model: 'test-model'
    });

    ({ processQueuedClusteringRun } = require('../../utils/worker-sentiment-clustering'));
  });

  afterEach(async () => {
    if (db?.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function queueRun(params = {}) {
    const defaultParams = {
      umap_n_components: 5, umap_n_neighbors: 15,
      hdbscan_min_cluster_size: 3, hdbscan_min_samples: 2, random_state: 42
    };
    const result = await db.runAsync(
      `INSERT INTO sentiment_phrase_cluster_runs (status, params_json) VALUES ('queued', ?)`,
      [JSON.stringify({ ...defaultParams, ...params })]
    );
    return result.lastInsertRowid;
  }

  function emitPythonSuccess(payload) {
    setImmediate(() => {
      spawnedProc.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
      spawnedProc.emit('close', 0);
    });
  }

  function emitPythonFailure(stderr, code = 1) {
    setImmediate(() => {
      spawnedProc.stderr.emit('data', Buffer.from(stderr));
      spawnedProc.emit('close', code);
    });
  }

  test('early-exits when no queued runs exist', async () => {
    const result = await processQueuedClusteringRun();
    expect(result).toEqual({ matched: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('claims oldest queued row and transitions to running', async () => {
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    // Spawn happens after the claim UPDATE — give it a tick
    await new Promise((r) => setImmediate(r));
    expect(mockSpawn).toHaveBeenCalled();
    emitPythonSuccess({ status: 'ok', clusters: [], noise_phrase_ids: [] });
    await promise;
    const row = await db.getAsync(`SELECT status, started_at, attempts FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(row.status).toBe('done');           // ended in done
    expect(row.started_at).not.toBeNull();     // claim landed
    expect(row.attempts).toBe(1);              // incremented
  });

  test('on Python success writes clusters + members and marks done', async () => {
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    emitPythonSuccess({
      status: 'ok',
      clusters: [
        { cluster_index: 0, members: [{ phrase_id: 1, distance_to_centroid: 0.123 }] }
      ],
      noise_phrase_ids: []
    });
    await promise;
    const run = await db.getAsync(`SELECT * FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(run.status).toBe('done');
    expect(run.cluster_count).toBe(1);
    expect(run.noise_count).toBe(0);
    expect(run.phrase_count).toBe(1);
    expect(run.completed_at).not.toBeNull();
    const clusters = await db.allAsync(`SELECT * FROM sentiment_phrase_clusters WHERE run_id = ?`, [runId]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].cluster_index).toBe(0);
    expect(clusters[0].size).toBe(1);
    const members = await db.allAsync(`SELECT * FROM sentiment_phrase_cluster_members WHERE cluster_id = ?`, [clusters[0].id]);
    expect(members).toHaveLength(1);
    expect(members[0].phrase_id).toBe(1);
    expect(members[0].distance_to_centroid).toBeCloseTo(0.123, 3);
    // Phase 2b: noise_phrase_ids_json is now persisted on the run
    expect(run.noise_phrase_ids_json).toBe('[]');
  });

  test('on Python non-zero exit marks run failed with stderr', async () => {
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    emitPythonFailure('Traceback: something broke', 1);
    await promise;
    const run = await db.getAsync(`SELECT status, error FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/exited 1.*Traceback/);
  });

  test('on Python malformed JSON marks run failed', async () => {
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    setImmediate(() => {
      spawnedProc.stdout.emit('data', Buffer.from('not json at all'));
      spawnedProc.emit('close', 0);
    });
    await promise;
    const run = await db.getAsync(`SELECT status, error FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/bad JSON/i);
  });

  test('empty phrase corpus still runs and persists done with cluster_count=0', async () => {
    // Delete the seeded phrase
    await db.runAsync(`DELETE FROM sentiment_emotion_phrases`);
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    emitPythonSuccess({ status: 'ok', clusters: [], noise_phrase_ids: [] });
    await promise;
    const run = await db.getAsync(`SELECT status, cluster_count, phrase_count, noise_phrase_ids_json FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(run.status).toBe('done');
    expect(run.cluster_count).toBe(0);
    expect(run.phrase_count).toBe(0);
    expect(run.noise_phrase_ids_json).toBe('[]');
  });

  test('two queued rows: only the oldest is processed per call', async () => {
    const olderId = await queueRun();
    // Force a later created_at for the second
    await new Promise((r) => setTimeout(r, 10));
    const newerId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    emitPythonSuccess({ status: 'ok', clusters: [], noise_phrase_ids: [] });
    await promise;
    const older = await db.getAsync(`SELECT status FROM sentiment_phrase_cluster_runs WHERE id = ?`, [olderId]);
    const newer = await db.getAsync(`SELECT status FROM sentiment_phrase_cluster_runs WHERE id = ?`, [newerId]);
    expect(older.status).toBe('done');
    expect(newer.status).toBe('queued');
  });

  test('persists noise_phrase_ids_json with the noise list from Python', async () => {
    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    emitPythonSuccess({
      status: 'ok',
      clusters: [
        { cluster_index: 0, members: [{ phrase_id: 1, distance_to_centroid: 0.01 }] }
      ],
      noise_phrase_ids: [42, 73, 99]
    });
    await promise;
    const run = await db.getAsync(
      `SELECT noise_phrase_ids_json, noise_count FROM sentiment_phrase_cluster_runs WHERE id = ?`,
      [runId]
    );
    expect(run.noise_count).toBe(3);
    expect(JSON.parse(run.noise_phrase_ids_json)).toEqual([42, 73, 99]);
  });

  test('subprocess exceeding timeout is killed and marked failed', async () => {
    process.env.SENTIMENT_CLUSTER_TIMEOUT_SEC = '0.05'; // 50ms — fires before we emit close
    const savedDb = db; // hold reference to initialized db before resetModules clears registry
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
    jest.doMock('../../utils/python-runtime', () => ({ resolvePythonBin: () => '/fake/python3' }));
    jest.doMock('../../database/db', () => savedDb); // re-register initialized db so fresh worker gets it
    ({ processQueuedClusteringRun } = require('../../utils/worker-sentiment-clustering'));

    const runId = await queueRun();
    const promise = processQueuedClusteringRun();
    await new Promise((r) => setImmediate(r));
    // Don't emit close; let the timeout fire and simulate the subprocess actually dying
    await new Promise((r) => setTimeout(r, 100));
    expect(spawnedProc.kill).toHaveBeenCalledWith('SIGTERM');
    // Simulate the subprocess exiting in response to SIGTERM
    spawnedProc.emit('close', 143); // SIGTERM exit code
    await promise;
    const run = await db.getAsync(`SELECT status, error FROM sentiment_phrase_cluster_runs WHERE id = ?`, [runId]);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/exceeded.*timeout/i);
  });
});
