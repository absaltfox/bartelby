'use strict';

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

  return null;
}

async function suggestMerges(entityType, threshold = 0.8) {
  const { entities } = require('../database/db');
  const rows = await entities.getByType(entityType, 500, 0);
  const suggestions = [];

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const score = similarityScore(rows[i].canonical_name, rows[j].canonical_name);
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

  await db.run('UPDATE date_expressions SET entity_id = ? WHERE entity_id = ?', [keepId, mergeId]);
  await db.run('UPDATE citations SET entity_id = ? WHERE entity_id = ?', [keepId, mergeId]);
  await db.run('UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?', [keepId, mergeId]);
  await db.run('UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?', [keepId, mergeId]);
  await db.run('DELETE FROM entities WHERE id = ?', [mergeId]);

  const { saveDatabase } = require('../database/db');
  await saveDatabase();
}

module.exports = {
  normalizeComparable,
  similarityScore,
  resolveEntity,
  suggestMerges,
  mergeEntities
};
