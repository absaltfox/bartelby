'use strict';

/**
 * Count [illegible] and [unclear: ...] markers in a transcript.
 * These represent words the model could not confidently read.
 */
function countUnknownWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const illegible = (text.match(/\[illegible\]/gi) || []).length;
  const unclear = (text.match(/\[unclear:/gi) || []).length;
  return illegible + unclear;
}

const path = require('path');
const fs = require('fs');
const config = require('../config');

function getRawDb() {
  return require('../database/db').getDb();
}

async function allAsync(sql, params = []) {
  return getRawDb().all(sql, params);
}

async function getAsync(sql, params = []) {
  return getRawDb().get(sql, params);
}

/**
 * Sum file sizes for all image_path values in a collection.
 * Local: stat each file. S3: HeadObject per file (best-effort).
 */
async function computeStorageBytes(imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return 0;

  if (config.storage.driver === 's3') {
    try {
      const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
      const s3cfg = config.storage.s3;
      const s3 = new S3Client({
        region: s3cfg.region,
        credentials: {
          accessKeyId: s3cfg.accessKeyId,
          secretAccessKey: s3cfg.secretAccessKey
        },
        endpoint: s3cfg.endpoint || undefined,
        forcePathStyle: s3cfg.forcePathStyle
      });
      let total = 0;
      for (const imgPath of imagePaths) {
        try {
          const res = await s3.send(new HeadObjectCommand({
            Bucket: s3cfg.bucket,
            Key: imgPath
          }));
          total += res.ContentLength || 0;
        } catch {
          // ignore missing files
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  // Local storage
  let total = 0;
  const uploadsRoot = path.join(__dirname, '..', 'public');
  for (const imgPath of imagePaths) {
    try {
      const abs = path.join(uploadsRoot, imgPath);
      const stat = fs.statSync(abs);
      total += stat.size;
    } catch {
      // file may not exist
    }
  }
  return total;
}

/**
 * Compute all dashboard metrics for a single collection.
 * Returns a stats object ready to be stored in collection_analytics.
 */
async function computeCollectionStats(collectionId) {
  const statsRow = await getAsync(`
    SELECT
      COUNT(DISTINCT dc.document_id) AS document_count,
      COUNT(DISTINCT t.document_id) AS transcribed_count,
      SUM(t.cost_usd) AS total_cost_usd,
      AVG(t.confidence) AS avg_confidence,
      AVG(t.unknown_word_count) AS avg_unknown_words
    FROM document_collections dc
    LEFT JOIN transcripts t ON t.document_id = dc.document_id AND t.is_best = 1
    WHERE dc.collection_id = ?
  `, [collectionId]);

  const docCount = statsRow.document_count || 0;
  const transcribedCount = statsRow.transcribed_count || 0;

  const docs = await allAsync(`
    SELECT d.image_path
    FROM documents d
    JOIN document_collections dc ON dc.document_id = d.id
    WHERE dc.collection_id = ?
  `, [collectionId]);

  const imagePaths = docs.map(d => d.image_path).filter(Boolean);
  const storageBytes = await computeStorageBytes(imagePaths);

  return {
    collection_id: collectionId,
    document_count: docCount,
    storage_bytes: storageBytes,
    transcribed_count: transcribedCount,
    untranscribed_count: docCount - transcribedCount,
    total_cost_usd: statsRow.total_cost_usd ?? null,
    avg_confidence: statsRow.avg_confidence ?? null,
    avg_unknown_words: statsRow.avg_unknown_words ?? null,
    page_count_at_run: docCount,
    topics_computed: false
  };
}

/**
 * Returns the analytics schedule interval in milliseconds.
 * Setting key: analytics_schedule_interval (hours string, default '168' = weekly)
 */
async function getScheduleIntervalMs() {
  const db = require('../database/db');
  const val = await db.settingsAsync.get('analytics_schedule_interval');
  const hours = val ? parseFloat(val) : 168;
  return hours * 60 * 60 * 1000;
}

/**
 * Returns true if the collection's document count has grown by more than
 * thresholdFraction (default 0.10 = 10%) since the last analytics run.
 * Returns true if analytics have never been run and there are documents.
 */
async function hasSignificantChange(collectionId, thresholdFraction = 0.10) {
  const db = require('../database/db');
  const latest = await db.collectionAnalyticsAsync.getLatest(collectionId);
  const row = await getAsync(
    `SELECT COUNT(*) as cnt FROM document_collections WHERE collection_id = ?`,
    [collectionId]
  );
  const current = row?.cnt ?? 0;

  if (!latest) return current > 0;
  if (latest.page_count_at_run === 0) return current > 0;

  const delta = current - latest.page_count_at_run;
  return delta / latest.page_count_at_run > thresholdFraction;
}

/**
 * Returns true if analytics should run for the given collection.
 * Checks: enabled setting, has documents, schedule elapsed, or significant change.
 */
async function shouldRunAnalytics(collectionId) {
  const db = require('../database/db');

  const enabled = await db.settingsAsync.get('analytics_enabled');
  if (enabled === '0') return false;

  const row = await getAsync(
    `SELECT COUNT(*) as cnt FROM document_collections WHERE collection_id = ?`,
    [collectionId]
  );
  if (!row?.cnt) return false;

  const threshStr = await db.settingsAsync.get('analytics_change_threshold');
  const threshFraction = threshStr ? parseFloat(threshStr) / 100 : 0.10;
  if (await hasSignificantChange(collectionId, threshFraction)) return true;

  const latest = await db.collectionAnalyticsAsync.getLatest(collectionId);
  if (!latest) return true;

  const intervalMs = await getScheduleIntervalMs();
  const lastRun = new Date(latest.computed_at).getTime();
  return (Date.now() - lastRun) >= intervalMs;
}

const { spawn } = require('child_process');
const os = require('os');

async function runBertopicAnalysis(collectionId) {
  const cfg = require('../config');

  // On Fly: dispatch to ephemeral machine with enough RAM for ML workloads.
  // Machine writes results to DB and sets topics_computed = 1 when done.
  if (cfg.flyMachines.enabled) {
    const { runEphemeralBertopicWorker } = require('./fly-machines');
    await runEphemeralBertopicWorker(collectionId);
    return 'dispatched';
  }

  // Local path: spawn Python directly
  const db = require('../database/db');

  const docs = await allAsync(`
    SELECT d.id, d.title, d.date_created, t.content
    FROM documents d
    JOIN document_collections dc ON dc.document_id = d.id
    JOIN transcripts t ON t.document_id = d.id AND t.is_best = 1
    WHERE dc.collection_id = ?
  `, [collectionId]);

  if (docs.length < 5) {
    console.log(`[analytics] collection ${collectionId}: fewer than 5 transcribed docs, skipping BERTopic`);
    return false;
  }

  const existingRows = await db.documentEmbeddingsAsync.getByCollection(collectionId);
  const existingEmbeddings = {};
  for (const row of existingRows) {
    existingEmbeddings[String(row.document_id)] = row.embedding;
  }

  const inputPath = path.join(os.tmpdir(), `bertopic_in_${collectionId}_${Date.now()}.json`);
  const outputPath = path.join(os.tmpdir(), `bertopic_out_${collectionId}_${Date.now()}.json`);

  fs.writeFileSync(inputPath, JSON.stringify({
    collection_id: collectionId,
    documents: docs.map(d => ({
      id: d.id,
      text: d.content || d.title || '',
      date_created: d.date_created || null
    })),
    existing_embeddings: existingEmbeddings,
    embedding_model: 'all-MiniLM-L6-v2'
  }));

  const scriptPath = path.join(__dirname, '..', 'scripts', 'bertopic_analysis.py');
  await new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath, '--input', inputPath, '--output', outputPath], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    const stderr = [];
    proc.stderr.on('data', d => stderr.push(d.toString()));
    proc.on('close', code => {
      console.log(`[analytics] BERTopic stderr: ${stderr.join('')}`);
      if (code !== 0) reject(new Error(`BERTopic exited with code ${code}: ${stderr.join('')}`));
      else resolve();
    });
  });

  const raw = fs.readFileSync(outputPath, 'utf8');
  const result = JSON.parse(raw);
  try { fs.unlinkSync(inputPath); } catch {}
  try { fs.unlinkSync(outputPath); } catch {}

  if (result.error || result.skipped) {
    console.log(`[analytics] BERTopic skipped for collection ${collectionId}: ${result.reason || result.error}`);
    return false;
  }

  if (result.new_embeddings && Object.keys(result.new_embeddings).length > 0) {
    const entries = Object.entries(result.new_embeddings).map(([docId, emb]) => ({
      document_id: parseInt(docId),
      embedding: emb,
      embedding_model: 'all-MiniLM-L6-v2'
    }));
    await db.documentEmbeddingsAsync.bulkUpsert(collectionId, entries);
  }

  if (result.topics?.length) await db.collectionTopicsAsync.replaceForCollection(collectionId, result.topics);
  if (result.assignments?.length) await db.documentTopicAssignmentsAsync.replaceForCollection(collectionId, result.assignments);
  if (result.evolution?.length) await db.topicEvolutionAsync.replaceForCollection(collectionId, result.evolution);

  return true;
}

async function runAnalyticsForCollection(collectionId) {
  console.log(`[analytics] starting for collection ${collectionId}`);
  const db = require('../database/db');

  const stats = await computeCollectionStats(collectionId);

  let topicsOk = false;
  if (stats.transcribed_count >= 5) {
    const result = await runBertopicAnalysis(collectionId).catch(err => {
      console.error(`[analytics] BERTopic failed for collection ${collectionId}:`, err.message);
      return false;
    });
    // 'dispatched' = Fly machine will update topics_computed async
    topicsOk = result === 'dispatched' ? false : result;
  }

  stats.topics_computed = topicsOk;
  await db.collectionAnalyticsAsync.upsert(stats);

  console.log(`[analytics] done for collection ${collectionId}. topics_computed=${topicsOk}`);
  return stats;
}

async function runScheduledAnalytics() {
  const collections = await allAsync(`SELECT id FROM collections`);
  for (const col of collections) {
    if (await shouldRunAnalytics(col.id)) {
      await runAnalyticsForCollection(col.id).catch(err => {
        console.error(`[analytics] error for collection ${col.id}:`, err.message);
      });
    }
  }
}

module.exports = {
  countUnknownWords,
  computeCollectionStats,
  computeStorageBytes,
  hasSignificantChange,
  shouldRunAnalytics,
  getScheduleIntervalMs,
  runBertopicAnalysis,
  runAnalyticsForCollection,
  runScheduledAnalytics
};
