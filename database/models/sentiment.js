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

    async markBatchPending(jobIds, correlationId, { submitted_prompt = null } = {}) {
      if (!Array.isArray(jobIds) || jobIds.length === 0) return;
      // Per-job UPDATE because submitted_prompt differs per row
      for (const id of jobIds) {
        await runAsync(
          `UPDATE sentiment_extraction_jobs
              SET batch_remote_id = ?,
                  batch_submitted_at = CURRENT_TIMESTAMP,
                  submitted_prompt = ?
            WHERE id = ? AND status = 'running' AND kind = 'batch'`,
          [correlationId, submitted_prompt, id]
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

    async markDone(id, { input_tokens = null, output_tokens = null, validation_drops = null } = {}) {
      await runAsync(
        `UPDATE sentiment_extraction_jobs
            SET status = 'done', completed_at = CURRENT_TIMESTAMP,
                input_tokens = ?, output_tokens = ?, validation_drops = ?
          WHERE id = ?`,
        [input_tokens, output_tokens, validation_drops ? JSON.stringify(validation_drops) : null, id]
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

    async setPhraseEmbedding(id, { embedding, embedding_model }) {
      await runAsync(
        `UPDATE sentiment_emotion_phrases
            SET embedding = ?, embedding_model = ?
          WHERE id = ?`,
        [Buffer.from(new Float32Array(embedding).buffer), embedding_model, id]
      );
      await saveDatabase();
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
             approval_status, auto_approved, reviewed_at,
             extracted_by, extraction_job_id, extracted_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            a.transcript_id, a.document_id, a.span_start, a.span_end, a.evidence_excerpt,
            a.polarity, a.intensity, a.confidence, a.voice_role, a.target_kind,
            a.target_entity_id ?? null, a.target_phrase ?? null,
            a.expressed_by_entity_id ?? null, a.described_subject_entity_id ?? null,
            a.emotion_phrase_id ?? null, a.emotion_phrase_verbatim,
            a.plutchik_hint ? JSON.stringify(a.plutchik_hint) : null,
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
