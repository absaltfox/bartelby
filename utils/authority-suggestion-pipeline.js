'use strict';

const { normalizeComparable, similarityScore, normalizeForMatching } = require('./entity-resolution');

const STOPWORDS = new Set(['the', 'of', 'and', 'in', 'at', 'to', 'a', 'an', 'de', 'van', 'von']);
const EXACT_NAME_AUTO_APPROVE_TYPES = new Set(['person', 'place']);

function normalizeGenericTerm(value) {
  return normalizeComparable(value);
}

function buildGenericTermMatcher(terms = []) {
  const globalTerms = new Set();
  const typedTerms = new Map();

  for (const row of terms || []) {
    const term = normalizeGenericTerm(row.normalized_term || row.term);
    if (!term) continue;
    const entityType = String(row.entity_type || '').trim();
    if (!entityType) {
      globalTerms.add(term);
      continue;
    }
    if (!typedTerms.has(entityType)) typedTerms.set(entityType, new Set());
    typedTerms.get(entityType).add(term);
  }

  return function isGenericAuthorityName(name, entityType = null) {
    const normalized = normalizeGenericTerm(name);
    if (!normalized) return false;
    if (globalTerms.has(normalized)) return true;
    const typed = typedTerms.get(String(entityType || '').trim());
    return !!typed && typed.has(normalized);
  };
}

function decideAuthorityLinkAction(pair, embeddingSimilarity, thresholds = {}, isGenericAuthorityName = () => false) {
  const entityA = pair?.entityA || {};
  const entityB = pair?.entityB || {};
  const entityType = String(entityB.entity_type || entityA.entity_type || '').trim();
  const exactNameMatch = normalizeComparable(entityA.canonical_name) === normalizeComparable(entityB.canonical_name);
  const pendingThreshold = Number(thresholds.pendingThreshold ?? thresholds.pending_threshold ?? 0.75);
  const autoApproveThreshold = Number(thresholds.autoApproveThreshold ?? thresholds.auto_approve_threshold ?? 0.92);
  const confidence = Number(embeddingSimilarity || 0);

  if (
    isGenericAuthorityName(entityA.canonical_name, entityA.entity_type)
    || isGenericAuthorityName(entityB.canonical_name, entityB.entity_type)
  ) {
    return { action: 'skip_generic', exactNameMatch };
  }

  if (confidence < pendingThreshold) {
    return { action: 'discard', exactNameMatch };
  }

  if (
    exactNameMatch
    && EXACT_NAME_AUTO_APPROVE_TYPES.has(entityType)
    && confidence >= pendingThreshold
  ) {
    return { action: 'auto_approve_exact', exactNameMatch };
  }

  if (confidence >= autoApproveThreshold) {
    return { action: 'auto_approve_embedding', exactNameMatch };
  }

  return { action: 'suggest', exactNameMatch };
}

/**
 * Build an inverted index: significant token → Set of indices into the entities array.
 * Only includes tokens that are not stopwords and are >= 2 chars.
 */
function buildTokenIndex(entities) {
  const index = new Map();
  for (let i = 0; i < entities.length; i++) {
    const normalized = normalizeComparable(entities[i].canonical_name);
    const tokens = normalized.split(' ').filter(t => t.length >= 2 && !STOPWORDS.has(t));
    for (const token of tokens) {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(i);
    }
  }
  return index;
}

/**
 * Find candidate entity pairs within the same entity_type using an inverted
 * token index, then filter by token-set similarity >= fuzzyThreshold.
 * Returns [{entityA, entityB, fuzzySimilarity}].
 */
function buildCandidatePairs(entities, fuzzyThreshold = 0.6) {
  // Group indices by entity_type — never compare across types
  const byType = new Map();
  for (let i = 0; i < entities.length; i++) {
    const type = entities[i].entity_type;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(i);
  }

  const pairs = [];
  const seen = new Set();

  for (const [, indices] of byType) {
    const subset = indices.map(i => entities[i]);
    const tokenIndex = buildTokenIndex(subset);

    for (let si = 0; si < subset.length; si++) {
      const entity = subset[si];
      const normalizedA = normalizeForMatching(entity.canonical_name);
      const tokens = normalizeComparable(entity.canonical_name)
        .split(' ')
        .filter(t => t.length >= 2 && !STOPWORDS.has(t));

      const candidates = new Set();
      for (const token of tokens) {
        if (tokenIndex.has(token)) {
          for (const sj of tokenIndex.get(token)) {
            if (sj !== si) candidates.add(sj);
          }
        }
      }

      for (const sj of candidates) {
        const lo = Math.min(si, sj);
        const hi = Math.max(si, sj);
        const pairKey = `${lo}:${hi}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const normalizedB = normalizeForMatching(subset[sj].canonical_name);
        const similarity = similarityScore(normalizedA, normalizedB);
        if (similarity >= fuzzyThreshold) {
          pairs.push({ entityA: subset[lo], entityB: subset[hi], fuzzySimilarity: similarity });
        }
      }
    }
  }

  return pairs;
}

/**
 * Cosine similarity between two numeric arrays.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Score candidate pairs using a provided embed function.
 * embedFn: async (texts: string[]) => number[][] — returns one embedding per input.
 * entityTextFn: (entity) => string — builds text representation for an entity.
 * Returns [{entityA, entityB, fuzzySimilarity, embeddingSimilarity}].
 */
async function scorePairs(pairs, embedFn, entityTextFn) {
  if (pairs.length === 0) return [];

  // Collect unique entities needed
  const entityMap = new Map();
  for (const p of pairs) {
    if (!entityMap.has(p.entityA.id)) entityMap.set(p.entityA.id, p.entityA);
    if (!entityMap.has(p.entityB.id)) entityMap.set(p.entityB.id, p.entityB);
  }
  const uniqueEntities = [...entityMap.values()];
  const texts = uniqueEntities.map(e => entityTextFn(e));

  const embeddings = await embedFn(texts);
  const embeddingById = new Map();
  for (let i = 0; i < uniqueEntities.length; i++) {
    embeddingById.set(uniqueEntities[i].id, embeddings[i]);
  }

  return pairs.map(pair => ({
    ...pair,
    embeddingSimilarity: cosineSimilarity(
      embeddingById.get(pair.entityA.id),
      embeddingById.get(pair.entityB.id)
    )
  }));
}

module.exports = {
  buildCandidatePairs,
  buildGenericTermMatcher,
  cosineSimilarity,
  decideAuthorityLinkAction,
  normalizeGenericTerm,
  scorePairs
};
