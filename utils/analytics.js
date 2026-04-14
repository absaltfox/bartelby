'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Analytics orchestration module.
 *
 * ## Architecture overview
 *
 * A full analytics run is two-phased:
 *
 *   1. Stats snapshot — synchronous DB queries compute per-collection document
 *      counts, storage bytes, confidence averages, etc. and write a row to
 *      `collection_analytics`.  This is fast and runs inline.
 *
 *   2. BERTopic dispatch — if the collection has >= 5 transcribed documents,
 *      topic modelling is dispatched.  On Fly.io with S3 storage the work is
 *      offloaded to an ephemeral Fly Machine (high RAM, isolated).  Locally it
 *      spawns a detached Node child that in turn runs the Python BERTopic
 *      script via a temp JSON file exchange.  Either way the main process
 *      returns immediately after dispatching.
 *
 * ## Concurrency lock
 *
 * `_analyticsRunning` is a module-level flag that serialises full scheduled
 * runs (`runScheduledAnalytics`).  It is intentionally *not* applied to
 * `runAnalyticsForCollection`, which the admin UI calls per-collection and
 * which is already serialised by the single admin acting in the browser.
 *
 * Both the background worker (`utils/worker.js`) and the admin "run-all"
 * route import `isAnalyticsRunning()` / `runScheduledAnalytics()` from here
 * so the lock is always shared from one authoritative location.
 */

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

const { resolvePythonBin } = require('./python-runtime');
const config = require('../config');
const { collectDocumentAssetPaths, computeStorageBytes } = require('./analytics-storage');

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
    SELECT d.image_path, d.metadata
    FROM documents d
    JOIN document_collections dc ON dc.document_id = d.id
    WHERE dc.collection_id = ?
  `, [collectionId]);

  const imagePaths = docs.flatMap(collectDocumentAssetPaths);
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

function normalizeScheduleIntervalHours(value) {
  const numeric = parseInt(value, 10);
  return [24, 168, 720].includes(numeric) ? numeric : 168;
}

function normalizeScheduleDayOfWeek(value) {
  const numeric = parseInt(value, 10);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 6 ? numeric : 1;
}

function normalizeScheduleTime(value) {
  const text = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(text)) return '02:00';
  const parts = text.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return '02:00';
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '02:00';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function withTime(date, timeString) {
  const parts = String(timeString || '02:00').split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hours,
    minutes,
    0,
    0
  );
}

function getLatestScheduledBoundary(now, schedule) {
  if (schedule.intervalHours === 24) {
    const todayAtTime = withTime(now, schedule.time);
    if (now >= todayAtTime) return todayAtTime;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return withTime(yesterday, schedule.time);
  }

  if (schedule.intervalHours === 168) {
    const daysSinceTarget = (now.getDay() - schedule.dayOfWeek + 7) % 7;
    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() - daysSinceTarget);
    let boundary = withTime(targetDate, schedule.time);
    if (boundary > now) {
      targetDate.setDate(targetDate.getDate() - 7);
      boundary = withTime(targetDate, schedule.time);
    }
    return boundary;
  }

  const monthBoundary = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
    0,
    0,
    0,
    0
  );
  let boundary = withTime(monthBoundary, schedule.time);
  if (boundary > now) {
    boundary = withTime(new Date(now.getFullYear(), now.getMonth() - 1, 1), schedule.time);
  }
  return boundary;
}

async function getScheduleConfig() {
  const db = require('../database/db');
  const [intervalValue, dayValue, timeValue] = await Promise.all([
    db.settingsAsync.get('analytics_schedule_interval'),
    db.settingsAsync.get('analytics_schedule_day_of_week'),
    db.settingsAsync.get('analytics_schedule_time')
  ]);

  return {
    intervalHours: normalizeScheduleIntervalHours(intervalValue),
    dayOfWeek: normalizeScheduleDayOfWeek(dayValue),
    time: normalizeScheduleTime(timeValue)
  };
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

  const schedule = await getScheduleConfig();
  const boundary = getLatestScheduledBoundary(new Date(), schedule);
  const lastRun = new Date(latest.computed_at);
  return lastRun.getTime() < boundary.getTime();
}

// ── Module-level concurrency lock ──────────────────────────────────────────
//
// Prevents overlapping full-collection scheduled analytics runs.  The lock is
// exported so external callers (admin route, worker) can inspect it without
// owning it.

let _analyticsRunning = false;

/** Returns true if a full scheduled analytics run is currently in progress. */
function isAnalyticsRunning() {
  return _analyticsRunning;
}

// ── BERTopic dispatch helpers ────────────────────────────────────────────────

const { spawn } = require('child_process');
const os = require('os');

/**
 * Spawn a detached local Node child process that runs the BERTopic worker
 * script (`utils/bertopic-worker.js`).  The child is fully detached so it
 * survives a main-process restart.  Communication is via environment variables
 * and a pair of temp JSON files written by the parent and read by the child.
 */
function queueLocalBertopicWorker(collectionId, analyticsRowId) {
  const workerPath = path.join(__dirname, 'bertopic-worker.js');
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BERTOPIC_WORKER_MODE: '1',
      ANALYTICS_COLLECTION_ID: String(collectionId),
      ANALYTICS_ROW_ID: analyticsRowId != null ? String(analyticsRowId) : '',
      PYTHONUNBUFFERED: '1'
    }
  });
  child.unref();
}

/**
 * Run BERTopic topic-modelling for a collection synchronously (blocking until
 * the Python process exits and results are written to the DB).
 *
 * Decision logic:
 *   - Fly Machines enabled AND S3 storage -> dispatch to ephemeral machine.
 *   - Otherwise -> spawn Python directly in the current environment.
 *
 * Embeddings reuse: existing document embeddings are read from the DB and
 * passed to the Python script as `existing_embeddings`.  The script only
 * recomputes embeddings for documents missing from the map, saving
 * significant API/compute cost on incremental runs.
 *
 * @returns {Promise<boolean|'dispatched'>} true if topics were computed,
 *   false if skipped (< 5 docs), or 'dispatched' when offloaded to a
 *   Fly Machine (results arrive asynchronously).
 */
async function runBertopicAnalysis(collectionId) {
  const cfg = require('../config');
  const { canLaunchEphemeralBertopicWorker } = require('./fly-machines');

  // On Fly: dispatch to ephemeral machine with enough RAM for ML workloads.
  // Machine writes results to DB and sets topics_computed = 1 when done.
  if (canLaunchEphemeralBertopicWorker()) {
    const { runEphemeralBertopicWorker } = require('./fly-machines');
    await runEphemeralBertopicWorker(collectionId);
    return 'dispatched';
  }

  if (cfg.flyMachines.enabled && cfg.storage.driver !== 's3') {
    console.warn(
      '[analytics] Fly Machines are enabled, but STORAGE_DRIVER is not s3; using the local BERTopic worker instead.'
    );
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
    const proc = spawn(resolvePythonBin(), [scriptPath, '--input', inputPath, '--output', outputPath], {
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

  if (result.topics?.length) {
    const providerName = await db.settingsAsync.get('default_provider');
    const { applyHumanReadableTopicLabels } = require('./topic-labels');
    result.topics = await applyHumanReadableTopicLabels({
      collectionId,
      providerName,
      topics: result.topics,
      assignments: result.assignments || [],
      documents: docs
    });
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
  await db.topicHierarchyAsync.replaceForCollection(collectionId, result.hierarchy || [], result.hierarchy_plot || null);
  if (result.evolution?.length) await db.topicEvolutionAsync.replaceForCollection(collectionId, result.evolution);

  return true;
}

async function dispatchBertopicAnalysis(collectionId, analyticsRowId) {
  const { canLaunchEphemeralBertopicWorker } = require('./fly-machines');

  if (canLaunchEphemeralBertopicWorker()) {
    const { runEphemeralBertopicWorker } = require('./fly-machines');
    await runEphemeralBertopicWorker(collectionId, analyticsRowId);
    return 'dispatched';
  }

  if (config.flyMachines.enabled && config.storage.driver !== 's3') {
    console.warn(
      '[analytics] Fly Machines are enabled, but STORAGE_DRIVER is not s3; queuing the local BERTopic worker instead.'
    );
  }

  queueLocalBertopicWorker(collectionId, analyticsRowId);
  console.log(`[analytics] local BERTopic worker queued for collection ${collectionId}`);
  return 'queued';
}

async function runAnalyticsForCollection(collectionId) {
  console.log(`[analytics] starting for collection ${collectionId}`);
  const db = require('../database/db');

  const stats = await computeCollectionStats(collectionId);
  stats.topics_computed = false;
  const analyticsRowId = await db.collectionAnalyticsAsync.upsert(stats);
  await db.saveDatabase();

  if (stats.transcribed_count >= 5) {
    await dispatchBertopicAnalysis(collectionId, analyticsRowId).catch(err => {
      console.error(`[analytics] BERTopic failed for collection ${collectionId}:`, err.message);
    });
  } else {
    console.log(`[analytics] collection ${collectionId}: fewer than 5 transcribed docs, skipping BERTopic dispatch`);
  }

  console.log(`[analytics] snapshot stored for collection ${collectionId}. topics queued=${stats.transcribed_count >= 5}`);
  return { ...stats, id: analyticsRowId, topics_computed: false };
}

/**
 * Run analytics for every collection that needs it, honouring the global
 * concurrency lock so only one full sweep runs at a time.
 *
 * Call sites:
 *   - `utils/worker.js` scheduled interval (every 15 min)
 *   - `routes/admin.js` POST /analytics-settings/run-all (manual admin trigger)
 *
 * Both call sites must import this function from here so the shared
 * `_analyticsRunning` flag is always authoritative.
 */
async function runScheduledAnalytics() {
  // Enforce global concurrency: refuse a second sweep if one is already running.
  // This prevents double-click or concurrent admin triggers from stacking up.
  if (_analyticsRunning) {
    console.log('[analytics] runScheduledAnalytics: already running, skipping duplicate invocation');
    return;
  }
  _analyticsRunning = true;
  try {
    const collections = await allAsync(`SELECT id FROM collections`);
    for (const col of collections) {
      if (await shouldRunAnalytics(col.id)) {
        await runAnalyticsForCollection(col.id).catch(err => {
          console.error(`[analytics] error for collection ${col.id}:`, err.message);
        });
      }
    }
  } finally {
    _analyticsRunning = false;
  }
}

module.exports = {
  countUnknownWords,
  computeCollectionStats,
  computeStorageBytes,
  hasSignificantChange,
  shouldRunAnalytics,
  getScheduleConfig,
  getScheduleIntervalMs,
  runBertopicAnalysis,
  runAnalyticsForCollection,
  runScheduledAnalytics,
  isAnalyticsRunning
};
