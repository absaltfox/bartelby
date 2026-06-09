'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase) => {
  const relationshipTypeAliases = {
    async resolve(aliasType) {
      const normalized = String(aliasType || '').trim().toLowerCase();
      if (!normalized) return null;
      const row = await getAsync(
        'SELECT canonical_type FROM relationship_type_aliases WHERE alias_type = ?',
        [normalized]
      );
      if (row) return row.canonical_type;
      // Pass-through: when the alias_type IS a known canonical (i.e., is itself the
      // canonical_type of any alias row), return it as-is. Else null.
      const canonicalHit = await getAsync(
        'SELECT canonical_type FROM relationship_type_aliases WHERE canonical_type = ? LIMIT 1',
        [normalized]
      );
      return canonicalHit ? canonicalHit.canonical_type : null;
    },

    async list() {
      return await allAsync(`
        SELECT id, canonical_type, alias_type, notes, created_by_user_id, created_at
        FROM relationship_type_aliases
        ORDER BY canonical_type ASC, alias_type ASC
      `);
    },

    async add({ canonicalType, aliasType, notes, userId }) {
      const result = await runAsync(`
        INSERT INTO relationship_type_aliases (canonical_type, alias_type, notes, created_by_user_id)
        VALUES (?, ?, ?, ?)
      `, [String(canonicalType).trim().toLowerCase(), String(aliasType).trim().toLowerCase(), notes || null, userId || null]);
      await saveDatabase();
      return result.lastInsertRowid;
    },

    async delete(id) {
      const result = await runAsync('DELETE FROM relationship_type_aliases WHERE id = ?', [Number(id)]);
      await saveDatabase();
      return result;
    }
  };

  return relationshipTypeAliases;
};
