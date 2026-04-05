'use strict';

// Standalone BERTopic worker — runs on ephemeral Fly Machine.
// Entry: node utils/bertopic-worker.js
// Env: BERTOPIC_WORKER_MODE=1, ANALYTICS_COLLECTION_ID=<id>

if (!process.env.BERTOPIC_WORKER_MODE) {
  console.error('[bertopic-worker] Not in BERTOPIC_WORKER_MODE — exiting');
  process.exit(1);
}

const collectionId = parseInt(process.env.ANALYTICS_COLLECTION_ID, 10);
if (!collectionId) {
  console.error('[bertopic-worker] ANALYTICS_COLLECTION_ID not set — exiting');
  process.exit(1);
}
const analyticsRowId = process.env.ANALYTICS_ROW_ID ? parseInt(process.env.ANALYTICS_ROW_ID, 10) : null;

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { resolvePythonBin } = require('./python-runtime');

async function main() {
  console.log(`[bertopic-worker] starting for collection ${collectionId}`);

  const db = require('../database/db');
  await db.initDatabase();

  const rawDb = db.getDb();

  const docs = await rawDb.all(`
    SELECT d.id, d.title, d.date_created, t.content
    FROM documents d
    JOIN document_collections dc ON dc.document_id = d.id
    JOIN transcripts t ON t.document_id = d.id AND t.is_best = 1
    WHERE dc.collection_id = ?
  `, [collectionId]);

  if (docs.length < 5) {
    console.log(`[bertopic-worker] only ${docs.length} transcribed docs — skipping`);
    process.exit(0);
  }

  const existingRows = await db.documentEmbeddingsAsync.getByCollection(collectionId);
  const existingEmbeddings = {};
  for (const row of existingRows) {
    existingEmbeddings[String(row.document_id)] = row.embedding;
  }

  const inputPath = path.join(os.tmpdir(), `bertopic_in_${collectionId}.json`);
  const outputPath = path.join(os.tmpdir(), `bertopic_out_${collectionId}.json`);

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
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`Python exited with code ${code}`));
      else resolve();
    });
  });

  const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  try { fs.unlinkSync(inputPath); } catch {}
  try { fs.unlinkSync(outputPath); } catch {}

  if (result.error || result.skipped) {
    console.log(`[bertopic-worker] skipped: ${result.reason || result.error}`);
    process.exit(0);
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

  if (result.topics?.length) {
    await db.collectionTopicsAsync.replaceForCollection(collectionId, result.topics);
  }
  if (result.assignments?.length) {
    await db.documentTopicAssignmentsAsync.replaceForCollection(collectionId, result.assignments);
  }
  await db.topicHierarchyAsync.replaceForCollection(collectionId, result.hierarchy || [], result.hierarchy_plot || null);
  if (result.evolution?.length) {
    await db.topicEvolutionAsync.replaceForCollection(collectionId, result.evolution);
  }

  // Mark latest analytics row as topics_computed = 1
  if (analyticsRowId) {
    await rawDb.run(`
      UPDATE collection_analytics SET topics_computed = 1
      WHERE id = ?
    `, [analyticsRowId]);
  } else {
    await rawDb.run(`
      UPDATE collection_analytics SET topics_computed = 1
      WHERE id = (
        SELECT id FROM collection_analytics
        WHERE collection_id = ?
        ORDER BY computed_at DESC LIMIT 1
      )
    `, [collectionId]);
  }

  await db.saveDatabase();
  console.log(`[bertopic-worker] done for collection ${collectionId}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[bertopic-worker] fatal:', err);
  process.exit(1);
});
