'use strict';
const { CITATION_APPROVAL_STATUSES, deriveCitationApproval } = require('../../utils/knowledge-approval');

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, isFts5Available = () => false) => {
const entities = {
  async create({ entity_type, canonical_name, description, properties }) {
    const result = await runAsync(`
      INSERT INTO entities (entity_type, canonical_name, description, properties)
      VALUES (?, ?, ?, ?)
    `, [
      entity_type,
      canonical_name,
      description || null,
      JSON.stringify(properties || {})
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
      SET canonical_name = ?, description = ?, properties = ?
      WHERE id = ?
    `, [
      fields.canonical_name !== undefined ? fields.canonical_name : existing.canonical_name,
      fields.description !== undefined ? fields.description : existing.description,
      fields.properties !== undefined ? JSON.stringify(fields.properties || {}) : JSON.stringify(existing.properties || {}),
      id
    ]);
    return await this.getById(id);
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
  async create({ source_entity_id, target_entity_id, relationship_type, label, properties, confidence, start_date, end_date, date_precision, date_qualifier }) {
    const result = await runAsync(`
      INSERT INTO relationships (
        source_entity_id, target_entity_id, relationship_type, label, properties,
        confidence, start_date, end_date, date_precision, date_qualifier
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      source_entity_id,
      target_entity_id,
      relationship_type,
      label || null,
      JSON.stringify(properties || {}),
      confidence != null ? confidence : null,
      start_date || null,
      end_date || null,
      date_precision || null,
      date_qualifier || null
    ]);
    return result.lastInsertRowid;
  },

  async getById(id) {
    return hydrateRelationship(await getAsync(`
      SELECT
        r.*,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.id = ?
    `, [id]));
  },

  async getByEntityId(entityId) {
    return (await allAsync(`
      SELECT
        r.*,
        se.canonical_name AS source_name, se.entity_type AS source_type,
        te.canonical_name AS target_name, te.entity_type AS target_type
      FROM relationships r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      ORDER BY r.created_at DESC
    `, [entityId, entityId])).map(hydrateRelationship);
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
  }
};

const citations = {
  async create({
    entity_id,
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
        entity_id, relationship_id, transcript_id, document_id,
        passage_start, passage_end, passage_text,
        extraction_method, extraction_model, confidence,
        reviewed_at, reviewed_by_user_id,
        approval_status, approval_method,
        approved_at, approved_by_user_id,
        rejected_at, rejected_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entity_id || null,
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
      SELECT c.*, e.canonical_name AS entity_name, e.entity_type,
             r.relationship_type, d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
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
      SELECT c.*, d.title AS document_title
      FROM citations c
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
      SELECT c.*, d.title AS document_title
      FROM citations c
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
      SELECT c.*, e.canonical_name AS entity_name, e.entity_type
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
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
      SELECT c.*, e.canonical_name AS entity_name, e.entity_type
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      ${queryFilter.clause}
      ORDER BY c.created_at DESC
    `, queryFilter.params);
  },

  async getStatusCounts(opts = {}) {
    const access = opts.userId || opts.isAdmin || opts.accessAll
      ? buildAccessibleDocumentFilter(opts, 'c.document_id')
      : { clause: '1=1', params: [] };
    const collection = buildCollectionDocumentFilter(opts.collectionId, 'c.document_id');
    const rows = await allAsync(`
      SELECT c.approval_status, COUNT(*) AS count
      FROM citations c
      WHERE (${access.clause})
        AND (${collection.clause})
      GROUP BY c.approval_status
    `, [...access.params, ...collection.params]);
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
    const params = [...access.params, ...collection.params];
    const statusClause = status === 'all'
      ? ''
      : ' AND c.approval_status = ?';
    if (status !== 'all') {
      params.push(status);
    }
    params.push(limit, offset);
    return await allAsync(`
      SELECT c.*, e.canonical_name AS entity_name, e.entity_type,
             r.relationship_type, d.title AS document_title
      FROM citations c
      LEFT JOIN entities e ON e.id = c.entity_id
      LEFT JOIN relationships r ON r.id = c.relationship_id
      LEFT JOIN documents d ON d.id = c.document_id
      WHERE (${access.clause})
        AND (${collection.clause})
        ${statusClause}
      ORDER BY c.created_at DESC
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
      SELECT c.*, d.title AS document_title
      FROM citations c
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
      SELECT c.*, d.title AS document_title
      FROM citations c
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
  }
};

const relationshipTypes = {
  async getAll() {
    return await allAsync(`
      SELECT * FROM relationship_types
      ORDER BY category, label
    `);
  },

  async resolve(name) {
    if (!name) return null;
    const exact = await getAsync('SELECT name FROM relationship_types WHERE name = ?', [name]);
    if (exact) return exact.name;
    const normalized = String(name).trim().toLowerCase().replace(/\s+/g, '_');
    const byNormalized = await getAsync('SELECT name FROM relationship_types WHERE name = ?', [normalized]);
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
        return (await allAsync(`
          SELECT DISTINCT e.*
          FROM entities e
          INNER JOIN citations c ON c.entity_id = e.id
          WHERE (${access.clause})
            AND e.entity_type != 'date'
            AND e.id IN (
              SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?
              UNION
              SELECT ea.entity_id FROM entity_aliases ea
              JOIN entity_aliases_fts af ON af.rowid = ea.id
              WHERE entity_aliases_fts MATCH ?
            )
          ORDER BY e.canonical_name
          LIMIT ?
        `, [...access.params, ftsQuery, ftsQuery, limit])).map(hydrateEntity);
      } catch (err) {
        // fall through to LIKE
      }
    }
    const pattern = `%${sanitized}%`;
    return (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
      INNER JOIN citations c ON c.entity_id = e.id
      WHERE (${access.clause})
        AND e.entity_type != 'date'
        AND (e.canonical_name LIKE ? OR ea.alias LIKE ?)
      ORDER BY e.canonical_name
      LIMIT ?
    `, [...access.params, pattern, pattern, limit])).map(hydrateEntity);
  },

  async getEntitiesByType(entityType, userId, isAdmin, accessAll, limit = 50, offset = 0, collectionId = null) {
    const access = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    const params = [...access.params];
    let typeClause = '';
    if (entityType) {
      typeClause = 'AND e.entity_type = ?';
      params.push(entityType);
    }
    params.push(limit, offset);
    return (await allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      WHERE (${access.clause})
        AND e.entity_type != 'date'
        ${typeClause}
      ORDER BY e.canonical_name
      LIMIT ? OFFSET ?
    `, params)).map(hydrateEntity);
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

  async getNeighbors(entityId, userId, isAdmin, accessAll, collectionId = null) {
    const visibility = buildKnowledgeCitationVisibilityFilter({ userId, isAdmin, accessAll, collectionId }, 'c', 'c.document_id');
    return (await allAsync(`
      SELECT DISTINCT
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
      JOIN citations c ON c.relationship_id = r.id
      JOIN entities e
        ON e.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE (r.source_entity_id = ? OR r.target_entity_id = ?)
        AND e.entity_type != 'date'
        AND (${visibility.clause})
      ORDER BY e.canonical_name
    `, [entityId, entityId, entityId, entityId, ...visibility.params])).map(hydrateEntity);
  }
};

function parseJsonValue(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
      WHERE col.is_public = 1 OR uca.user_id IS NOT NULL
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

function buildCitationQueryConditions(opts = {}, alias = 'c') {
  const clauses = [];
  const params = [];

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
