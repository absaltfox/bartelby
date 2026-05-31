'use strict';

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '');
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
             extracted_by, extraction_job_id, extracted_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            a.extracted_by || null, jobId, a.extracted_at || new Date().toISOString()
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

    async listPendingAnnotations({ limit = 25, beforeCreatedAt = null, beforeId = null } = {}) {
      const params = [];
      let cursorClause = '';
      if (beforeCreatedAt && beforeId) {
        cursorClause = `AND (extracted_at < ? OR (extracted_at = ? AND id < ?))`;
        params.push(beforeCreatedAt, beforeCreatedAt, beforeId);
      }
      params.push(Math.min(Math.max(1, limit), 100));
      return allAsync(
        `SELECT * FROM sentiment_annotations
          WHERE approval_status = 'pending' ${cursorClause}
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
    }
  };

  return { sentimentAsync, normalizePhrase };
};
