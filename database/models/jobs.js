'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, runWithoutSave, runAsyncWithoutSave) => {

// Turso (libSQL) uses a stateless HTTP protocol — each client.execute() is
// auto-committed independently, so BEGIN EXCLUSIVE / COMMIT / ROLLBACK issued
// as plain statements do not form a real transaction. On Turso we skip the
// explicit lock and rely on optimistic locking (WHERE status = 'queued' in the
// UPDATE): whichever worker wins the UPDATE gets changes=1; the other gets 0.
// On local SQLite (sqljs / better-sqlite3) we use BEGIN EXCLUSIVE so the
// SELECT+UPDATE pair is truly atomic.
//
// Multiple setInterval worker ticks fire concurrently (they're all async), so
// we need a module-level mutex to ensure only one BEGIN EXCLUSIVE is in flight
// at a time on the same connection.
let _exclusiveLockBusy = false;
const _exclusiveLockQueue = [];
const { DEFAULT_BATCH_FINALIZATION_STALE_SECONDS } = require('../../utils/finalization-claims');
const DEFAULT_PAGE_SIZE = 50;

function sortJobsByCreatedAtDesc(a, b) {
  return new Date(b.created_at) - new Date(a.created_at);
}

function normalizeStatusFilter(statusFilter = 'all') {
  const normalized = String(statusFilter || 'all').toLowerCase();
  return ['all', 'queued', 'running', 'done', 'failed'].includes(normalized)
    ? normalized
    : 'all';
}

function matchesStatusFilter(status, statusFilter) {
  const normalized = normalizeStatusFilter(statusFilter);
  if (normalized === 'all') return true;
  if (normalized === 'running') {
    return status === 'running' || status === 'processing';
  }
  return status === normalized;
}

function normalizeTypeFilter(typeFilter = 'all', allowed = ['all', 'transcription', 'import', 'extraction', 'sentiment', 'authority_suggestion']) {
  const normalized = String(typeFilter || 'all').toLowerCase();
  return allowed.includes(normalized) ? normalized : 'all';
}

function createStatusCounts() {
  return { total: 0, queued: 0, running: 0, done: 0, failed: 0 };
}

function addStatusCount(target, status, count) {
  const numericCount = Number(count || 0);
  target.total += numericCount;
  if (status === 'queued') {
    target.queued += numericCount;
  } else if (status === 'running' || status === 'processing' || status === 'batch_submitted') {
    // `batch_submitted` is sentiment's in-flight state (provider has the batch,
    // worker is polling). Group it under "running" so the unified Jobs tab
    // shows it the same way as a transcription job that is mid-call.
    target.running += numericCount;
  } else if (status === 'done') {
    target.done += numericCount;
  } else if (status === 'failed') {
    target.failed += numericCount;
  }
}

function buildCountMap(rows = []) {
  const counts = createStatusCounts();
  rows.forEach((row) => addStatusCount(counts, row.status, row.count));
  return counts;
}

function mergeCountMaps(...maps) {
  return maps.reduce((acc, map) => {
    if (!map) return acc;
    acc.total += Number(map.total || 0);
    acc.queued += Number(map.queued || 0);
    acc.running += Number(map.running || 0);
    acc.done += Number(map.done || 0);
    acc.failed += Number(map.failed || 0);
    return acc;
  }, createStatusCounts());
}

function normalizeJobSummary(row, jobType) {
  return {
    ...row,
    job_type: jobType
  };
}

function appendLegacyLog(existingLog, lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return existingLog || '';
  }
  return `${existingLog || ''}${lines.map((row) => row.line || '').join('')}`;
}

function parseImportJobPayload(job) {
  if (!job?.submit_payload) return null;
  try {
    return typeof job.submit_payload === 'string'
      ? JSON.parse(job.submit_payload)
      : job.submit_payload;
  } catch (err) {
    return null;
  }
}

function decorateManageImportJob(job, collectionId) {
  const payload = parseImportJobPayload(job);
  const authorizedCollectionIds = Array.isArray(payload?.authorizedCollectionIds)
    ? payload.authorizedCollectionIds.map(Number).filter(Number.isInteger)
    : [];

  if (authorizedCollectionIds.length > 0 && !authorizedCollectionIds.includes(collectionId)) {
    return null;
  }

  return {
    ...job,
    job_type: 'import',
    scope: authorizedCollectionIds.includes(collectionId) ? 'collection' : 'user',
    scope_label: authorizedCollectionIds.includes(collectionId) ? null : 'Your import job'
  };
}

async function withExclusiveLock(fn) {
  if (process.env.DATABASE_DRIVER === 'turso') {
    return await fn();
  }

  if (_exclusiveLockBusy) {
    await new Promise(resolve => _exclusiveLockQueue.push(resolve));
  }
  _exclusiveLockBusy = true;

  try {
    await runAsync('BEGIN EXCLUSIVE');
    try {
      const result = await fn();
      await runAsync('COMMIT');
      return result;
    } catch (err) {
      try { await runAsync('ROLLBACK'); } catch (e) { void e; }
      throw err;
    }
  } finally {
    if (_exclusiveLockQueue.length > 0) {
      _exclusiveLockQueue.shift()();
    } else {
      _exclusiveLockBusy = false;
    }
  }
}

function appendJobLogEntrySync(jobType, jobId, text) {
  if (!text) return;
  runWithoutSave(`
    INSERT INTO job_log_entries (job_type, job_id, line)
    VALUES (?, ?, ?)
  `, [jobType, jobId, text]);
  saveDatabase();
}

async function appendJobLogEntry(jobType, jobId, text) {
  if (!text) return;
  await runAsyncWithoutSave(`
    INSERT INTO job_log_entries (job_type, job_id, line)
    VALUES (?, ?, ?)
  `, [jobType, jobId, text]);
  await saveDatabase();
}

async function getAppendedJobLog(jobType, jobId) {
  return await allAsync(`
    SELECT line
    FROM job_log_entries
    WHERE job_type = ? AND job_id = ?
    ORDER BY id ASC
  `, [jobType, jobId]);
}

async function hydrateJobLog(row, jobType) {
  if (!row) return row;
  const lines = await getAppendedJobLog(jobType, row.id);
  return {
    ...row,
    log: appendLegacyLog(row.log, lines)
  };
}

const transcriptionJobs = {
  create({
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    image_path,
    additional_image_paths,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id,
    job_kind = 'single',
    batch_display_name = null,
    batch_document_count = 1,
    batch_page_count = 0,
    batch_manifest = null,
    linked_document_ids = null
  }) {
    const result = run(`
      INSERT INTO transcription_jobs
        (
          document_id, provider, model, temperature, initiated_by,
          image_path, additional_image_paths, provider_key_scope,
          user_api_key_id, requested_by_user_id, job_kind,
          batch_display_name, batch_document_count, batch_page_count,
          batch_manifest, status, log
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      image_path,
      additional_image_paths ? JSON.stringify(additional_image_paths) : null,
      provider_key_scope || null,
      user_api_key_id || null,
      requested_by_user_id || null,
      job_kind || 'single',
      batch_display_name || null,
      Number.isInteger(batch_document_count) ? batch_document_count : 1,
      Number.isInteger(batch_page_count) ? batch_page_count : 0,
      batch_manifest ? JSON.stringify(batch_manifest) : null
    ]);
    const jobId = result.lastInsertRowid;
    this.linkDocuments(jobId, linked_document_ids || [document_id]);
    return jobId;
  },

  linkDocuments(jobId, documentIds) {
    if (!Number.isInteger(jobId) || !Array.isArray(documentIds)) return;
    const uniqueIds = [...new Set(documentIds.map(Number).filter(Number.isInteger))];
    uniqueIds.forEach((documentId) => {
      run(`
        INSERT OR IGNORE INTO transcription_job_documents (job_id, document_id)
        VALUES (?, ?)
      `, [jobId, documentId]);
    });
  },

  markRunning(id) {
    runWithoutSave("UPDATE transcription_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?", [id]);
    saveDatabase();
  },

  appendLog(id, text) {
    appendJobLogEntrySync('transcription', id, text);
  },

  markDone(id) {
    runWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'done',
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
    `, [id]);
    saveDatabase();
  },

  markFailed(id, error) {
    runWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
        AND status != 'done'
    `, [error || 'Unknown error', id]);
    saveDatabase();
  },

  requeueForRetry(id) {
    runWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0
      WHERE id = ?
    `, [id]);
    saveDatabase();
  },

  getAll() {
    return all(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ORDER BY j.created_at DESC
    `);
  },

  getById(id) {
    return get(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.id = ?
    `, [id]);
  },

  getCounts() {
    const rows = all("SELECT status, COUNT(*) as count FROM transcription_jobs GROUP BY status");
    const counts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
    rows.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + r.count;
      counts.total += r.count;
    });
    return counts;
  },

  retry(id) {
    runWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0
      WHERE id = ? AND status = 'failed'
    `, [id]);
    saveDatabase();
  },

  delete(id) {
    return run("DELETE FROM transcription_jobs WHERE id = ?", [id]);
  },

  getPendingForDocument(docId) {
    return get(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.status IN ('queued', 'running')
        AND (
          j.document_id = ?
          OR EXISTS (
            SELECT 1
            FROM transcription_job_documents tjd
            WHERE tjd.job_id = j.id AND tjd.document_id = ?
          )
        )
      ORDER BY j.created_at DESC
      LIMIT 1
    `, [docId, docId]);
  },

  getRunningBatches() {
    return all(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.job_kind = 'batch' AND j.status = 'running'
      ORDER BY j.created_at ASC
    `);
  },

  updateBatchRemote(id, { remoteId, remoteStatus }) {
    run(`
      UPDATE transcription_jobs
      SET batch_remote_id = COALESCE(?, batch_remote_id),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [remoteId || null, remoteStatus || null, id]);
  },

  updateBatchProgress(id, { completedCount, failedCount, remoteStatus }) {
    run(`
      UPDATE transcription_jobs
      SET batch_completed_count = COALESCE(?, batch_completed_count),
          batch_failed_count = COALESCE(?, batch_failed_count),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [
      Number.isInteger(completedCount) ? completedCount : null,
      Number.isInteger(failedCount) ? failedCount : null,
      remoteStatus || null,
      id
    ]);
  }
};

const transcriptionJobsAsync = {
  async create({
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    image_path,
    additional_image_paths,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id,
    job_kind = 'single',
    batch_display_name = null,
    batch_document_count = 1,
    batch_page_count = 0,
    batch_manifest = null,
    linked_document_ids = null
  }) {
    const result = await runAsyncWithoutSave(`
      INSERT INTO transcription_jobs
        (
          document_id, provider, model, temperature, initiated_by,
          image_path, additional_image_paths, provider_key_scope,
          user_api_key_id, requested_by_user_id, job_kind,
          batch_display_name, batch_document_count, batch_page_count,
          batch_manifest, status, log
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      image_path,
      additional_image_paths ? JSON.stringify(additional_image_paths) : null,
      provider_key_scope || null,
      user_api_key_id || null,
      requested_by_user_id || null,
      job_kind || 'single',
      batch_display_name || null,
      Number.isInteger(batch_document_count) ? batch_document_count : 1,
      Number.isInteger(batch_page_count) ? batch_page_count : 0,
      batch_manifest ? JSON.stringify(batch_manifest) : null
    ]);
    const jobId = result.lastInsertRowid;
    await this.linkDocuments(jobId, linked_document_ids || [document_id]);
    return jobId;
  },

  async linkDocuments(jobId, documentIds) {
    if (!Number.isInteger(jobId) || !Array.isArray(documentIds)) return;
    const uniqueIds = [...new Set(documentIds.map(Number).filter(Number.isInteger))];
    for (const documentId of uniqueIds) {
      await runAsync(`
        INSERT OR IGNORE INTO transcription_job_documents (job_id, document_id)
        VALUES (?, ?)
      `, [jobId, documentId]);
    }
  },

  async claimNextQueued() {
    return await withExclusiveLock(async () => {
      const job = await getAsync(
        "SELECT * FROM transcription_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
      );
      if (!job) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE transcription_jobs
        SET status = 'running',
            started_at = CURRENT_TIMESTAMP,
            attempts = attempts + 1
        WHERE id = ? AND status = 'queued'
      `, [job.id]);
      if (!result || !result.changes) return null;
      return await this.getById(job.id);
    });
  },

  async markRunning(id) {
    await runAsyncWithoutSave("UPDATE transcription_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?", [id]);
    await saveDatabase();
  },

  async appendLog(id, text) {
    await appendJobLogEntry('transcription', id, text);
  },

  async markDone(id) {
    const result = await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'done',
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
        AND status != 'done'
    `, [id]);
    await saveDatabase();
    return !!(result && result.changes);
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
        AND status != 'done'
    `, [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async requeueForRetry(id) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0
      WHERE id = ?
    `, [id]);
    await saveDatabase();
  },

  async getById(id) {
    const row = await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.id = ?
    `, [id]);
    return await hydrateJobLog(row, 'transcription');
  },

  async getPendingForDocument(docId) {
    return await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.status IN ('queued', 'running')
        AND (
          j.document_id = ?
          OR EXISTS (
            SELECT 1
            FROM transcription_job_documents tjd
            WHERE tjd.job_id = j.id AND tjd.document_id = ?
          )
        )
      ORDER BY j.created_at DESC
      LIMIT 1
    `, [docId, docId]);
  },

  async getLatestForDocument(docId) {
    return await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.document_id = ?
         OR EXISTS (
           SELECT 1
           FROM transcription_job_documents tjd
           WHERE tjd.job_id = j.id AND tjd.document_id = ?
         )
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT 1
    `, [docId, docId]);
  },

  async findBatchBySubmissionJobId(submissionJobId) {
    return await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.job_kind = 'batch'
        AND j.batch_manifest LIKE ?
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT 1
    `, [`%"submissionJobId":${Number(submissionJobId)}%`]);
  },

  async getAll() {
    return await allAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ORDER BY j.created_at DESC
    `);
  },

  async getByDocumentIds(docIds) {
    if (!docIds || docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    return await allAsync(`
      SELECT DISTINCT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE j.document_id IN (${placeholders})
         OR tjd.document_id IN (${placeholders})
      ORDER BY j.created_at DESC
    `, [...docIds, ...docIds]);
  },

  async getCountByCollectionId(collectionId, statusFilter = 'all') {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const rows = await allAsync(`
      SELECT j.status, COUNT(DISTINCT j.id) AS count
      FROM transcription_jobs j
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE EXISTS (
        SELECT 1
        FROM document_collections dc
        WHERE dc.collection_id = ?
          AND (dc.document_id = j.document_id OR dc.document_id = tjd.document_id)
      )
      GROUP BY j.status
    `, [collectionId]);
    const counts = buildCountMap(rows);
    return normalizedStatus === 'all'
      ? counts.total
      : normalizedStatus === 'running'
        ? counts.running
        : counts[normalizedStatus] || 0;
  },

  async getCountsByCollectionId(collectionId) {
    const rows = await allAsync(`
      SELECT j.status, COUNT(DISTINCT j.id) AS count
      FROM transcription_jobs j
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE EXISTS (
        SELECT 1
        FROM document_collections dc
        WHERE dc.collection_id = ?
          AND (dc.document_id = j.document_id OR dc.document_id = tjd.document_id)
      )
      GROUP BY j.status
    `, [collectionId]);
    return buildCountMap(rows);
  },

  async getSummariesByCollectionId(collectionId, { statusFilter = 'all', limit = null } = {}) {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const params = [collectionId];
    let limitClause = '';
    if (Number.isInteger(limit) && limit > 0) {
      params.push(limit);
      limitClause = 'LIMIT ?';
    }

    const rows = await allAsync(`
      SELECT DISTINCT
        j.id,
        j.created_at,
        j.status,
        j.document_id,
        j.started_at,
        j.completed_at,
        j.error,
        j.provider,
        j.model,
        d.title AS document_title,
        j.job_kind,
        j.batch_display_name,
        j.batch_document_count,
        j.batch_page_count,
        j.batch_completed_count,
        j.batch_failed_count,
        j.batch_remote_status
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE EXISTS (
        SELECT 1
        FROM document_collections dc
        WHERE dc.collection_id = ?
          AND (dc.document_id = j.document_id OR dc.document_id = tjd.document_id)
      )
        ${normalizedStatus === 'all'
          ? ''
          : normalizedStatus === 'running'
            ? "AND j.status IN ('queued', 'running')"
            : 'AND j.status = ?'}
      ORDER BY j.created_at DESC
      ${limitClause}
    `, normalizedStatus === 'all'
      ? params
      : normalizedStatus === 'running'
        ? params
        : [collectionId, normalizedStatus, ...(limitClause ? [limit] : [])]);

    return rows.map((row) => normalizeJobSummary(row, 'transcription'));
  },

  async getActiveByCollectionId(collectionId) {
    return await this.getSummariesByCollectionId(collectionId, {
      statusFilter: 'running'
    });
  },

  async getByIdForCollection(id, collectionId) {
    const row = await getAsync(`
      SELECT j.*, d.title AS document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE j.id = ?
        AND EXISTS (
          SELECT 1
          FROM document_collections dc
          WHERE dc.collection_id = ?
            AND (dc.document_id = j.document_id OR dc.document_id = tjd.document_id)
        )
      LIMIT 1
    `, [id, collectionId]);
    return await hydrateJobLog(row, 'transcription');
  },

  async getActiveByDocumentIds(docIds) {
    if (!docIds || docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    return await allAsync(`
      SELECT DISTINCT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      LEFT JOIN transcription_job_documents tjd ON tjd.job_id = j.id
      WHERE (j.document_id IN (${placeholders}) OR tjd.document_id IN (${placeholders}))
        AND j.status IN ('queued','running')
      ORDER BY j.created_at DESC
    `, [...docIds, ...docIds]);
  },

  async getRunningBatches() {
    return await allAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.job_kind = 'batch' AND j.status = 'running'
      ORDER BY j.created_at ASC
    `);
  },

  async claimBatchFinalization(id, owner, staleSeconds = DEFAULT_BATCH_FINALIZATION_STALE_SECONDS) {
    const ttlSeconds = Number.isInteger(staleSeconds) && staleSeconds > 0
      ? staleSeconds
      : DEFAULT_BATCH_FINALIZATION_STALE_SECONDS;
    const claimed = await withExclusiveLock(async () => {
      const result = await runAsyncWithoutSave(`
        UPDATE transcription_jobs
        SET batch_finalization_claimed_at = CURRENT_TIMESTAMP,
            batch_finalization_claimed_by = ?
        WHERE id = ?
          AND status = 'running'
          AND job_kind = 'batch'
          AND (
            batch_finalization_claimed_at IS NULL
            OR batch_finalization_claimed_at < datetime('now', ?)
            OR batch_finalization_claimed_by = ?
          )
      `, [owner || null, id, `-${ttlSeconds} seconds`, owner || null]);
      if (!result || !result.changes) return false;
      return true;
    });
    if (claimed) {
      await saveDatabase();
    }
    return claimed;
  },

  async heartbeatBatchFinalizationClaim(id, owner) {
    const result = await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET batch_finalization_claimed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'running'
        AND job_kind = 'batch'
        AND batch_finalization_claimed_by = ?
    `, [id, owner || null]);
    if (result?.changes) {
      await saveDatabase();
      return true;
    }
    return false;
  },

  async releaseBatchFinalizationClaim(id, owner = null) {
    const params = [id];
    let ownerClause = '';
    if (owner != null) {
      ownerClause = ' AND batch_finalization_claimed_by = ?';
      params.push(owner);
    }
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?${ownerClause}
    `, params);
    await saveDatabase();
  },

  async updateBatchRemote(id, { remoteId, remoteStatus }) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET batch_remote_id = COALESCE(?, batch_remote_id),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [remoteId || null, remoteStatus || null, id]);
    await saveDatabase();
  },

  async updateBatchProgress(id, { completedCount, failedCount, remoteStatus }) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET batch_completed_count = COALESCE(?, batch_completed_count),
          batch_failed_count = COALESCE(?, batch_failed_count),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [
      Number.isInteger(completedCount) ? completedCount : null,
      Number.isInteger(failedCount) ? failedCount : null,
      remoteStatus || null,
      id
    ]);
    await saveDatabase();
  },

  async savePartialResults(id, results) {
    await runAsyncWithoutSave('UPDATE transcription_jobs SET partial_results = ? WHERE id = ?', [JSON.stringify(results), id]);
  },

  async getPartialResults(id) {
    const row = await getAsync('SELECT partial_results FROM transcription_jobs WHERE id = ?', [id]);
    if (!row || !row.partial_results) return [];
    try { return JSON.parse(row.partial_results); } catch { return []; }
  },

  async clearPartialResults(id) {
    await runAsyncWithoutSave('UPDATE transcription_jobs SET partial_results = NULL WHERE id = ?', [id]);
  },

  async retry(id) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0
      WHERE id = ? AND status = 'failed'
    `, [id]);
    await saveDatabase();
  },

  // Admin escape hatch: a batch job stuck in `running` (e.g. stranded on the
  // submission sentinel, or a wedged finalization) has no other exit — retry
  // and delete both gate on failed/done. Restricted to batch jobs: non-batch
  // running jobs are actively held by a worker cycle.
  // Per docs/reviews/2026-07-06-application-reliability-review.md R2.
  async forceFail(id, reason = 'Manually marked failed by admin') {
    const result = await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
        AND status = 'running'
        AND job_kind = 'batch'
    `, [reason, id]);
    await saveDatabase();
    return result;
  },

  async updateProvider(id, { provider, model }) {
    const result = await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET provider = ?,
          model = CASE WHEN ? IS NOT NULL THEN ? ELSE model END,
          provider_key_scope = 'system',
          user_api_key_id = NULL,
          status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0
      WHERE id = ? AND status = 'failed'
    `, [provider, model || null, model || null, id]);
    await saveDatabase();
    return result;
  },

  async delete(id) {
    return await runAsync("DELETE FROM transcription_jobs WHERE id = ?", [id]);
  }
};

const importJobs = {
  create({ original_name, file_path }) {
    const result = run(`
      INSERT INTO import_jobs (original_name, file_path, status)
      VALUES (?, ?, 'processing')
    `, [original_name || null, file_path || null]);
    return result.lastInsertRowid;
  },

  updateProgress(id, { page_count, pages_rendered }) {
    if (page_count != null) {
      runWithoutSave("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      runWithoutSave("UPDATE import_jobs SET pages_rendered = ?, last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?", [pages_rendered, id]);
    }
    // Don't call saveDatabase() on every progress tick — it's expensive for sql.js.
    // The in-memory DB is already updated; it'll be persisted on markDone/markFailed.
  },

  markDone(id, pages) {
    runWithoutSave("UPDATE import_jobs SET status = 'done', pages = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(pages), id]);
    saveDatabase();
  },

  markFailed(id, error) {
    runWithoutSave("UPDATE import_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error || 'Unknown error', id]);
    saveDatabase();
  },

  getById(id) {
    return get('SELECT * FROM import_jobs WHERE id = ?', [id]);
  },

  getAll() {
    return all('SELECT * FROM import_jobs ORDER BY created_at DESC');
  },

  getCounts() {
    const rows = all("SELECT status, COUNT(*) as count FROM import_jobs GROUP BY status");
    const counts = { processing: 0, done: 0, failed: 0, total: 0 };
    rows.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + r.count;
      counts.total += r.count;
    });
    return counts;
  },

  updateMachineId(id, machineId) {
    runWithoutSave("UPDATE import_jobs SET machine_id = ? WHERE id = ?", [machineId, id]);
  },

  markSubmitted(id) {
    runWithoutSave("UPDATE import_jobs SET submitted = 1 WHERE id = ?", [id]);
    saveDatabase();
  },

  updateGroupingState(id, groupingState) {
    runWithoutSave("UPDATE import_jobs SET grouping_state = ? WHERE id = ?", [
      groupingState ? JSON.stringify(groupingState) : null,
      id
    ]);
    saveDatabase();
  },

  delete(id) {
    return run("DELETE FROM import_jobs WHERE id = ?", [id]);
  }
};

const importJobsAsync = {
  async create({ original_name, file_path, user_id, job_kind = 'render', payload = null }) {
    const result = await runAsync(`
      INSERT INTO import_jobs (original_name, file_path, status, user_id, job_kind, submit_payload)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `, [original_name || null, file_path || null, user_id || null, job_kind, payload ? JSON.stringify(payload) : null]);
    return result.lastInsertRowid;
  },

  async createSubmissionJob({ original_name, user_id, total_count, payload }) {
    const result = await runAsync(`
      INSERT INTO import_jobs (
        original_name, status, user_id, submitted, job_kind,
        page_count, pages_rendered, submit_payload
      )
      VALUES (?, 'queued', ?, 1, 'submit', ?, 0, ?)
    `, [
      original_name || null,
      user_id || null,
      Number.isInteger(total_count) ? total_count : 0,
      payload ? JSON.stringify(payload) : null
    ]);
    return result.lastInsertRowid;
  },

  async updateProgress(id, { page_count, pages_rendered }) {
    if (page_count != null) {
      await runAsyncWithoutSave("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      await runAsyncWithoutSave("UPDATE import_jobs SET pages_rendered = ?, last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?", [pages_rendered, id]);
    }
  },

  async markDone(id, pages) {
    await runAsyncWithoutSave("UPDATE import_jobs SET status = 'done', pages = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [pages == null ? null : JSON.stringify(pages), id]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave("UPDATE import_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async getById(id) {
    return await getAsync('SELECT * FROM import_jobs WHERE id = ?', [id]);
  },

  async getAll() {
    return await allAsync('SELECT * FROM import_jobs ORDER BY created_at DESC');
  },

  async getByUserId(userId) {
    return await allAsync('SELECT * FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  async getSummaryByUserId(userId, { statusFilter = 'all', activeOnly = false } = {}) {
    const normalizedStatus = activeOnly ? 'running' : normalizeStatusFilter(statusFilter);
    const rows = await allAsync(`
      SELECT
        id,
        created_at,
        status,
        started_at,
        completed_at,
        error,
        COALESCE(job_kind, 'render') AS job_kind,
        original_name,
        page_count,
        pages_rendered,
        submitted,
        submit_payload,
        user_id
      FROM import_jobs
      WHERE user_id = ?
        ${normalizedStatus === 'all'
          ? ''
          : normalizedStatus === 'running'
            ? "AND status IN ('queued', 'processing', 'running')"
            : 'AND status = ?'}
      ORDER BY created_at DESC
    `, normalizedStatus === 'all'
      ? [userId]
      : normalizedStatus === 'running'
        ? [userId]
        : [userId, normalizedStatus]);
    return rows.map((row) => normalizeJobSummary(row, 'import'));
  },

  async getVisibleByUserAndCollection(userId, collectionId, { statusFilter = 'all', activeOnly = false } = {}) {
    const rows = await this.getSummaryByUserId(userId, { statusFilter, activeOnly });
    return rows
      .map((job) => decorateManageImportJob(job, collectionId))
      .filter(Boolean);
  },

  async getVisibleCountByUserAndCollection(userId, collectionId, statusFilter = 'all') {
    const rows = await this.getVisibleByUserAndCollection(userId, collectionId, { statusFilter });
    return rows.length;
  },

  async getVisibleCountsByUserAndCollection(userId, collectionId) {
    const rows = await this.getVisibleByUserAndCollection(userId, collectionId);
    return rows.reduce((counts, row) => {
      addStatusCount(counts, row.status, 1);
      return counts;
    }, createStatusCounts());
  },

  async claimNextQueuedSubmission() {
    const job = await withExclusiveLock(async () => {
      const j = await getAsync(`
        SELECT * FROM import_jobs
        WHERE status = 'queued' AND COALESCE(job_kind, 'render') = 'submit'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!j) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE import_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL
        WHERE id = ? AND status = 'queued'
      `, [j.id]);
      if (!result || !result.changes) return null;
      return j;
    });
    if (!job) return null;
    await saveDatabase();
    return await this.getById(job.id);
  },

  async claimNextQueuedRender() {
    const job = await withExclusiveLock(async () => {
      const j = await getAsync(`
        SELECT * FROM import_jobs
        WHERE status = 'queued' AND COALESCE(job_kind, 'render') = 'render'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!j) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE import_jobs
        SET status = 'processing',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL
        WHERE id = ? AND status = 'queued'
      `, [j.id]);
      if (!result || !result.changes) return null;
      return j;
    });
    if (!job) return null;
    await saveDatabase();
    return await this.getById(job.id);
  },

  async claimNextQueuedGrouping() {
    const job = await withExclusiveLock(async () => {
      const j = await getAsync(`
        SELECT * FROM import_jobs
        WHERE status = 'queued' AND COALESCE(job_kind, 'render') = 'grouping'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!j) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE import_jobs
        SET status = 'processing',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL
        WHERE id = ? AND status = 'queued'
      `, [j.id]);
      if (!result || !result.changes) return null;
      return j;
    });
    if (!job) return null;
    await saveDatabase();
    return await this.getById(job.id);
  },

  async markRunningBatch(id, { batch_remote_id, batch_remote_status, batch_manifest }) {
    await runAsyncWithoutSave(`
      UPDATE import_jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          batch_remote_id = ?,
          batch_remote_status = ?,
          batch_manifest = ?
      WHERE id = ?
    `, [batch_remote_id, batch_remote_status || 'submitted',
        batch_manifest ? JSON.stringify(batch_manifest) : null, id]);
    await saveDatabase();
  },

  async updateBatchStatus(id, remoteStatus) {
    await runAsyncWithoutSave(
      "UPDATE import_jobs SET batch_remote_status = ? WHERE id = ?",
      [remoteStatus, id]
    );
    // Don't persist on every poll — in-memory is updated, will persist on markDone/markFailed.
  },

  async getRunningGroupingBatches() {
    return await allAsync(`
      SELECT * FROM import_jobs
      WHERE status = 'processing'
        AND COALESCE(job_kind, 'render') = 'grouping'
        AND batch_remote_id IS NOT NULL
      ORDER BY created_at ASC
    `);
  },

  async updateMachineId(id, machineId) {
    await runAsyncWithoutSave("UPDATE import_jobs SET machine_id = ? WHERE id = ?", [machineId, id]);
  },

  async updateSubmissionState(id, payload, { processedCount } = {}) {
    await runAsyncWithoutSave(`
      UPDATE import_jobs
      SET submit_payload = ?,
          pages_rendered = COALESCE(?, pages_rendered)
      WHERE id = ?
    `, [
      payload ? JSON.stringify(payload) : null,
      Number.isInteger(processedCount) ? processedCount : null,
      id
    ]);
    await saveDatabase();
  },

  async markSubmitted(id) {
    await runAsyncWithoutSave("UPDATE import_jobs SET submitted = 1 WHERE id = ?", [id]);
    await saveDatabase();
  },

  async retry(id) {
    await runAsyncWithoutSave(`
      UPDATE import_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL
      WHERE id = ?
        AND status = 'failed'
        AND COALESCE(job_kind, 'render') = 'submit'
    `, [id]);
    await saveDatabase();
  },

  async updateGroupingState(id, groupingState) {
    await runAsyncWithoutSave("UPDATE import_jobs SET grouping_state = ? WHERE id = ?", [
      groupingState ? JSON.stringify(groupingState) : null,
      id
    ]);
    await saveDatabase();
  },

  async updatePayload(id, payload) {
    await runAsyncWithoutSave("UPDATE import_jobs SET submit_payload = ? WHERE id = ?", [
      payload ? JSON.stringify(payload) : null,
      id
    ]);
    await saveDatabase();
  },

  async delete(id) {
    return await runAsync("DELETE FROM import_jobs WHERE id = ?", [id]);
  },

  async updateHeartbeat(id) {
    await runAsyncWithoutSave(
      'UPDATE import_jobs SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    await saveDatabase();
  },

  async getTimedOutProcessingJobs(timeoutMinutes) {
    return await allAsync(`
      SELECT id
      FROM import_jobs
      WHERE status = 'processing'
        AND COALESCE(job_kind, 'render') = 'render'
        AND COALESCE(started_at, created_at) < datetime('now', ?)
    `, [`-${timeoutMinutes} minutes`]);
  },

  async requeueStaleJobs() {
    const thresholdMs = parseInt(process.env.WORKER_HEARTBEAT_TIMEOUT_MS, 10) || 300000;
    const thresholdSeconds = Math.floor(thresholdMs / 1000);
    const result = await runAsync(`
      UPDATE import_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          last_heartbeat_at = NULL,
          machine_id = NULL
      WHERE status = 'processing'
        AND machine_id IS NOT NULL
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < datetime('now', '-${thresholdSeconds} seconds')
    `);
    const count = result?.changes || 0;
    if (count > 0) {
      console.log(`[db] Requeued ${count} stale import job(s) with stale heartbeat`);
    }
    return count;
  }
};

const adminJobsAsync = {
  async getTranscriptionCounts(statusFilter = 'all') {
    const counts = buildCountMap(await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM transcription_jobs
      GROUP BY status
    `));
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    return normalizedStatus === 'all'
      ? counts
      : normalizedStatus === 'running'
        ? counts.running
        : counts[normalizedStatus] || 0;
  },

  async getImportCounts(statusFilter = 'all') {
    const counts = buildCountMap(await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM import_jobs
      GROUP BY status
    `));
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    return normalizedStatus === 'all'
      ? counts
      : normalizedStatus === 'running'
        ? counts.running
        : counts[normalizedStatus] || 0;
  },

  async getExtractionCounts(statusFilter = 'all') {
    const counts = buildCountMap(await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM extraction_jobs
      GROUP BY status
    `));
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    return normalizedStatus === 'all'
      ? counts
      : normalizedStatus === 'running'
        ? counts.running
        : counts[normalizedStatus] || 0;
  },

  async getSentimentCounts(statusFilter = 'all') {
    const counts = buildCountMap(await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM sentiment_extraction_jobs
      GROUP BY status
    `));
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    return normalizedStatus === 'all'
      ? counts
      : normalizedStatus === 'running'
        ? counts.running
        : counts[normalizedStatus] || 0;
  },

  async getAuthoritySuggestionCounts(statusFilter = 'all') {
    const counts = await authoritySuggestionJobs.getCounts();
    const normalized = String(statusFilter || 'all').toLowerCase();
    if (normalized === 'all') return counts;
    if (normalized === 'running') return counts.running;
    return counts[normalized] || 0;
  },

  async getAuthoritySuggestionSummaries(opts = {}) {
    return await authoritySuggestionJobs.getSummaries(opts);
  },

  async getTranscriptionSummaries({ statusFilter = 'all', limit = DEFAULT_PAGE_SIZE } = {}) {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const params = [];
    let statusClause = '';
    if (normalizedStatus === 'running') {
      statusClause = "WHERE j.status IN ('running', 'processing')";
    } else if (normalizedStatus !== 'all') {
      statusClause = 'WHERE j.status = ?';
      params.push(normalizedStatus);
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        j.id,
        j.created_at,
        j.status,
        j.document_id,
        j.started_at,
        j.completed_at,
        j.error,
        j.provider,
        j.model,
        d.title AS document_title,
        j.job_kind,
        j.batch_display_name,
        j.batch_document_count,
        j.batch_page_count,
        j.batch_completed_count,
        j.batch_failed_count,
        j.batch_remote_status
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ${statusClause}
      ORDER BY j.created_at DESC
      LIMIT ?
    `, params);
    return rows.map((row) => normalizeJobSummary(row, 'transcription'));
  },

  async getImportSummaries({ statusFilter = 'all', limit = DEFAULT_PAGE_SIZE } = {}) {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const params = [];
    let statusClause = '';
    if (normalizedStatus === 'running') {
      statusClause = "WHERE status IN ('processing', 'running')";
    } else if (normalizedStatus !== 'all') {
      statusClause = 'WHERE status = ?';
      params.push(normalizedStatus);
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        id,
        created_at,
        status,
        started_at,
        completed_at,
        error,
        COALESCE(job_kind, 'render') AS job_kind,
        original_name,
        page_count,
        pages_rendered,
        submitted
      FROM import_jobs
      ${statusClause}
      ORDER BY created_at DESC
      LIMIT ?
    `, params);
    return rows.map((row) => normalizeJobSummary(row, 'import'));
  },

  async getExtractionSummaries({ statusFilter = 'all', limit = DEFAULT_PAGE_SIZE } = {}) {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const params = [];
    let statusClause = '';
    if (normalizedStatus === 'running') {
      statusClause = "WHERE j.status IN ('running', 'processing')";
    } else if (normalizedStatus !== 'all') {
      statusClause = 'WHERE j.status = ?';
      params.push(normalizedStatus);
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        j.id,
        j.created_at,
        j.status,
        j.document_id,
        j.started_at,
        j.completed_at,
        j.error,
        j.provider,
        j.model,
        d.title AS document_title,
        j.job_kind,
        j.batch_display_name,
        j.batch_document_count,
        j.batch_completed_count,
        j.batch_failed_count,
        j.batch_remote_status,
        j.unresolved_relationship_count,
        j.unresolved_date_count,
        j.dropped_verbatim_mismatch_count,
        j.dropped_unknown_entity_mention_count
      FROM extraction_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ${statusClause}
      ORDER BY j.created_at DESC
      LIMIT ?
    `, params);
    return rows.map((row) => normalizeJobSummary(row, 'extraction'));
  },

  async getSentimentSummaries({ statusFilter = 'all', limit = DEFAULT_PAGE_SIZE } = {}) {
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    const params = [];
    let statusClause = '';
    if (normalizedStatus === 'running') {
      // Sentiment uses `batch_submitted` while a provider batch is in flight;
      // include it under the unified "running" filter alongside the legacy
      // `running` / `processing` states.
      statusClause = "WHERE j.status IN ('running', 'processing', 'batch_submitted')";
    } else if (normalizedStatus !== 'all') {
      statusClause = 'WHERE j.status = ?';
      params.push(normalizedStatus);
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        j.id,
        j.created_at,
        j.status,
        j.document_id,
        j.transcript_id,
        j.started_at,
        j.completed_at,
        j.error,
        j.provider,
        j.model_name AS model,
        j.kind AS job_kind,
        j.batch_remote_id,
        j.batch_submitted_at,
        j.input_tokens,
        j.output_tokens,
        d.title AS document_title
      FROM sentiment_extraction_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ${statusClause}
      ORDER BY j.created_at DESC
      LIMIT ?
    `, params);
    return rows.map((row) => normalizeJobSummary(row, 'sentiment'));
  },

  // Overall + per-type counts (no filter applied — used for tab badges)
  async getCounts(statusFilter = 'all', typeFilter = 'all') {
    const normalizedType = normalizeTypeFilter(typeFilter);
    const normalizedStatus = normalizeStatusFilter(statusFilter);

    const [transcriptionCounts, importCounts, extractionCounts, sentimentCounts, authoritySuggestionCounts] = await Promise.all([
      this.getTranscriptionCounts(),
      this.getImportCounts(),
      this.getExtractionCounts(),
      this.getSentimentCounts(),
      this.getAuthoritySuggestionCounts()
    ]);

    // Status tab counts: scoped to typeFilter (shows the breakdown for the selected type)
    let statusCounts;
    if (normalizedType === 'transcription') statusCounts = transcriptionCounts;
    else if (normalizedType === 'import') statusCounts = importCounts;
    else if (normalizedType === 'extraction') statusCounts = extractionCounts;
    else if (normalizedType === 'sentiment') statusCounts = sentimentCounts;
    else if (normalizedType === 'authority_suggestion') statusCounts = authoritySuggestionCounts;
    else statusCounts = mergeCountMaps(transcriptionCounts, importCounts, extractionCounts, sentimentCounts, authoritySuggestionCounts);

    // Type tab counts: scoped to statusFilter (shows how many of each type match the current status)
    const getCount = (countMap) => {
      if (normalizedStatus === 'all') return countMap.total;
      if (normalizedStatus === 'running') return countMap.running;
      return countMap[normalizedStatus] || 0;
    };

    return {
      counts: statusCounts,
      typeCounts: {
        import: getCount(importCounts),
        transcription: getCount(transcriptionCounts),
        extraction: getCount(extractionCounts),
        sentiment: getCount(sentimentCounts),
        authority_suggestion: getCount(authoritySuggestionCounts)
      }
    };
  },

  // Total count for the current filter combination (for page count)
  async getFilteredCount(statusFilter, typeFilter) {
    const normalizedType = normalizeTypeFilter(typeFilter);
    const normalizedStatus = normalizeStatusFilter(statusFilter);
    if (normalizedType === 'transcription') return await this.getTranscriptionCounts(normalizedStatus);
    if (normalizedType === 'import') return await this.getImportCounts(normalizedStatus);
    if (normalizedType === 'extraction') return await this.getExtractionCounts(normalizedStatus);
    if (normalizedType === 'sentiment') return await this.getSentimentCounts(normalizedStatus);
    if (normalizedType === 'authority_suggestion') return await this.getAuthoritySuggestionCounts(normalizedStatus);
    const [transcriptionCount, importCount, extractionCount, sentimentCount, authoritySuggestionCount] = await Promise.all([
      this.getTranscriptionCounts(normalizedStatus),
      this.getImportCounts(normalizedStatus),
      this.getExtractionCounts(normalizedStatus),
      this.getSentimentCounts(normalizedStatus),
      this.getAuthoritySuggestionCounts(normalizedStatus)
    ]);
    return transcriptionCount + importCount + extractionCount + sentimentCount + authoritySuggestionCount;
  },

  // Paginated combined job list
  async getPage(limit, offset, statusFilter, typeFilter) {
    const fetchLimit = Math.max(Number(limit || DEFAULT_PAGE_SIZE) + Number(offset || 0), DEFAULT_PAGE_SIZE);
    const normalizedType = normalizeTypeFilter(typeFilter);
    const normalizedStatus = normalizeStatusFilter(statusFilter);

    const jobsByType = await Promise.all([
      normalizedType === 'all' || normalizedType === 'transcription'
        ? this.getTranscriptionSummaries({ statusFilter: normalizedStatus, limit: fetchLimit })
        : [],
      normalizedType === 'all' || normalizedType === 'import'
        ? this.getImportSummaries({ statusFilter: normalizedStatus, limit: fetchLimit })
        : [],
      normalizedType === 'all' || normalizedType === 'extraction'
        ? this.getExtractionSummaries({ statusFilter: normalizedStatus, limit: fetchLimit })
        : [],
      normalizedType === 'all' || normalizedType === 'sentiment'
        ? this.getSentimentSummaries({ statusFilter: normalizedStatus, limit: fetchLimit })
        : [],
      normalizedType === 'all' || normalizedType === 'authority_suggestion'
        ? this.getAuthoritySuggestionSummaries({ statusFilter: normalizedStatus, limit: fetchLimit })
        : []
    ]);

    return jobsByType
      .flat()
      .sort(sortJobsByCreatedAtDesc)
      .slice(offset, offset + limit);
  },

  // Active jobs only (for AJAX polling — avoids historical scans)
  async getActive() {
    const [transcriptionJobs, importJobs, extractionJobs, sentimentJobs, authoritySuggestionJobsActive] = await Promise.all([
      this.getTranscriptionSummaries({ statusFilter: 'running', limit: 1000 }),
      this.getImportSummaries({ statusFilter: 'running', limit: 1000 }),
      this.getExtractionSummaries({ statusFilter: 'running', limit: 1000 }),
      this.getSentimentSummaries({ statusFilter: 'running', limit: 1000 }),
      this.getAuthoritySuggestionSummaries({ statusFilter: 'running', limit: 1000 })
    ]);
    return [...transcriptionJobs, ...importJobs, ...extractionJobs, ...sentimentJobs, ...authoritySuggestionJobsActive].sort(sortJobsByCreatedAtDesc);
  }
};

const extractionJobs = {
  // Spec § "Dashboard counts" (extraction quality aggregate). Sums the
  // drop/unresolved counters across every extraction_jobs row whose target
  // document is in the given collection, plus counts of failed/running
  // jobs. The drop-counter columns are introduced by migration v74
  // (dropped_verbatim_mismatch_count) and v76 (unresolved_relationship_count,
  // unresolved_date_count). NOTE for PR 3 dashboard handler: the spec said
  // "latest job per document" but at the dashboard level we want the
  // running total of LLM hygiene incidents the curator should be aware of,
  // so this implementation sums across all jobs. If "latest per document"
  // turns out to be the desired UX in PR 3, swap to a window-style query.
  async sumQualityCountersByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    const zero = {
      verbatim_mismatch: 0,
      unresolved_rel: 0,
      unresolved_date: 0,
      failed_jobs: 0,
      running_jobs: 0
    };
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return zero;
    const row = await getAsync(`
      SELECT
        COALESCE(SUM(j.dropped_verbatim_mismatch_count), 0) AS verbatim_mismatch,
        COALESCE(SUM(j.unresolved_relationship_count), 0) AS unresolved_rel,
        COALESCE(SUM(j.unresolved_date_count), 0) AS unresolved_date,
        SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
        SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running_jobs
      FROM extraction_jobs j
      WHERE j.document_id IN (
        SELECT document_id FROM document_collections WHERE collection_id = ?
      )
    `, [normalizedId]);
    return {
      verbatim_mismatch: Number(row?.verbatim_mismatch || 0),
      unresolved_rel: Number(row?.unresolved_rel || 0),
      unresolved_date: Number(row?.unresolved_date || 0),
      failed_jobs: Number(row?.failed_jobs || 0),
      running_jobs: Number(row?.running_jobs || 0)
    };
  },

  async create({
    transcript_id,
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id,
    reset_existing,
    job_kind,
    batch_display_name,
    batch_document_count,
    batch_manifest
  }) {
    const result = await runAsync(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, provider, model, temperature, initiated_by,
        provider_key_scope, user_api_key_id, requested_by_user_id,
        reset_existing, job_kind, batch_display_name, batch_document_count,
        batch_manifest, status, log
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      transcript_id,
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      provider_key_scope || null,
      user_api_key_id || null,
      requested_by_user_id || null,
      reset_existing ? 1 : 0,
      job_kind || 'single',
      batch_display_name || null,
      Number.isInteger(batch_document_count) ? batch_document_count : 1,
      batch_manifest ? JSON.stringify(batch_manifest) : null
    ]);
    return result.lastInsertRowid;
  },

  async createBatch({
    transcript_id,
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id,
    reset_existing,
    batch_display_name,
    batch_document_count,
    batch_manifest,
    documents
  }) {
    const jobId = await this.create({
      transcript_id,
      document_id,
      provider,
      model,
      temperature,
      initiated_by,
      provider_key_scope,
      user_api_key_id,
      requested_by_user_id,
      reset_existing,
      job_kind: 'batch',
      batch_display_name,
      batch_document_count,
      batch_manifest
    });

    const docs = documents || [];
    if (docs.length > 0) {
      const placeholders = docs.map(() => '(?, ?, ?)').join(', ');
      const values = docs.flatMap((item) => [jobId, item.document_id, item.transcript_id]);
      await runAsync(
        `INSERT OR IGNORE INTO extraction_job_documents (job_id, document_id, transcript_id) VALUES ${placeholders}`,
        values
      );
    }

    return jobId;
  },

  async claimNextQueued() {
    return await withExclusiveLock(async () => {
      const job = await getAsync(`
        SELECT * FROM extraction_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!job) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE extraction_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL,
            attempts = attempts + 1
        WHERE id = ? AND status = 'queued'
      `, [job.id]);
      if (!result || !result.changes) return null;
      return await this.getById(job.id);
    });
  },

  async getById(id) {
    const row = await getAsync(`
      SELECT j.*, d.title AS document_title
      FROM extraction_jobs j
      LEFT JOIN documents d ON d.id = j.document_id
      WHERE j.id = ?
    `, [id]);
    return await hydrateJobLog(row, 'extraction');
  },

  async savePartialResults(id, results) {
    await runAsyncWithoutSave('UPDATE extraction_jobs SET partial_results = ? WHERE id = ?', [JSON.stringify(results), id]);
    await saveDatabase();
  },

  async getPartialResults(id) {
    const row = await getAsync('SELECT partial_results FROM extraction_jobs WHERE id = ?', [id]);
    if (!row || !row.partial_results) return [];
    try {
      return JSON.parse(row.partial_results);
    } catch {
      return [];
    }
  },

  async appendLog(id, text) {
    await appendJobLogEntry('extraction', id, text);
  },

  async markDone(id, {
    entity_count,
    relationship_count,
    unresolved_relationship_count,
    unresolved_date_count,
    dropped_verbatim_mismatch_count,
    dropped_unknown_entity_mention_count
  } = {}) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'done',
          entity_count = COALESCE(?, entity_count),
          relationship_count = COALESCE(?, relationship_count),
          unresolved_relationship_count = COALESCE(?, unresolved_relationship_count),
          unresolved_date_count = COALESCE(?, unresolved_date_count),
          dropped_verbatim_mismatch_count = COALESCE(?, dropped_verbatim_mismatch_count),
          dropped_unknown_entity_mention_count = COALESCE(?, dropped_unknown_entity_mention_count),
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          partial_results = NULL
      WHERE id = ?
    `, [
      Number.isInteger(entity_count) ? entity_count : null,
      Number.isInteger(relationship_count) ? relationship_count : null,
      Number.isInteger(unresolved_relationship_count) ? unresolved_relationship_count : null,
      Number.isInteger(unresolved_date_count) ? unresolved_date_count : null,
      Number.isInteger(dropped_verbatim_mismatch_count) ? dropped_verbatim_mismatch_count : null,
      Number.isInteger(dropped_unknown_entity_mention_count) ? dropped_unknown_entity_mention_count : null,
      id
    ]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'failed',
          error = ?,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status != 'done'
    `, [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async requeueForRetry(id) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'queued',
          error = NULL,
          reset_existing = 1,
          started_at = NULL,
          completed_at = NULL,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          partial_results = NULL
      WHERE id = ?
    `, [id]);
    await saveDatabase();
  },

  async retry(id) {
    const result = await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          reset_existing = 1,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          partial_results = NULL
      WHERE id = ? AND status = 'failed'
    `, [id]);
    await saveDatabase();
    return result;
  },

  // Admin escape hatch: a batch job stuck in `running` (e.g. stranded on the
  // submission sentinel, or a wedged finalization) has no other exit — retry
  // and delete both gate on failed/done. Restricted to batch jobs: non-batch
  // running jobs are actively held by a worker cycle.
  // Per docs/reviews/2026-07-06-application-reliability-review.md R2.
  async forceFail(id, reason = 'Manually marked failed by admin') {
    const result = await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
        AND status = 'running'
        AND job_kind = 'batch'
    `, [reason, id]);
    await saveDatabase();
    return result;
  },

  async updateProvider(id, { provider, model }) {
    const result = await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET provider = ?,
          model = CASE WHEN ? IS NOT NULL THEN ? ELSE model END,
          provider_key_scope = 'system',
          user_api_key_id = NULL,
          status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          reset_existing = 1,
          batch_remote_id = NULL,
          batch_remote_status = NULL,
          batch_completed_count = 0,
          batch_failed_count = 0,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          partial_results = NULL
      WHERE id = ? AND status = 'failed'
    `, [provider, model || null, model || null, id]);
    await saveDatabase();
    return result;
  },

  async getAll() {
    return await allAsync(`
      SELECT j.*, d.title AS document_title
      FROM extraction_jobs j
      LEFT JOIN documents d ON d.id = j.document_id
      ORDER BY j.created_at DESC
    `);
  },

  async getStatusCounts() {
    const rows = await allAsync(`
      SELECT status, COUNT(*) AS n
      FROM extraction_jobs
      GROUP BY status
    `);
    const out = { total: 0, queued: 0, running: 0, done: 0, failed: 0 };
    for (const r of rows) {
      const n = Number(r.n) || 0;
      out.total += n;
      if (r.status in out) out[r.status] = n;
    }
    return out;
  },

  async getByDocumentId(documentId) {
    return await allAsync(`
      SELECT j.*, d.title AS document_title
      FROM extraction_jobs j
      LEFT JOIN documents d ON d.id = j.document_id
      WHERE j.document_id = ?
      ORDER BY j.created_at DESC
    `, [documentId]);
  },

  async getPendingForDocument(documentId) {
    return await getAsync(`
      SELECT * FROM extraction_jobs
      WHERE document_id = ?
        AND status IN ('queued', 'running')
      UNION
      SELECT j.*
      FROM extraction_jobs j
      INNER JOIN extraction_job_documents ejd ON ejd.job_id = j.id
      WHERE ejd.document_id = ?
        AND j.status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `, [documentId, documentId]);
  },

  async getRunningBatches() {
    return await allAsync(`
      SELECT j.*, d.title AS document_title
      FROM extraction_jobs j
      LEFT JOIN documents d ON d.id = j.document_id
      WHERE j.job_kind = 'batch' AND j.status = 'running'
      ORDER BY j.created_at ASC
    `);
  },

  async claimBatchFinalization(id, owner, staleSeconds = DEFAULT_BATCH_FINALIZATION_STALE_SECONDS) {
    const ttlSeconds = Number.isInteger(staleSeconds) && staleSeconds > 0
      ? staleSeconds
      : DEFAULT_BATCH_FINALIZATION_STALE_SECONDS;
    const claimed = await withExclusiveLock(async () => {
      const result = await runAsyncWithoutSave(`
        UPDATE extraction_jobs
        SET batch_finalization_claimed_at = CURRENT_TIMESTAMP,
            batch_finalization_claimed_by = ?
        WHERE id = ?
          AND status = 'running'
          AND job_kind = 'batch'
          AND (
            batch_finalization_claimed_at IS NULL
            OR batch_finalization_claimed_at < datetime('now', ?)
            OR batch_finalization_claimed_by = ?
          )
      `, [owner || null, id, `-${ttlSeconds} seconds`, owner || null]);
      if (!result || !result.changes) return false;
      return true;
    });
    if (claimed) {
      await saveDatabase();
    }
    return claimed;
  },

  async heartbeatBatchFinalizationClaim(id, owner) {
    const result = await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET batch_finalization_claimed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'running'
        AND job_kind = 'batch'
        AND batch_finalization_claimed_by = ?
    `, [id, owner || null]);
    if (result?.changes) {
      await saveDatabase();
      return true;
    }
    return false;
  },

  async updateBatchRemote(id, { remoteId, remoteStatus }) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET batch_remote_id = COALESCE(?, batch_remote_id),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [remoteId || null, remoteStatus || null, id]);
    await saveDatabase();
  },

  async updateBatchProgress(id, { completedCount, failedCount, remoteStatus }) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET batch_completed_count = COALESCE(?, batch_completed_count),
          batch_failed_count = COALESCE(?, batch_failed_count),
          batch_remote_status = COALESCE(?, batch_remote_status)
      WHERE id = ?
    `, [
      Number.isInteger(completedCount) ? completedCount : null,
      Number.isInteger(failedCount) ? failedCount : null,
      remoteStatus || null,
      id
    ]);
    await saveDatabase();
  },

  async getBatchDocuments(jobId) {
    return await allAsync(`
      SELECT * FROM extraction_job_documents
      WHERE job_id = ?
      ORDER BY document_id, transcript_id
    `, [jobId]);
  },

  async getPendingForTranscript(transcriptId) {
    return await getAsync(`
      SELECT * FROM extraction_jobs
      WHERE transcript_id = ?
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `, [transcriptId]);
  },

  async delete(id) {
    return await runAsync('DELETE FROM extraction_jobs WHERE id = ?', [id]);
  }
};

const authorityResolutionJobs = {
  async create({ entityIds = [], batchSize = 100, requestedByUserId = null }) {
    const normalizedIds = Array.from(new Set(
      (Array.isArray(entityIds) ? entityIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    ));
    const result = await runAsync(`
      INSERT INTO authority_resolution_jobs (
        entity_ids,
        batch_size,
        requested_by_user_id,
        status,
        log
      ) VALUES (?, ?, ?, 'queued', '')
    `, [
      normalizedIds.length ? JSON.stringify(normalizedIds) : null,
      Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 100,
      requestedByUserId || null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    const row = await getAsync(`
      SELECT * FROM authority_resolution_jobs
      WHERE id = ?
    `, [id]);
    return await hydrateJobLog(row, 'authority_resolution');
  },

  async getAll() {
    return await allAsync(`
      SELECT * FROM authority_resolution_jobs
      ORDER BY created_at DESC
    `);
  },

  async getCounts() {
    const rows = await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM authority_resolution_jobs
      GROUP BY status
    `);
    return rows.reduce((acc, row) => {
      acc.total += Number(row.count || 0);
      acc[row.status || 'unknown'] = Number(row.count || 0);
      return acc;
    }, { total: 0, queued: 0, running: 0, done: 0, failed: 0 });
  },

  async claimNextQueued() {
    return await withExclusiveLock(async () => {
      const job = await getAsync(`
        SELECT * FROM authority_resolution_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!job) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE authority_resolution_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL,
            attempts = attempts + 1
        WHERE id = ? AND status = 'queued'
      `, [job.id]);
      if (!result || !result.changes) return null;
      return await this.getById(job.id);
    });
  },

  async appendLog(id, text) {
    await appendJobLogEntry('authority_resolution', id, text);
  },

  async updateProgress(id, { processedCount, resolvedCount }) {
    await runAsyncWithoutSave(`
      UPDATE authority_resolution_jobs
      SET processed_count = COALESCE(?, processed_count),
          resolved_count = COALESCE(?, resolved_count)
      WHERE id = ?
    `, [
      Number.isInteger(processedCount) ? processedCount : null,
      Number.isInteger(resolvedCount) ? resolvedCount : null,
      id
    ]);
    await saveDatabase();
  },

  async markDone(id, { processedCount, resolvedCount } = {}) {
    await runAsyncWithoutSave(`
      UPDATE authority_resolution_jobs
      SET status = 'done',
          processed_count = COALESCE(?, processed_count),
          resolved_count = COALESCE(?, resolved_count),
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      Number.isInteger(processedCount) ? processedCount : null,
      Number.isInteger(resolvedCount) ? resolvedCount : null,
      id
    ]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave(`
      UPDATE authority_resolution_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async retry(id) {
    const result = await runAsyncWithoutSave(`
      UPDATE authority_resolution_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL
      WHERE id = ? AND status = 'failed'
    `, [id]);
    await saveDatabase();
    return result;
  },

  parseEntityIds(job) {
    if (!job || !job.entity_ids) return [];
    try {
      const parsed = JSON.parse(job.entity_ids);
      return Array.isArray(parsed)
        ? parsed.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : [];
    } catch {
      return [];
    }
  }
};


const authoritySuggestionJobs = {
  async create({ collection_id = null, fuzzy_threshold = 0.6, pending_threshold = 0.75, auto_approve_threshold = 0.92, requested_by_user_id = null } = {}) {
    const result = await runAsync(`
      INSERT INTO authority_suggestion_jobs
        (collection_id, fuzzy_threshold, pending_threshold, auto_approve_threshold, requested_by_user_id, status)
      VALUES (?, ?, ?, ?, ?, 'queued')
    `, [
      collection_id != null ? Number(collection_id) : null,
      fuzzy_threshold,
      pending_threshold,
      auto_approve_threshold,
      requested_by_user_id != null ? Number(requested_by_user_id) : null
    ]);
    await saveDatabase();
    return result.lastInsertRowid;
  },

  async getById(id) {
    const row = await getAsync('SELECT * FROM authority_suggestion_jobs WHERE id = ?', [id]);
    return await hydrateJobLog(row, 'authority_suggestion');
  },

  async hasPendingOrRunningForCollection(collection_id) {
    const row = await getAsync(`
      SELECT id FROM authority_suggestion_jobs
      WHERE collection_id IS ? AND status IN ('queued', 'running')
      LIMIT 1
    `, [collection_id != null ? Number(collection_id) : null]);
    return !!row;
  },

  async claimNextQueued() {
    return await withExclusiveLock(async () => {
      const job = await getAsync(`
        SELECT * FROM authority_suggestion_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!job) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE authority_suggestion_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL,
            attempts = attempts + 1
        WHERE id = ? AND status = 'queued'
      `, [job.id]);
      if (!result || !result.changes) return null;
      return await this.getById(job.id);
    });
  },

  async appendLog(id, text) {
    await appendJobLogEntry('authority_suggestion', id, text);
  },

  async markDone(id, { entityCount, candidateCount, suggestionCount, autoApprovedCount } = {}) {
    await runAsyncWithoutSave(`
      UPDATE authority_suggestion_jobs
      SET status = 'done',
          entity_count = COALESCE(?, entity_count),
          candidate_count = COALESCE(?, candidate_count),
          suggestion_count = COALESCE(?, suggestion_count),
          auto_approved_count = COALESCE(?, auto_approved_count),
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      Number.isInteger(entityCount) ? entityCount : null,
      Number.isInteger(candidateCount) ? candidateCount : null,
      Number.isInteger(suggestionCount) ? suggestionCount : null,
      Number.isInteger(autoApprovedCount) ? autoApprovedCount : null,
      id
    ]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave(`
      UPDATE authority_suggestion_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async getCounts() {
    const rows = await allAsync(`
      SELECT status, COUNT(*) AS count
      FROM authority_suggestion_jobs
      GROUP BY status
    `);
    return rows.reduce((acc, row) => {
      const n = Number(row.count || 0);
      acc.total += n;
      if (row.status === 'queued') acc.queued += n;
      else if (row.status === 'running' || row.status === 'processing') acc.running += n;
      else if (row.status === 'done') acc.done += n;
      else if (row.status === 'failed') acc.failed += n;
      return acc;
    }, { total: 0, queued: 0, running: 0, done: 0, failed: 0 });
  },

  async getSummaries({ statusFilter = 'all', limit = 50 } = {}) {
    const normalized = String(statusFilter || 'all').toLowerCase();
    const params = [];
    let statusClause = '';
    if (normalized === 'running') {
      statusClause = "WHERE j.status IN ('running', 'processing')";
    } else if (['queued', 'done', 'failed'].includes(normalized)) {
      statusClause = 'WHERE j.status = ?';
      params.push(normalized);
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        j.id,
        j.created_at,
        j.status,
        j.started_at,
        j.completed_at,
        j.error,
        j.collection_id,
        j.entity_count,
        j.candidate_count,
        j.suggestion_count,
        j.auto_approved_count,
        c.name AS collection_name,
        (
          SELECT MIN(als.confidence) FROM authority_link_suggestions als
          WHERE als.created_at >= COALESCE(j.started_at, j.created_at)
            AND als.created_at <= COALESCE(j.completed_at, datetime('now'))
        ) AS confidence_min,
        (
          SELECT MAX(als.confidence) FROM authority_link_suggestions als
          WHERE als.created_at >= COALESCE(j.started_at, j.created_at)
            AND als.created_at <= COALESCE(j.completed_at, datetime('now'))
        ) AS confidence_max,
        (
          SELECT COUNT(DISTINCT als.confidence) FROM authority_link_suggestions als
          WHERE als.created_at >= COALESCE(j.started_at, j.created_at)
            AND als.created_at <= COALESCE(j.completed_at, datetime('now'))
        ) AS confidence_distinct_count
      FROM authority_suggestion_jobs j
      LEFT JOIN collections c ON c.id = j.collection_id
      ${statusClause}
      ORDER BY j.created_at DESC
      LIMIT ?
    `, params);
    return rows.map((row) => ({
      ...row,
      job_type: 'authority_suggestion',
      subject_label: row.collection_id == null ? 'Full corpus' : (row.collection_name || `Collection #${row.collection_id}`)
    }));
  },

  async delete(id) {
    return await runAsync('DELETE FROM authority_suggestion_jobs WHERE id = ?', [id]);
  },

  async retry(id) {
    const failed = await getAsync(
      'SELECT * FROM authority_suggestion_jobs WHERE id = ?',
      [id]
    );
    if (!failed) {
      return { status: 'not_found' };
    }
    if (failed.status !== 'failed') {
      return { status: 'not_failed', existingStatus: failed.status };
    }

    // Idempotency: if another queued/running job already covers this scope,
    // surface it instead of creating a duplicate. Matches the
    // hasPendingOrRunningForCollection check used at
    // utils/worker-extraction.js:368, preserving "One Canonical Backend Path
    // per Workflow" (docs/development-principles.md).
    const existing = await getAsync(`
      SELECT id FROM authority_suggestion_jobs
      WHERE collection_id IS ?
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `, [failed.collection_id]);
    if (existing) {
      return { status: 'already_queued', existingJobId: existing.id };
    }

    const newJobId = await this.create({
      collection_id: failed.collection_id,
      fuzzy_threshold: failed.fuzzy_threshold,
      pending_threshold: failed.pending_threshold,
      auto_approve_threshold: failed.auto_approve_threshold,
      requested_by_user_id: failed.requested_by_user_id
    });
    return { status: 'queued', newJobId };
  }
};

  return {
    transcriptionJobs,
    transcriptionJobsAsync,
    importJobs,
    importJobsAsync,
    adminJobsAsync,
    extractionJobs,
    authorityResolutionJobs,
    authorityResolutionJobsAsync: authorityResolutionJobs,
    authoritySuggestionJobs
  };
};
