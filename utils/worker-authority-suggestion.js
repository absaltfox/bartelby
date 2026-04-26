'use strict';

const { buildEntityText } = require('./entity-embedding');
const { buildCandidatePairs, cosineSimilarity } = require('./authority-suggestion-pipeline');

let isBusy = false;

function makeLogger(jobId, authoritySuggestionJobsAsync) {
  return async function logLine(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await authoritySuggestionJobsAsync.appendLog(jobId, line);
  };
}

/**
 * Build the embed function from @huggingface/transformers (v3+).
 * Returns async (texts: string[]) => number[][]
 */
async function makeEmbedFn() {
  const { pipeline } = require('@huggingface/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'q8'
  });
  return async function embed(texts) {
    const results = await embedder(texts, { pooling: 'mean', normalize: true });
    return results.map(r => Array.from(r.data));
  };
}

/**
 * Load all entities in scope, enriched with their aliases and first approved citation passage.
 * Scoped to a collection when collectionId is non-null; otherwise full corpus.
 */
async function loadEntitiesInScope(collectionId, db) {
  let rows;
  if (collectionId != null) {
    rows = await db.allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = c.document_id
      WHERE dc.collection_id = ?
    `, [collectionId]);
  } else {
    rows = await db.entitiesAsync.getAll(100000, 0);
  }

  const enriched = await Promise.all(rows.map(async (entity) => {
    const aliases = await db.entityAliasesAsync.getByEntityId(entity.id);
    const aliasTexts = aliases.map(a => a.alias).filter(Boolean);
    const firstCitation = await db.getAsync(`
      SELECT passage_text FROM citations
      WHERE entity_id = ? AND approval_status = 'approved'
      ORDER BY id ASC LIMIT 1
    `, [entity.id]);
    return {
      ...entity,
      aliases: aliasTexts,
      citationPassage: firstCitation ? firstCitation.passage_text : null
    };
  }));
  return enriched;
}

/**
 * Find or create an authority for a given entity type and canonical name.
 * Returns the authority id.
 */
async function ensureAuthority(entity, db) {
  const existing = await db.getAsync(
    'SELECT id FROM authorities WHERE authority_type = ? AND canonical_name = ?',
    [entity.entity_type, entity.canonical_name]
  );
  if (existing) return existing.id;
  return await db.authoritiesAsync.create({
    authority_type: entity.entity_type,
    canonical_name: entity.canonical_name,
    description: null,
    properties: {}
  });
}

async function runAuthoritySuggestionWorkerCycle() {
  if (isBusy) return;
  isBusy = true;

  try {
    const db = require('../database/db');
    const { authoritySuggestionJobsAsync, authorityLinkSuggestionsAsync } = db;

    const job = await authoritySuggestionJobsAsync.claimNextQueued();
    if (!job) return;

    const logLine = makeLogger(job.id, authoritySuggestionJobsAsync);
    await logLine(`Authority suggestion job #${job.id} started. Scope: ${job.collection_id != null ? `collection #${job.collection_id}` : 'full corpus'}.`);

    let entityCount = 0, candidateCount = 0, suggestionCount = 0, autoApprovedCount = 0;

    try {
      const entities = await loadEntitiesInScope(job.collection_id, db);
      entityCount = entities.length;
      await logLine(`Loaded ${entityCount} entities.`);

      const pairs = buildCandidatePairs(entities, job.fuzzy_threshold);
      candidateCount = pairs.length;
      await logLine(`Fuzzy pre-filter produced ${candidateCount} candidate pairs.`);

      if (candidateCount === 0) {
        await authoritySuggestionJobsAsync.markDone(job.id, { entityCount, candidateCount, suggestionCount, autoApprovedCount });
        return;
      }

      const embedFn = await makeEmbedFn();

      // Collect unique entities from all pairs and embed them
      const entityMap = new Map();
      for (const p of pairs) {
        if (!entityMap.has(p.entityA.id)) entityMap.set(p.entityA.id, p.entityA);
        if (!entityMap.has(p.entityB.id)) entityMap.set(p.entityB.id, p.entityB);
      }
      const uniqueEntities = [...entityMap.values()];
      const texts = uniqueEntities.map(e => buildEntityText(e, e.aliases || [], e.citationPassage || null));
      await logLine(`Embedding ${uniqueEntities.length} unique entities...`);

      const rawEmbeddings = await embedFn(texts);
      const embeddingById = new Map();
      for (let i = 0; i < uniqueEntities.length; i++) {
        embeddingById.set(uniqueEntities[i].id, rawEmbeddings[i]);
      }

      for (const pair of pairs) {
        const embA = embeddingById.get(pair.entityA.id);
        const embB = embeddingById.get(pair.entityB.id);
        const similarity = cosineSimilarity(embA, embB);

        if (similarity < job.pending_threshold) continue;

        const authorityId = await ensureAuthority(pair.entityA, db);

        if (similarity >= job.auto_approve_threshold) {
          // Auto-approve: assign authority directly to both entities
          await db.runAsync('UPDATE entities SET authority_id = ? WHERE id = ?', [authorityId, pair.entityA.id]);
          await db.runAsync('UPDATE entities SET authority_id = ? WHERE id = ?', [authorityId, pair.entityB.id]);
          await db.saveDatabase();
          autoApprovedCount++;
          await logLine(`Auto-approved: entity #${pair.entityB.id} → authority #${authorityId} (similarity ${similarity.toFixed(3)})`);
        } else {
          // Pending suggestion
          await authorityLinkSuggestionsAsync.createIfMissing({
            entity_id: pair.entityB.id,
            suggested_authority_id: authorityId,
            confidence: similarity,
            match_method: 'embedding'
          });
          suggestionCount++;
        }
      }

      await logLine(`Done. Suggestions: ${suggestionCount} pending, ${autoApprovedCount} auto-approved.`);
      await authoritySuggestionJobsAsync.markDone(job.id, { entityCount, candidateCount, suggestionCount, autoApprovedCount });
    } catch (err) {
      await logLine(`ERROR: ${err.message}`);
      await authoritySuggestionJobsAsync.markFailed(job.id, err.message);
    }
  } finally {
    isBusy = false;
  }
}

module.exports = { runAuthoritySuggestionWorkerCycle };
module.exports.__testables = { makeEmbedFn };
