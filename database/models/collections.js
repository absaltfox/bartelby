'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
// Turso (libsql over HTTP) auto-commits every statement and does not support
// BEGIN EXCLUSIVE across separate HTTP calls.  On Turso we execute statements
// directly; on local SQLite we wrap in an exclusive transaction for atomicity.
async function withExclusiveLock(fn) {
  if (process.env.DATABASE_DRIVER === 'turso') {
    return await fn();
  }
  await runAsync('BEGIN EXCLUSIVE');
  try {
    const result = await fn();
    await runAsync('COMMIT');
    return result;
  } catch (err) {
    await runAsync('ROLLBACK').catch(() => {});
    throw err;
  }
}
function withExclusiveLockSync(fn) {
  if (process.env.DATABASE_DRIVER === 'turso') {
    return fn();
  }
  run('BEGIN EXCLUSIVE');
  try {
    const result = fn();
    run('COMMIT');
    return result;
  } catch (err) {
    try { run('ROLLBACK'); } catch (e) { void e; }
    throw err;
  }
}
const collections = {
  getAll() {
    return all(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count
      FROM collections c
      ORDER BY c.name
    `);
  },

  getAllWithThumbnails() {
    return all(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count,
             COALESCE(
               (SELECT d.image_path FROM documents d WHERE d.id = c.preview_document_id),
               (SELECT d.image_path FROM documents d
                INNER JOIN document_collections dc ON d.id = dc.document_id
                WHERE dc.collection_id = c.id
                ORDER BY d.created_at DESC LIMIT 1)
             ) as thumbnail
      FROM collections c
      ORDER BY c.name
    `);
  },

  getById(id) {
    return get('SELECT * FROM collections WHERE id = ?', [id]);
  },

  canAccess(collectionId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;

    if (!userId) {
      // Unauthenticated: world-public only
      const result = get(`SELECT id FROM collections WHERE id = ? AND is_world_public = 1`, [collectionId]);
      return !!result;
    }

    const result = get(`
      SELECT c.id
      FROM collections c
      LEFT JOIN user_collection_access uca
        ON c.id = uca.collection_id AND uca.user_id = ?
      WHERE c.id = ?
        AND (c.is_public = 1 OR c.is_world_public = 1 OR uca.user_id IS NOT NULL)
    `, [userId, collectionId]);

    return !!result;
  },

  create({ name, description, is_public, is_world_public, allow_export, createdBy }) {
    const result = run(
      'INSERT INTO collections (name, description, is_public, is_world_public, allow_export, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, allow_export ? 1 : 0, createdBy || null]
    );
    return result.lastInsertRowid;
  },

  update(id, { name, description, is_public, is_world_public }) {
    run('UPDATE collections SET name = ?, description = ?, is_public = ?, is_world_public = ? WHERE id = ?',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, id]);
  },

  setPreviewDocument(id, documentId) {
    if (documentId != null) {
      const belongsToCollection = get(`
        SELECT 1
        FROM document_collections
        WHERE collection_id = ? AND document_id = ?
      `, [id, documentId]);
      if (!belongsToCollection) {
        throw new Error('Preview document must belong to the collection');
      }
    }
    run('UPDATE collections SET preview_document_id = ? WHERE id = ?',
      [documentId || null, id]);
  },

  delete(id) {
    return run('DELETE FROM collections WHERE id = ?', [id]);
  }
};

const collectionsAsync = {
  async getAll() {
    return await allAsync(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count
      FROM collections c
      ORDER BY c.name
    `);
  },

  async getAllWithThumbnails() {
    return await allAsync(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count,
             COALESCE(
               (SELECT d.image_path FROM documents d WHERE d.id = c.preview_document_id),
               (SELECT d.image_path FROM documents d
                INNER JOIN document_collections dc ON d.id = dc.document_id
                WHERE dc.collection_id = c.id
                ORDER BY d.created_at DESC LIMIT 1)
             ) as thumbnail
      FROM collections c
      ORDER BY c.name
    `);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM collections WHERE id = ?', [id]);
  },

  async canAccess(collectionId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;

    if (!userId) {
      // Unauthenticated: world-public only
      const result = await getAsync(`SELECT id FROM collections WHERE id = ? AND is_world_public = 1`, [collectionId]);
      return !!result;
    }

    const result = await getAsync(`
      SELECT c.id
      FROM collections c
      LEFT JOIN user_collection_access uca
        ON c.id = uca.collection_id AND uca.user_id = ?
      WHERE c.id = ?
        AND (c.is_public = 1 OR c.is_world_public = 1 OR uca.user_id IS NOT NULL)
    `, [userId, collectionId]);

    return !!result;
  },

  async create({ name, description, is_public, is_world_public, allow_export, auto_group_pages, createdBy }) {
    const result = await runAsync(
      'INSERT INTO collections (name, description, is_public, is_world_public, allow_export, auto_group_pages, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, allow_export ? 1 : 0, auto_group_pages ? 1 : 0, createdBy || null]
    );
    return result.lastInsertRowid;
  },

  async update(id, { name, description, is_public, is_world_public }) {
    await runAsync('UPDATE collections SET name = ?, description = ?, is_public = ?, is_world_public = ? WHERE id = ?',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, id]);
  },

  async setPreviewDocument(id, documentId) {
    if (documentId != null) {
      const belongsToCollection = await getAsync(`
        SELECT 1
        FROM document_collections
        WHERE collection_id = ? AND document_id = ?
      `, [id, documentId]);
      if (!belongsToCollection) {
        throw new Error('Preview document must belong to the collection');
      }
    }
    await runAsync('UPDATE collections SET preview_document_id = ? WHERE id = ?',
      [documentId || null, id]);
  },

  async setAllowExport(id, allow) {
    await runAsync('UPDATE collections SET allow_export = ? WHERE id = ?', [allow ? 1 : 0, id]);
  },

  async setAutoGroupPages(id, enabled) {
    await runAsync('UPDATE collections SET auto_group_pages = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  async delete(id) {
    return await runAsync('DELETE FROM collections WHERE id = ?', [id]);
  }
};

const documentCollections = {
  getByDocumentId(documentId) {
    return all(`
      SELECT c.* FROM collections c
      INNER JOIN document_collections dc ON c.id = dc.collection_id
      WHERE dc.document_id = ?
      ORDER BY c.name
    `, [documentId]);
  },

  getByCollectionId(collectionId) {
    return all(`
      SELECT dc.document_id FROM document_collections dc
      WHERE dc.collection_id = ?
    `, [collectionId]);
  },

  setForDocument(documentId, collectionIds) {
    const ids = (collectionIds || []).map(Number).filter(Number.isInteger);
    withExclusiveLockSync(() => {
      run('DELETE FROM document_collections WHERE document_id = ?', [documentId]);
      for (const cid of ids) {
        run('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, cid]);
      }
    });
  }
};

const documentCollectionsAsync = {
  async getByDocumentId(documentId) {
    return await allAsync(`
      SELECT c.* FROM collections c
      INNER JOIN document_collections dc ON c.id = dc.collection_id
      WHERE dc.document_id = ?
      ORDER BY c.name
    `, [documentId]);
  },

  async getByCollectionId(collectionId) {
    return await allAsync(`
      SELECT dc.document_id FROM document_collections dc
      WHERE dc.collection_id = ?
    `, [collectionId]);
  },

  async countByCollectionId(collectionId) {
    const row = await getAsync(`
      SELECT COUNT(*) AS count
      FROM document_collections
      WHERE collection_id = ?
    `, [collectionId]);
    return row ? Number(row.count || 0) : 0;
  },

  async hasDocumentInCollection(collectionId, documentId) {
    const row = await getAsync(`
      SELECT 1
      FROM document_collections
      WHERE collection_id = ? AND document_id = ?
      LIMIT 1
    `, [collectionId, documentId]);
    return !!row;
  },

  async getCollectionsForDocumentIds(documentIds) {
    const ids = [...new Set((documentIds || []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return await allAsync(`
      SELECT
        dc.document_id,
        c.*
      FROM document_collections dc
      INNER JOIN collections c ON c.id = dc.collection_id
      WHERE dc.document_id IN (${placeholders})
      ORDER BY dc.document_id, c.name
    `, ids);
  },

  async setForDocument(documentId, collectionIds) {
    const ids = (collectionIds || []).map(Number).filter(Number.isInteger);
    await withExclusiveLock(async () => {
      await runAsync('DELETE FROM document_collections WHERE document_id = ?', [documentId]);
      for (const cid of ids) {
        await runAsync('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, cid]);
      }
    });
    await saveDatabase();
  },

  async add(documentId, collectionId) {
    await runAsync('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, collectionId]);
  },

  async remove(documentId, collectionId) {
    await runAsync('DELETE FROM document_collections WHERE document_id = ? AND collection_id = ?', [documentId, collectionId]);
  }
};

const userCollectionAccess = {
  getByUserId(userId) {
    return all(`
      SELECT c.* FROM collections c
      INNER JOIN user_collection_access uca ON c.id = uca.collection_id
      WHERE uca.user_id = ?
      ORDER BY c.name
    `, [userId]);
  },

  getIdsByUserId(userId) {
    return all('SELECT collection_id FROM user_collection_access WHERE user_id = ?', [userId])
      .map(r => r.collection_id);
  },

  getByCollectionId(collectionId) {
    return all(`
      SELECT u.id, u.username, u.email, u.role
      FROM users u
      INNER JOIN user_collection_access uca ON u.id = uca.user_id
      WHERE uca.collection_id = ?
      ORDER BY u.username
    `, [collectionId]);
  },

  grant(userId, collectionId) {
    try {
      run('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id) VALUES (?, ?)', [userId, collectionId]);
    } catch (e) {}
  },

  revoke(userId, collectionId) {
    run('DELETE FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
  },

  setForUser(userId, collectionIds) {
    const ids = (collectionIds || []).map(Number).filter(Number.isInteger);
    withExclusiveLockSync(() => {
      run('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
      for (const cid of ids) {
        run('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id) VALUES (?, ?)', [userId, cid]);
      }
    });
  }
};

const userCollectionAccessAsync = {
  async getIdsByUserId(userId) {
    const rows = await allAsync('SELECT collection_id FROM user_collection_access WHERE user_id = ?', [userId]);
    return rows.map(r => r.collection_id);
  },

  async getWithRolesByUserId(userId) {
    return await allAsync('SELECT collection_id, role FROM user_collection_access WHERE user_id = ?', [userId]);
  },

  async getRoleForUser(userId, collectionId) {
    const row = await getAsync('SELECT role FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
    return row ? row.role : null;
  },

  async getByCollectionId(collectionId) {
    return await allAsync(`
      SELECT u.id, u.username, u.email, u.role AS system_role, uca.role AS collection_role
      FROM users u
      INNER JOIN user_collection_access uca ON u.id = uca.user_id
      WHERE uca.collection_id = ?
      ORDER BY u.username
    `, [collectionId]);
  },

  async countByCollectionId(collectionId) {
    const row = await getAsync(`
      SELECT COUNT(*) AS count
      FROM user_collection_access
      WHERE collection_id = ?
    `, [collectionId]);
    return row ? Number(row.count || 0) : 0;
  },

  async setForUser(userId, collectionIds) {
    const ids = (collectionIds || []).map(Number).filter(Number.isInteger);
    await withExclusiveLock(async () => {
      await runAsync('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
      for (const cid of ids) {
        await runAsync('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, cid, 'viewer']);
      }
    });
    await saveDatabase();
  },

  async setForUserWithRoles(userId, collectionRoles) {
    const entries = Object.entries(collectionRoles || {}).map(([cid, role]) => [
      parseInt(cid),
      ROLE_HIERARCHY[role] ? role : 'viewer'
    ]).filter(([cid]) => Number.isInteger(cid));
    await withExclusiveLock(async () => {
      await runAsync('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
      for (const [cid, role] of entries) {
        await runAsync('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, cid, role]);
      }
    });
    await saveDatabase();
  },

  async grant(userId, collectionId, role) {
    const safeRole = ROLE_HIERARCHY[role] ? role : 'viewer';
    try {
      const existing = await getAsync('SELECT role FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
      if (existing) {
        await runAsync('UPDATE user_collection_access SET role = ? WHERE user_id = ? AND collection_id = ?', [safeRole, userId, collectionId]);
      } else {
        await runAsync('INSERT INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, collectionId, safeRole]);
      }
    } catch (e) {}
  },

  async revoke(userId, collectionId) {
    await runAsync('DELETE FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
  },

  async getManagerCollectionIds(userId) {
    const rows = await allAsync("SELECT collection_id FROM user_collection_access WHERE user_id = ? AND role = 'manager'", [userId]);
    return rows.map(r => r.collection_id);
  },

  async getEditableCollectionIds(userId) {
    const rows = await allAsync("SELECT collection_id FROM user_collection_access WHERE user_id = ? AND role IN ('editor', 'manager')", [userId]);
    return rows.map(r => r.collection_id);
  },

  async getManagerCollectionIdForDocument(userId, documentId) {
    const row = await getAsync(`
      SELECT uca.collection_id FROM user_collection_access uca
      INNER JOIN document_collections dc ON dc.collection_id = uca.collection_id
      WHERE uca.user_id = ? AND dc.document_id = ? AND uca.role = 'manager'
      LIMIT 1
    `, [userId, documentId]);
    return row ? row.collection_id : null;
  },

  async hasRoleOnDocumentCollections(userId, documentId, minRole) {
    const row = await getAsync(`
      SELECT uca.role FROM user_collection_access uca
      INNER JOIN document_collections dc ON dc.collection_id = uca.collection_id
      WHERE uca.user_id = ? AND dc.document_id = ?
      ORDER BY CASE uca.role WHEN 'manager' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END DESC
      LIMIT 1
    `, [userId, documentId]);
    return row ? roleAtLeast(row.role, minRole) : false;
  }
};

const ROLE_HIERARCHY = { viewer: 1, editor: 2, manager: 3 };

function roleAtLeast(userRole, minRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[minRole] || 0);
}

function normalizeCollectionIds(collectionIds) {
  if (!Array.isArray(collectionIds)) return [];
  return [...new Set(collectionIds.map(Number).filter(Number.isInteger))];
}

function parseInviteCollectionIds(value) {
  if (!value) return [];
  try {
    return normalizeCollectionIds(JSON.parse(value));
  } catch {
    return [];
  }
}


  return {
    collections,
    collectionsAsync,
    documentCollections,
    documentCollectionsAsync,
    userCollectionAccess,
    userCollectionAccessAsync,
    normalizeCollectionIds,
    parseInviteCollectionIds
  };
};
