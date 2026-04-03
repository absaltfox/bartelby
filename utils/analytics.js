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

module.exports = {
  countUnknownWords,
  computeCollectionStats,
  computeStorageBytes
};
