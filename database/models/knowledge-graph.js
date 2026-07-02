'use strict';
const { CITATION_APPROVAL_STATUSES, deriveCitationApproval } = require('../../utils/knowledge-approval');
const { normalizeGenericTerm } = require('../../utils/authority-suggestion-pipeline');
const REVIEW_KIND_ENTITY_TYPES = new Set([
  'person',
  'place',
  'event',
  'organization',
  'topic',
  'artifact',
  'claim',
  'document',
  'role'
]);

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, isFts5Available = () => false) => {
const entities = {
  async create({ entity_type, canonical_name, description, properties, authority_id }) {
    const result = await runAsync(`
      INSERT INTO entities (entity_type, canonical_name, description, properties, authority_id)
      VALUES (?, ?, ?, ?, ?)
    `, [
      entity_type,
      canonical_name,
      description || null,
      JSON.stringify(properties || {}),
      Number.isInteger(authority_id) ? authority_id : null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    return hydrateEntity(await getAsync('SELECT * FROM entities WHERE id = ?', [id]));
  },

  async getByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await allAsync(`SELECT * FROM entities WHERE id IN (${placeholders})`, ids);
    return rows.map(hydrateEntity);
  },

  async getAll(limit = 50, offset = 0) {
    return (await allAsync(`
      SELECT * FROM entities
      ORDER BY canonical_name
      LIMIT ? OFFSET ?
    `, [limit, offset])).map(hydrateEntity);
  },

  async getByType(entityType, limit = 50, offset = 0) {
    return (await allAsync(`
      SELECT * FROM entities
      WHERE entity_type = ?
      ORDER BY canonical_name
      LIMIT ? OFFSET ?
    `, [entityType, limit, offset])).map(hydrateEntity);
  },

  async getCount(entityType = null) {
    const row = entityType
      ? await getAsync('SELECT COUNT(*) as count FROM entities WHERE entity_type = ?', [entityType])
      : await getAsync('SELECT COUNT(*) as count FROM entities');
    return row?.count || 0;
  },

  async getCountsByType() {
    return await allAsync(`
      SELECT entity_type, COUNT(*) as count
      FROM entities
      GROUP BY entity_type
      ORDER BY count DESC, entity_type ASC
    `);
  },

  async search(query, limit = 50) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    if (!sanitized) return [];
    if (isFts5Available()) {
      const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');
      try {
        const rows = await allAsync(`
          SELECT DISTINCT e.*
          FROM entities e
          WHERE e.id IN (
            SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?
            UNION
            SELECT ea.entity_id FROM entity_aliases ea
            JOIN entity_aliases_fts af ON af.rowid = ea.id
            WHERE entity_aliases_fts MATCH ?
          )
          ORDER BY e.canonical_name
          LIMIT ?
        `, [ftsQuery, ftsQuery, limit]);
        return rows.map(hydrateEntity);
      } catch (err) {
        // fall through to LIKE
      }
    }
    const pattern = `%${sanitized}%`;
    const rows = await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      WHERE e.canonical_name LIKE ? OR ea.alias LIKE ?
      ORDER BY e.canonical_name
      LIMIT ?
    `, [pattern, pattern, limit]);
    return rows.map(hydrateEntity);
  },

  // Spec § "Data flow and query scoping" (Entities list) — a unified
  // admin-listing entry point that accepts an opt bag with optional
  // { collectionId, type, unresolved, q, limit, offset }. When no opts are
  // supplied the call is equivalent to getAll(limit, offset). Per the
  // spec, scoping always traverses document_collections (entities have no
  // collection_id of their own — migrations.js v44 puts the entity ->
  // document edge on citations.entity_id).
  //
  // `q` is a case-insensitive substring match against canonical_name.
  // Pushed into SQL so pagination reflects the true filtered set — the
  // manage handler previously applied `q` in-memory AFTER the LIMIT/OFFSET
  // slice, so a matching row past page 1 was silently unreachable.
  async listForAdmin(opts = {}) {
    const limit = Number.isInteger(Number(opts.limit)) ? Number(opts.limit) : 50;
    const offset = Number.isInteger(Number(opts.offset)) ? Number(opts.offset) : 0;
    const where = [];
    const params = [];

    if (opts.type && typeof opts.type === 'string') {
      where.push('e.entity_type = ?');
      params.push(opts.type);
    }
    if (opts.unresolved === true) {
      where.push('e.authority_id IS NULL');
    }
    if (opts.q && typeof opts.q === 'string' && opts.q.trim()) {
      // ESCAPE the LIKE metacharacters so operators can't be sneaked in via
      // curator-typed search text.
      const needle = opts.q.trim().replace(/[\\%_]/g, '\\$&');
      where.push(`LOWER(e.canonical_name) LIKE LOWER(?) ESCAPE '\\'`);
      params.push(`%${needle}%`);
    }
    if (Number.isInteger(Number(opts.collectionId)) && Number(opts.collectionId) > 0) {
      where.push(`e.id IN (
        SELECT DISTINCT c.entity_id
        FROM citations c
        INNER JOIN document_collections dc ON dc.document_id = c.document_id
        WHERE dc.collection_id = ?
          AND c.entity_id IS NOT NULL
      )`);
      params.push(Number(opts.collectionId));
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);

    return (await allAsync(`
      SELECT e.*
      FROM entities e
      ${whereClause}
      ORDER BY e.canonical_name
      LIMIT ? OFFSET ?
    `, params)).map(hydrateEntity);
  },

  // Companion to listForAdmin — returns a single COUNT matching the same
  // WHERE clause (collectionId + type + unresolved + q). Manage-side
  // pagination uses this instead of countByCollection so the header
  // reflects the true filtered set. Kept as a separate method rather than
  // an opt on countByCollection because the byType breakdown is a
  // different shape and byType is meaningless when q is applied.
  async countMatchingForAdmin(opts = {}) {
    const where = [];
    const params = [];
    if (opts.type && typeof opts.type === 'string') {
      where.push('e.entity_type = ?');
      params.push(opts.type);
    }
    if (opts.unresolved === true) {
      where.push('e.authority_id IS NULL');
    }
    if (opts.q && typeof opts.q === 'string' && opts.q.trim()) {
      const needle = opts.q.trim().replace(/[\\%_]/g, '\\$&');
      where.push(`LOWER(e.canonical_name) LIKE LOWER(?) ESCAPE '\\'`);
      params.push(`%${needle}%`);
    }
    if (Number.isInteger(Number(opts.collectionId)) && Number(opts.collectionId) > 0) {
      where.push(`e.id IN (
        SELECT DISTINCT c.entity_id
        FROM citations c
        INNER JOIN document_collections dc ON dc.document_id = c.document_id
        WHERE dc.collection_id = ?
          AND c.entity_id IS NOT NULL
      )`);
      params.push(Number(opts.collectionId));
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = await getAsync(`
      SELECT COUNT(*) AS n
      FROM entities e
      ${whereClause}
    `, params);
    return Number(row?.n || 0);
  },

  // Spec § "Dashboard counts" (entities in collection). Counts distinct
  // entities whose citations land in the given collection, with a byType
  // breakdown by entity_type. Per § "Data flow and query scoping" the
  // scope traverses document_collections via citations.entity_id ->
  // citations.document_id, since entities have no document_id (migrations.js v44).
  async countByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
      return { total: 0, byType: {} };
    }
    const rows = await allAsync(`
      SELECT e.entity_type, COUNT(DISTINCT e.id) AS n
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = c.document_id
      WHERE dc.collection_id = ?
      GROUP BY e.entity_type
    `, [normalizedId]);
    const byType = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.n || 0);
      byType[row.entity_type] = count;
      total += count;
    }
    return { total, byType };
  },

  // Spec § "Dashboard counts" (unresolved entities). Same scoping as
  // countByCollection plus authority_id IS NULL.
  async countUnresolvedByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
      return { total: 0, byType: {} };
    }
    const rows = await allAsync(`
      SELECT e.entity_type, COUNT(DISTINCT e.id) AS n
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = c.document_id
      WHERE dc.collection_id = ?
        AND e.authority_id IS NULL
      GROUP BY e.entity_type
    `, [normalizedId]);
    const byType = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.n || 0);
      byType[row.entity_type] = count;
      total += count;
    }
    return { total, byType };
  },

  async getByDocumentId(documentId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      documentId,
      approvalStatus: opts.approvalStatus || CITATION_APPROVAL_STATUSES.APPROVED
    });
    return (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      ${queryFilter.clause}
        AND e.entity_type != 'date'
      ORDER BY e.entity_type, e.canonical_name
    `, queryFilter.params)).map(hydrateEntity);
  },

  async update(id, fields = {}) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await runAsync(`
      UPDATE entities
      SET entity_type = ?, canonical_name = ?, description = ?, properties = ?, authority_id = ?
      WHERE id = ?
    `, [
      fields.entity_type !== undefined ? fields.entity_type : existing.entity_type,
      fields.canonical_name !== undefined ? fields.canonical_name : existing.canonical_name,
      fields.description !== undefined ? fields.description : existing.description,
      fields.properties !== undefined ? JSON.stringify(fields.properties || {}) : JSON.stringify(existing.properties || {}),
      fields.authority_id !== undefined
        ? (Number.isInteger(fields.authority_id) ? fields.authority_id : null)
        : (Number.isInteger(existing.authority_id) ? existing.authority_id : null),
      id
    ]);
    return await this.getById(id);
  },

  async getByAuthorityId(authorityId, limit = 200) {
    if (!Number.isInteger(Number(authorityId)) || Number(authorityId) <= 0) return [];
    return (await allAsync(`
      SELECT *
      FROM entities
      WHERE authority_id = ?
      ORDER BY canonical_name
      LIMIT ?
    `, [Number(authorityId), limit])).map(hydrateEntity);
  },

  async assignAuthority(entityId, authorityId) {
    const normalizedAuthorityId = Number.isInteger(Number(authorityId)) ? Number(authorityId) : null;
    await runAsync(`
      UPDATE entities
      SET authority_id = ?
      WHERE id = ?
    `, [
      normalizedAuthorityId,
      entityId
    ]);
    if (normalizedAuthorityId) {
      await runAsync(`
        UPDATE authority_link_suggestions
        SET status = 'rejected',
            reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP)
        WHERE entity_id = ?
          AND status = 'pending'
      `, [entityId]);
    }
    return await this.getById(entityId);
  },

  async delete(id) {
    return await runAsync('DELETE FROM entities WHERE id = ?', [id]);
  },

  async getNeighbors(entityId, depth = 1) {
    const direct = await allAsync(`
      SELECT
        e.*,
        r.id AS relationship_id,
        r.relationship_type,
        r.confidence,
        r.start_date,
        r.end_date,
        r.date_precision,
        r.date_qualifier,
        CASE WHEN r.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
        se.canonical_name AS source_name,
        se.entity_type AS source_type,
        te.canonical_name AS target_name,
        te.entity_type AS target_type
      FROM relationships r
      JOIN entities e
        ON e.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      ORDER BY e.canonical_name
    `, [entityId, entityId, entityId, entityId]);

    if (depth <= 1) return direct.map(hydrateEntity);

    const seen = new Set([entityId, ...direct.map((row) => row.id)]);
    const secondLevel = [];
    for (const first of direct) {
      const rows = await allAsync(`
        SELECT
          e.*,
          r.id AS relationship_id,
          r.relationship_type,
          r.confidence,
          r.start_date,
          r.end_date,
          r.date_precision,
          r.date_qualifier,
          CASE WHEN r.source_entity_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
          se.canonical_name AS source_name,
          se.entity_type AS source_type,
          te.canonical_name AS target_name,
          te.entity_type AS target_type
        FROM relationships r
        JOIN entities e
          ON e.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      `, [first.id, first.id, first.id, first.id]);
      rows.forEach((row) => {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          secondLevel.push({ ...row, via_entity_id: first.id });
        }
      });
    }
    return [...direct, ...secondLevel].map(hydrateEntity);
  }
};

const entityAliases = {
  async create({ entity_id, alias, source }) {
    const result = await runAsync(`
      INSERT INTO entity_aliases (entity_id, alias, source)
      VALUES (?, ?, ?)
    `, [entity_id, alias, source || 'extracted']);
    return result.lastInsertRowid;
  },

  async findExisting(entityId, alias) {
    return await getAsync(`
      SELECT * FROM entity_aliases
      WHERE entity_id = ? AND lower(alias) = lower(?)
      LIMIT 1
    `, [entityId, alias]);
  },

  async createIfMissing({ entity_id, alias, source }) {
    if (!alias) return null;
    const existing = await this.findExisting(entity_id, alias);
    if (existing) return existing.id;
    return await this.create({ entity_id, alias, source });
  },

  async getByEntityId(entityId) {
    return await allAsync(`
      SELECT * FROM entity_aliases
      WHERE entity_id = ?
      ORDER BY alias
    `, [entityId]);
  },

  async search(query, limit = 50) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    if (!sanitized) return [];
    if (isFts5Available()) {
      const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');
      try {
        return await allAsync(`
          SELECT ea.*, e.canonical_name, e.entity_type
          FROM entity_aliases ea
          JOIN entities e ON e.id = ea.entity_id
          WHERE ea.id IN (
            SELECT rowid FROM entity_aliases_fts WHERE entity_aliases_fts MATCH ?
          )
          ORDER BY ea.alias
          LIMIT ?
        `, [ftsQuery, limit]);
      } catch (err) {
        // fall through to LIKE
      }
    }
    const pattern = `%${sanitized}%`;
    return await allAsync(`
      SELECT ea.*, e.canonical_name, e.entity_type
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE ea.alias LIKE ?
      ORDER BY ea.alias
      LIMIT ?
    `, [pattern, limit]);
  },

  async getByEntityIds(entityIds) {
    if (!entityIds.length) return [];
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = await allAsync(`SELECT * FROM entity_aliases WHERE entity_id IN (${placeholders}) ORDER BY alias`, entityIds);
    return rows;
  },

  async delete(id) {
    return await runAsync('DELETE FROM entity_aliases WHERE id = ?', [id]);
  }
};

const authorities = {
  async create({ authority_type, canonical_name, description, properties, external_source, external_key }) {
    const result = await runAsync(`
      INSERT INTO authorities (
        authority_type, canonical_name, description, properties, external_source, external_key
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      authority_type,
      canonical_name,
      description || null,
      JSON.stringify(properties || {}),
      external_source || null,
      external_key || null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    return hydrateAuthority(await getAsync('SELECT * FROM authorities WHERE id = ?', [id]));
  },

  async getAll(limit = 50, offset = 0) {
    return (await allAsync(`
      SELECT *
      FROM authorities
      ORDER BY canonical_name
      LIMIT ? OFFSET ?
    `, [limit, offset])).map(hydrateAuthority);
  },

  async listWithStats({ limit = 50, offset = 0, query = '', authorityType = '', sort = 'name', direction = 'asc' } = {}) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    const typeFilter = String(authorityType || '').trim();
    const params = [];
    const clauses = [];
    if (typeFilter) {
      clauses.push('a.authority_type = ?');
      params.push(typeFilter);
    }
    if (sanitized) {
      const pattern = `%${sanitized}%`;
      clauses.push(`(
        a.canonical_name LIKE ?
        OR EXISTS (
          SELECT 1 FROM entities e_search
          WHERE e_search.authority_id = a.id
            AND e_search.canonical_name LIKE ?
        )
        OR EXISTS (
          SELECT 1
          FROM entities e_alias
          INNER JOIN entity_aliases ea_search ON ea_search.entity_id = e_alias.id
          WHERE e_alias.authority_id = a.id
            AND ea_search.alias LIKE ?
        )
      )`);
      params.push(pattern, pattern, pattern);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sortColumns = {
      name: 'a.canonical_name COLLATE NOCASE',
      type: 'a.authority_type COLLATE NOCASE',
      members: 'member_count',
      documents: 'document_count'
    };
    const orderColumn = sortColumns[sort] || sortColumns.name;
    const orderDirection = String(direction || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    params.push(limit, offset);

    return (await allAsync(`
      SELECT
        a.*,
        COUNT(DISTINCT e.id) AS member_count,
        COUNT(DISTINCT c.document_id) AS document_count
      FROM authorities a
      LEFT JOIN entities e ON e.authority_id = a.id
      LEFT JOIN citations c ON c.entity_id = e.id AND c.approval_status = 'approved'
      ${where}
      GROUP BY a.id
      ORDER BY ${orderColumn} ${orderDirection}, a.canonical_name COLLATE NOCASE ASC, a.id ASC
      LIMIT ? OFFSET ?
    `, params)).map(hydrateAuthority);
  },

  async getListCount({ query = '', authorityType = '' } = {}) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    const typeFilter = String(authorityType || '').trim();
    const params = [];
    const clauses = [];
    if (typeFilter) {
      clauses.push('a.authority_type = ?');
      params.push(typeFilter);
    }
    if (sanitized) {
      const pattern = `%${sanitized}%`;
      clauses.push(`(
        a.canonical_name LIKE ?
        OR EXISTS (
          SELECT 1 FROM entities e_search
          WHERE e_search.authority_id = a.id
            AND e_search.canonical_name LIKE ?
        )
        OR EXISTS (
          SELECT 1
          FROM entities e_alias
          INNER JOIN entity_aliases ea_search ON ea_search.entity_id = e_alias.id
          WHERE e_alias.authority_id = a.id
            AND ea_search.alias LIKE ?
        )
      )`);
      params.push(pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = await getAsync(`
      SELECT COUNT(*) AS count
      FROM authorities a
      ${where}
    `, params);
    return Number(row?.count || 0);
  },

  async getTypes() {
    const rows = await allAsync(`
      SELECT authority_type, COUNT(*) AS count
      FROM authorities
      GROUP BY authority_type
      ORDER BY authority_type
    `);
    return rows.map((row) => ({
      authority_type: row.authority_type,
      count: Number(row.count || 0)
    }));
  },

  async getCount(authorityType = null) {
    const row = authorityType
      ? await getAsync('SELECT COUNT(*) AS count FROM authorities WHERE authority_type = ?', [authorityType])
      : await getAsync('SELECT COUNT(*) AS count FROM authorities');
    return Number(row?.count || 0);
  },

  async search(query, limit = 50, opts = {}) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    if (!sanitized) return [];
    const pattern = `%${sanitized}%`;
    const params = [pattern, pattern, pattern];
    let typeClause = '';
    if (opts.authorityType) {
      typeClause = 'AND a.authority_type = ?';
      params.push(opts.authorityType);
    }
    params.push(limit);
    return (await allAsync(`
      SELECT DISTINCT a.*
      FROM authorities a
      LEFT JOIN entities e ON e.authority_id = a.id
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      WHERE (
        a.canonical_name LIKE ?
        OR e.canonical_name LIKE ?
        OR ea.alias LIKE ?
      )
      ${typeClause}
      ORDER BY a.canonical_name
      LIMIT ?
    `, params)).map(hydrateAuthority);
  },

  async getMembers(authorityId, limit = 200) {
    if (!Number.isInteger(Number(authorityId)) || Number(authorityId) <= 0) return [];
    return (await allAsync(`
      SELECT *
      FROM entities
      WHERE authority_id = ?
      ORDER BY canonical_name
      LIMIT ?
    `, [Number(authorityId), limit])).map(hydrateEntity);
  },

  // Spec § "Data flow and query scoping" (Authorities list) and the
  // § "Authority list 'N / M' annotation" SQL recipe. Returns one row per
  // authority that has at least one member entity cited in the given
  // collection. `in_collection_members` counts distinct member entities
  // whose citation lands in the collection; `total_members` is the
  // authority's full corpus-wide member count (every authority-linked
  // entity ever cited anywhere, distinct).
  //
  // The join chain is authority -> entities (e.authority_id) -> citations
  // (c.entity_id) -> document_collections (dc.document_id), because
  // entities have no document_id column (migrations.js v44).
  // Conditional aggregation (SUM(CASE WHEN dc.collection_id = ? ...))
  // keeps this to a single query rather than two passes.
  async listTouchedByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return [];
    return await allAsync(`
      SELECT
        a.id,
        a.canonical_name,
        a.authority_type,
        COUNT(DISTINCT CASE WHEN dc.collection_id = ? THEN e.id END) AS in_collection_members,
        COUNT(DISTINCT e.id) AS total_members,
        COUNT(DISTINCT cit.document_id) AS document_count
      FROM authorities a
      INNER JOIN entities e ON e.authority_id = a.id
      INNER JOIN citations cit ON cit.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = cit.document_id
      GROUP BY a.id, a.canonical_name, a.authority_type
      HAVING in_collection_members > 0
      ORDER BY a.canonical_name
    `, [normalizedId]);
  },

  // Spec § "Dashboard counts" (distinct authorities touched). Same scope
  // shape as listTouchedByCollection but compressed to a single COUNT(DISTINCT).
  async countDistinctTouchedByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return { total: 0 };
    const row = await getAsync(`
      SELECT COUNT(DISTINCT a.id) AS n
      FROM authorities a
      INNER JOIN entities e ON e.authority_id = a.id
      INNER JOIN citations cit ON cit.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = cit.document_id
      WHERE dc.collection_id = ?
    `, [normalizedId]);
    return { total: Number(row?.n || 0) };
  },

  async getMemberAliases(authorityId, limit = 500) {
    if (!Number.isInteger(Number(authorityId)) || Number(authorityId) <= 0) return [];
    return await allAsync(`
      SELECT DISTINCT ea.alias
      FROM entity_aliases ea
      INNER JOIN entities e ON e.id = ea.entity_id
      WHERE e.authority_id = ?
      ORDER BY ea.alias
      LIMIT ?
    `, [Number(authorityId), limit]);
  },

  async update(id, fields = {}) {
    const existing = await this.getById(id);
    if (!existing) return null;
    await runAsync(`
      UPDATE authorities
      SET authority_type = ?,
          canonical_name = ?,
          description = ?,
          properties = ?,
          external_source = ?,
          external_key = ?
      WHERE id = ?
    `, [
      fields.authority_type || existing.authority_type,
      fields.canonical_name !== undefined ? fields.canonical_name : existing.canonical_name,
      fields.description !== undefined ? fields.description : existing.description,
      fields.properties !== undefined ? JSON.stringify(fields.properties || {}) : JSON.stringify(existing.properties || {}),
      fields.external_source !== undefined ? fields.external_source : existing.external_source,
      fields.external_key !== undefined ? fields.external_key : existing.external_key,
      id
    ]);
    return await this.getById(id);
  },

  async mergeAuthorities(keepId, mergeId) {
    const keep = await this.getById(keepId);
    const merge = await this.getById(mergeId);
    if (!keep || !merge) {
      throw new Error('Authority not found.');
    }
    if (keep.authority_type !== merge.authority_type) {
      throw new Error('Authorities must have the same type to be merged.');
    }

    const runMerge = async () => {
      await runAsync('UPDATE entities SET authority_id = ? WHERE authority_id = ?', [keepId, mergeId]);
      await runAsync(`
        DELETE FROM authority_link_suggestions
        WHERE suggested_authority_id = ?
          AND entity_id IN (
            SELECT entity_id
            FROM authority_link_suggestions
            WHERE suggested_authority_id = ?
          )
      `, [mergeId, keepId]);
      await runAsync('UPDATE authority_link_suggestions SET suggested_authority_id = ? WHERE suggested_authority_id = ?', [keepId, mergeId]);
      await runAsync('DELETE FROM authorities WHERE id = ?', [mergeId]);
    };

    await runMerge();
    await saveDatabase();
    return await this.getById(keepId);
  },

  async delete(id) {
    await runAsync('UPDATE entities SET authority_id = NULL WHERE authority_id = ?', [id]);
    await runAsync('DELETE FROM authority_link_suggestions WHERE suggested_authority_id = ?', [id]);
    const result = await runAsync('DELETE FROM authorities WHERE id = ?', [id]);
    await saveDatabase();
    return result;
  }
};

const GENERIC_TERM_STATUSES = new Set(['active', 'suggested', 'rejected', 'disabled']);
const GENERIC_TERM_SOURCES = new Set(['manual', 'review_pattern', 'extraction', 'corpus_frequency']);

function normalizeGenericEntityType(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeGenericStatus(value, fallback = 'suggested') {
  const text = String(value || '').trim();
  return GENERIC_TERM_STATUSES.has(text) ? text : fallback;
}

function normalizeGenericSource(value, fallback = 'manual') {
  const text = String(value || '').trim();
  return GENERIC_TERM_SOURCES.has(text) ? text : fallback;
}

const authorityGenericTerms = {
  async list(status = 'active', opts = {}) {
    const params = [];
    const clauses = [];
    if (status && status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (opts.entityType) {
      clauses.push('(entity_type = ? OR entity_type IS NULL)');
      params.push(String(opts.entityType).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    return await allAsync(`
      SELECT *
      FROM authority_generic_terms
      ${where}
      ORDER BY
        CASE status WHEN 'suggested' THEN 0 WHEN 'active' THEN 1 WHEN 'disabled' THEN 2 ELSE 3 END,
        updated_at DESC,
        id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM authority_generic_terms WHERE id = ?', [id]);
  },

  async listActive() {
    return await this.list('active', { limit: 1000 });
  },

  async createManual({ term, entity_type = null, notes = null, userId = null, status = 'active' }) {
    return await this.upsert({
      term,
      entity_type,
      source: 'manual',
      status,
      notes,
      created_by_user_id: userId,
      reviewed_by_user_id: status === 'active' ? userId : null
    });
  },

  async upsert({
    term,
    entity_type = null,
    source = 'manual',
    status = 'suggested',
    notes = null,
    created_by_user_id = null,
    reviewed_by_user_id = null,
    seenIncrement = 0,
    rejectedIncrement = 0,
    approvedIncrement = 0
  }) {
    const normalizedTerm = normalizeGenericTerm(term);
    if (!normalizedTerm) throw new Error('Generic term is required.');
    const entityType = normalizeGenericEntityType(entity_type);
    const normalizedStatus = normalizeGenericStatus(status);
    const normalizedSource = normalizeGenericSource(source);
    const existing = await getAsync(`
      SELECT *
      FROM authority_generic_terms
      WHERE normalized_term = ?
        AND ((entity_type IS NULL AND ? IS NULL) OR entity_type = ?)
      LIMIT 1
    `, [normalizedTerm, entityType, entityType]);

    if (existing) {
      const keepReviewed = existing.status === 'active' && normalizedStatus !== 'active';
      await runAsync(`
        UPDATE authority_generic_terms
        SET term = COALESCE(?, term),
            source = COALESCE(?, source),
            status = CASE
              WHEN status = 'active' AND ? != 'active' THEN status
              ELSE ?
            END,
            seen_count = seen_count + ?,
            rejected_link_count = rejected_link_count + ?,
            approved_link_count = approved_link_count + ?,
            notes = COALESCE(?, notes),
            reviewed_by_user_id = CASE WHEN ? IS NOT NULL THEN ? ELSE reviewed_by_user_id END,
            reviewed_at = CASE
              WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP
              ELSE reviewed_at
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        term || null,
        normalizedSource,
        normalizedStatus,
        normalizedStatus,
        Number(seenIncrement || 0),
        Number(rejectedIncrement || 0),
        Number(approvedIncrement || 0),
        notes || null,
        keepReviewed ? null : reviewed_by_user_id,
        keepReviewed ? null : reviewed_by_user_id,
        keepReviewed ? null : reviewed_by_user_id,
        existing.id
      ]);
      return existing.id;
    }

    const result = await runAsync(`
      INSERT INTO authority_generic_terms (
        term, normalized_term, entity_type, status, source,
        seen_count, rejected_link_count, approved_link_count, notes,
        created_by_user_id, reviewed_by_user_id, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END)
    `, [
      term,
      normalizedTerm,
      entityType,
      normalizedStatus,
      normalizedSource,
      Number(seenIncrement || 0),
      Number(rejectedIncrement || 0),
      Number(approvedIncrement || 0),
      notes || null,
      created_by_user_id || null,
      reviewed_by_user_id || null,
      reviewed_by_user_id || null
    ]);
    return result.lastInsertRowid;
  },

  async setStatus(id, status, userId = null) {
    const normalizedStatus = normalizeGenericStatus(status, null);
    if (!normalizedStatus) throw new Error('Invalid generic term status.');
    await runAsync(`
      UPDATE authority_generic_terms
      SET status = ?,
          reviewed_by_user_id = ?,
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [normalizedStatus, userId || null, id]);
    return await this.getById(id);
  },

  async delete(id) {
    return await runAsync('DELETE FROM authority_generic_terms WHERE id = ?', [id]);
  },

  async isGenericName(name, entityType = null) {
    const normalizedTerm = normalizeGenericTerm(name);
    if (!normalizedTerm) return false;
    const row = await getAsync(`
      SELECT id
      FROM authority_generic_terms
      WHERE normalized_term = ?
        AND status = 'active'
        AND (entity_type IS NULL OR entity_type = ?)
      LIMIT 1
    `, [normalizedTerm, normalizeGenericEntityType(entityType)]);
    return !!row;
  },

  async recordExtractionHint({ term, entity_type = null }) {
    return await this.upsert({
      term,
      entity_type,
      source: 'extraction',
      status: 'suggested',
      seenIncrement: 1
    });
  }
};

const authorityLinkSuggestions = {
  async createIfMissing({ entity_id, suggested_authority_id, confidence, match_method, status = 'pending' }) {
    const entity = await entities.getById(Number(entity_id));
    const hasAuthorityLink = entity
      && entity.authority_id !== null
      && entity.authority_id !== undefined
      && Number.isInteger(Number(entity.authority_id))
      && Number(entity.authority_id) > 0;
    const normalizedStatus = status || 'pending';
    const existing = await getAsync(`
      SELECT * FROM authority_link_suggestions
      WHERE entity_id = ? AND suggested_authority_id = ?
      LIMIT 1
    `, [entity_id, suggested_authority_id]);
    if (hasAuthorityLink) {
      if (existing && existing.status === 'pending') {
        await runAsync(`
          UPDATE authority_link_suggestions
          SET status = 'rejected',
              reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP)
          WHERE id = ?
        `, [existing.id]);
      }
      return null;
    }
    if (existing) {
      await runAsync(`
        UPDATE authority_link_suggestions
        SET confidence = COALESCE(?, confidence),
            match_method = COALESCE(?, match_method),
            status = CASE WHEN status = 'approved' THEN status ELSE ? END,
            reviewed_at = CASE
              WHEN ? = 'approved' AND reviewed_at IS NULL THEN CURRENT_TIMESTAMP
              ELSE reviewed_at
            END
        WHERE id = ?
      `, [
        confidence != null ? confidence : null,
        match_method || null,
        normalizedStatus,
        normalizedStatus,
        existing.id
      ]);
      return existing.id;
    }

    const result = await runAsync(`
      INSERT INTO authority_link_suggestions (
        entity_id, suggested_authority_id, confidence, match_method, status
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      entity_id,
      suggested_authority_id,
      confidence != null ? confidence : null,
      match_method || null,
      normalizedStatus
    ]);
    if (normalizedStatus === 'approved') {
      await runAsync(`
        UPDATE authority_link_suggestions
        SET reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `, [result.lastInsertRowid]);
    }
    return result.lastInsertRowid;
  },

  async countPending() {
    const row = await getAsync(`
      SELECT COUNT(*) AS n
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      WHERE als.status = 'pending'
        AND e.authority_id IS NULL
    `);
    return Number(row?.n || 0);
  },

  // Returns { pending, approved, rejected, byMethod } for the stat header.
  // Per docs/knowledge-graph-design.md, curators need queue scale before
  // diving into review.
  async getStatusCounts() {
    const rows = await allAsync(`
      SELECT status, COUNT(*) AS n
      FROM authority_link_suggestions
      GROUP BY status
    `);
    const byStatus = Object.fromEntries((rows || []).map(r => [r.status, Number(r.n || 0)]));
    const methodRows = await allAsync(`
      SELECT DISTINCT match_method FROM authority_link_suggestions WHERE match_method IS NOT NULL
    `);
    const byMethod = (methodRows || []).map(r => r.match_method).filter(Boolean);
    return {
      pending: byStatus.pending || 0,
      approved: byStatus.approved || 0,
      rejected: byStatus.rejected || 0,
      byMethod
    };
  },

  async list(status = 'pending', limit = 25, opts = {}) {
    const exactNameSql = "LOWER(TRIM(e.canonical_name)) = LOWER(TRIM(a.canonical_name))";
    const actionablePendingSql = "e.authority_id IS NULL";
    const includeContext = opts.includeContext === true;
    const params = [];
    let where = '';
    if (status && status !== 'all') {
      where = 'WHERE als.status = ?';
      params.push(status);
    }
    if (status === 'pending' && opts.includeAlreadyLinked !== true) {
      where += where ? ` AND ${actionablePendingSql}` : `WHERE ${actionablePendingSql}`;
    }
    if (opts.nameSignal === 'exact') {
      where += where ? ` AND ${exactNameSql}` : `WHERE ${exactNameSql}`;
    }
    if (Array.isArray(opts.matchMethodFilter) && opts.matchMethodFilter.length > 0) {
      const placeholders = opts.matchMethodFilter.map(() => '?').join(',');
      where += where ? ` AND als.match_method IN (${placeholders})` : `WHERE als.match_method IN (${placeholders})`;
      params.push(...opts.matchMethodFilter);
    }
    if (Number.isInteger(Number(opts.entityId)) && Number(opts.entityId) > 0) {
      where += where ? ' AND als.entity_id = ?' : 'WHERE als.entity_id = ?';
      params.push(Number(opts.entityId));
    }
    // Optional collection scope: authority_link_suggestions reference an
    // entity_id; the resolution chain to a collection is
    //   als.entity_id -> citations.entity_id -> citations.document_id
    //   -> document_collections.collection_id
    // Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-
    // workbench-design.md § "Data flow and query scoping", entities have
    // no document_id column (migrations.js v44), so the join routes
    // through citations.
    if (Number.isInteger(Number(opts.collectionId)) && Number(opts.collectionId) > 0) {
      const clause = `als.entity_id IN (
        SELECT DISTINCT c.entity_id
        FROM citations c
        INNER JOIN document_collections dc ON dc.document_id = c.document_id
        WHERE dc.collection_id = ?
          AND c.entity_id IS NOT NULL
      )`;
      where += where ? ' AND ' + clause : 'WHERE ' + clause;
      params.push(Number(opts.collectionId));
    }
    if (opts.cursor && opts.cursor.beforeCreatedAt && Number.isInteger(Number(opts.cursor.beforeId))) {
      const beforeExactNameMatch = Number(opts.cursor.beforeExactNameMatch);
      if (opts.orderExactFirst && Number.isInteger(beforeExactNameMatch)) {
        const clause = `(
          CASE WHEN ${exactNameSql} THEN 1 ELSE 0 END < ?
          OR (
            CASE WHEN ${exactNameSql} THEN 1 ELSE 0 END = ?
            AND (als.created_at < ? OR (als.created_at = ? AND als.id < ?))
          )
        )`;
        where += where ? ' AND ' + clause : 'WHERE ' + clause;
        params.push(beforeExactNameMatch, beforeExactNameMatch, opts.cursor.beforeCreatedAt, opts.cursor.beforeCreatedAt, Number(opts.cursor.beforeId));
      } else {
        const clause = '(als.created_at < ? OR (als.created_at = ? AND als.id < ?))';
        where += where ? ' AND ' + clause : 'WHERE ' + clause;
        params.push(opts.cursor.beforeCreatedAt, opts.cursor.beforeCreatedAt, Number(opts.cursor.beforeId));
      }
    }
    params.push(limit);
    const rows = await allAsync(`
      SELECT
        als.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        e.authority_id AS current_authority_id,
        ca.canonical_name AS current_authority_name,
        a.canonical_name AS suggested_authority_name,
        a.authority_type AS suggested_authority_type,
        CASE WHEN ${exactNameSql} THEN 1 ELSE 0 END AS exact_name_match
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      INNER JOIN authorities a ON a.id = als.suggested_authority_id
      LEFT JOIN authorities ca ON ca.id = e.authority_id
      ${where}
      ORDER BY ${opts.orderExactFirst ? `exact_name_match DESC, ` : ''}als.created_at DESC, als.id DESC
      LIMIT ?
    `, params);
    return includeContext ? await this.attachContext(rows) : rows;
  },

  // Convenience over list('pending', ...) — spec § "Data flow and query
  // scoping" (Authority suggestions) refers to this as listPending. Any
  // opt accepted by list() is passed through, including the optional
  // { collectionId } scope.
  async listPending(opts = {}) {
    const { limit = 5000, ...rest } = opts;
    return await this.list('pending', limit, rest);
  },

  // Spec § "Dashboard counts" (pending authority_link_suggestions). The
  // total counts pending, actionable (e.authority_id IS NULL) suggestions
  // whose entity is cited in the given collection. disambiguationGroups
  // counts entities with >=2 pending suggestions — i.e. cases where the
  // curator has to disambiguate between multiple candidate authorities.
  // The scoping join routes through citations because entities have no
  // document_id (migrations.js v44).
  async countPendingByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    const zero = { total: 0, disambiguationGroups: 0 };
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return zero;
    const totalRow = await getAsync(`
      SELECT COUNT(*) AS n
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      WHERE als.status = 'pending'
        AND e.authority_id IS NULL
        AND als.entity_id IN (
          SELECT DISTINCT c.entity_id
          FROM citations c
          INNER JOIN document_collections dc ON dc.document_id = c.document_id
          WHERE dc.collection_id = ?
            AND c.entity_id IS NOT NULL
        )
    `, [normalizedId]);
    const groupRow = await getAsync(`
      SELECT COUNT(*) AS n
      FROM (
        SELECT als.entity_id
        FROM authority_link_suggestions als
        INNER JOIN entities e ON e.id = als.entity_id
        WHERE als.status = 'pending'
          AND e.authority_id IS NULL
          AND als.entity_id IN (
            SELECT DISTINCT c.entity_id
            FROM citations c
            INNER JOIN document_collections dc ON dc.document_id = c.document_id
            WHERE dc.collection_id = ?
              AND c.entity_id IS NOT NULL
          )
        GROUP BY als.entity_id
        HAVING COUNT(*) >= 2
      ) grouped
    `, [normalizedId]);
    return {
      total: Number(totalRow?.n || 0),
      disambiguationGroups: Number(groupRow?.n || 0)
    };
  },

  async attachContext(rows = []) {
    if (!rows.length) return rows;
    const uniqueNumbers = (values) => [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    const entityIds = uniqueNumbers(rows.map((row) => row.entity_id));
    const authorityIds = uniqueNumbers(rows.map((row) => row.suggested_authority_id));

    const placeholders = (ids) => ids.map(() => '?').join(',');
    const evidenceByEntity = new Map();
    const memberCountByAuthority = new Map();
    const documentCountByAuthority = new Map();

    if (entityIds.length) {
      const evidenceRows = await allAsync(`
        SELECT
          c.entity_id,
          d.title AS document_title,
          c.passage_text,
          c.created_at,
          c.id
        FROM citations c
        LEFT JOIN documents d ON d.id = c.document_id
        WHERE c.approval_status = 'approved'
          AND c.entity_id IN (${placeholders(entityIds)})
        ORDER BY c.entity_id, c.created_at DESC, c.id DESC
      `, entityIds);
      for (const row of evidenceRows) {
        if (!evidenceByEntity.has(row.entity_id)) evidenceByEntity.set(row.entity_id, row);
      }
    }

    if (authorityIds.length) {
      const memberRows = await allAsync(`
        SELECT authority_id, COUNT(*) AS member_count
        FROM entities
        WHERE authority_id IN (${placeholders(authorityIds)})
        GROUP BY authority_id
      `, authorityIds);
      memberRows.forEach((row) => memberCountByAuthority.set(row.authority_id, Number(row.member_count || 0)));

      const documentRows = await allAsync(`
        SELECT e.authority_id, COUNT(DISTINCT c.document_id) AS document_count
        FROM entities e
        INNER JOIN citations c
          ON c.entity_id = e.id
         AND c.approval_status = 'approved'
        WHERE e.authority_id IN (${placeholders(authorityIds)})
        GROUP BY e.authority_id
      `, authorityIds);
      documentRows.forEach((row) => documentCountByAuthority.set(row.authority_id, Number(row.document_count || 0)));
    }

    return rows.map((row) => {
      const evidence = evidenceByEntity.get(row.entity_id) || {};
      return {
        ...row,
        source_document_title: evidence.document_title || null,
        source_evidence_text: evidence.passage_text || null,
        suggested_authority_member_count: memberCountByAuthority.get(row.suggested_authority_id) || 0,
        suggested_authority_document_count: documentCountByAuthority.get(row.suggested_authority_id) || 0
      };
    });
  },

  async getByEntityId(entityId, limit = 50) {
    return await this.list('all', limit, { entityId });
  },

  async getByIds(ids = [], opts = {}) {
    const safeIds = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!safeIds.length) return [];
    const placeholders = safeIds.map(() => '?').join(',');
    const rows = await allAsync(`
      SELECT
        als.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        e.authority_id AS current_authority_id,
        ca.canonical_name AS current_authority_name,
        a.canonical_name AS suggested_authority_name,
        a.authority_type AS suggested_authority_type,
        CASE WHEN LOWER(TRIM(e.canonical_name)) = LOWER(TRIM(a.canonical_name)) THEN 1 ELSE 0 END AS exact_name_match
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      INNER JOIN authorities a ON a.id = als.suggested_authority_id
      LEFT JOIN authorities ca ON ca.id = e.authority_id
      WHERE als.id IN (${placeholders})
    `, safeIds);
    const ordered = safeIds
      .map((id) => rows.find((row) => Number(row.id) === id))
      .filter(Boolean);
    return opts.includeContext ? await this.attachContext(ordered) : ordered;
  },

  async getById(id) {
    return await getAsync('SELECT * FROM authority_link_suggestions WHERE id = ?', [id]);
  },

  async approve(id, reviewedByUserId) {
    const suggestion = await getAsync(`
      SELECT * FROM authority_link_suggestions
      WHERE id = ?
    `, [id]);
    if (!suggestion) {
      throw new Error('Authority suggestion not found.');
    }
    const details = await getAsync(`
      SELECT
        als.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        a.canonical_name AS authority_name
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      INNER JOIN authorities a ON a.id = als.suggested_authority_id
      WHERE als.id = ?
    `, [id]);

    const runApprove = async () => {
      await runAsync('UPDATE entities SET authority_id = ? WHERE id = ?', [suggestion.suggested_authority_id, suggestion.entity_id]);
      await runAsync(`
        UPDATE authority_link_suggestions
        SET status = 'approved',
            reviewed_at = CURRENT_TIMESTAMP,
            reviewed_by_user_id = ?
        WHERE id = ?
      `, [reviewedByUserId || null, id]);
      await runAsync(`
        UPDATE authority_link_suggestions
        SET status = 'rejected',
            reviewed_at = CURRENT_TIMESTAMP,
            reviewed_by_user_id = ?
        WHERE entity_id = ?
          AND id != ?
          AND status = 'pending'
      `, [reviewedByUserId || null, suggestion.entity_id, id]);
    };

    await runApprove();
    await saveDatabase();
    await maybeLearnGenericTermFromSuggestion(details, 'approved');
  },

  async reject(id, reviewedByUserId) {
    const details = await getAsync(`
      SELECT
        als.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        a.canonical_name AS authority_name
      FROM authority_link_suggestions als
      INNER JOIN entities e ON e.id = als.entity_id
      INNER JOIN authorities a ON a.id = als.suggested_authority_id
      WHERE als.id = ?
    `, [id]);
    await runAsync(`
      UPDATE authority_link_suggestions
      SET status = 'rejected',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?
      WHERE id = ?
    `, [reviewedByUserId || null, id]);
    await maybeLearnGenericTermFromSuggestion(details, 'rejected');
  },

  // U3.1/U3.4: Group pending suggestions by entity when ≥2 exist for the same
  // entity. Single-suggestion entities stay as type:'single'. Returns
  // decisionUnits (paginated), totalGroups, totalSingles, totalUnits.
  // Per docs/reviews/2026-05-31-entity-extraction-historian-lens.md U3.1, U3.4.
  async listPendingGrouped({ matchMethodFilter, limit, offset } = {}) {
    const where = Array.isArray(matchMethodFilter) && matchMethodFilter.length > 0
      ? `AND s.match_method IN (${matchMethodFilter.map(() => '?').join(',')})`
      : '';
    const params = Array.isArray(matchMethodFilter) && matchMethodFilter.length > 0
      ? [...matchMethodFilter]
      : [];

    const allPending = await allAsync(`
      SELECT s.*,
             e.canonical_name AS entity_name, e.entity_type,
             a.canonical_name AS suggested_authority_name
      FROM authority_link_suggestions s
      INNER JOIN entities e ON e.id = s.entity_id
      INNER JOIN authorities a ON a.id = s.suggested_authority_id
      WHERE s.status = 'pending'
        AND e.authority_id IS NULL
        ${where}
      ORDER BY s.entity_id ASC, s.created_at DESC
    `, params);

    const byEntity = new Map();
    for (const row of allPending) {
      if (!byEntity.has(row.entity_id)) byEntity.set(row.entity_id, []);
      byEntity.get(row.entity_id).push(row);
    }

    const decisionUnits = [];
    let totalGroups = 0;
    let totalSingles = 0;
    for (const [entityId, rows] of byEntity) {
      if (rows.length >= 2) {
        decisionUnits.push({
          type: 'group',
          entityId,
          entity: { id: entityId, canonical_name: rows[0].entity_name, entity_type: rows[0].entity_type },
          candidates: rows
        });
        totalGroups += 1;
      } else {
        decisionUnits.push({
          type: 'single',
          suggestion: rows[0]
        });
        totalSingles += 1;
      }
    }
    const totalUnits = decisionUnits.length;
    const safeOffset = offset || 0;
    const safeLimit = limit || totalUnits;
    const page = decisionUnits.slice(safeOffset, safeOffset + safeLimit);
    // U3.4 visibility: when total decision-units exceed the requested page
    // size, the route doesn't yet wire load-more for the grouped path, so
    // surface the truncation as a flag the view can render as a notice.
    // Full grouped-path pagination is a follow-up. Per final-review on
    // bundle commit f0ead78.
    const truncated = safeOffset + page.length < totalUnits;
    return { decisionUnits: page, totalGroups, totalSingles, totalUnits, truncated };
  }
};

async function maybeLearnGenericTermFromSuggestion(details, outcome) {
  if (!details) return;
  const enabled = await getAsync("SELECT value FROM settings WHERE key = 'authority_generic_learning_enabled'");
  if (String(enabled?.value ?? '1') === '0') return;
  const entityName = normalizeGenericTerm(details.entity_name);
  const authorityName = normalizeGenericTerm(details.authority_name);
  if (!entityName || entityName !== authorityName) return;
  const existing = await getAsync(`
    SELECT id
    FROM authority_generic_terms
    WHERE normalized_term = ?
      AND ((entity_type IS NULL AND ? IS NULL) OR entity_type = ?)
    LIMIT 1
  `, [entityName, details.entity_type || null, details.entity_type || null]);
  if (outcome === 'approved' && !existing) return;

  const rejectedIncrement = outcome === 'rejected' ? 1 : 0;
  const approvedIncrement = outcome === 'approved' ? 1 : 0;
  const minRejected = parseInt((await getAsync("SELECT value FROM settings WHERE key = 'authority_generic_learning_min_rejections'"))?.value, 10) || 3;
  const minSeen = parseInt((await getAsync("SELECT value FROM settings WHERE key = 'authority_generic_learning_min_seen'"))?.value, 10) || 5;

  if (existing) {
    await authorityGenericTerms.upsert({
      term: details.entity_name,
      entity_type: details.entity_type,
      source: 'review_pattern',
      status: 'suggested',
      seenIncrement: 1,
      rejectedIncrement,
      approvedIncrement
    });
    return;
  }

  if (outcome !== 'rejected') return;

  const aggregate = await getAsync(`
    SELECT
      COUNT(*) AS seen_count,
      SUM(CASE WHEN als.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
    FROM authority_link_suggestions als
    INNER JOIN entities e ON e.id = als.entity_id
    INNER JOIN authorities a ON a.id = als.suggested_authority_id
    WHERE LOWER(TRIM(e.canonical_name)) = LOWER(TRIM(a.canonical_name))
      AND e.entity_type = ?
      AND LOWER(TRIM(e.canonical_name)) = ?
  `, [details.entity_type, entityName]);
  if (
    Number(aggregate?.rejected_count || 0) >= minRejected
    && Number(aggregate?.seen_count || 0) >= minSeen
  ) {
    await authorityGenericTerms.upsert({
      term: details.entity_name,
      entity_type: details.entity_type,
      source: 'review_pattern',
      status: 'suggested',
      seenIncrement: Number(aggregate.seen_count || 0),
      rejectedIncrement: Number(aggregate.rejected_count || 0),
      notes: `Suggested after ${aggregate.rejected_count} rejected exact-name authority links.`
    });
  }
}

const dateExpressions = {
  async create({ entity_id, label, earliest, latest, precision, qualifier, calendar }) {
    const result = await runAsync(`
      INSERT INTO date_expressions (entity_id, label, earliest, latest, precision, qualifier, calendar)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      entity_id,
      label,
      earliest || null,
      latest || null,
      precision || 'unknown',
      qualifier || null,
      calendar || 'gregorian'
    ]);
    return result.lastInsertRowid;
  },

  async findExisting({ entity_id, label, earliest, latest, precision, qualifier, calendar }) {
    return await getAsync(`
      SELECT * FROM date_expressions
      WHERE entity_id = ?
        AND label = ?
        AND COALESCE(earliest, '') = COALESCE(?, '')
        AND COALESCE(latest, '') = COALESCE(?, '')
        AND COALESCE(precision, '') = COALESCE(?, '')
        AND COALESCE(qualifier, '') = COALESCE(?, '')
        AND COALESCE(calendar, '') = COALESCE(?, '')
      LIMIT 1
    `, [
      entity_id,
      label,
      earliest || null,
      latest || null,
      precision || 'unknown',
      qualifier || null,
      calendar || 'gregorian'
    ]);
  },

  async createIfMissing({ entity_id, label, earliest, latest, precision, qualifier, calendar }) {
    const existing = await this.findExisting({
      entity_id,
      label,
      earliest,
      latest,
      precision,
      qualifier,
      calendar
    });
    if (existing) return existing.id;
    return await this.create({ entity_id, label, earliest, latest, precision, qualifier, calendar });
  },

  async getById(id) {
    return await getAsync(`
      SELECT * FROM date_expressions
      WHERE id = ?
    `, [id]);
  },

  async getByEntityId(entityId) {
    return await allAsync(`
      SELECT * FROM date_expressions
      WHERE entity_id = ?
      ORDER BY earliest, latest, label
    `, [entityId]);
  },

  async findInRange(from, to) {
    return await allAsync(`
      SELECT de.*, e.canonical_name, e.entity_type
      FROM date_expressions de
      JOIN entities e ON e.id = de.entity_id
      WHERE COALESCE(de.latest, de.earliest) >= ?
        AND COALESCE(de.earliest, de.latest) <= ?
      ORDER BY de.earliest, de.latest, e.canonical_name
    `, [from, to]);
  }
};

const relationships = {
  async create({ source_entity_id, target_entity_id, relationship_type, label, properties, confidence, start_date, end_date, date_precision, date_qualifier, voice_role, expressed_by_entity_id, described_subject_entity_id }) {
    const result = await runAsync(`
      INSERT INTO relationships (
        source_entity_id, target_entity_id, relationship_type, label, properties,
        confidence, start_date, end_date, date_precision, date_qualifier,
        voice_role, expressed_by_entity_id, described_subject_entity_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      source_entity_id,
      target_entity_id,
      relationship_type,
      label || null,
      typeof properties === 'string' ? properties : JSON.stringify(properties || {}),
      confidence != null ? confidence : null,
      start_date || null,
      end_date || null,
      date_precision || null,
      date_qualifier || null,
      voice_role || null,
      Number.isInteger(expressed_by_entity_id) ? expressed_by_entity_id : null,
      Number.isInteger(described_subject_entity_id) ? described_subject_entity_id : null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    return hydrateRelationship(await getAsync(`
      SELECT
        r.*,
        rt.deprecated_at AS relationship_type_deprecated_at,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      LEFT JOIN relationship_types rt ON rt.name = r.relationship_type
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.id = ?
    `, [id]));
  },

  async getByEntityId(entityId) {
    return (await allAsync(`
      SELECT
        r.*,
        rt.deprecated_at AS relationship_type_deprecated_at,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      LEFT JOIN relationship_types rt ON rt.name = r.relationship_type
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      ORDER BY r.created_at DESC
    `, [entityId, entityId])).map(hydrateRelationship);
  },

  async getByEntityIds(entityIds) {
    const ids = [...new Set((entityIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (await allAsync(`
      SELECT DISTINCT
        r.*,
        rt.deprecated_at AS relationship_type_deprecated_at,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      LEFT JOIN relationship_types rt ON rt.name = r.relationship_type
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.source_entity_id IN (${placeholders})
         OR r.target_entity_id IN (${placeholders})
      ORDER BY r.created_at DESC
    `, [...ids, ...ids])).map(hydrateRelationship);
  },

  async getBetween(entityA, entityB) {
    return (await allAsync(`
      SELECT
        r.*,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE (r.source_entity_id = ? AND r.target_entity_id = ?)
         OR (r.source_entity_id = ? AND r.target_entity_id = ?)
      ORDER BY r.created_at DESC
    `, [entityA, entityB, entityB, entityA])).map(hydrateRelationship);
  },

  async getByDocumentId(documentId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      documentId,
      approvalStatus: opts.approvalStatus || CITATION_APPROVAL_STATUSES.APPROVED
    });
    return (await allAsync(`
      SELECT DISTINCT
        r.*,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      JOIN citations c ON c.relationship_id = r.id
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      ${queryFilter.clause}
      ORDER BY r.created_at DESC
    `, queryFilter.params)).map(hydrateRelationship);
  },

  async findExisting(source_entity_id, target_entity_id, relationship_type) {
    return await getAsync(`
      SELECT * FROM relationships
      WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = ?
    `, [source_entity_id, target_entity_id, relationship_type]);
  },

  async countByDocumentId(documentId) {
    if (!Number.isInteger(documentId)) {
      return { pending: 0, approved: 0, rejected: 0 };
    }
    const rows = await allAsync(`
      SELECT c.approval_status, COUNT(DISTINCT r.id) AS count
      FROM relationships r
      JOIN citations c ON c.relationship_id = r.id
      WHERE c.document_id = ?
      GROUP BY c.approval_status
    `, [documentId]);
    return rows.reduce((acc, row) => {
      const status = row.approval_status || 'pending';
      if (Object.prototype.hasOwnProperty.call(acc, status)) {
        acc[status] = row.count;
      }
      return acc;
    }, { pending: 0, approved: 0, rejected: 0 });
  }
};

const citations = {
  async create({
    entity_id,
    date_expression_id,
    relationship_id,
    transcript_id,
    document_id,
    passage_start,
    passage_end,
    passage_text,
    extraction_method,
    extraction_model,
    confidence,
    approval_status,
    approval_method,
    approved_at,
    approved_by_user_id,
    rejected_at,
    rejected_by_user_id
  }) {
    const approval = deriveCitationApproval(confidence, approval_status || null);
    const finalStatus = approval_status || approval.approvalStatus;
    const finalMethod = approval_method || approval.approvalMethod || null;
    const autoApprovedAt = finalStatus === CITATION_APPROVAL_STATUSES.APPROVED
      ? (approved_at || new Date().toISOString())
      : null;
    const autoRejectedAt = finalStatus === CITATION_APPROVAL_STATUSES.REJECTED
      ? (rejected_at || new Date().toISOString())
      : null;
    const result = await runAsync(`
      INSERT INTO citations (
        entity_id, date_expression_id, relationship_id, transcript_id, document_id,
        passage_start, passage_end, passage_text,
        extraction_method, extraction_model, confidence,
        reviewed_at, reviewed_by_user_id,
        approval_status, approval_method,
        approved_at, approved_by_user_id,
        rejected_at, rejected_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entity_id || null,
      date_expression_id || null,
      relationship_id || null,
      transcript_id,
      document_id,
      passage_start != null ? passage_start : null,
      passage_end != null ? passage_end : null,
      passage_text,
      extraction_method,
      extraction_model || null,
      confidence != null ? confidence : null,
      finalStatus === CITATION_APPROVAL_STATUSES.APPROVED ? autoApprovedAt : null,
      finalStatus === CITATION_APPROVAL_STATUSES.APPROVED ? (approved_by_user_id || null) : null,
      finalStatus,
      finalMethod,
      finalStatus === CITATION_APPROVAL_STATUSES.APPROVED ? autoApprovedAt : null,
      finalStatus === CITATION_APPROVAL_STATUSES.APPROVED ? (approved_by_user_id || null) : null,
      finalStatus === CITATION_APPROVAL_STATUSES.REJECTED ? autoRejectedAt : null,
      finalStatus === CITATION_APPROVAL_STATUSES.REJECTED ? (rejected_by_user_id || null) : null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    return await getAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        r.relationship_type,
        r.start_date AS relationship_start_date,
        r.end_date AS relationship_end_date,
        r.date_precision AS relationship_date_precision,
        r.date_qualifier AS relationship_date_qualifier,
        se.canonical_name AS source_name,
        se.entity_type AS source_type,
        te.canonical_name AS target_name,
        te.entity_type AS target_type,
        d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
      LEFT JOIN entities se ON se.id = r.source_entity_id
      LEFT JOIN entities te ON te.id = r.target_entity_id
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.id = ?
    `, [id]);
  },

  async getByEntityId(entityId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      entityId
    });
    return await allAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN documents d ON d.id = c.document_id
      ${queryFilter.clause}
      ORDER BY c.created_at DESC
    `, queryFilter.params);
  },

  async getByRelationshipId(relationshipId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      relationshipId
    });
    return await allAsync(`
      SELECT
        c.*,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        r.relationship_type,
        r.start_date AS relationship_start_date,
        r.end_date AS relationship_end_date,
        r.date_precision AS relationship_date_precision,
        r.date_qualifier AS relationship_date_qualifier,
        se.canonical_name AS source_name,
        se.entity_type AS source_type,
        te.canonical_name AS target_name,
        te.entity_type AS target_type,
        d.title AS document_title
      FROM citations c
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
      LEFT JOIN entities se ON se.id = r.source_entity_id
      LEFT JOIN entities te ON te.id = r.target_entity_id
      LEFT JOIN documents d ON d.id = c.document_id
      ${queryFilter.clause}
      ORDER BY c.created_at DESC
    `, queryFilter.params);
  },

  async getByDocumentId(documentId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      documentId
    });
    return await allAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      ${queryFilter.clause}
      ORDER BY c.created_at DESC
    `, queryFilter.params);
  },

  async getByTranscriptId(transcriptId, opts = {}) {
    const queryFilter = buildCitationQueryConditions({
      ...opts,
      transcriptId
    });
    return await allAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      ${queryFilter.clause}
      ORDER BY c.created_at DESC
    `, queryFilter.params);
  },

  async getStatusCounts(opts = {}) {
    const access = opts.userId || opts.isAdmin || opts.accessAll
      ? buildAccessibleDocumentFilter(opts, 'c.document_id')
      : { clause: '1=1', params: [] };
    const collection = buildCollectionDocumentFilter(opts.collectionId, 'c.document_id');
    const kindFilter = buildReviewKindFilter(opts.reviewKind, 'c', 'e');
    const rows = await allAsync(`
      SELECT c.approval_status, COUNT(*) AS count
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      WHERE (${access.clause})
        AND (${collection.clause})
        AND (${kindFilter.clause})
      GROUP BY c.approval_status
    `, [...access.params, ...collection.params, ...kindFilter.params]);
    return rows.reduce((acc, row) => {
      acc[row.approval_status || CITATION_APPROVAL_STATUSES.PENDING] = row.count;
      return acc;
    }, {
      [CITATION_APPROVAL_STATUSES.PENDING]: 0,
      [CITATION_APPROVAL_STATUSES.APPROVED]: 0,
      [CITATION_APPROVAL_STATUSES.REJECTED]: 0
    });
  },

  async list(status = 'all', limit = 50, offset = 0, opts = {}) {
    const access = opts.userId || opts.isAdmin || opts.accessAll
      ? buildAccessibleDocumentFilter(opts, 'c.document_id')
      : { clause: '1=1', params: [] };
    const collection = buildCollectionDocumentFilter(opts.collectionId, 'c.document_id');
    const kindFilter = buildReviewKindFilter(opts.reviewKind, 'c', 'e');
    const params = [...access.params, ...collection.params, ...kindFilter.params];
    const statusClause = status === 'all'
      ? ''
      : ' AND c.approval_status = ?';
    if (status !== 'all') {
      params.push(status);
    }
    const sourceFilter = opts.source && typeof opts.source === 'string' ? opts.source : null;
    const sourceClause = sourceFilter ? ' AND c.extraction_method = ?' : '';
    if (sourceFilter) {
      params.push(sourceFilter);
    }
    params.push(limit, offset);
    const orderBy = buildCitationOrderBy(opts.sort);
    return await allAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        r.relationship_type,
        r.start_date AS relationship_start_date,
        r.end_date AS relationship_end_date,
        r.date_precision AS relationship_date_precision,
        r.date_qualifier AS relationship_date_qualifier,
        r.voice_role,
        r.expressed_by_entity_id,
        r.described_subject_entity_id,
        se.canonical_name AS source_name,
        se.entity_type AS source_type,
        te.canonical_name AS target_name,
        te.entity_type AS target_type,
        ec.id AS entity_support_citation_id,
        ec.passage_text AS entity_support_passage_text,
        ec.passage_start AS entity_support_passage_start,
        ec.passage_end AS entity_support_passage_end,
        sec.id AS source_support_citation_id,
        sec.passage_text AS source_support_passage_text,
        sec.passage_start AS source_support_passage_start,
        sec.passage_end AS source_support_passage_end,
        tec.id AS target_support_citation_id,
        tec.passage_text AS target_support_passage_text,
        tec.passage_start AS target_support_passage_start,
        tec.passage_end AS target_support_passage_end,
        d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
      LEFT JOIN relationship_types rt ON rt.name = r.relationship_type
      LEFT JOIN entities se ON se.id = r.source_entity_id
      LEFT JOIN entities te ON te.id = r.target_entity_id
      LEFT JOIN citations ec ON ec.id = (
        ${buildNearestSupportCitationSubquery('c2', 'c.entity_id')}
      )
      LEFT JOIN citations sec ON sec.id = (
        ${buildNearestSupportCitationSubquery('c3', 'r.source_entity_id')}
      )
      LEFT JOIN citations tec ON tec.id = (
        ${buildNearestSupportCitationSubquery('c4', 'r.target_entity_id')}
      )
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE (${access.clause})
        AND (${collection.clause})
        AND (${kindFilter.clause})
        ${statusClause}
        ${sourceClause}
      ${orderBy}
      LIMIT ?
      OFFSET ?
    `, params);
  },

  async getByStatus(status = CITATION_APPROVAL_STATUSES.PENDING, limit = 50, opts = {}) {
    return await this.list(status, limit, 0, opts);
  },

  async getUnreviewed(limit = 50, opts = {}) {
    return await this.getByStatus(CITATION_APPROVAL_STATUSES.PENDING, limit, opts);
  },

  // Spec § "Data flow and query scoping" (Review queue) calls this
  // listPending; we add it as a thin convenience over list(...) so callers
  // that want pending-only review-queue rows can pass { collectionId } (and
  // the rest of the existing opts) directly. The underlying list() already
  // accepts collectionId and joins through document_collections per
  // buildCollectionDocumentFilter — see § "Data flow and query scoping" on
  // the entities-have-no-document_id constraint (we route via citations.document_id).
  async listPending(opts = {}) {
    const { limit = 5000, ...rest } = opts;
    return await this.list(CITATION_APPROVAL_STATUSES.PENDING, limit, 0, rest);
  },

  // Spec § "Dashboard counts" (pending citations split by kind). One
  // query returns { entity, relationship, date, total } for pending
  // citations whose document is in the given collection. The kind split
  // mirrors buildReviewKindFilter: relationship_id NOT NULL is the
  // relationship branch, date_expression_id NOT NULL is the date branch,
  // and everything else is the entity branch.
  async countPendingByCollection(collectionId) {
    const normalizedId = Number(collectionId);
    const zero = { entity: 0, relationship: 0, date: 0, total: 0 };
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return zero;
    const row = await getAsync(`
      SELECT
        SUM(CASE WHEN c.relationship_id IS NULL AND c.date_expression_id IS NULL THEN 1 ELSE 0 END) AS entity,
        SUM(CASE WHEN c.relationship_id IS NOT NULL THEN 1 ELSE 0 END) AS relationship,
        SUM(CASE WHEN c.date_expression_id IS NOT NULL THEN 1 ELSE 0 END) AS date,
        COUNT(*) AS total
      FROM citations c
      WHERE c.approval_status = 'pending'
        AND c.document_id IN (
          SELECT dc.document_id
          FROM document_collections dc
          WHERE dc.collection_id = ?
        )
    `, [normalizedId]);
    return {
      entity: Number(row?.entity || 0),
      relationship: Number(row?.relationship || 0),
      date: Number(row?.date || 0),
      total: Number(row?.total || 0)
    };
  },

  // Total count of citations in a collection at a given approval status,
  // split by review kind. Powers the manage-knowledge review-extractions
  // pagination when the tab is NOT 'pending' — the earlier fallback of
  // `reviewItems.length + offset` lied whenever the current page was a
  // full page (a 200-row status set showed totalPages=1 on page 1, hiding
  // pages 2-4). `status: 'all'` returns the union across statuses.
  async countByCollectionAndStatus(collectionId, status) {
    const normalizedId = Number(collectionId);
    const zero = { entity: 0, relationship: 0, date: 0, total: 0 };
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return zero;
    const ALLOWED_STATUSES = ['pending', 'approved', 'rejected'];
    const conditions = [
      `c.document_id IN (SELECT dc.document_id FROM document_collections dc WHERE dc.collection_id = ?)`
    ];
    const params = [normalizedId];
    if (status && ALLOWED_STATUSES.includes(status)) {
      conditions.push('c.approval_status = ?');
      params.push(status);
    }
    const row = await getAsync(`
      SELECT
        SUM(CASE WHEN c.relationship_id IS NULL AND c.date_expression_id IS NULL THEN 1 ELSE 0 END) AS entity,
        SUM(CASE WHEN c.relationship_id IS NOT NULL THEN 1 ELSE 0 END) AS relationship,
        SUM(CASE WHEN c.date_expression_id IS NOT NULL THEN 1 ELSE 0 END) AS date,
        COUNT(*) AS total
      FROM citations c
      WHERE ${conditions.join(' AND ')}
    `, params);
    return {
      entity: Number(row?.entity || 0),
      relationship: Number(row?.relationship || 0),
      date: Number(row?.date || 0),
      total: Number(row?.total || 0)
    };
  },

  async approve(id, approvedByUserId, method = 'manual') {
    await runAsync(`
      UPDATE citations
      SET reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?,
          approval_status = ?,
          approval_method = ?,
          approved_at = CURRENT_TIMESTAMP,
          approved_by_user_id = ?,
          rejected_at = NULL,
          rejected_by_user_id = NULL
      WHERE id = ?
    `, [
      approvedByUserId || null,
      CITATION_APPROVAL_STATUSES.APPROVED,
      method || 'manual',
      approvedByUserId || null,
      id
    ]);
  },

  async review(id, reviewedByUserId) {
    return await this.approve(id, reviewedByUserId, 'manual');
  },

  async reject(id, rejectedByUserId) {
    await runAsync(`
      UPDATE citations
      SET reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?,
          approval_status = ?,
          approval_method = 'manual',
          rejected_at = CURRENT_TIMESTAMP,
          rejected_by_user_id = ?,
          approved_at = NULL,
          approved_by_user_id = NULL
      WHERE id = ?
    `, [
      rejectedByUserId || null,
      CITATION_APPROVAL_STATUSES.REJECTED,
      rejectedByUserId || null,
      id
    ]);
  },

  async rejectByDocumentEntity(documentId, entityId, rejectedByUserId) {
    const result = await runAsync(`
      UPDATE citations
      SET reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?,
          approval_status = ?,
          approval_method = 'manual',
          rejected_at = CURRENT_TIMESTAMP,
          rejected_by_user_id = ?,
          approved_at = NULL,
          approved_by_user_id = NULL
      WHERE document_id = ?
        AND entity_id = ?
        AND approval_status = ?
    `, [
      rejectedByUserId || null,
      CITATION_APPROVAL_STATUSES.REJECTED,
      rejectedByUserId || null,
      documentId,
      entityId,
      CITATION_APPROVAL_STATUSES.APPROVED
    ]);
    return result.changes || 0;
  },

  async rejectByDocumentRelationship(documentId, relationshipId, rejectedByUserId) {
    const result = await runAsync(`
      UPDATE citations
      SET reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by_user_id = ?,
          approval_status = ?,
          approval_method = 'manual',
          rejected_at = CURRENT_TIMESTAMP,
          rejected_by_user_id = ?,
          approved_at = NULL,
          approved_by_user_id = NULL
      WHERE document_id = ?
        AND relationship_id = ?
        AND approval_status = ?
    `, [
      rejectedByUserId || null,
      CITATION_APPROVAL_STATUSES.REJECTED,
      rejectedByUserId || null,
      documentId,
      relationshipId,
      CITATION_APPROVAL_STATUSES.APPROVED
    ]);
    return result.changes || 0;
  },

  async getByEntityIds(entityIds, opts = {}) {
    if (!entityIds.length) return [];
    const placeholders = entityIds.map(() => '?').join(',');
    const { clause, params } = buildCitationQueryConditions(opts);
    // clause is either '' or 'WHERE ...' — strip the WHERE prefix so we can AND it
    const extra = clause ? 'AND ' + clause.replace(/^WHERE\s+/i, '') : '';
    const rows = await allAsync(`
      SELECT
        c.*,
        e.canonical_name AS entity_name,
        e.entity_type,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.entity_id IN (${placeholders}) ${extra}
      ORDER BY c.created_at DESC
    `, [...entityIds, ...params]);
    return rows;
  },

  async getByRelationshipIds(relationshipIds, opts = {}) {
    if (!relationshipIds.length) return [];
    const placeholders = relationshipIds.map(() => '?').join(',');
    const { clause, params } = buildCitationQueryConditions(opts);
    const extra = clause ? 'AND ' + clause.replace(/^WHERE\s+/i, '') : '';
    const rows = await allAsync(`
      SELECT
        c.*,
        de.label AS date_label,
        de.earliest AS date_earliest,
        de.latest AS date_latest,
        de.precision AS date_precision,
        de.qualifier AS date_qualifier,
        r.relationship_type,
        r.start_date AS relationship_start_date,
        r.end_date AS relationship_end_date,
        r.date_precision AS relationship_date_precision,
        r.date_qualifier AS relationship_date_qualifier,
        se.canonical_name AS source_name,
        se.entity_type AS source_type,
        te.canonical_name AS target_name,
        te.entity_type AS target_type,
        d.title AS document_title
      FROM citations c
      LEFT JOIN date_expressions de ON de.id = c.date_expression_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
      LEFT JOIN entities se ON se.id = r.source_entity_id
      LEFT JOIN entities te ON te.id = r.target_entity_id
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.relationship_id IN (${placeholders}) ${extra}
      ORDER BY c.created_at DESC
    `, [...relationshipIds, ...params]);
    return rows;
  },

  async delete(id) {
    return await runAsync('DELETE FROM citations WHERE id = ?', [id]);
  }
};

const graphMaintenance = {
  async resetTranscriptExtraction(transcriptId) {
    const transcriptCitations = await allAsync(`
      SELECT entity_id, relationship_id
      FROM citations
      WHERE transcript_id = ?
    `, [transcriptId]);

    if (!transcriptCitations.length) {
      return {
        deletedCitations: 0,
        deletedRelationships: 0,
        deletedEntities: 0
      };
    }

    const entityIds = [...new Set(
      transcriptCitations
        .map((row) => row.entity_id)
        .filter((value) => Number.isInteger(value))
    )];
    const relationshipIds = [...new Set(
      transcriptCitations
        .map((row) => row.relationship_id)
        .filter((value) => Number.isInteger(value))
    )];

    await runAsync('DELETE FROM citations WHERE transcript_id = ?', [transcriptId]);

    let deletedRelationships = 0;
    for (const relationshipId of relationshipIds) {
      const stillReferenced = await getAsync(`
        SELECT 1
        FROM citations
        WHERE relationship_id = ?
        LIMIT 1
      `, [relationshipId]);
      if (!stillReferenced) {
        await runAsync('DELETE FROM relationships WHERE id = ?', [relationshipId]);
        deletedRelationships += 1;
      }
    }

    let deletedEntities = 0;
    for (const entityId of entityIds) {
      const hasCitations = await getAsync(`
        SELECT 1
        FROM citations
        WHERE entity_id = ?
        LIMIT 1
      `, [entityId]);
      const hasRelationships = await getAsync(`
        SELECT 1
        FROM relationships
        WHERE source_entity_id = ? OR target_entity_id = ?
        LIMIT 1
      `, [entityId, entityId]);

      if (!hasCitations && !hasRelationships) {
        await runAsync('DELETE FROM entity_aliases WHERE entity_id = ?', [entityId]);
        await runAsync('DELETE FROM date_expressions WHERE entity_id = ?', [entityId]);
        await runAsync('DELETE FROM entities WHERE id = ?', [entityId]);
        deletedEntities += 1;
      }
    }

    return {
      deletedCitations: transcriptCitations.length,
      deletedRelationships,
      deletedEntities
    };
  },

  /**
   * Collect the IDs of all citations currently linked to a transcript.
   * Call this BEFORE writing new extraction data, then pass the IDs to
   * resetCitationsById AFTER the new data is committed. This ensures the
   * transcript always has graph coverage — old data is only removed once
   * the new data is safely written.
   */
  async getPreExistingCitationIds(transcriptId) {
    const rows = await allAsync(
      'SELECT id FROM citations WHERE transcript_id = ?',
      [transcriptId]
    );
    return rows.map((r) => r.id).filter((v) => Number.isInteger(v));
  },

  /**
   * Delete a specific set of citations by ID, then clean up any orphaned
   * relationships and entities that are no longer referenced. Used as the
   * post-write cleanup step in staged reruns.
   */
  async resetCitationsById(citationIds) {
    if (!citationIds || citationIds.length === 0) {
      return { deletedCitations: 0, deletedRelationships: 0, deletedEntities: 0 };
    }

    const placeholders = citationIds.map(() => '?').join(',');
    const affectedCitations = await allAsync(
      `SELECT entity_id, relationship_id FROM citations WHERE id IN (${placeholders})`,
      citationIds
    );

    const entityIds = [...new Set(
      affectedCitations.map((r) => r.entity_id).filter((v) => Number.isInteger(v))
    )];
    const relationshipIds = [...new Set(
      affectedCitations.map((r) => r.relationship_id).filter((v) => Number.isInteger(v))
    )];

    await runAsync(`DELETE FROM citations WHERE id IN (${placeholders})`, citationIds);

    let deletedRelationships = 0;
    for (const relationshipId of relationshipIds) {
      const stillReferenced = await getAsync(`
        SELECT 1 FROM citations WHERE relationship_id = ? LIMIT 1
      `, [relationshipId]);
      if (!stillReferenced) {
        await runAsync('DELETE FROM relationships WHERE id = ?', [relationshipId]);
        deletedRelationships += 1;
      }
    }

    let deletedEntities = 0;
    for (const entityId of entityIds) {
      const hasCitations = await getAsync(
        'SELECT 1 FROM citations WHERE entity_id = ? LIMIT 1',
        [entityId]
      );
      const hasRelationships = await getAsync(`
        SELECT 1 FROM relationships
        WHERE source_entity_id = ? OR target_entity_id = ?
        LIMIT 1
      `, [entityId, entityId]);

      if (!hasCitations && !hasRelationships) {
        await runAsync('DELETE FROM entity_aliases WHERE entity_id = ?', [entityId]);
        await runAsync('DELETE FROM date_expressions WHERE entity_id = ?', [entityId]);
        await runAsync('DELETE FROM entities WHERE id = ?', [entityId]);
        deletedEntities += 1;
      }
    }

    return {
      deletedCitations: citationIds.length,
      deletedRelationships,
      deletedEntities
    };
  }
};

const relationshipTypes = {
  async getAll() {
    return await allAsync(`
      SELECT * FROM relationship_types
      ORDER BY category, label
    `);
  },

  async resolve(name, { includeDeprecated = false } = {}) {
    if (!name) return null;
    const activeClause = includeDeprecated ? '' : ' AND deprecated_at IS NULL';
    const exact = await getAsync(`SELECT name FROM relationship_types WHERE name = ?${activeClause}`, [name]);
    if (exact) return exact.name;
    const normalized = String(name).trim().toLowerCase().replace(/\s+/g, '_');
    const byNormalized = await getAsync(`SELECT name FROM relationship_types WHERE name = ?${activeClause}`, [normalized]);
    return byNormalized ? byNormalized.name : null;
  },

  async create({ name, label, inverse_name, source_type, target_type, category }) {
    await runAsync(`
      INSERT OR IGNORE INTO relationship_types (name, label, inverse_name, source_type, target_type, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      name,
      label || name,
      inverse_name || null,
      source_type || null,
      target_type || null,
      category || 'general'
    ]);
  },

  async listAll() {
    return await allAsync(`
      SELECT *,
        (SELECT COUNT(*) FROM relationships r WHERE r.relationship_type = rt.name) AS usage_count
      FROM relationship_types rt
      ORDER BY rt.category, rt.label
    `);
  },

  async listActive() {
    return await allAsync(`
      SELECT *,
        (SELECT COUNT(*) FROM relationships r WHERE r.relationship_type = rt.name) AS usage_count
      FROM relationship_types rt
      WHERE rt.deprecated_at IS NULL
      ORDER BY rt.category, rt.label
    `);
  },

  async getUsageCount(name) {
    const row = await getAsync(
      `SELECT COUNT(*) AS n FROM relationships WHERE relationship_type = ?`,
      [String(name)]
    );
    return row ? Number(row.n) : 0;
  },

  async update(name, fields) {
    // Per C4 v1: name (PK) is immutable. We deliberately strip it from the
    // payload so deprecation is the only mechanism for retiring a type.
    const updatable = ['label', 'inverse_name', 'source_type', 'target_type', 'category', 'frequency'];
    const sets = [];
    const params = [];
    for (const key of updatable) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(fields[key] === '' ? null : fields[key]);
      }
    }
    if (!sets.length) return;
    params.push(String(name));
    await runAsync(`UPDATE relationship_types SET ${sets.join(', ')} WHERE name = ?`, params);
    await saveDatabase();
  },

  async deprecate(name) {
    await runAsync(
      `UPDATE relationship_types SET deprecated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      [String(name)]
    );
    await saveDatabase();
  },

  async reactivate(name) {
    await runAsync(
      `UPDATE relationship_types SET deprecated_at = NULL WHERE name = ?`,
      [String(name)]
    );
    await saveDatabase();
  }
};

const graphAccess = {
  async searchEntities(query, userId, isAdmin, accessAll, limit = 50, collectionId = null) {
    const sanitized = String(query || '').replace(/['"]/g, '').trim();
    if (!sanitized) return [];
    const access = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    if (isFts5Available()) {
      const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');
      try {
        const rows = (await allAsync(`
          SELECT DISTINCT e.*
          FROM entities e
          LEFT JOIN authorities a ON a.id = e.authority_id
          INNER JOIN citations c ON c.entity_id = e.id
          WHERE (${access.clause})
            AND e.entity_type != 'date'
            AND (e.id IN (
              SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?
              UNION
              SELECT ea.entity_id FROM entity_aliases ea
              JOIN entity_aliases_fts af ON af.rowid = ea.id
              WHERE entity_aliases_fts MATCH ?
            ) OR a.canonical_name LIKE ?)
          ORDER BY COALESCE(a.canonical_name, e.canonical_name), e.canonical_name
          LIMIT ?
        `, [...access.params, ftsQuery, ftsQuery, `%${sanitized}%`, limit * 5])).map(hydrateEntity);
        return await projectGraphNodes(rows, { userId, isAdmin, accessAll, collectionId, limit });
      } catch (err) {
        // fall through to LIKE
      }
    }
    const pattern = `%${sanitized}%`;
    const rows = (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      LEFT JOIN authorities a ON a.id = e.authority_id
      INNER JOIN citations c ON c.entity_id = e.id
      WHERE (${access.clause})
        AND e.entity_type != 'date'
        AND (e.canonical_name LIKE ? OR ea.alias LIKE ? OR a.canonical_name LIKE ?)
      ORDER BY COALESCE(a.canonical_name, e.canonical_name), e.canonical_name
      LIMIT ?
    `, [...access.params, pattern, pattern, pattern, limit * 5])).map(hydrateEntity);
    return await projectGraphNodes(rows, { userId, isAdmin, accessAll, collectionId, limit });
  },

  async getEntitiesByType(entityType, userId, isAdmin, accessAll, limit = 50, offset = 0, collectionId = null) {
    const access = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    const params = [...access.params];
    let typeClause = '';
    if (entityType) {
      typeClause = 'AND e.entity_type = ?';
      params.push(entityType);
    }
    params.push(limit * 5, offset);
    const rows = (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      LEFT JOIN authorities a ON a.id = e.authority_id
      INNER JOIN citations c ON c.entity_id = e.id
      WHERE (${access.clause})
        AND e.entity_type != 'date'
        ${typeClause}
      ORDER BY COALESCE(a.canonical_name, e.canonical_name), e.canonical_name
      LIMIT ? OFFSET ?
    `, params)).map(hydrateEntity);
    return await projectGraphNodes(rows, { userId, isAdmin, accessAll, collectionId, limit });
  },

  async canAccessEntity(entityId, userId, isAdmin, accessAll, collectionId = null) {
    const access = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    const row = await getAsync(`
      SELECT 1
      FROM citations c
      WHERE c.entity_id = ?
        AND (${access.clause})
      LIMIT 1
    `, [entityId, ...access.params]);
    return !!row;
  },

  async getAuthorityContext(entityId, userId, isAdmin, accessAll, collectionId = null) {
    const entity = await entities.getById(entityId);
    if (!entity) {
      return { entity: null, authority: null, linkedEntities: [], centerEntityIds: [] };
    }
    if (!Number.isInteger(entity.authority_id)) {
      return {
        entity,
        authority: null,
        linkedEntities: [entity],
        graphNode: await buildEntityGraphNode(entity, { userId, isAdmin, accessAll, collectionId }),
        centerEntityIds: [entity.id]
      };
    }

    const visibility = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    const linkedEntities = (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      WHERE e.authority_id = ?
        AND (${visibility.clause})
      ORDER BY e.canonical_name
    `, [entity.authority_id, ...visibility.params])).map(hydrateEntity);

    return {
      entity,
      authority: await authorities.getById(entity.authority_id),
      linkedEntities,
      graphNode: await buildAuthorityGraphNode(entity.authority_id, linkedEntities, { userId, isAdmin, accessAll, collectionId }),
      centerEntityIds: linkedEntities.length ? linkedEntities.map((row) => row.id) : [entity.id]
    };
  },

  async getNeighbors(entityId, userId, isAdmin, accessAll, collectionId = null, opts = {}) {
    const context = await this.getAuthorityContext(entityId, userId, isAdmin, accessAll, collectionId);
    const centerEntityIds = Array.from(new Set(
      (context.centerEntityIds || []).filter((value) => Number.isInteger(value))
    ));
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    if (!centerEntityIds.length) {
      return { neighbors: [], total: 0, limit, offset, hasMore: false, nextOffset: null };
    }

    const visibility = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    const centerPlaceholders = centerEntityIds.map(() => '?').join(',');
    const rows = await allAsync(`
      SELECT
        c.id AS citation_id,
        r.id AS relationship_id,
        r.relationship_type,
        r.confidence,
        r.start_date,
        r.end_date,
        r.date_precision,
        r.date_qualifier,
        c.passage_text AS evidence_text,
        CASE WHEN r.source_entity_id IN (${centerPlaceholders}) THEN 'outgoing' ELSE 'incoming' END AS direction,
        other.id AS other_entity_id,
        other.canonical_name AS other_entity_name,
        other.entity_type AS other_entity_type,
        other.description AS other_entity_description,
        other.authority_id AS other_authority_id,
        oa.canonical_name AS other_authority_name,
        oa.authority_type AS other_authority_type,
        c.document_id AS evidence_document_id
      FROM relationships r
      INNER JOIN citations c ON c.relationship_id = r.id
      INNER JOIN entities other
        ON other.id = CASE
          WHEN r.source_entity_id IN (${centerPlaceholders}) THEN r.target_entity_id
          ELSE r.source_entity_id
        END
      LEFT JOIN authorities oa ON oa.id = other.authority_id
      WHERE (
        (r.source_entity_id IN (${centerPlaceholders}) AND r.target_entity_id NOT IN (${centerPlaceholders}))
        OR
        (r.target_entity_id IN (${centerPlaceholders}) AND r.source_entity_id NOT IN (${centerPlaceholders}))
      )
        AND other.entity_type != 'date'
        AND (${visibility.clause})
      ORDER BY other.canonical_name, r.id, c.id
    `, [
      ...centerEntityIds,
      ...centerEntityIds,
      ...centerEntityIds,
      ...centerEntityIds,
      ...centerEntityIds,
      ...centerEntityIds,
      ...visibility.params
    ]);

    const grouped = new Map();
    for (const row of rows) {
      const hasAuthority = Number.isInteger(row.other_authority_id);
      const key = hasAuthority ? `authority:${row.other_authority_id}` : `entity:${row.other_entity_id}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: row.other_entity_id,
          canonical_name: hasAuthority ? row.other_authority_name : row.other_entity_name,
          entity_type: hasAuthority ? row.other_authority_type : row.other_entity_type,
          description: row.other_entity_description || '',
          authority_id: hasAuthority ? row.other_authority_id : null,
          node_kind: hasAuthority ? 'authority' : 'entity',
          graph_node_id: key,
          member_entity_ids: new Set(),
          document_ids: new Set(),
          citation_ids: new Set(),
          relationship_ids: new Set(),
          relationship_types: new Set(),
          directions: new Set(),
          evidence_texts: []
        });
      }
      const entry = grouped.get(key);
      entry.member_entity_ids.add(row.other_entity_id);
      if (row.evidence_document_id) entry.document_ids.add(row.evidence_document_id);
      if (row.citation_id) entry.citation_ids.add(row.citation_id);
      entry.relationship_ids.add(row.relationship_id);
      entry.relationship_types.add(row.relationship_type || 'related_to');
      entry.directions.add(row.direction === 'incoming' ? 'incoming' : 'outgoing');
      if (row.evidence_text && !entry.evidence_texts.includes(row.evidence_text) && entry.evidence_texts.length < 3) {
        entry.evidence_texts.push(row.evidence_text);
      }
    }

    const allNeighbors = Array.from(grouped.values()).map((entry) => ({
      id: entry.id,
      canonical_name: entry.canonical_name,
      entity_type: entry.entity_type,
      description: entry.description,
      authority_id: entry.authority_id,
      node_kind: entry.node_kind,
      graph_node_id: entry.graph_node_id,
      member_entity_ids: Array.from(entry.member_entity_ids),
      member_count: entry.member_entity_ids.size,
      document_count: entry.document_ids.size,
      citation_count: entry.citation_ids.size,
      relationship_id: entry.relationship_ids.size === 1 ? Array.from(entry.relationship_ids)[0] : null,
      relationship_ids: Array.from(entry.relationship_ids),
      relationship_type: Array.from(entry.relationship_types).join(', '),
      relationship_types: Array.from(entry.relationship_types),
      direction: entry.directions.size === 1 ? Array.from(entry.directions)[0] : 'mixed',
      evidence_text: entry.evidence_texts[0] || null,
      evidence_texts: entry.evidence_texts
    })).sort((a, b) => {
      if (b.citation_count !== a.citation_count) return b.citation_count - a.citation_count;
      if (b.document_count !== a.document_count) return b.document_count - a.document_count;
      if (b.relationship_ids.length !== a.relationship_ids.length) return b.relationship_ids.length - a.relationship_ids.length;
      if (b.member_count !== a.member_count) return b.member_count - a.member_count;
      return String(a.canonical_name || '').localeCompare(String(b.canonical_name || ''));
    });

    const total = allNeighbors.length;
    const neighbors = allNeighbors.slice(offset, offset + limit);
    const nextOffset = offset + neighbors.length;
    return {
      neighbors,
      total,
      limit,
      offset,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null
    };
  }
};

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function getVisibleCitationStats(entityIds, opts = {}) {
  const ids = Array.from(new Set((entityIds || []).map(normalizePositiveInteger).filter(Boolean)));
  if (!ids.length) {
    return { citationCount: 0, documentCount: 0 };
  }
  const placeholders = ids.map(() => '?').join(',');
  const visibility = buildKnowledgeCitationVisibilityFilter(opts, 'c', 'c.document_id');
  const row = await getAsync(`
    SELECT
      COUNT(DISTINCT c.id) AS citation_count,
      COUNT(DISTINCT c.document_id) AS document_count
    FROM citations c
    WHERE c.entity_id IN (${placeholders})
      AND (${visibility.clause})
  `, [...ids, ...visibility.params]);
  return {
    citationCount: Number(row?.citation_count || 0),
    documentCount: Number(row?.document_count || 0)
  };
}

async function getVisibleAuthorityMembers(authorityId, opts = {}) {
  const normalizedAuthorityId = normalizePositiveInteger(authorityId);
  if (!normalizedAuthorityId) return [];
  const visibility = buildKnowledgeCitationVisibilityFilter(opts, 'c', 'c.document_id');
  return (await allAsync(`
    SELECT DISTINCT e.*
    FROM entities e
    INNER JOIN citations c ON c.entity_id = e.id
    WHERE e.authority_id = ?
      AND e.entity_type != 'date'
      AND (${visibility.clause})
    ORDER BY e.canonical_name, e.id
  `, [normalizedAuthorityId, ...visibility.params])).map(hydrateEntity);
}

async function buildEntityGraphNode(entity, opts = {}) {
  if (!entity) return null;
  const stats = await getVisibleCitationStats([entity.id], opts);
  return {
    ...entity,
    node_kind: 'entity',
    graph_node_id: `entity:${entity.id}`,
    authority_id: null,
    member_entity_ids: [entity.id],
    member_count: 1,
    document_count: stats.documentCount,
    citation_count: stats.citationCount
  };
}

async function buildAuthorityGraphNode(authorityId, visibleMembers, opts = {}) {
  const authority = await authorities.getById(authorityId);
  const members = visibleMembers && visibleMembers.length
    ? visibleMembers
    : await getVisibleAuthorityMembers(authorityId, opts);
  if (!authority || !members.length) return null;
  const memberIds = members.map((member) => member.id);
  const stats = await getVisibleCitationStats(memberIds, opts);
  const representative = members[0];
  return {
    id: representative.id,
    entity_type: authority.authority_type || representative.entity_type,
    canonical_name: authority.canonical_name || representative.canonical_name,
    description: authority.description || representative.description || '',
    properties: authority.properties || {},
    authority_id: authority.id,
    node_kind: 'authority',
    graph_node_id: `authority:${authority.id}`,
    member_entity_ids: memberIds,
    member_count: memberIds.length,
    document_count: stats.documentCount,
    citation_count: stats.citationCount
  };
}

async function projectGraphNodes(entityRows, opts = {}) {
  const grouped = new Map();
  for (const row of entityRows || []) {
    if (!row || !row.id) continue;
    const authorityId = normalizePositiveInteger(row.authority_id);
    const key = authorityId ? `authority:${authorityId}` : `entity:${row.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        authorityId,
        entities: []
      });
    }
    grouped.get(key).entities.push(row);
  }

  const projected = [];
  for (const group of grouped.values()) {
    const node = group.authorityId
      ? await buildAuthorityGraphNode(group.authorityId, null, opts)
      : await buildEntityGraphNode(group.entities[0], opts);
    if (node) projected.push(node);
  }

  const limit = Math.max(1, parseInt(opts.limit, 10) || projected.length || 50);
  return projected
    .sort((a, b) => String(a.canonical_name || '').localeCompare(String(b.canonical_name || '')))
    .slice(0, limit);
}

function parseJsonValue(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateAuthority(row) {
  if (!row) return row;
  return {
    ...row,
    properties: parseJsonValue(row.properties, {})
  };
}

function hydrateEntity(row) {
  if (!row) return row;
  return {
    ...row,
    properties: parseJsonValue(row.properties, {})
  };
}

function hydrateRelationship(row) {
  if (!row) return row;
  return {
    ...row,
    properties: parseJsonValue(row.properties, {})
  };
}

function buildAccessibleDocumentFilter(opts = {}, column = 'c.document_id') {
  const { userId, isAdmin, accessAll } = opts;
  if (isAdmin || accessAll) {
    return { clause: '1=1', params: [] };
  }
  if (!userId) {
    return {
      clause: `${column} IN (
        SELECT dc.document_id
        FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_world_public = 1
      )`,
      params: []
    };
  }
  return {
    clause: `${column} IN (
      SELECT dc.document_id
      FROM document_collections dc
      INNER JOIN collections col ON dc.collection_id = col.id
      LEFT JOIN user_collection_access uca
        ON dc.collection_id = uca.collection_id AND uca.user_id = ?
      WHERE col.is_public = 1 OR col.is_world_public = 1 OR uca.user_id IS NOT NULL
    )`,
    params: [userId]
  };
}

function buildCollectionDocumentFilter(collectionId, column = 'c.document_id') {
  const normalizedId = Number(collectionId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return { clause: '1=1', params: [] };
  }
  return {
    clause: `${column} IN (
      SELECT dc.document_id
      FROM document_collections dc
      WHERE dc.collection_id = ?
    )`,
    params: [normalizedId]
  };
}

function buildKnowledgeCitationVisibilityFilter(opts = {}, citationAlias = 'c', documentColumn = `${citationAlias}.document_id`) {
  const access = buildAccessibleDocumentFilter(opts, documentColumn);
  const collection = buildCollectionDocumentFilter(opts.collectionId, documentColumn);
  return {
    clause: `(${access.clause}) AND (${collection.clause}) AND ${citationAlias}.approval_status = ?`,
    params: [...access.params, ...collection.params, CITATION_APPROVAL_STATUSES.APPROVED]
  };
}

function buildReviewKindFilter(reviewKind, citationAlias = 'c', entityAlias = 'e') {
  const normalized = String(reviewKind || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') {
    return { clause: '1=1', params: [] };
  }

  if (normalized === 'date') {
    return {
      clause: `${citationAlias}.date_expression_id IS NOT NULL`,
      params: []
    };
  }

  if (normalized === 'relationship') {
    return {
      clause: `${citationAlias}.relationship_id IS NOT NULL`,
      params: []
    };
  }

  if (normalized === 'entity') {
    return {
      clause: `${citationAlias}.relationship_id IS NULL AND ${citationAlias}.date_expression_id IS NULL`,
      params: []
    };
  }

  if (REVIEW_KIND_ENTITY_TYPES.has(normalized)) {
    return {
      clause: `${entityAlias}.entity_type = ?`,
      params: [normalized]
    };
  }

  return { clause: '1=1', params: [] };
}

function buildNearestSupportCitationSubquery(candidateAlias, entityExpression) {
  return `
        SELECT ranked.id
        FROM (
          SELECT
            ${candidateAlias}.id AS id,
            ABS(COALESCE(${candidateAlias}.passage_start, 0) - COALESCE(c.passage_start, 0)) AS distance_from_primary
          FROM citations ${candidateAlias}
          WHERE ${candidateAlias}.entity_id = ${entityExpression}
            AND ${candidateAlias}.transcript_id = c.transcript_id
            AND ${candidateAlias}.id != c.id
            AND ${candidateAlias}.relationship_id IS NULL
            AND ${candidateAlias}.date_expression_id IS NULL
          ORDER BY distance_from_primary ASC, ${candidateAlias}.id DESC
          LIMIT 1
        ) ranked
      `;
}

function buildCitationOrderBy(sort) {
  const normalized = String(sort || 'newest').toLowerCase();
  if (normalized === 'rare-type-first') {
    return `
      ORDER BY
        CASE COALESCE(rt.frequency, 'common')
          WHEN 'rare' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END ASC,
        c.created_at DESC
    `;
  }
  if (normalized === 'low-confidence-first') {
    return 'ORDER BY COALESCE(c.confidence, 0) ASC, c.created_at DESC';
  }
  // newest (default)
  return 'ORDER BY c.created_at DESC';
}

function buildCitationQueryConditions(opts = {}, alias = 'c') {
  const clauses = [];
  const params = [];

  // Document access filter — only applied when caller passes access opts
  if (opts.userId !== undefined || opts.isAdmin || opts.accessAll) {
    const access = buildAccessibleDocumentFilter(opts, `${alias}.document_id`);
    if (access.clause !== '1=1') {
      clauses.push(access.clause);
      params.push(...access.params);
    }
  }

  if (opts.approvalStatus) {
    clauses.push(`${alias}.approval_status = ?`);
    params.push(opts.approvalStatus);
  }

  if (Number.isInteger(Number(opts.collectionId)) && Number(opts.collectionId) > 0) {
    clauses.push(`${alias}.document_id IN (
      SELECT dc.document_id
      FROM document_collections dc
      WHERE dc.collection_id = ?
    )`);
    params.push(Number(opts.collectionId));
  }

  if (Number.isInteger(Number(opts.documentId)) && Number(opts.documentId) > 0) {
    clauses.push(`${alias}.document_id = ?`);
    params.push(Number(opts.documentId));
  }

  if (Number.isInteger(Number(opts.transcriptId)) && Number(opts.transcriptId) > 0) {
    clauses.push(`${alias}.transcript_id = ?`);
    params.push(Number(opts.transcriptId));
  }

  if (Number.isInteger(Number(opts.entityId)) && Number(opts.entityId) > 0) {
    clauses.push(`${alias}.entity_id = ?`);
    params.push(Number(opts.entityId));
  }

  if (Number.isInteger(Number(opts.relationshipId)) && Number(opts.relationshipId) > 0) {
    clauses.push(`${alias}.relationship_id = ?`);
    params.push(Number(opts.relationshipId));
  }

  return {
    clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}


  return {
    entities,
    entityAliases,
    authorities,
    authorityLinkSuggestions,
    authorityGenericTerms,
    dateExpressions,
    relationships,
    citations,
    graphMaintenance,
    relationshipTypes,
    graphAccess,
    hydrateEntity,
    hydrateRelationship,
    buildAccessibleDocumentFilter,
    buildCollectionDocumentFilter,
    buildKnowledgeCitationVisibilityFilter,
    buildCitationQueryConditions
  };
};
