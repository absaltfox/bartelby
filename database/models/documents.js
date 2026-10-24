'use strict';

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const documents = {
  buildAccessConditions(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;
    const conditions = [];
    const params = [];

    if (!isAdmin && !accessAll) {
      if (userId) {
        // Authenticated user: world-public + all-users + explicitly granted
        conditions.push(`EXISTS (
          SELECT 1
          FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          LEFT JOIN user_collection_access uca
            ON uca.collection_id = dc.collection_id
           AND uca.user_id = ?
          WHERE dc.document_id = d.id
            AND (col.is_public = 1 OR col.is_world_public = 1 OR uca.user_id IS NOT NULL)
        )`);
        params.push(userId);
      } else {
        // Unauthenticated visitor: world-public only
        conditions.push(`EXISTS (
          SELECT 1
          FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE dc.document_id = d.id
            AND col.is_world_public = 1
        )`);
      }
    }

    return { conditions, params };
  },

  buildFilterConditions(filters = {}) {
    const { collectionId, uncollected, docTypes, locations, authors, dateFrom, dateTo } = filters;
    const conditions = [];
    const params = [];

    if (uncollected) {
      conditions.push(`NOT EXISTS (
        SELECT 1
        FROM document_collections dc_uncollected
        WHERE dc_uncollected.document_id = d.id
      )`);
    } else if (collectionId) {
      conditions.push(`EXISTS (
        SELECT 1
        FROM document_collections dc_scope
        WHERE dc_scope.document_id = d.id
          AND dc_scope.collection_id = ?
      )`);
      params.push(collectionId);
    }
    if (docTypes && docTypes.length > 0) {
      const placeholders = docTypes.map(() => '?').join(',');
      conditions.push(`json_extract(d.metadata, '$.document_type') IN (${placeholders})`);
      params.push(...docTypes);
    }
    if (locations && locations.length > 0) {
      const placeholders = locations.map(() => 'LOWER(TRIM(?))').join(',');
      conditions.push(`LOWER(TRIM(json_extract(d.metadata, '$.location'))) IN (${placeholders})`);
      params.push(...locations);
    }
    if (authors && authors.length > 0) {
      const placeholders = authors.map(() => 'LOWER(TRIM(?))').join(',');
      conditions.push(`LOWER(TRIM(json_extract(d.metadata, '$.author'))) IN (${placeholders})`);
      params.push(...authors);
    }
    if (dateFrom) {
      conditions.push(`d.date_created >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`d.date_created <= ?`);
      params.push(dateTo);
    }

    return { conditions, params };
  },

  // opts: { userId, isAdmin, accessAll } — omit or set isAdmin to bypass filtering
  getAll(limit = 20, offset = 0, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      return all(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    if (!userId) {
      // Unauthenticated: world-public only
      return all(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    return all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
  },

  getById(id) {
    return get('SELECT * FROM documents WHERE id = ?', [id]);
  },

  getByIds(ids, limit = 25, offset = 0) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (${placeholders})
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...ids, limit, offset]);
  },

  // Check if a user can access a specific document
  canAccess(docId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;
    if (!userId) {
      // Unauthenticated: only world-public
      const row = get(`
        SELECT 1 FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE dc.document_id = ? AND col.is_world_public = 1
        LIMIT 1
      `, [docId]);
      return !!row;
    }
    const row = get(`
      SELECT 1 FROM document_collections dc
      INNER JOIN collections col ON dc.collection_id = col.id
      WHERE dc.document_id = ? AND (
        col.is_public = 1
        OR col.is_world_public = 1
        OR dc.collection_id IN (
          SELECT collection_id FROM user_collection_access WHERE user_id = ?
        )
      )
      LIMIT 1
    `, [docId, userId]);
    return !!row;
  },

  getCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      const result = get('SELECT COUNT(*) as count FROM documents');
      return result ? result.count : 0;
    }

    if (!userId) {
      // Unauthenticated: count only world-public documents
      const result = get(`
        SELECT COUNT(DISTINCT d.id) as count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
      `);
      return result ? result.count : 0;
    }

    const result = get(`
      SELECT COUNT(DISTINCT d.id) as count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
    `, [userId]);
    return result ? result.count : 0;
  },

  getUncollectedCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;
    let accessClause = '';
    const params = [];
    if (!isAdmin && !accessAll && userId) {
      // Uncollected docs are only visible to admins in practice,
      // but include access check for safety
      accessClause = '';
    }
    const result = get(`
      SELECT COUNT(*) as count FROM documents d
      WHERE d.id NOT IN (SELECT document_id FROM document_collections)
    `);
    return result ? result.count : 0;
  },

  getDistinctTypes() {
    return all(`
      SELECT DISTINCT json_extract(metadata, '$.document_type') as doc_type
      FROM documents
      WHERE json_extract(metadata, '$.document_type') IS NOT NULL
        AND json_extract(metadata, '$.document_type') != ''
      ORDER BY doc_type
    `).map(r => r.doc_type);
  },

  getDistinctTypesFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.document_type') IS NOT NULL`,
      `json_extract(d.metadata, '$.document_type') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    return all(`
      SELECT DISTINCT json_extract(d.metadata, '$.document_type') as doc_type
      FROM documents d
      ${where}
      ORDER BY doc_type
    `, params).map(r => r.doc_type);
  },

  getDistinctLocations() {
    return all(`
      SELECT DISTINCT json_extract(metadata, '$.location') as location
      FROM documents
      WHERE json_extract(metadata, '$.location') IS NOT NULL
        AND json_extract(metadata, '$.location') != ''
      ORDER BY location
    `).map(r => r.location);
  },

  getDistinctLocationsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.location') IS NOT NULL`,
      `json_extract(d.metadata, '$.location') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    return all(`
      SELECT DISTINCT json_extract(d.metadata, '$.location') as location
      FROM documents d
      ${where}
      ORDER BY location
    `, params).map(r => r.location);
  },

  getDateRange() {
    const result = get(`
      SELECT MIN(date_created) as min_date, MAX(date_created) as max_date
      FROM documents
      WHERE date_created IS NOT NULL AND date_created != ''
    `);
    return result || { min_date: null, max_date: null };
  },

  getDateRangeFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `d.date_created IS NOT NULL`,
      `d.date_created != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = get(`
      SELECT MIN(d.date_created) as min_date, MAX(d.date_created) as max_date
      FROM documents d
      ${where}
    `, params);
    return result || { min_date: null, max_date: null };
  },

  getAllFiltered(limit = 20, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = get(`SELECT COUNT(*) as count FROM documents d ${where}`, params);
    const totalCount = countResult ? countResult.count : 0;

    const rows = all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      ${where}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { rows, totalCount };
  },

  create(doc) {
    const result = run(`
      INSERT INTO documents (title, date_created, description, image_path, metadata)
      VALUES (?, ?, ?, ?, ?)
    `, [
      doc.title,
      doc.date_created,
      doc.description,
      doc.image_path,
      JSON.stringify(doc.metadata || {})
    ]);
    return result.lastInsertRowid;
  },

  update(id, fields) {
    const doc = get('SELECT * FROM documents WHERE id = ?', [id]);
    if (!doc) return;
    run(`
      UPDATE documents SET title = ?, date_created = ?, description = ?, metadata = ?
      WHERE id = ?
    `, [
      fields.title !== undefined ? fields.title : doc.title,
      fields.date_created !== undefined ? fields.date_created : doc.date_created,
      fields.description !== undefined ? fields.description : doc.description,
      fields.metadata !== undefined ? JSON.stringify(fields.metadata) : doc.metadata,
      id
    ]);
  },

  delete(id) {
    // Manually cascade: annotations → transcripts → document_collections → document
    const docTranscripts = all('SELECT id FROM transcripts WHERE document_id = ?', [id]);
    for (const t of docTranscripts) {
      run('DELETE FROM annotations WHERE transcript_id = ?', [t.id]);
    }
    run('DELETE FROM transcripts WHERE document_id = ?', [id]);
    run('DELETE FROM document_collections WHERE document_id = ?', [id]);
    return run('DELETE FROM documents WHERE id = ?', [id]);
  }
};

const documentsAsync = {
  buildAccessConditions: documents.buildAccessConditions.bind(documents),
  buildFilterConditions: documents.buildFilterConditions.bind(documents),

  async getById(id) {
    return await getAsync('SELECT * FROM documents WHERE id = ?', [id]);
  },

  /**
   * Resolves the documents an upload URL belongs to, for the authorizing
   * /uploads proxy.
   *
   * Both probes are index seeks: a page master through `image_path` (v87,
   * `idx_documents_image_path`), and any later page through
   * `document_page_urls` (v93), which triggers in database/db.js keep in step
   * with `metadata.additional_pages`. This matters for availability more than
   * latency: the proxy runs this before any authorization check, and
   * `anonymousUploadLimiter` skips authenticated requests, so a scanning
   * lookup let any signed-in reader drive unbounded full scans by requesting
   * /uploads/* in a loop. Issue #75.
   *
   * Short-circuiting rather than UNION-ing is safe because the two sets are
   * disjoint by construction. Both writers that produce `/uploads/*` values —
   * utils/import-submission.js and routes/import-api.js — store `pages[0]` as
   * `image_path` and `pages.slice(1)` as `additional_pages`, and every upload
   * gets a freshly generated unique filename (a collision loop in
   * utils/storage/local.js, a random suffix in utils/storage/s3.js). So no URL
   * is one document's master and another's additional page. (utils/worker-iiif.js
   * writes remote IIIF URLs, which never reach this lookup at all.)
   *
   * And if that ever were violated, the short-circuit is fail-closed: it can
   * only return *fewer* candidate document ids, which gives the caller's
   * `canAccess` loop fewer chances to grant. It cannot over-permit.
   */
  async getIdsByUploadUrl(uploadUrl) {
    if (!uploadUrl) return [];
    const primaryRows = await allAsync(
      'SELECT id FROM documents WHERE image_path = ?',
      [uploadUrl]
    );
    if (primaryRows.length) return primaryRows.map((row) => row.id);

    const additionalPageRows = await allAsync(
      'SELECT document_id AS id FROM document_page_urls WHERE url = ?',
      [uploadUrl]
    );
    return additionalPageRows.map((row) => row.id);
  },

  async canAccess(docId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;
    if (!userId) {
      // Unauthenticated: only world-public
      const row = await getAsync(`
        SELECT 1 FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE dc.document_id = ? AND col.is_world_public = 1
        LIMIT 1
      `, [docId]);
      return !!row;
    }
    const row = await getAsync(`
      SELECT 1 FROM document_collections dc
      INNER JOIN collections col ON dc.collection_id = col.id
      WHERE dc.document_id = ? AND (
        col.is_public = 1
        OR col.is_world_public = 1
        OR dc.collection_id IN (
          SELECT collection_id FROM user_collection_access WHERE user_id = ?
        )
      )
      LIMIT 1
    `, [docId, userId]);
    return !!row;
  },

  async getAll(limit = 20, offset = 0, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      return await allAsync(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    if (!userId) {
      // Unauthenticated: world-public only
      return await allAsync(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    return await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1 OR col.is_world_public = 1
      )
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
  },

  async getByIds(ids, limit = 25, offset = 0) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (${placeholders})
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...ids, limit, offset]);
  },

  async getByCollectionId(collectionId, limit = 25, offset = 0) {
    return await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) AS transcript_count
      FROM documents d
      INNER JOIN document_collections dc ON dc.document_id = d.id
      WHERE dc.collection_id = ?
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [collectionId, limit, offset]);
  },

  async getCountByCollectionId(collectionId) {
    const row = await getAsync(`
      SELECT COUNT(*) AS count
      FROM document_collections
      WHERE collection_id = ?
    `, [collectionId]);
    return row ? Number(row.count || 0) : 0;
  },

  async getCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      const result = await getAsync('SELECT COUNT(*) as count FROM documents');
      return result ? result.count : 0;
    }

    if (!userId) {
      // Unauthenticated: count only world-public documents
      const result = await getAsync(`
        SELECT COUNT(DISTINCT d.id) as count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
      `);
      return result ? result.count : 0;
    }

    const result = await getAsync(`
      SELECT COUNT(DISTINCT d.id) as count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1 OR col.is_world_public = 1
      )
    `, [userId]);
    return result ? result.count : 0;
  },

  async getUncollectedCount() {
    const result = await getAsync(`
      SELECT COUNT(*) as count FROM documents d
      WHERE d.id NOT IN (SELECT document_id FROM document_collections)
    `);
    return result ? result.count : 0;
  },

  async getDistinctTypesFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.document_type') IS NOT NULL`,
      `json_extract(d.metadata, '$.document_type') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.document_type') as doc_type
      FROM documents d
      ${where}
      ORDER BY doc_type
    `, params);
    return rows.map(r => r.doc_type);
  },

  async getDistinctLocationsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.location') IS NOT NULL`,
      `json_extract(d.metadata, '$.location') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.location') as location
      FROM documents d
      ${where}
      ORDER BY location
    `, params);
    return rows.map(r => r.location);
  },

  async getDistinctAuthorsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.author') IS NOT NULL`,
      `json_extract(d.metadata, '$.author') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.author') as author
      FROM documents d
      ${where}
      ORDER BY author
    `, params);
    return rows.map(r => r.author);
  },

  async getDateRangeFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `d.date_created IS NOT NULL`,
      `d.date_created != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = await getAsync(`
      SELECT MIN(d.date_created) as min_date, MAX(d.date_created) as max_date
      FROM documents d
      ${where}
    `, params);
    return result || { min_date: null, max_date: null };
  },

  async getAllFiltered(limit = 20, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [countResult, rows] = await Promise.all([
      getAsync(`SELECT COUNT(*) as count FROM documents d ${where}`, params),
      allAsync(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        ${where}
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, offset])
    ]);
    const totalCount = countResult ? countResult.count : 0;

    return { rows, totalCount };
  },

  async searchAdvanced(limit = 25, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];
    const query = String(filters.query || '').trim();

    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const termConditions = terms.map(() =>
          `(d.title LIKE ? OR d.description LIKE ? OR bt.content LIKE ? OR json_extract(d.metadata, '$.author') LIKE ? OR json_extract(d.metadata, '$.location') LIKE ?)`
        ).join(' AND ');
        conditions.push(`(${termConditions})`);
        terms.forEach(term => {
          const likeTerm = `%${term}%`;
          params.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
        });
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await getAsync(`
      SELECT COUNT(*) as count
      FROM documents d
      LEFT JOIN transcripts bt ON bt.document_id = d.id AND bt.is_best = 1
      ${where}
    `, params);

    const rows = await allAsync(`
      SELECT
        d.*,
        bt.id as transcript_id,
        bt.content as transcript_content,
        bt.transcriber as transcript_transcriber,
        bt.version as transcript_version,
        (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      LEFT JOIN transcripts bt ON bt.document_id = d.id AND bt.is_best = 1
      ${where}
      ORDER BY d.date_created DESC, d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const normalizedTerms = query ? query.split(/\s+/).filter(Boolean).map(term => term.toLowerCase()) : [];

    const decorated = rows.map(row => {
      let meta = row.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (err) { meta = {}; }
      }

      const title = row.title || '';
      const description = row.description || '';
      const transcriptContent = row.transcript_content || '';
      const author = meta.author || '';

      let snippet = description || transcriptContent.substring(0, 220);
      for (const term of normalizedTerms) {
        const fields = [title, description, transcriptContent, author];
        const match = fields.find(field => field && field.toLowerCase().includes(term));
        if (match) {
          const idx = match.toLowerCase().indexOf(term);
          const start = Math.max(0, idx - 90);
          const end = Math.min(match.length, idx + term.length + 90);
          snippet = (start > 0 ? '...' : '') + match.substring(start, end) + (end < match.length ? '...' : '');
          break;
        }
      }

      snippet = String(snippet || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      normalizedTerms.forEach(term => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        snippet = snippet.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
      });

      return { ...row, metadata: meta, snippet };
    });

    return {
      rows: decorated,
      totalCount: countResult ? countResult.count : 0
    };
  },

  async update(id, fields) {
    const doc = await getAsync('SELECT * FROM documents WHERE id = ?', [id]);
    if (!doc) return;
    await runAsync(`
      UPDATE documents SET title = ?, date_created = ?, description = ?, metadata = ?
      WHERE id = ?
    `, [
      fields.title !== undefined ? fields.title : doc.title,
      fields.date_created !== undefined ? fields.date_created : doc.date_created,
      fields.description !== undefined ? fields.description : doc.description,
      fields.metadata !== undefined ? JSON.stringify(fields.metadata) : doc.metadata,
      id
    ]);
  },

  async create(doc) {
    const result = await runAsync(`
      INSERT INTO documents (title, date_created, description, image_path, metadata)
      VALUES (?, ?, ?, ?, ?)
    `, [
      doc.title,
      doc.date_created,
      doc.description,
      doc.image_path,
      JSON.stringify(doc.metadata || {})
    ]);
    return result.lastInsertRowid;
  },

  async findByImportSubmission(submissionJobId, groupKey) {
    return await getAsync(`
      SELECT * FROM documents
      WHERE metadata LIKE ?
        AND metadata LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `, [
      `%"import_submission_job_id":${Number(submissionJobId)}%`,
      `%"import_group_key":"${String(groupKey)}"%`
    ]);
  },

  async delete(id) {
    const docTranscripts = await allAsync('SELECT id FROM transcripts WHERE document_id = ?', [id]);
    for (const t of docTranscripts) {
      await runAsync('DELETE FROM annotations WHERE transcript_id = ?', [t.id]);
    }
    await runAsync('DELETE FROM transcripts WHERE document_id = ?', [id]);
    await runAsync('DELETE FROM document_collections WHERE document_id = ?', [id]);
    return await runAsync('DELETE FROM documents WHERE id = ?', [id]);
  }
};

const transcripts = {
  getByDocumentId(documentId) {
    return all(`
      SELECT * FROM transcripts
      WHERE document_id = ?
      ORDER BY version DESC
    `, [documentId]);
  },

  getById(id) {
    return get('SELECT * FROM transcripts WHERE id = ?', [id]);
  },

  getBySourceJobId(sourceJobId, documentId) {
    if (!Number.isInteger(sourceJobId) || !Number.isInteger(documentId)) return null;
    return get(`
      SELECT * FROM transcripts
      WHERE source_job_id = ? AND document_id = ?
      LIMIT 1
    `, [sourceJobId, documentId]);
  },

  create(transcript) {
    const result = run(`
      INSERT INTO transcripts (
        document_id, content, transcriber, version, notes,
        provider, model, prompt, temperature, initiated_by, run_duration_ms,
        source_job_id, provider_key_scope, page_segments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transcript.document_id,
      transcript.content,
      transcript.transcriber,
      transcript.version || 1,
      transcript.notes,
      transcript.provider || null,
      transcript.model || null,
      transcript.prompt || null,
      transcript.temperature != null ? transcript.temperature : null,
      transcript.initiated_by || null,
      transcript.run_duration_ms || null,
      transcript.source_job_id || null,
      transcript.provider_key_scope || null,
      transcript.page_segments ? JSON.stringify(transcript.page_segments) : null
    ]);
    return result.lastInsertRowid;
  },

  search(query, limit = 20, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    const searchTerms = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0);

    if (searchTerms.length === 0) return [];

    const termConditions = searchTerms.map(() =>
      '(t.content LIKE ? OR d.title LIKE ? OR d.description LIKE ?)'
    ).join(' OR ');

    const params = [];
    searchTerms.forEach(term => {
      const likeTerm = `%${term}%`;
      params.push(likeTerm, likeTerm, likeTerm);
    });

    let accessClause = '';
    if (!isAdmin && !accessAll) {
      if (userId) {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
          WHERE uca.user_id = ?
          UNION
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_public = 1
        )`;
        params.push(userId);
      } else {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )`;
      }
    }

    params.push(limit);

    const results = all(`
      SELECT t.*, d.title as document_title, d.id as document_id, d.description as document_description
      FROM transcripts t
      JOIN documents d ON t.document_id = d.id
      WHERE (${termConditions}) ${accessClause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `, params);

    return results.map(row => {
      let snippet = '';
      for (const term of searchTerms) {
        const termLower = term.toLowerCase();
        if (row.document_title && row.document_title.toLowerCase().includes(termLower)) {
          snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
          break;
        }
        if (row.document_description && row.document_description.toLowerCase().includes(termLower)) {
          snippet = row.document_description;
          break;
        }
        const idx = row.content.toLowerCase().indexOf(termLower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(row.content.length, idx + term.length + 80);
          snippet = (start > 0 ? '...' : '') + row.content.substring(start, end) + (end < row.content.length ? '...' : '');
          break;
        }
      }
      if (!snippet) snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
      // Escape HTML to prevent XSS, then safely highlight search terms
      snippet = snippet
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      for (const term of searchTerms) {
        // Escape regex special chars to prevent ReDoS
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        snippet = snippet.replace(regex, '<mark>$1</mark>');
      }
      return { ...row, snippet };
    });
  }
};

const transcriptsAsync = {
  async getByDocumentId(documentId) {
    return await allAsync(`
      SELECT * FROM transcripts
      WHERE document_id = ?
      ORDER BY is_best DESC, version DESC
    `, [documentId]);
  },

  /**
   * Version-selector projection: everything needed to list a document's
   * transcript versions and pick one, and nothing else. `getByDocumentId`
   * returns `content`, `prompt`, and `notes` for *every* version, so a
   * document with several transcription runs moves hundreds of KB over the
   * Turso wire per page view to render a `<select>`. Callers that need a
   * version's body fetch it with `getById` once the selection is known.
   *
   * Added alongside `getByDocumentId` rather than narrowing it: the
   * transcription pipeline and the knowledge-rerun helper both rely on the
   * full rows.
   */
  async listByDocumentId(documentId) {
    return await allAsync(`
      SELECT id, document_id, version, transcriber, is_best, created_at
      FROM transcripts
      WHERE document_id = ?
      ORDER BY is_best DESC, version DESC
    `, [documentId]);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM transcripts WHERE id = ?', [id]);
  },

  async getBySourceJobId(sourceJobId, documentId) {
    if (!Number.isInteger(sourceJobId) || !Number.isInteger(documentId)) return null;
    return await getAsync(`
      SELECT * FROM transcripts
      WHERE source_job_id = ? AND document_id = ?
      LIMIT 1
    `, [sourceJobId, documentId]);
  },

  async getBestByDocumentId(documentId) {
    return await getAsync('SELECT * FROM transcripts WHERE document_id = ? AND is_best = 1', [documentId]);
  },

  async create(transcript) {
    const result = await runAsync(`
      INSERT INTO transcripts (
        document_id, content, transcriber, version, notes,
        provider, model, prompt, temperature, initiated_by, run_duration_ms,
        source_job_id, is_best, created_by_user_id, provider_key_scope, page_segments,
        input_tokens, output_tokens, cost_usd, confidence, unknown_word_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transcript.document_id,
      transcript.content,
      transcript.transcriber,
      transcript.version || 1,
      transcript.notes,
      transcript.provider || null,
      transcript.model || null,
      transcript.prompt || null,
      transcript.temperature != null ? transcript.temperature : null,
      transcript.initiated_by || null,
      transcript.run_duration_ms || null,
      transcript.source_job_id || null,
      transcript.is_best ? 1 : 0,
      transcript.created_by_user_id || null,
      transcript.provider_key_scope || null,
      transcript.page_segments ? JSON.stringify(transcript.page_segments) : null,
      transcript.input_tokens != null ? transcript.input_tokens : null,
      transcript.output_tokens != null ? transcript.output_tokens : null,
      transcript.cost_usd != null ? transcript.cost_usd : null,
      transcript.confidence != null ? transcript.confidence : null,
      transcript.unknown_word_count ?? null
    ]);
    return result.lastInsertRowid;
  },

  async setBest(transcriptId, documentId) {
    await runAsync(
      'UPDATE transcripts SET is_best = (id = ?) WHERE document_id = ?',
      [transcriptId, documentId]
    );
  },

  async updateContent(id, content) {
    await runAsync('UPDATE transcripts SET content = ? WHERE id = ?', [content, id]);
  },

  async updateContentAndPageSegments(id, content, pageSegments) {
    await runAsync('UPDATE transcripts SET content = ?, page_segments = ? WHERE id = ?', [
      content,
      pageSegments ? JSON.stringify(pageSegments) : null,
      id
    ]);
  },

  async updateNotes(id, notes) {
    await runAsync('UPDATE transcripts SET notes = ? WHERE id = ?', [notes, id]);
  },

  async delete(id) {
    await runAsync('DELETE FROM annotations WHERE transcript_id = ?', [id]);
    await runAsync('DELETE FROM transcripts WHERE id = ?', [id]);
  },

  async search(query, limit = 20, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    const searchTerms = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0);

    if (searchTerms.length === 0) return [];

    const termConditions = searchTerms.map(() =>
      '(t.content LIKE ? OR d.title LIKE ? OR d.description LIKE ?)'
    ).join(' OR ');

    const params = [];
    searchTerms.forEach(term => {
      const likeTerm = `%${term}%`;
      params.push(likeTerm, likeTerm, likeTerm);
    });

    // Same three-branch shape as the sync twin above: a caller with no identity
    // gets the anonymous (world-public) scope, never an unfiltered query.
    let accessClause = '';
    if (!isAdmin && !accessAll) {
      if (userId) {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
          WHERE uca.user_id = ?
          UNION
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_public = 1
        )`;
        params.push(userId);
      } else {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )`;
      }
    }

    params.push(limit);

    const results = await allAsync(`
      SELECT t.*, d.title as document_title, d.id as document_id, d.description as document_description
      FROM transcripts t
      JOIN documents d ON t.document_id = d.id
      WHERE t.is_best = 1 AND (${termConditions}) ${accessClause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `, params);

    return results.map(row => {
      let snippet = '';
      for (const term of searchTerms) {
        const termLower = term.toLowerCase();
        if (row.document_title && row.document_title.toLowerCase().includes(termLower)) {
          snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
          break;
        }
        if (row.document_description && row.document_description.toLowerCase().includes(termLower)) {
          snippet = row.document_description;
          break;
        }
        const idx = row.content.toLowerCase().indexOf(termLower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(row.content.length, idx + term.length + 80);
          snippet = (start > 0 ? '...' : '') + row.content.substring(start, end) + (end < row.content.length ? '...' : '');
          break;
        }
      }
      if (!snippet) snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
      snippet = snippet
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      for (const term of searchTerms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        snippet = snippet.replace(regex, '<mark>$1</mark>');
      }
      return { ...row, snippet };
    });
  }
};

const annotations = {
  getByTranscriptId(transcriptId) {
    return all(`
      SELECT * FROM annotations
      WHERE transcript_id = ?
      ORDER BY position_start, created_at
    `, [transcriptId]);
  },

  getById(id) {
    return get('SELECT * FROM annotations WHERE id = ?', [id]);
  },

  create(annotation) {
    const result = run(`
      INSERT INTO annotations (transcript_id, user_name, content, position_start, position_end)
      VALUES (?, ?, ?, ?, ?)
    `, [
      annotation.transcript_id,
      annotation.user_name,
      annotation.content,
      annotation.position_start,
      annotation.position_end
    ]);
    return result.lastInsertRowid;
  },

  delete(id) {
    return run('DELETE FROM annotations WHERE id = ?', [id]);
  }
};

const annotationsAsync = {
  async getByTranscriptId(transcriptId) {
    return await allAsync(`
      SELECT * FROM annotations
      WHERE transcript_id = ?
      ORDER BY position_start, created_at
    `, [transcriptId]);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM annotations WHERE id = ?', [id]);
  },

  async create(annotation) {
    const result = await runAsync(`
      INSERT INTO annotations (transcript_id, user_name, content, position_start, position_end)
      VALUES (?, ?, ?, ?, ?)
    `, [
      annotation.transcript_id,
      annotation.user_name,
      annotation.content,
      annotation.position_start,
      annotation.position_end
    ]);
    return result.lastInsertRowid;
  },

  async delete(id) {
    return await runAsync('DELETE FROM annotations WHERE id = ?', [id]);
  }
};

const documentEventsAsync = {
  async log(documentId, userId, userName, eventType, details = null) {
    await runAsync(`
      INSERT INTO document_events (document_id, user_id, user_name, event_type, details)
      VALUES (?, ?, ?, ?, ?)
    `, [documentId, userId || null, userName || null, eventType, details ? JSON.stringify(details) : null]);
  },

  async getByDocumentId(documentId, limit = 50, offset = 0) {
    return await allAsync(`
      SELECT * FROM document_events
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [documentId, limit, offset]);
  },

  async getCountByDocumentId(documentId) {
    const row = await getAsync('SELECT COUNT(*) as count FROM document_events WHERE document_id = ?', [documentId]);
    return row ? row.count : 0;
  }
};


  return {
    documents,
    documentsAsync,
    transcripts,
    transcriptsAsync,
    annotations,
    annotationsAsync,
    documentEventsAsync
  };
};
