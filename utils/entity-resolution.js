'use strict';

const HISTORICAL_ABBREVIATIONS = new Map([
  ['wm', 'william'],
  ['wm.', 'william'],
  ['jno', 'john'],
  ['jno.', 'john'],
  ['chas', 'charles'],
  ['chas.', 'charles'],
  ['thos', 'thomas'],
  ['thos.', 'thomas'],
  ['jas', 'james'],
  ['jas.', 'james'],
  ['benj', 'benjamin'],
  ['benj.', 'benjamin'],
  ['saml', 'samuel'],
  ['saml.', 'samuel'],
  ['danl', 'daniel'],
  ['danl.', 'daniel'],
  ['nathl', 'nathaniel'],
  ['nathl.', 'nathaniel'],
  ['richd', 'richard'],
  ['richd.', 'richard'],
  ['edwd', 'edward'],
  ['edwd.', 'edward'],
  ['robt', 'robert'],
  ['robt.', 'robert'],
  ['geo', 'george'],
  ['geo.', 'george'],
  ['jos', 'joseph'],
  ['jos.', 'joseph'],
  ['eliz', 'elizabeth'],
  ['eliz.', 'elizabeth'],
  ['margt', 'margaret'],
  ['margt.', 'margaret'],
  ['cathne', 'catherine'],
  ['cathne.', 'catherine'],
]);

// Generational disambiguators (Jr/Sr/II/III/IV) are NOT honorifics —
// they distinguish distinct people in prosopography (e.g., father and son
// with the same name). Stripping them would silently merge those entities
// when the A3.1 exact-match gate (normalizeForMatching) fires. Per
// final-review on A2/A3 branch (commit dc36950) and the curator-as-expert
// principle in docs/development-principles.md.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'rev', 'hon', 'sir', 'lady',
  'capt', 'captain', 'col', 'colonel', 'gen', 'general', 'lt', 'lieutenant',
  'sgt', 'sergeant', 'pvt', 'private', 'maj', 'major', 'esq', 'esquire'
]);

function normalizeComparable(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeComparable(value).split(' ').filter(Boolean));
}

function similarityScore(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function stripHonorifics(tokens) {
  return tokens.filter(t => !HONORIFICS.has(t.replace(/\.$/, '')));
}

function expandAbbreviations(tokens) {
  return tokens.map(t => {
    const clean = t.replace(/\.$/, '');
    return HISTORICAL_ABBREVIATIONS.get(t) || HISTORICAL_ABBREVIATIONS.get(clean) || t;
  });
}

function normalizeForMatching(value) {
  const raw = normalizeComparable(value);
  const tokens = raw.split(' ').filter(Boolean);
  const stripped = stripHonorifics(tokens);
  const expanded = expandAbbreviations(stripped);
  return expanded.join(' ');
}

/**
 * Seed the mention→entityId lookup map with all normalization forms.
 * Tracks collisions: when the same normalized key is set with a different
 * entityId than already present, the key is added to `collidedKeys` and
 * the original entry is removed so that resolveMentionToEntity refuses
 * to route any lookup through that ambiguous key.
 *
 * Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md E3.1/E3.2.
 */
function seedMentionLookup({ mention, normalized, entityId, mentionToEntityId, collidedKeys }) {
  const baseMention = String(mention || '');
  const baseNormalized = String(normalized || mention || '');
  const keys = [
    baseMention.toLowerCase(),
    baseNormalized.toLowerCase(),
    normalizeComparable(baseMention),
    normalizeComparable(baseNormalized),
    normalizeForMatching(baseMention),
    normalizeForMatching(baseNormalized)
  ];
  for (const key of keys) {
    if (!key) continue;
    if (collidedKeys && collidedKeys.has(key)) {
      // Already known-collided; do not re-introduce a routing.
      continue;
    }
    const existing = mentionToEntityId.get(key);
    if (existing != null && existing !== entityId) {
      mentionToEntityId.delete(key);
      if (collidedKeys) collidedKeys.add(key);
      continue;
    }
    mentionToEntityId.set(key, entityId);
  }
}

/**
 * Resolve a mention string to an entityId by trying three normalization
 * passes against `mentionToEntityId`. Returns null on miss or when the
 * key is in `collidedKeys` (ambiguous — refuse to route arbitrarily).
 *
 * Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md E3.1.
 */
function resolveMentionToEntity(mention, mentionToEntityId, options = {}) {
  if (!mentionToEntityId || mentionToEntityId.size === 0) return null;
  const raw = String(mention || '').trim();
  if (!raw) return null;
  const collidedKeys = options.collidedKeys || null;

  const candidates = [
    raw.toLowerCase(),
    normalizeComparable(raw),
    normalizeForMatching(raw)
  ];
  for (const key of candidates) {
    if (!key) continue;
    if (collidedKeys && collidedKeys.has(key)) {
      // Ambiguous — refuse rather than routing arbitrarily. Caller logs.
      return null;
    }
    if (mentionToEntityId.has(key)) {
      return mentionToEntityId.get(key);
    }
  }
  return null;
}

/**
 * Synchronous, Map-scoped entity resolution.
 * Replaces the async DB-hitting resolveEntity for use inside an extraction run.
 * mentionToEntityId maps normalised name strings → entity IDs for entities
 * created in the current extraction run only.
 */
function resolveEntityInScope(mention, normalized, entityType, mentionToEntityId) {
  if (!mentionToEntityId || mentionToEntityId.size === 0) return null;

  const candidate = normalizeComparable(normalized || mention);
  if (!candidate) return null;

  // Exact normalised match
  if (mentionToEntityId.has(candidate)) {
    return { entityId: mentionToEntityId.get(candidate), matchType: 'scope_canonical' };
  }

  // Fuzzy: expand abbreviations + strip honorifics, then try again
  const expanded = normalizeForMatching(normalized || mention);
  if (expanded !== candidate && mentionToEntityId.has(expanded)) {
    return { entityId: mentionToEntityId.get(expanded), matchType: 'scope_fuzzy' };
  }

  return null;
}

async function resolveEntity(mention, normalized, entityType) {
  const { entities, entityAliases } = require('../database/db');
  const candidate = normalizeComparable(normalized || mention);
  if (!candidate) return null;

  const direct = await entities.search(candidate, 25);
  const typed = direct.filter((entity) => entity.entity_type === entityType);
  for (const entity of typed) {
    if (normalizeComparable(entity.canonical_name) === candidate) {
      return { entityId: entity.id, matchType: 'canonical' };
    }
  }

  const aliasMatches = await entityAliases.search(candidate, 25);
  for (const alias of aliasMatches) {
    if (alias.entity_type === entityType && normalizeComparable(alias.alias) === candidate) {
      return { entityId: alias.entity_id, matchType: 'alias' };
    }
  }

  // Fuzzy pass: expand abbreviations and strip honorifics, then compare
  const expandedCandidate = normalizeForMatching(normalized || mention);
  if (expandedCandidate !== candidate) {
    // Re-search with expanded form
    const expandedDirect = await entities.search(expandedCandidate, 25);
    const expandedTyped = expandedDirect.filter((entity) => entity.entity_type === entityType);
    for (const entity of expandedTyped) {
      if (normalizeForMatching(entity.canonical_name) === expandedCandidate) {
        return { entityId: entity.id, matchType: 'fuzzy_canonical' };
      }
    }

    const expandedAliases = await entityAliases.search(expandedCandidate, 25);
    for (const alias of expandedAliases) {
      if (alias.entity_type === entityType && normalizeForMatching(alias.alias) === expandedCandidate) {
        return { entityId: alias.entity_id, matchType: 'fuzzy_alias' };
      }
    }
  }

  // Token-set similarity pass for remaining near-matches
  for (const entity of typed) {
    const score = similarityScore(normalizeForMatching(entity.canonical_name), expandedCandidate);
    if (score >= 0.85) {
      return { entityId: entity.id, matchType: 'similarity' };
    }
  }

  return null;
}

async function suggestMerges(entityType, threshold = 0.8) {
  const { entities } = require('../database/db');
  const rows = await entities.getByType(entityType, 500, 0);
  const suggestions = [];

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const score = similarityScore(
        normalizeForMatching(rows[i].canonical_name),
        normalizeForMatching(rows[j].canonical_name)
      );
      if (score >= threshold) {
        suggestions.push({
          score,
          keep: rows[i],
          merge: rows[j]
        });
      }
    }
  }

  return suggestions.sort((a, b) => b.score - a.score);
}

async function mergeEntities(keepId, mergeId) {
  const { getDb, entities, entityAliases } = require('../database/db');
  const db = getDb();
  if (!db) throw new Error('Database is not initialized.');

  const keep = await entities.getById(keepId);
  const merge = await entities.getById(mergeId);
  if (!keep || !merge) {
    throw new Error('Entity not found.');
  }

  await db.run('BEGIN');
  try {
    if (
      Number.isInteger(keep.authority_id)
      && Number.isInteger(merge.authority_id)
      && keep.authority_id !== merge.authority_id
    ) {
      throw new Error('Cannot merge entities that belong to different authorities. Reassign one entity first.');
    }

    const aliases = await entityAliases.getByEntityId(mergeId);
    for (const alias of aliases) {
      await db.run(`
        INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source)
        VALUES (?, ?, ?)
      `, [keepId, alias.alias, alias.source || 'merged']);
    }

    await db.run(`
      INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source)
      VALUES (?, ?, 'merged')
    `, [keepId, merge.canonical_name]);

    if (!Number.isInteger(keep.authority_id) && Number.isInteger(merge.authority_id)) {
      await db.run('UPDATE entities SET authority_id = ? WHERE id = ?', [merge.authority_id, keepId]);
    }

    await db.run('UPDATE date_expressions SET entity_id = ? WHERE entity_id = ?', [keepId, mergeId]);
    await db.run('UPDATE citations SET entity_id = ? WHERE entity_id = ?', [keepId, mergeId]);
    await db.run('UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?', [keepId, mergeId]);
    await db.run('UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?', [keepId, mergeId]);
    await db.run('DELETE FROM entities WHERE id = ?', [mergeId]);

    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }

  const { saveDatabase } = require('../database/db');
  await saveDatabase();
}

module.exports = {
  normalizeComparable,
  similarityScore,
  normalizeForMatching,
  expandAbbreviations,
  stripHonorifics,
  resolveEntityInScope,
  resolveEntity,
  resolveMentionToEntity,
  seedMentionLookup,
  suggestMerges,
  mergeEntities
};
