'use strict';

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '');
}

function normalizePhraseSql(expr) {
  return `LOWER(RTRIM(TRIM(${expr}), '.,;:!?'))`;
}

module.exports = function buildSentimentModel(db, runAsync, getAsync, allAsync, saveDatabase) {
  const sentimentAsync = {
    async createJob({ document_id, transcript_id, reset_existing = 0, provider = null }) {
      const result = await runAsync(
        `INSERT INTO sentiment_extraction_jobs
           (document_id, transcript_id, reset_existing, provider, status, kind, created_at)
         VALUES (?, ?, ?, ?, 'queued', 'singleton', CURRENT_TIMESTAMP)`,
        [document_id, transcript_id, reset_existing ? 1 : 0, provider]
      );
      await saveDatabase();
      return result.lastInsertRowid;
    },

    async getJobById(id) {
      return getAsync(`SELECT * FROM sentiment_extraction_jobs WHERE id = ?`, [id]);
    },

    async hasQueuedOrRunningForTranscript(transcript_id) {
      const row = await getAsync(
        `SELECT 1 AS hit FROM sentiment_extraction_jobs
          WHERE transcript_id = ? AND status IN ('queued','running','batch_submitted')
          LIMIT 1`,
        [transcript_id]
      );
      return Boolean(row);
    },

    async claimNextQueued() {
      const row = await getAsync(
        `SELECT id FROM sentiment_extraction_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC
          LIMIT 1`
      );
      if (!row) return null;
      const updated = await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'running', kind = 'singleton', started_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'`,
        [row.id]
      );
      if (!updated.changes) return null;
      await saveDatabase();
      return getAsync(`SELECT * FROM sentiment_extraction_jobs WHERE id = ?`, [row.id]);
    },

    async claimUpToBatch(maxClaim) {
      const rows = await allAsync(
        `SELECT id FROM sentiment_extraction_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
        [Math.max(1, Math.min(maxClaim, 50))]
      );
      const claimed = [];
      for (const r of rows) {
        const u = await runAsync(
          `UPDATE sentiment_extraction_jobs
              SET status = 'running', kind = 'batch', started_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'queued'`,
          [r.id]
        );
        if (u.changes) {
          claimed.push(await getAsync(`SELECT * FROM sentiment_extraction_jobs WHERE id = ?`, [r.id]));
        }
      }
      if (claimed.length) await saveDatabase();
      return claimed;
    },

    async markBatchSubmitted(id, { batch_remote_id, provider }) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'batch_submitted',
                batch_remote_id = ?,
                provider = COALESCE(?, provider),
                batch_submitted_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [batch_remote_id, provider, id]
      );
      await saveDatabase();
    },

    async listBatchSubmittedByRemoteId(batch_remote_id) {
      return allAsync(
        `SELECT * FROM sentiment_extraction_jobs
          WHERE batch_remote_id = ? AND status = 'batch_submitted'`,
        [batch_remote_id]
      );
    },

    async claimBatchFinalization(batch_remote_id, claimedBy) {
      const r = await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET batch_finalization_claimed_at = CURRENT_TIMESTAMP,
                batch_finalization_claimed_by = ?
          WHERE batch_remote_id = ?
            AND status = 'batch_submitted'
            AND batch_finalization_claimed_at IS NULL`,
        [claimedBy, batch_remote_id]
      );
      await saveDatabase();
      return r.changes > 0;
    },

    async markBatchPending(jobIds, correlationId, { submitted_prompt = null, provider = null } = {}) {
      if (!Array.isArray(jobIds) || jobIds.length === 0) return;
      // Per-job UPDATE because submitted_prompt differs per row. provider is set
      // here so the reconciliation tick (Phase 1.6a) can route an orphaned
      // pending-* row to the right provider API after a crash. Without this the
      // orphan window has provider=NULL and reconciliation has no way to know
      // which list endpoint to call.
      for (const id of jobIds) {
        await runAsync(
          `UPDATE sentiment_extraction_jobs
              SET batch_remote_id = ?,
                  batch_submitted_at = CURRENT_TIMESTAMP,
                  submitted_prompt = ?,
                  provider = COALESCE(?, provider)
            WHERE id = ? AND status = 'running' AND kind = 'batch'`,
          [correlationId, submitted_prompt, provider, id]
        );
      }
      await saveDatabase();
    },

    async markBatchSubmittedByCorrelation(correlationId, {
      batch_remote_id, provider, model_name,
      prompt_template_hash = null, temperature = null, system_prompt = null
    }) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'batch_submitted',
                batch_remote_id = ?,
                provider = COALESCE(?, provider),
                model_name = ?,
                prompt_template_hash = ?,
                temperature = ?,
                system_prompt = ?
          WHERE batch_remote_id = ?`,
        [batch_remote_id, provider, model_name, prompt_template_hash, temperature, system_prompt, correlationId]
      );
      await saveDatabase();
    },

    async markBatchSubmissionFailed(correlationId, errorMessage) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'failed',
                error = ?,
                completed_at = CURRENT_TIMESTAMP,
                batch_remote_id = NULL
          WHERE batch_remote_id = ?`,
        [String(errorMessage || 'unknown error').slice(0, 2000), correlationId]
      );
      await saveDatabase();
    },

    async markDone(id, {
      input_tokens = null, output_tokens = null,
      validation_drops = null, extraction_notes = null
    } = {}) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'done', completed_at = CURRENT_TIMESTAMP,
                input_tokens = ?, output_tokens = ?,
                validation_drops = ?,
                extraction_notes = ?
          WHERE id = ?`,
        [
          input_tokens, output_tokens,
          validation_drops ? JSON.stringify(validation_drops) : null,
          extraction_notes,
          id
        ]
      );
      await saveDatabase();
    },

    async markFailed(id, errorMessage) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = ?
          WHERE id = ?`,
        [String(errorMessage || 'unknown error').slice(0, 2000), id]
      );
      await saveDatabase();
    },

    // Surface a single failed/done sentiment job back to the queue. Clears
    // batch correlation + per-job paradata so the worker rebuilds the request
    // cleanly. Mirrors transcriptionJobsAsync.retry / extractionJobsAsync.retry
    // so the admin /admin/jobs Retry button works across all job types.
    async retry(id) {
      const result = await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'queued',
                kind = 'singleton',
                batch_remote_id = NULL,
                batch_submitted_at = NULL,
                batch_finalization_claimed_at = NULL,
                batch_finalization_claimed_by = NULL,
                started_at = NULL,
                completed_at = NULL,
                error = NULL,
                validation_drops = NULL,
                input_tokens = NULL,
                output_tokens = NULL,
                submitted_prompt = NULL,
                model_name = NULL,
                prompt_template_hash = NULL,
                temperature = NULL,
                system_prompt = NULL,
                extraction_notes = NULL
          WHERE id = ? AND status IN ('failed', 'done')`,
        [id]
      );
      await saveDatabase();
      return result;
    },

    async delete(id) {
      await runAsync(
        `DELETE FROM sentiment_extraction_jobs WHERE id = ? AND status IN ('done', 'failed')`,
        [id]
      );
      await saveDatabase();
    },

    async upsertEmotionPhrase(verbatim) {
      const normalized = normalizePhrase(verbatim);
      if (!normalized) throw new Error('emotion phrase normalized to empty string');
      const existing = await getAsync(
        `SELECT * FROM sentiment_emotion_phrases WHERE phrase_text_normalized = ?`,
        [normalized]
      );
      if (existing) {
        await runAsync(
          `UPDATE sentiment_emotion_phrases
              SET usage_count = usage_count + 1, last_seen_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [existing.id]
        );
        await saveDatabase();
        return { ...existing, usage_count: existing.usage_count + 1 };
      }
      const result = await runAsync(
        `INSERT INTO sentiment_emotion_phrases (phrase_text_normalized, usage_count)
         VALUES (?, 1)`,
        [normalized]
      );
      await saveDatabase();
      return getAsync(`SELECT * FROM sentiment_emotion_phrases WHERE id = ?`, [result.lastInsertRowid]);
    },

    async bulkUpsertEmotionPhrases(verbatims) {
      if (!Array.isArray(verbatims) || verbatims.length === 0) return new Map();
      const uniqueNormalized = new Set();
      for (const v of verbatims) {
        const n = normalizePhrase(v);
        if (!n) throw new Error('emotion phrase normalized to empty string');
        uniqueNormalized.add(n);
      }
      const normalizedList = [...uniqueNormalized];
      const placeholders = normalizedList.map(() => '?').join(', ');

      // 1. Find existing rows
      const existing = await allAsync(
        `SELECT * FROM sentiment_emotion_phrases WHERE phrase_text_normalized IN (${placeholders})`,
        normalizedList
      );
      const existingByNormalized = new Map(existing.map((r) => [r.phrase_text_normalized, r]));

      // 2. Increment usage_count for existing (one UPDATE per row; SQLite has no
      //    multi-row UPDATE with different WHERE per row, but the IDs are known
      //    so the per-row UPDATEs are cheap).
      for (const row of existing) {
        await runAsync(
          `UPDATE sentiment_emotion_phrases
              SET usage_count = usage_count + 1, last_seen_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [row.id]
        );
      }

      // 3. Insert missing rows
      const missing = normalizedList.filter((n) => !existingByNormalized.has(n));
      for (const normalized of missing) {
        await runAsync(
          `INSERT INTO sentiment_emotion_phrases (phrase_text_normalized, usage_count)
           VALUES (?, 1)`,
          [normalized]
        );
      }

      // 4. Re-SELECT to return fresh rows including new IDs and post-increment counts
      const final = await allAsync(
        `SELECT * FROM sentiment_emotion_phrases WHERE phrase_text_normalized IN (${placeholders})`,
        normalizedList
      );
      await saveDatabase();
      return new Map(final.map((r) => [r.phrase_text_normalized, r]));
    },

    async setPhraseEmbedding(id, { embedding, embedding_model }) {
      await runAsync(
        `UPDATE sentiment_emotion_phrases
            SET embedding = ?, embedding_model = ?
          WHERE id = ?`,
        [Buffer.from(new Float32Array(embedding).buffer), embedding_model, id]
      );
      await saveDatabase();
    },

    async bulkSetPhraseEmbeddings(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      for (const { id, embedding, embedding_model } of rows) {
        await runAsync(
          `UPDATE sentiment_emotion_phrases
              SET embedding = ?, embedding_model = ?
            WHERE id = ?`,
          [Buffer.from(new Float32Array(embedding).buffer), embedding_model, id]
        );
      }
      await saveDatabase();
    },

    async createOrFetchLabel(name, { description = null, createdByUserId = null } = {}) {
      const normalized = normalizePhrase(name);
      if (!normalized) throw new Error('label name normalized to empty string');
      // INSERT OR IGNORE handles races; we SELECT afterward for the canonical row
      const insertResult = await runAsync(
        `INSERT OR IGNORE INTO sentiment_phrase_labels (name, description, created_by_user_id)
         VALUES (?, ?, ?)`,
        [normalized, description, createdByUserId]
      );
      const created = insertResult.changes > 0;
      const row = await getAsync(
        `SELECT * FROM sentiment_phrase_labels WHERE name = ?`,
        [normalized]
      );
      await saveDatabase();
      return { row, created };
    },

    async listLabels() {
      return allAsync(`
        SELECT l.id, l.name, l.description, l.created_by_user_id,
               l.created_at, l.updated_at,
               COALESCE(c.phrase_count, 0) AS phrase_count
          FROM sentiment_phrase_labels l
          LEFT JOIN (
            SELECT canonical_label_id, COUNT(*) AS phrase_count
              FROM sentiment_emotion_phrases
             WHERE canonical_label_id IS NOT NULL
             GROUP BY canonical_label_id
          ) c ON c.canonical_label_id = l.id
         ORDER BY phrase_count DESC, l.name ASC
      `);
    },

    async renameLabel(id, newName, { description } = {}) {
      const normalized = normalizePhrase(newName);
      if (!normalized) throw new Error('label name normalized to empty string');
      // Check for conflict
      const existing = await getAsync(
        `SELECT id FROM sentiment_phrase_labels WHERE name = ? AND id != ?`,
        [normalized, id]
      );
      if (existing) {
        return { conflict: true, existing_label_id: existing.id };
      }
      const fields = ['name = ?', 'updated_at = CURRENT_TIMESTAMP'];
      const args = [normalized];
      if (description !== undefined) {
        fields.push('description = ?');
        args.push(description);
      }
      args.push(id);
      await runAsync(
        `UPDATE sentiment_phrase_labels SET ${fields.join(', ')} WHERE id = ?`,
        args
      );
      const row = await getAsync(`SELECT * FROM sentiment_phrase_labels WHERE id = ?`, [id]);
      await saveDatabase();
      return { row };
    },

    async deleteLabel(id) {
      const before = await getAsync(
        `SELECT COUNT(*) AS count FROM sentiment_emotion_phrases WHERE canonical_label_id = ?`,
        [id]
      );
      await runAsync(`DELETE FROM sentiment_phrase_labels WHERE id = ?`, [id]);
      // ON DELETE SET NULL handles the phrase rows
      await saveDatabase();
      return { unlabeled_phrase_count: before?.count || 0 };
    },

    async applyLabelToPhrases(labelId, phraseIds) {
      if (!Array.isArray(phraseIds) || phraseIds.length === 0) {
        return { updated_count: 0 };
      }
      const placeholders = phraseIds.map(() => '?').join(', ');
      const result = await runAsync(
        `UPDATE sentiment_emotion_phrases
            SET canonical_label_id = ?
          WHERE id IN (${placeholders})`,
        [labelId, ...phraseIds]
      );
      await saveDatabase();
      return { updated_count: result.changes || 0 };
    },

    async clearLabelsFromPhrases(phraseIds) {
      if (!Array.isArray(phraseIds) || phraseIds.length === 0) {
        return { cleared_count: 0 };
      }
      const placeholders = phraseIds.map(() => '?').join(', ');
      const result = await runAsync(
        `UPDATE sentiment_emotion_phrases
            SET canonical_label_id = NULL
          WHERE id IN (${placeholders})
            AND canonical_label_id IS NOT NULL`,
        phraseIds
      );
      await saveDatabase();
      return { cleared_count: result.changes || 0 };
    },

    async mergeLabel(fromId, intoId) {
      await runAsync('BEGIN');
      try {
        const update = await runAsync(
          `UPDATE sentiment_emotion_phrases
              SET canonical_label_id = ?
            WHERE canonical_label_id = ?`,
          [intoId, fromId]
        );
        await runAsync(
          `DELETE FROM sentiment_phrase_labels WHERE id = ?`,
          [fromId]
        );
        await runAsync('COMMIT');
        await saveDatabase();
        return { merged_phrase_count: update.changes || 0 };
      } catch (err) {
        try { await runAsync('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    },

    async getClustersWithLabelState(runId) {
      const rows = await allAsync(`
        SELECT
          c.id AS cluster_id,
          c.cluster_index,
          c.size,
          COUNT(p.canonical_label_id) AS labeled_count,
          COUNT(DISTINCT p.canonical_label_id) AS distinct_label_count,
          MAX(l.id) AS sample_label_id,
          MAX(l.name) AS sample_label_name
          FROM sentiment_phrase_clusters c
          JOIN sentiment_phrase_cluster_members m ON m.cluster_id = c.id
          JOIN sentiment_emotion_phrases p ON p.id = m.phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
         WHERE c.run_id = ?
         GROUP BY c.id
         ORDER BY c.size DESC, c.cluster_index ASC
      `, [runId]);

      return rows.map((r) => {
        let label_state;
        if (r.labeled_count === 0) {
          label_state = 'unlabeled';
        } else if (r.distinct_label_count > 1) {
          label_state = 'mixed';
        } else if (r.labeled_count < r.size) {
          label_state = 'partial';
        } else {
          label_state = 'full';
        }
        return {
          ...r,
          label_state,
          dominant_label_id: r.distinct_label_count === 1 ? r.sample_label_id : null,
          dominant_label_name: r.distinct_label_count === 1 ? r.sample_label_name : null
        };
      });
    },

    async getClusterMembersWithLabels(clusterId) {
      const cluster = await getAsync(
        `SELECT id, cluster_index, size FROM sentiment_phrase_clusters WHERE id = ?`,
        [clusterId]
      );
      if (!cluster) return null;
      const members = await allAsync(`
        SELECT m.phrase_id, m.distance_to_centroid,
               p.phrase_text_normalized,
               p.canonical_label_id,
               l.name AS canonical_label_name
          FROM sentiment_phrase_cluster_members m
          JOIN sentiment_emotion_phrases p ON p.id = m.phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
         WHERE m.cluster_id = ?
         ORDER BY (m.distance_to_centroid IS NULL), m.distance_to_centroid ASC
      `, [clusterId]);
      return {
        cluster_id: cluster.id,
        cluster_index: cluster.cluster_index,
        size: cluster.size,
        members
      };
    },

    async getNoisePhrasesForRun(runId, { page = 1, pageSize = 50 } = {}) {
      const run = await getAsync(
        `SELECT noise_phrase_ids_json FROM sentiment_phrase_cluster_runs WHERE id = ?`,
        [runId]
      );
      if (!run || !run.noise_phrase_ids_json) {
        return { total_noise_count: 0, page, page_size: pageSize, total_pages: 0, phrases: [] };
      }
      const ids = JSON.parse(run.noise_phrase_ids_json);
      const totalCount = ids.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      const offset = (page - 1) * pageSize;
      const pageIds = ids.slice(offset, offset + pageSize);
      if (pageIds.length === 0) {
        return { total_noise_count: totalCount, page, page_size: pageSize, total_pages: totalPages, phrases: [] };
      }
      const placeholders = pageIds.map(() => '?').join(', ');
      const phrases = await allAsync(`
        SELECT p.id AS phrase_id, p.phrase_text_normalized,
               p.canonical_label_id, l.name AS canonical_label_name
          FROM sentiment_emotion_phrases p
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
         WHERE p.id IN (${placeholders})
         ORDER BY p.phrase_text_normalized ASC
      `, pageIds);
      return {
        total_noise_count: totalCount,
        page,
        page_size: pageSize,
        total_pages: totalPages,
        phrases
      };
    },

    async getClusterIdsContainingLabel(runId, labelId) {
      const rows = await allAsync(`
        SELECT DISTINCT m.cluster_id
          FROM sentiment_phrase_cluster_members m
          JOIN sentiment_emotion_phrases p ON p.id = m.phrase_id
          JOIN sentiment_phrase_clusters c ON c.id = m.cluster_id
         WHERE c.run_id = ?
           AND p.canonical_label_id = ?
      `, [runId, labelId]);
      return new Set(rows.map((r) => r.cluster_id));
    },

    async getPhrasesMissingEmbedding(limit = 100) {
      return allAsync(
        `SELECT id, phrase_text_normalized FROM sentiment_emotion_phrases
          WHERE embedding IS NULL
          ORDER BY id ASC
          LIMIT ?`,
        [limit]
      );
    },

    async writeAnnotationsForJob(jobId, annotations) {
      if (!Array.isArray(annotations) || annotations.length === 0) return 0;
      let written = 0;
      for (const a of annotations) {
        await runAsync(
          `INSERT INTO sentiment_annotations (
             transcript_id, document_id, span_start, span_end, evidence_excerpt,
             polarity, intensity, confidence, voice_role, target_kind,
             target_entity_id, target_phrase,
             expressed_by_entity_id, described_subject_entity_id,
             emotion_phrase_id, emotion_phrase_verbatim, plutchik_hint,
             notes,
             approval_status, auto_approved, reviewed_at,
             extracted_by, extraction_job_id, extracted_at,
             emotion_about_phrase_verbatim, emotion_about_earliest,
             emotion_about_latest, emotion_about_precision, emotion_about_qualifier
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            a.transcript_id, a.document_id, a.span_start, a.span_end, a.evidence_excerpt,
            a.polarity, a.intensity, a.confidence, a.voice_role, a.target_kind,
            a.target_entity_id ?? null, a.target_phrase ?? null,
            a.expressed_by_entity_id ?? null, a.described_subject_entity_id ?? null,
            a.emotion_phrase_id ?? null, a.emotion_phrase_verbatim,
            a.plutchik_hint ? JSON.stringify(a.plutchik_hint) : null,
            a.notes ?? null,
            a.approval_status || 'pending',
            a.auto_approved ? 1 : 0,
            a.auto_approved ? a.extracted_at : null,
            a.extracted_by || null, jobId, a.extracted_at || new Date().toISOString(),
            a.emotion_about_phrase_verbatim ?? null,
            a.emotion_about_earliest ?? null,
            a.emotion_about_latest ?? null,
            a.emotion_about_precision ?? null,
            a.emotion_about_qualifier ?? null
          ]
        );
        written++;
      }
      await saveDatabase();
      return written;
    },

    async getAnnotationsByJobId(jobId) {
      return allAsync(
        `SELECT * FROM sentiment_annotations WHERE extraction_job_id = ? ORDER BY id ASC`,
        [jobId]
      );
    },

    async getAnnotationIdsByTranscript(transcript_id) {
      const rows = await allAsync(
        `SELECT id FROM sentiment_annotations WHERE transcript_id = ?`,
        [transcript_id]
      );
      return rows.map((r) => r.id);
    },

    async deleteAnnotationsByIds(ids) {
      if (!ids || !ids.length) return 0;
      const placeholders = ids.map(() => '?').join(',');
      const r = await runAsync(
        `DELETE FROM sentiment_annotations WHERE id IN (${placeholders})`,
        ids
      );
      await saveDatabase();
      return r.changes;
    },

    async listPendingAnnotations({ limit = 25, beforeCreatedAt = null, beforeId = null, entityTypeFilter = null } = {}) {
      const params = [];
      let cursorClause = '';
      if (beforeCreatedAt && beforeId) {
        cursorClause = `AND (extracted_at < ? OR (extracted_at = ? AND id < ?))`;
        params.push(beforeCreatedAt, beforeCreatedAt, beforeId);
      }
      let entityTypeClause = '';
      if (entityTypeFilter) {
        entityTypeClause = `AND EXISTS (
          SELECT 1 FROM entities e
          WHERE e.id = sentiment_annotations.target_entity_id
            AND e.entity_type = ?
        )`;
        params.push(entityTypeFilter);
      }
      params.push(Math.min(Math.max(1, limit), 100));
      return allAsync(
        `SELECT * FROM sentiment_annotations
          WHERE approval_status = 'pending' ${cursorClause} ${entityTypeClause}
          ORDER BY extracted_at DESC, id DESC
          LIMIT ?`,
        params
      );
    },

    async setApprovalStatus(id, { approval_status, reviewed_by, review_note = null }) {
      const r = await runAsync(
        `UPDATE sentiment_annotations
            SET approval_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?
          WHERE id = ? AND approval_status = 'pending'`,
        [approval_status, reviewed_by, review_note, id]
      );
      await saveDatabase();
      return r.changes > 0;
    },

    async deleteAnnotationById(id) {
      const r = await runAsync(`DELETE FROM sentiment_annotations WHERE id = ?`, [id]);
      await saveDatabase();
      return r.changes > 0;
    },

    // S3: aggregate phrase-target annotations into per-phrase rollups for the
    // curator-facing /admin/knowledge/sentiment/phrase-targets surface.
    // includeSuppressed=false (default) filters out phrases the curator has
    // already added to sentiment_phrase_suppressions.
    async aggregatePhraseTargets({
      limit = 50,
      offset = 0,
      includeSuppressed = false,
      minFrequency = 1,
      q = '',
      collectionId = null,
      polarity = ''
    } = {}) {
      const suppressedJoin = includeSuppressed
        ? ''
        : 'LEFT JOIN sentiment_phrase_suppressions s ON s.target_phrase_normalized = ' + normalizePhraseSql('a.target_phrase');
      const suppressedFilter = includeSuppressed
        ? ''
        : 'AND s.id IS NULL';
      const filters = [];
      const params = [];
      const search = String(q || '').trim().toLowerCase();
      if (search) {
        filters.push('AND LOWER(a.target_phrase) LIKE ?');
        params.push(`%${search}%`);
      }
      if (collectionId) {
        filters.push('AND a.document_id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)');
        params.push(Number(collectionId));
      }
      if (['positive', 'negative', 'neutral', 'mixed'].includes(String(polarity))) {
        filters.push('AND a.polarity = ?');
        params.push(String(polarity));
      }

      const rows = await allAsync(`
        SELECT
          ${normalizePhraseSql('a.target_phrase')} AS phrase_normalized,
          MIN(a.target_phrase) AS phrase_display,
          COUNT(*) AS frequency,
          SUM(CASE WHEN a.polarity = 'positive' THEN 1 ELSE 0 END) AS positive,
          SUM(CASE WHEN a.polarity = 'negative' THEN 1 ELSE 0 END) AS negative,
          SUM(CASE WHEN a.polarity = 'neutral'  THEN 1 ELSE 0 END) AS neutral,
          SUM(CASE WHEN a.polarity = 'mixed'    THEN 1 ELSE 0 END) AS mixed
        FROM sentiment_annotations a
        ${suppressedJoin}
        WHERE a.target_kind = 'phrase'
          AND a.target_phrase IS NOT NULL
          AND TRIM(a.target_phrase) != ''
          ${suppressedFilter}
          ${filters.join('\n')}
        GROUP BY phrase_normalized
        HAVING frequency >= ?
        ORDER BY frequency DESC, phrase_normalized ASC
        LIMIT ? OFFSET ?
      `, [...params, Number(minFrequency) || 1, Number(limit) || 50, Number(offset) || 0]);

      if (!rows.length) return [];

      // Attach up to 3 sample annotations per phrase via a batched lookup.
      const placeholders = rows.map(() => '?').join(',');
      const samplesRaw = await allAsync(`
        SELECT a.id, a.document_id, a.transcript_id, a.evidence_excerpt, a.target_phrase, a.polarity, a.intensity
        FROM sentiment_annotations a
        ${suppressedJoin}
        WHERE a.target_kind = 'phrase'
          AND ${normalizePhraseSql('a.target_phrase')} IN (${placeholders})
          ${suppressedFilter}
          ${filters.join('\n')}
        ORDER BY a.id DESC
        LIMIT ${rows.length * 5}
      `, [...rows.map((r) => r.phrase_normalized), ...params]);

      const samplesByPhrase = {};
      samplesRaw.forEach((s) => {
        const key = normalizePhrase(s.target_phrase);
        if (!samplesByPhrase[key]) samplesByPhrase[key] = [];
        if (samplesByPhrase[key].length < 3) samplesByPhrase[key].push(s);
      });

      return rows.map((r) => ({
        phraseNormalized: r.phrase_normalized,
        phraseDisplay: r.phrase_display,
        frequency: Number(r.frequency),
        polarity: {
          positive: Number(r.positive),
          negative: Number(r.negative),
          neutral: Number(r.neutral),
          mixed: Number(r.mixed)
        },
        samples: samplesByPhrase[r.phrase_normalized] || []
      }));
    },

    async countPhraseTargets({ includeSuppressed = false, minFrequency = 1, q = '', collectionId = null, polarity = '' } = {}) {
      const suppressedJoin = includeSuppressed
        ? ''
        : 'LEFT JOIN sentiment_phrase_suppressions s ON s.target_phrase_normalized = ' + normalizePhraseSql('a.target_phrase');
      const suppressedFilter = includeSuppressed
        ? ''
        : 'AND s.id IS NULL';
      const filters = [];
      const params = [];
      const search = String(q || '').trim().toLowerCase();
      if (search) {
        filters.push('AND LOWER(a.target_phrase) LIKE ?');
        params.push(`%${search}%`);
      }
      if (collectionId) {
        filters.push('AND a.document_id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)');
        params.push(Number(collectionId));
      }
      if (['positive', 'negative', 'neutral', 'mixed'].includes(String(polarity))) {
        filters.push('AND a.polarity = ?');
        params.push(String(polarity));
      }
      const row = await getAsync(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT ${normalizePhraseSql('a.target_phrase')} AS phrase_normalized, COUNT(*) AS frequency
          FROM sentiment_annotations a
          ${suppressedJoin}
          WHERE a.target_kind = 'phrase'
            AND a.target_phrase IS NOT NULL
            AND TRIM(a.target_phrase) != ''
            ${suppressedFilter}
            ${filters.join('\n')}
          GROUP BY phrase_normalized
          HAVING frequency >= ?
        ) rollup
      `, [...params, Number(minFrequency) || 1]);
      return Number(row?.count || 0);
    },

    // ----------------------------------------------------------------------
    // Phase 4 research surfaces. Per docs/sentiment-design.md Phase 4 +
    // docs/development-principles.md "Respect Permissions by Default" +
    // "One Canonical Backend Path per Workflow".
    //
    // All helpers receive:
    //   filters       — normalized filter object from parseResearchFilters
    //   accessSql     — { conditions: string[], params: any[] } from
    //                   documentsAsync.buildAccessConditions(opts). Conditions
    //                   assume the documents table is aliased as `d`.
    // ----------------------------------------------------------------------

    async hasResearchAnnotations(filters, accessSql) {
      // EXISTS-probe used to short-circuit the panel load on entity / document
      // pages where the long tail has no sentiment. Cheaper than running the
      // GROUP BY just to return [] — SQLite stops at the first matching row.
      const { where, params } = buildResearchWhere(filters, accessSql);
      const row = await getAsync(
        `SELECT 1 AS hit
         ${RESEARCH_BASE_FROM}
         WHERE ${where}
         LIMIT 1`,
        params
      );
      return Boolean(row);
    },

    async listResearchAnnotations(filters, accessSql, { limit = 25, cursor = null } = {}) {
      const { where, params } = buildResearchWhere(filters, accessSql);
      const cap = Math.min(Math.max(1, Number(limit) || 25), 100);
      const cursorClause = cursor && cursor.extracted_at != null && cursor.id != null
        ? `AND (a.extracted_at < ? OR (a.extracted_at = ? AND a.id < ?))`
        : '';
      const cursorParams = cursorClause
        ? [cursor.extracted_at, cursor.extracted_at, cursor.id]
        : [];
      const rows = await allAsync(
        `${RESEARCH_BASE_SELECT}
          ${RESEARCH_BASE_FROM}
          WHERE ${where} ${cursorClause}
          ORDER BY a.extracted_at DESC, a.id DESC
          LIMIT ?`,
        [...params, ...cursorParams, cap + 1]
      );
      const hasMore = rows.length > cap;
      const slice = hasMore ? rows.slice(0, cap) : rows;
      const last = slice[slice.length - 1];
      const nextCursor = hasMore && last
        ? { extracted_at: last.extracted_at, id: last.id }
        : null;
      return { rows: slice.map(decorateResearchRow), nextCursor };
    },

    async summarizeByLabel(filters, accessSql) {
      const { where, params } = buildResearchWhere(filters, accessSql);
      const rows = await allAsync(
        `SELECT
            l.id AS label_id,
            l.name AS label_name,
            COUNT(*) AS annotation_count,
            COUNT(DISTINCT a.document_id) AS document_count,
            SUM(CASE WHEN a.polarity = 'positive' THEN 1 ELSE 0 END) AS positive_count,
            SUM(CASE WHEN a.polarity = 'negative' THEN 1 ELSE 0 END) AS negative_count,
            SUM(CASE WHEN a.polarity = 'neutral'  THEN 1 ELSE 0 END) AS neutral_count,
            SUM(CASE WHEN a.polarity = 'mixed'    THEN 1 ELSE 0 END) AS mixed_count
          FROM sentiment_annotations a
          JOIN documents d ON d.id = a.document_id
          LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
          WHERE ${where}
          GROUP BY l.id, l.name
          ORDER BY annotation_count DESC, l.name ASC`,
        params
      );
      return rows.map((r) => ({
        label_id: r.label_id,
        label_name: r.label_name || null,
        annotation_count: Number(r.annotation_count) || 0,
        document_count: Number(r.document_count) || 0,
        polarity_counts: {
          positive: Number(r.positive_count) || 0,
          negative: Number(r.negative_count) || 0,
          neutral:  Number(r.neutral_count)  || 0,
          mixed:    Number(r.mixed_count)    || 0
        }
      }));
    },

    async timelineByBucket(filters, accessSql, { bucket = 'decade' } = {}) {
      // Research date = COALESCE(emotion_about_earliest, documents.date_created).
      // extracted_at is never used — it would misrepresent a 19c letter as a 2026 event.
      // NULL research_date → explicit Undated bucket (returned as bucket_key = null).
      const substrLen = bucket === 'month' ? 7 : bucket === 'year' ? 4 : 3;
      const bucketExpr = bucket === 'decade'
        ? `SUBSTR(COALESCE(a.emotion_about_earliest, d.date_created), 1, 3) || '0'`
        : `SUBSTR(COALESCE(a.emotion_about_earliest, d.date_created), 1, ${substrLen})`;
      const { where, params } = buildResearchWhere(filters, accessSql);
      const rows = await allAsync(
        `SELECT
            CASE
              WHEN COALESCE(a.emotion_about_earliest, d.date_created) IS NULL OR
                   TRIM(COALESCE(a.emotion_about_earliest, d.date_created)) = ''
                THEN NULL
              ELSE ${bucketExpr}
            END AS bucket_key,
            l.id AS label_id,
            l.name AS label_name,
            COUNT(*) AS annotation_count
          FROM sentiment_annotations a
          JOIN documents d ON d.id = a.document_id
          LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
          WHERE ${where}
          GROUP BY bucket_key, l.id, l.name
          ORDER BY bucket_key IS NULL, bucket_key ASC, annotation_count DESC`,
        params
      );
      return rows.map((r) => ({
        bucket_key: r.bucket_key,
        is_undated: r.bucket_key == null,
        label_id: r.label_id,
        label_name: r.label_name || null,
        annotation_count: Number(r.annotation_count) || 0
      }));
    },

    async fingerprintByAuthor(filters, accessSql) {
      // documents.metadata.author is plain text — no authority FK exists today.
      // The result envelope marks this with caveat: 'text-grouped' so the UI
      // can surface "not authority-resolved" to the researcher.
      const { where, params } = buildResearchWhere(filters, accessSql);
      const rows = await allAsync(
        `SELECT
            TRIM(json_extract(d.metadata, '$.author')) AS author_text,
            l.id AS label_id,
            l.name AS label_name,
            COUNT(*) AS annotation_count,
            COUNT(DISTINCT a.document_id) AS document_count
          FROM sentiment_annotations a
          JOIN documents d ON d.id = a.document_id
          LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
          WHERE ${where}
            AND json_extract(d.metadata, '$.author') IS NOT NULL
            AND TRIM(json_extract(d.metadata, '$.author')) != ''
          GROUP BY author_text, l.id, l.name
          ORDER BY author_text ASC, annotation_count DESC`,
        params
      );
      return {
        caveat: 'text-grouped',
        rows: rows.map((r) => ({
          author_text: r.author_text,
          label_id: r.label_id,
          label_name: r.label_name || null,
          annotation_count: Number(r.annotation_count) || 0,
          document_count: Number(r.document_count) || 0
        }))
      };
    },

    async cooccurrenceWithEntity(entityId, filters, accessSql) {
      const eid = Number(entityId);
      if (!Number.isInteger(eid) || eid <= 0) {
        throw new ResearchFilterError('entity_id is required for cooccurrence');
      }
      const { where, params } = buildResearchWhere(filters, accessSql);
      // Co-occurrence: labels appearing in documents that ALSO contain an
      // annotation touching the selected entity (target/expressed/subject).
      const rows = await allAsync(
        `SELECT
            l.id AS label_id,
            l.name AS label_name,
            COUNT(*) AS annotation_count,
            COUNT(DISTINCT a.document_id) AS document_count
          FROM sentiment_annotations a
          JOIN documents d ON d.id = a.document_id
          LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
          WHERE ${where}
            AND a.document_id IN (
              SELECT DISTINCT a2.document_id
              FROM sentiment_annotations a2
              WHERE a2.approval_status = 'approved'
                AND (a2.target_entity_id = ?
                  OR a2.expressed_by_entity_id = ?
                  OR a2.described_subject_entity_id = ?)
            )
          GROUP BY l.id, l.name
          ORDER BY annotation_count DESC, l.name ASC`,
        [...params, eid, eid, eid]
      );
      return rows.map((r) => ({
        label_id: r.label_id,
        label_name: r.label_name || null,
        annotation_count: Number(r.annotation_count) || 0,
        document_count: Number(r.document_count) || 0
      }));
    },

    async networkSentimentEdges(filters, accessSql) {
      // Per voice-tag invariant in docs/sentiment-design.md §2: an edge only
      // makes sense when the annotation targets an entity AND there is a
      // second entity to point from (expressed_by for speaker voice,
      // described_subject for described_subject voice). Author-voice
      // annotations have no second entity by construction — they remain
      // entity-attached sentiment, never edges.
      const { where, params } = buildResearchWhere(filters, accessSql);
      const rows = await allAsync(
        `SELECT
            a.id,
            a.document_id,
            a.target_entity_id  AS target_id,
            COALESCE(a.expressed_by_entity_id, a.described_subject_entity_id) AS source_id,
            a.voice_role,
            a.polarity,
            a.intensity,
            l.id   AS label_id,
            l.name AS label_name
          FROM sentiment_annotations a
          JOIN documents d ON d.id = a.document_id
          LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
          LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
          WHERE ${where}
            AND a.target_kind = 'entity'
            AND a.target_entity_id IS NOT NULL
            AND (a.expressed_by_entity_id IS NOT NULL OR a.described_subject_entity_id IS NOT NULL)
          ORDER BY a.id ASC`,
        params
      );
      return rows.map((r) => ({
        annotation_id: r.id,
        document_id: r.document_id,
        source_entity_id: r.source_id,
        target_entity_id: r.target_id,
        voice_role: r.voice_role,
        polarity: r.polarity,
        intensity: r.intensity,
        label_id: r.label_id,
        label_name: r.label_name || null
      }));
    }
  };

  return { sentimentAsync, normalizePhrase, parseResearchFilters, parseTimelineBucket, ResearchFilterError };
};

// ============================================================================
// Phase 4 research filter parsing — exported via module.exports.
// Kept outside the buildSentimentModel closure because it's pure validation,
// has no DB dependency, and is independently unit-testable.
// ============================================================================

class ResearchFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResearchFilterError';
  }
}

const VOICE_ROLES   = new Set(['author', 'speaker', 'described_subject']);
const POLARITIES    = new Set(['positive', 'negative', 'neutral', 'mixed']);
const INTENSITIES   = new Set(['low', 'moderate', 'strong']);
const TARGET_KINDS  = new Set(['entity', 'phrase', 'theme']);
const STATUSES      = new Set(['approved', 'pending']);
const TIMELINE_BUCKETS = new Set(['decade', 'year', 'month']);

function asPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asEnum(value, allowed) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  return allowed.has(v) ? v : null;
}

function asIsoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  // Accept YYYY, YYYY-MM, or YYYY-MM-DD; reject anything else.
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return null;
  return s;
}

function parseResearchFilters(rawQuery, { isAdmin = false } = {}) {
  if (rawQuery == null) rawQuery = {};
  if (typeof rawQuery !== 'object') {
    throw new ResearchFilterError('filters must be an object');
  }
  // Plutchik is internal-only (docs/sentiment-design.md §1, non-negotiable).
  // Reject any attempt to filter on it from the research surface.
  if ('plutchik' in rawQuery || 'plutchik_hint' in rawQuery) {
    throw new ResearchFilterError('plutchik is internal-only and may not be filtered');
  }

  const requestedStatus = asEnum(rawQuery.status, STATUSES);
  let status = 'approved';
  if (requestedStatus === 'pending') {
    if (!isAdmin) throw new ResearchFilterError('status=pending requires admin');
    status = 'pending';
  }

  const filters = {
    status,
    collection_id: asPositiveInt(rawQuery.collection ?? rawQuery.collection_id),
    label_id: asPositiveInt(rawQuery.label ?? rawQuery.label_id),
    label_unset: rawQuery.label === 'unlabeled' || rawQuery.label_id === 'unlabeled',
    voice_role: asEnum(rawQuery.voice_role, VOICE_ROLES),
    polarity: asEnum(rawQuery.polarity, POLARITIES),
    intensity: asEnum(rawQuery.intensity, INTENSITIES),
    target_kind: asEnum(rawQuery.target_kind, TARGET_KINDS),
    entity_id: asPositiveInt(rawQuery.entity_id),
    authority_id: asPositiveInt(rawQuery.authority_id),
    document_id: asPositiveInt(rawQuery.document_id),
    author_text: rawQuery.author_text ? String(rawQuery.author_text).trim() || null : null,
    date_from: asIsoDate(rawQuery.date_from),
    date_to: asIsoDate(rawQuery.date_to),
    q: rawQuery.q ? String(rawQuery.q).trim() || null : null
  };

  return filters;
}

function parseTimelineBucket(value) {
  const b = asEnum(value, TIMELINE_BUCKETS);
  return b || 'decade';
}

const RESEARCH_BASE_SELECT = `
  SELECT
    a.id, a.transcript_id, a.document_id,
    a.span_start, a.span_end, a.evidence_excerpt,
    a.polarity, a.intensity, a.confidence,
    a.voice_role, a.target_kind,
    a.target_entity_id, a.target_phrase,
    a.expressed_by_entity_id, a.described_subject_entity_id,
    a.emotion_phrase_id, a.emotion_phrase_verbatim,
    a.notes, a.approval_status, a.extracted_at,
    a.emotion_about_phrase_verbatim, a.emotion_about_earliest,
    a.emotion_about_latest, a.emotion_about_precision, a.emotion_about_qualifier,
    COALESCE(a.emotion_about_earliest, d.date_created) AS research_date,
    d.title AS document_title,
    d.date_created AS document_date,
    json_extract(d.metadata, '$.author') AS document_author,
    p.canonical_label_id AS label_id,
    l.name AS label_name,
    te.canonical_name AS target_entity_name,
    ee.canonical_name AS expressed_by_entity_name,
    se.canonical_name AS described_subject_entity_name
`;

const RESEARCH_BASE_FROM = `
  FROM sentiment_annotations a
  JOIN documents d ON d.id = a.document_id
  LEFT JOIN sentiment_emotion_phrases p ON p.id = a.emotion_phrase_id
  LEFT JOIN sentiment_phrase_labels l ON l.id = p.canonical_label_id
  LEFT JOIN entities te ON te.id = a.target_entity_id
  LEFT JOIN entities ee ON ee.id = a.expressed_by_entity_id
  LEFT JOIN entities se ON se.id = a.described_subject_entity_id
`;

function buildResearchWhere(filters, accessSql) {
  const conditions = [];
  const params = [];

  conditions.push('a.approval_status = ?');
  params.push(filters.status || 'approved');

  if (accessSql && Array.isArray(accessSql.conditions) && accessSql.conditions.length) {
    conditions.push(...accessSql.conditions);
    params.push(...(accessSql.params || []));
  }

  if (filters.collection_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM document_collections dc
       WHERE dc.document_id = a.document_id AND dc.collection_id = ?
    )`);
    params.push(filters.collection_id);
  }
  if (filters.label_id) {
    conditions.push('p.canonical_label_id = ?');
    params.push(filters.label_id);
  } else if (filters.label_unset) {
    conditions.push('p.canonical_label_id IS NULL');
  }
  if (filters.voice_role) {
    conditions.push('a.voice_role = ?');
    params.push(filters.voice_role);
  }
  if (filters.polarity) {
    conditions.push('a.polarity = ?');
    params.push(filters.polarity);
  }
  if (filters.intensity) {
    conditions.push('a.intensity = ?');
    params.push(filters.intensity);
  }
  if (filters.target_kind) {
    conditions.push('a.target_kind = ?');
    params.push(filters.target_kind);
  }
  if (filters.entity_id) {
    conditions.push(`(a.target_entity_id = ?
                  OR a.expressed_by_entity_id = ?
                  OR a.described_subject_entity_id = ?)`);
    params.push(filters.entity_id, filters.entity_id, filters.entity_id);
  }
  if (filters.authority_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM entities e
       WHERE e.authority_id = ?
         AND (e.id = a.target_entity_id
           OR e.id = a.expressed_by_entity_id
           OR e.id = a.described_subject_entity_id)
    )`);
    params.push(filters.authority_id);
  }
  if (filters.document_id) {
    conditions.push('a.document_id = ?');
    params.push(filters.document_id);
  }
  if (filters.author_text) {
    conditions.push(`LOWER(TRIM(json_extract(d.metadata, '$.author'))) = LOWER(TRIM(?))`);
    params.push(filters.author_text);
  }
  if (filters.date_from) {
    conditions.push(`COALESCE(a.emotion_about_earliest, d.date_created) >= ?`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`COALESCE(a.emotion_about_earliest, d.date_created) <= ?`);
    params.push(filters.date_to);
  }
  if (filters.q) {
    conditions.push('LOWER(a.evidence_excerpt) LIKE ?');
    params.push(`%${filters.q.toLowerCase()}%`);
  }

  return { where: conditions.join(' AND '), params };
}

function decorateResearchRow(row) {
  return {
    ...row,
    is_undated: row.research_date == null || String(row.research_date).trim() === ''
  };
}

module.exports.parseResearchFilters = parseResearchFilters;
module.exports.parseTimelineBucket = parseTimelineBucket;
module.exports.ResearchFilterError = ResearchFilterError;
