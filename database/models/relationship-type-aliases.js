'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase) => {
  const relationshipTypeAliases = {
    /**
     * Return the canonical_type for a given alias_type, or null if the input
     * is not an alias. Canonical pass-through is intentionally NOT done here —
     * callers should consult relationship_types separately for canonical names.
     * Per final-review finding on bundle commit 3db6fd1: doing canonical
     * pass-through here gave false negatives for canonicals not seeded as
     * aliases, silently degrading them to related_to.
     */
    async resolve(aliasType) {
      const normalized = String(aliasType || '').trim().toLowerCase();
      if (!normalized) return null;
      const row = await getAsync(
        'SELECT canonical_type FROM relationship_type_aliases WHERE alias_type = ?',
        [normalized]
      );
      return row ? row.canonical_type : null;
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
