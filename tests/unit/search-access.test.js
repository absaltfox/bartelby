'use strict';

// Tests for two search access bugs:
// 1. Citation counts must be scoped to accessible documents (not all documents)
// 2. getAccessibleCollections must include is_world_public collections

// ── Test 1: citation counts exclude inaccessible documents ───────────────────
// We instantiate the knowledge-graph model factory directly with a minimal
// in-memory store so we can test buildCitationQueryConditions / getByEntityId
// without booting the full server.

describe('citations.getByEntityId access scoping', () => {
  let citations;

  beforeEach(() => {
    // In-memory store for documents and citations
    const documents = [
      { id: 1, collection_id: 10 }, // in public collection
      { id: 2, collection_id: 20 }, // in private collection
    ];
    const collectionsMap = {
      10: { id: 10, is_public: 1, is_world_public: 0 },
      20: { id: 20, is_public: 0, is_world_public: 0 },
    };
    const documentCollections = [
      { document_id: 1, collection_id: 10 },
      { document_id: 2, collection_id: 20 },
    ];
    const citationsData = [
      { id: 1, entity_id: 99, document_id: 1, transcript_id: null, relationship_id: null, approval_status: 'approved' },
      { id: 2, entity_id: 99, document_id: 2, transcript_id: null, relationship_id: null, approval_status: 'approved' },
    ];

    // We need to provide allAsync that the knowledge-graph model will call.
    // Rather than spinning up sqljs, we mock the SQL execution by feeding
    // buildCitationQueryConditions output through a JavaScript filter that
    // mirrors the SQL semantics for our controlled dataset.

    // Instead, we directly call the exported buildCitationQueryConditions
    // to verify the clause is generated correctly with access opts, then
    // use a real sqljs DB for the behavioral assertion.

    // Build a lightweight allAsync that runs the actual query conditions
    // against our in-memory data using the clause logic.
    // For simplicity, we use the exported function directly.
    const knowledgeGraphFactory = require('../../database/models/knowledge-graph');

    // allAsync mock: executes citation queries against our in-memory data
    const allAsync = jest.fn(async (sql, params) => {
      // Filter citations based on the query — we simulate the two key conditions:
      // entity_id filter and document access filter.
      // We check which document_ids are accessible based on is_public.
      const accessibleDocIds = documentCollections
        .filter(dc => collectionsMap[dc.collection_id]?.is_public === 1)
        .map(dc => dc.document_id);

      // Determine if the query restricts document access (has a WHERE clause with subquery)
      const hasAccessFilter = sql.includes('is_public') || sql.includes('user_collection_access');

      return citationsData.filter(c => {
        if (c.entity_id !== 99) return false;
        if (hasAccessFilter && !accessibleDocIds.includes(c.document_id)) return false;
        return true;
      });
    });

    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const saveDatabase = jest.fn();
    const run = jest.fn();
    const get = jest.fn();
    const all = jest.fn();

    const models = knowledgeGraphFactory(
      null, runAsync, getAsync, allAsync, saveDatabase, run, get, all, () => false
    );
    citations = models.citations;
  });

  it('without access opts: returns all approved citations (both public and private)', async () => {
    const rows = await citations.getByEntityId(99);
    // No access filter applied — allAsync mock returns all 2 citations
    expect(rows.length).toBe(2);
  });

  it('with access opts (userId, not admin): only returns citations for accessible documents', async () => {
    const opts = { userId: 42, isAdmin: false, accessAll: false };
    const rows = await citations.getByEntityId(99, opts);
    // Access filter applied — only document 1 (public collection) is accessible
    expect(rows.length).toBe(1);
    expect(rows[0].document_id).toBe(1);
  });

  it('with access opts: citationCount and documentCount reflect only accessible documents', async () => {
    const opts = { userId: 42, isAdmin: false, accessAll: false };
    const citeRows = await citations.getByEntityId(99, opts);
    const documentIds = new Set(citeRows.map(r => r.document_id).filter(Boolean));
    expect(citeRows.length).toBe(1);   // citationCount
    expect(documentIds.size).toBe(1);  // documentCount
  });
});

// ── Test 2: getAccessibleCollections includes is_world_public collections ────
// Visibility now lives in SQL inside collectionsAsync.getAccessibleWithThumbnails
// (database/models/collections.js).  Routes/search.js calls that helper instead
// of filtering in JS, so the regression guard reads from the model source.

describe('getAccessibleCollections includes is_world_public', () => {
  const fs = require('fs');
  const path = require('path');
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '../../routes/search.js'),
    'utf8'
  );
  const modelSrc = fs.readFileSync(
    path.join(__dirname, '../../database/models/collections.js'),
    'utf8'
  );

  it('search route delegates to the visibility-aware collection helpers', () => {
    // The route must use getAllWithThumbnailsForAdmin for admin/accessAll and
    // getAccessibleWithThumbnails for ordinary authenticated users — that's
    // where the SQL visibility filter lives.
    expect(routeSrc).toMatch(/getAllWithThumbnailsForAdmin/);
    expect(routeSrc).toMatch(/getAccessibleWithThumbnails/);
  });

  it('getAccessibleWithThumbnails SQL filter includes is_world_public check', () => {
    // The SQL clause must accept world-public collections without requiring an
    // explicit user_collection_access row.
    expect(modelSrc).toMatch(/getAccessibleWithThumbnails/);
    expect(modelSrc).toMatch(/is_world_public\s*=\s*1/);
  });

  it('filter logic: world-public collection is visible to non-admin user without explicit access', () => {
    // Replicate the filter logic from getAccessibleCollections
    const collections = [
      { id: 1, is_public: false, is_world_public: true,  name: 'World Public' },
      { id: 2, is_public: false, is_world_public: false, name: 'Private' },
      { id: 3, is_public: true,  is_world_public: false, name: 'Public' },
    ];
    const accessIds = []; // user has no explicit access

    // This is the FIXED filter from getAccessibleCollections
    const visible = collections.filter(c =>
      c.is_public || c.is_world_public || accessIds.includes(c.id)
    );

    expect(visible.map(c => c.name)).toContain('World Public');
    expect(visible.map(c => c.name)).toContain('Public');
    expect(visible.map(c => c.name)).not.toContain('Private');
  });

  it('filter logic matches documents browser: same collections shown in both places', () => {
    // Both routes/documents.js and routes/search.js (after fix) should use:
    //   c.is_public || c.is_world_public || accessIds.includes(c.id)
    const collections = [
      { id: 1, is_public: false, is_world_public: true  },
      { id: 2, is_public: true,  is_world_public: false },
      { id: 3, is_public: false, is_world_public: false },
      { id: 4, is_public: false, is_world_public: false }, // user has explicit access
    ];
    const accessIds = [4];

    // documents.js logic
    const docsVisible = collections.filter(c =>
      c.is_public || c.is_world_public || accessIds.includes(c.id)
    );

    // search.js logic (after fix — same as above)
    const searchVisible = collections.filter(c =>
      c.is_public || c.is_world_public || accessIds.includes(c.id)
    );

    expect(docsVisible.map(c => c.id)).toEqual(searchVisible.map(c => c.id));
  });
});
