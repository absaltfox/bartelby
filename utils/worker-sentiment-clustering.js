'use strict';

// Phase 2a: Pick up the oldest queued sentiment_phrase_cluster_runs row,
// spawn the Python clustering script, write results back. The tick wrapper
// in utils/worker.js owns the busy flag and the setInterval.
//
// Per docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md § 5.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../database/db');
const { resolvePythonBin } = require('./python-runtime');

const TIMEOUT_SEC_DEFAULT = 600;
const SIGKILL_GRACE_MS = 5000;
const PYTHON_SCRIPT = 'scripts/sentiment_cluster.py';

async function processQueuedClusteringRun() {
  const run = await db.getAsync(
    `SELECT id, params_json FROM sentiment_phrase_cluster_runs
      WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
  );
  if (!run) return { matched: 0 };

  // Atomic claim — guards against another worker grabbing the same row
  const claim = await db.runAsync(
    `UPDATE sentiment_phrase_cluster_runs
        SET status = 'running',
            started_at = CURRENT_TIMESTAMP,
            attempts = attempts + 1
      WHERE id = ? AND status = 'queued'`,
    [run.id]
  );
  if (!claim.changes) return { matched: 0 }; // someone else claimed it

  const params = JSON.parse(run.params_json);
  const startMs = Date.now();
  console.log(`[sentiment-clustering] run ${run.id}: started`);

  try {
    // Read phrases + embeddings (Float32Array stored as BLOB)
    const phraseRows = await db.allAsync(
      `SELECT id, embedding FROM sentiment_emotion_phrases WHERE embedding IS NOT NULL`
    );
    const phrases = phraseRows.map((r) => ({
      id: r.id,
      embedding: Array.from(
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
      )
    }));

    // Spawn Python, exchange JSON
    const result = await runClusteringSubprocess({ phrases, params });

    // Persist clusters + members
    for (const cluster of result.clusters) {
      const inserted = await db.runAsync(
        `INSERT INTO sentiment_phrase_clusters (run_id, cluster_index, size) VALUES (?, ?, ?)`,
        [run.id, cluster.cluster_index, cluster.members.length]
      );
      const clusterId = inserted.lastInsertRowid;
      for (const m of cluster.members) {
        await db.runAsync(
          `INSERT INTO sentiment_phrase_cluster_members (cluster_id, phrase_id, distance_to_centroid) VALUES (?, ?, ?)`,
          [clusterId, m.phrase_id, m.distance_to_centroid]
        );
      }
    }

    await db.runAsync(
      `UPDATE sentiment_phrase_cluster_runs
          SET status = 'done',
              cluster_count = ?,
              noise_count = ?,
              phrase_count = ?,
              noise_phrase_ids_json = ?,
              completed_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [result.clusters.length, result.noise_phrase_ids.length, phrases.length,
       JSON.stringify(result.noise_phrase_ids || []), run.id]
    );
    await db.saveDatabase?.();

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    console.log(`[sentiment-clustering] run ${run.id}: done (${result.clusters.length} clusters, ${result.noise_phrase_ids.length} noise, ${phrases.length} phrases, ${elapsedSec}s)`);
    return { matched: 1, runId: run.id, status: 'done' };
  } catch (err) {
    await db.runAsync(
      `UPDATE sentiment_phrase_cluster_runs
          SET status = 'failed',
              error = ?,
              completed_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [String(err.message).slice(0, 500), run.id]
    );
    await db.saveDatabase?.();
    console.log(`[sentiment-clustering] run ${run.id}: failed: ${err.message}`);
    return { matched: 1, runId: run.id, status: 'failed' };
  }
}

async function runClusteringSubprocess({ phrases, params }) {
  // The payload for 2k+ phrases is ~17MB. Piping that via stdin to a Python
  // subprocess that only reads it after json.load(sys.stdin) means the OS pipe
  // buffer (64KB on macOS) fills up and the writer blocks on backpressure
  // throughout the read, adding 5–6× overhead versus reading from a file.
  // Write to a temp file instead; the Python script reads it via --input.
  const tmpPath = path.join(os.tmpdir(), `sentiment-cluster-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ phrases, params }));

  try {
    return await new Promise((resolve, reject) => {
      const timeoutSec = Number(process.env.SENTIMENT_CLUSTER_TIMEOUT_SEC) || TIMEOUT_SEC_DEFAULT;
      const proc = spawn(resolvePythonBin(), [PYTHON_SCRIPT, '--input', tmpPath], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let sigkillTimer = null;

      const sigtermTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          proc.kill('SIGKILL');
        }, SIGKILL_GRACE_MS);
      }, timeoutSec * 1000);

      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('error', (err) => {
        clearTimeout(sigtermTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(sigtermTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (timedOut) {
          return reject(new Error(`Clustering exceeded ${timeoutSec} second timeout`));
        }
        if (code !== 0) {
          return reject(new Error(`sentiment_cluster.py exited ${code}: ${stderr.slice(-500)}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`bad JSON from sentiment_cluster.py: ${e.message}`));
        }
      });
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
  }
}

module.exports = { processQueuedClusteringRun };
