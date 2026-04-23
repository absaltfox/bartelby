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
const DEFAULT_BATCH_FINALIZATION_STALE_SECONDS = 2 * 60 * 60;

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
    runWithoutSave("UPDATE transcription_jobs SET log = log || ? WHERE id = ?", [text, id]);
    saveDatabase();
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
    await runAsyncWithoutSave("UPDATE transcription_jobs SET log = log || ? WHERE id = ?", [text, id]);
    await saveDatabase();
  },

  async markDone(id) {
    await runAsyncWithoutSave(`
      UPDATE transcription_jobs
      SET status = 'done',
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE id = ?
    `, [id]);
    await saveDatabase();
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
    return await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.id = ?
    `, [id]);
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
      runWithoutSave("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      runWithoutSave("UPDATE import_jobs SET pages_rendered = ? WHERE id = ?", [pages_rendered, id]);
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
      await runAsyncWithoutSave("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      await runAsyncWithoutSave("UPDATE import_jobs SET pages_rendered = ? WHERE id = ?", [pages_rendered, id]);
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
  // Overall + per-type counts (no filter applied — used for tab badges)
  async getCounts() {
    const row = await getAsync(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status IN ('running','processing') THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN job_type = 'import' THEN 1 ELSE 0 END) AS import_count,
        SUM(CASE WHEN job_type = 'transcription' THEN 1 ELSE 0 END) AS transcription_count,
        SUM(CASE WHEN job_type = 'extraction' THEN 1 ELSE 0 END) AS extraction_count
      FROM (
        SELECT status, 'transcription' AS job_type FROM transcription_jobs
        UNION ALL
        SELECT status, 'import' AS job_type FROM import_jobs
        UNION ALL
        SELECT status, 'extraction' AS job_type FROM extraction_jobs
      )
    `);
    return {
      counts: {
        total: row.total || 0,
        queued: row.queued || 0,
        running: row.running || 0,
        done: row.done || 0,
        failed: row.failed || 0
      },
      typeCounts: {
        import: row.import_count || 0,
        transcription: row.transcription_count || 0,
        extraction: row.extraction_count || 0
      }
    };
  },

  // Total count for the current filter combination (for page count)
  async getFilteredCount(statusFilter, typeFilter) {
    const statusCond = statusFilter === 'all' ? '1=1'
      : statusFilter === 'running' ? "status IN ('running','processing')"
      : "status = '" + statusFilter.replace(/[^a-z]/g, '') + "'";
    const typeCond = typeFilter === 'all' ? '1=1'
      : "job_type = '" + (
        typeFilter === 'import'
          ? 'import'
          : typeFilter === 'extraction'
            ? 'extraction'
            : 'transcription'
      ) + "'";
    const row = await getAsync(`
      SELECT COUNT(*) AS n FROM (
        SELECT status, 'transcription' AS job_type FROM transcription_jobs
        UNION ALL
        SELECT status, 'import' AS job_type FROM import_jobs
        UNION ALL
        SELECT status, 'extraction' AS job_type FROM extraction_jobs
      ) WHERE ${statusCond} AND ${typeCond}
    `);
    return row ? (row.n || 0) : 0;
  },

  // Paginated combined job list
  async getPage(limit, offset, statusFilter, typeFilter) {
    const statusCond = statusFilter === 'all' ? '1=1'
      : statusFilter === 'running' ? "status IN ('running','processing')"
      : "status = '" + statusFilter.replace(/[^a-z]/g, '') + "'";
    const typeCond = typeFilter === 'all' ? '1=1'
      : "job_type = '" + (
        typeFilter === 'import'
          ? 'import'
          : typeFilter === 'extraction'
            ? 'extraction'
            : 'transcription'
      ) + "'";
    return await allAsync(`
      SELECT * FROM (
        SELECT j.id, j.created_at, j.status, 'transcription' AS job_type,
               j.document_id, j.started_at, j.completed_at, j.error, j.log,
               j.provider, j.model, d.title AS document_title,
               j.job_kind, j.batch_display_name, j.batch_document_count,
               j.batch_page_count, j.batch_completed_count, j.batch_failed_count,
               j.batch_remote_status,
               NULL AS original_name, NULL AS page_count, NULL AS pages_rendered, NULL AS submitted
        FROM transcription_jobs j
        LEFT JOIN documents d ON j.document_id = d.id
        UNION ALL
        SELECT id, created_at, status, 'import' AS job_type,
               NULL AS document_id, started_at, completed_at, error, NULL AS log,
               NULL AS provider, NULL AS model, NULL AS document_title,
               COALESCE(job_kind, 'render') AS job_kind, NULL AS batch_display_name, 1 AS batch_document_count,
               0 AS batch_page_count, 0 AS batch_completed_count, 0 AS batch_failed_count,
               NULL AS batch_remote_status,
               original_name, page_count, pages_rendered, submitted
        FROM import_jobs
        UNION ALL
        SELECT j.id, j.created_at, j.status, 'extraction' AS job_type,
               j.document_id, j.started_at, j.completed_at, j.error, j.log,
               j.provider, j.model, d.title AS document_title,
               j.job_kind, j.batch_display_name, j.batch_document_count,
               0 AS batch_page_count, j.batch_completed_count, j.batch_failed_count,
               j.batch_remote_status,
               NULL AS original_name, NULL AS page_count, NULL AS pages_rendered, NULL AS submitted
        FROM extraction_jobs j
        LEFT JOIN documents d ON j.document_id = d.id
      ) combined
      WHERE ${statusCond} AND ${typeCond}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
  },

  // Active jobs only (for AJAX polling — avoids full table scan)
  async getActive() {
    return await allAsync(`
      SELECT j.id, j.created_at, j.status, 'transcription' AS job_type,
             j.document_id, j.started_at, j.completed_at, j.error,
             j.provider, d.title AS document_title,
             j.job_kind, j.batch_display_name, j.batch_document_count,
             j.batch_page_count, j.batch_completed_count, j.batch_failed_count,
             j.batch_remote_status,
             NULL AS original_name, NULL AS page_count, NULL AS pages_rendered
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.status IN ('queued','running')
      UNION ALL
      SELECT id, created_at, status, 'import' AS job_type,
             NULL AS document_id, started_at, completed_at, error,
             NULL AS provider, NULL AS document_title,
             COALESCE(job_kind, 'render') AS job_kind, NULL AS batch_display_name, 1 AS batch_document_count,
             0 AS batch_page_count, 0 AS batch_completed_count, 0 AS batch_failed_count,
             NULL AS batch_remote_status,
             original_name, page_count, pages_rendered
      FROM import_jobs
      WHERE status IN ('processing','queued')
      UNION ALL
      SELECT j.id, j.created_at, j.status, 'extraction' AS job_type,
             j.document_id, j.started_at, j.completed_at, j.error,
             j.provider, d.title AS document_title,
             j.job_kind, j.batch_display_name, j.batch_document_count,
             0 AS batch_page_count, j.batch_completed_count, j.batch_failed_count,
             j.batch_remote_status,
             NULL AS original_name, NULL AS page_count, NULL AS pages_rendered
      FROM extraction_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.status IN ('queued','running')
      ORDER BY created_at DESC
    `);
  }
};

const extractionJobs = {
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

    for (const item of (documents || [])) {
      await runAsync(`
        INSERT OR IGNORE INTO extraction_job_documents (job_id, document_id, transcript_id)
        VALUES (?, ?, ?)
      `, [jobId, item.document_id, item.transcript_id]);
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
    return await getAsync(`
      SELECT j.*, d.title AS document_title
      FROM extraction_jobs j
      LEFT JOIN documents d ON d.id = j.document_id
      WHERE j.id = ?
    `, [id]);
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
    await runAsyncWithoutSave('UPDATE extraction_jobs SET log = log || ? WHERE id = ?', [text, id]);
    await saveDatabase();
  },

  async markDone(id, { entity_count, relationship_count } = {}) {
    await runAsyncWithoutSave(`
      UPDATE extraction_jobs
      SET status = 'done',
          entity_count = COALESCE(?, entity_count),
          relationship_count = COALESCE(?, relationship_count),
          completed_at = CURRENT_TIMESTAMP,
          batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL,
          partial_results = NULL
      WHERE id = ?
    `, [
      Number.isInteger(entity_count) ? entity_count : null,
      Number.isInteger(relationship_count) ? relationship_count : null,
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
    return await getAsync(`
      SELECT * FROM authority_resolution_jobs
      WHERE id = ?
    `, [id]);
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
    await runAsyncWithoutSave('UPDATE authority_resolution_jobs SET log = log || ? WHERE id = ?', [text, id]);
    await saveDatabase();
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
    return await getAsync('SELECT * FROM authority_suggestion_jobs WHERE id = ?', [id]);
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
    await runAsyncWithoutSave(
      'UPDATE authority_suggestion_jobs SET log = log || ? WHERE id = ?',
      [text, id]
    );
    await saveDatabase();
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
