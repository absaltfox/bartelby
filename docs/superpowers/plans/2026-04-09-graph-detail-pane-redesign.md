# Knowledge Graph Entity Detail Pane Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the knowledge-graph entity detail pane (`renderDetail` in `public/js/graph-explorer.js`) so it collapses the duplicated header, removes the stats row, merges the two citation sections, hides empty sections, and renders directional connection rows with evidence excerpts.

**Architecture:** Client-side refactor driven by one small backend change. The `/graph/entities/:id/neighbors` endpoint is extended to include `relationship_id`, `direction`, and a single evidence excerpt per neighbour row. The client's `dedupeNeighbors()` is rewritten to preserve direction so a neighbour with mixed directions produces one row per direction. `renderDetail()` is replaced entirely with a new layout. The two graph view templates and `style.css` are updated to match.

**Tech Stack:** Vanilla JavaScript (IIFE, no build step), Express routes, SQLite via `database/db.js`, Jest + supertest for backend integration tests.

**Spec:** `docs/superpowers/specs/2026-04-09-graph-detail-pane-redesign-design.md`

---

## File Structure

**Modified:**
- `routes/graph.js:156-191` — `/graph/entities/:id/neighbors` handler, attach relationship evidence excerpts per neighbour row.
- `public/js/graph-explorer.js:565-594` — `dedupeNeighbors()` preserves direction, relationship_id, evidence_text; produces one row per direction.
- `public/js/graph-explorer.js:739-861` — `renderDetail()` rewritten entirely.
- `public/js/graph-explorer.js:935-976` — `loadEntity()` stops writing to the removed detail-header title/subtitle elements.
- `public/css/style.css:2970-3080` — `.graph-detail-tab*` rules removed, new rules added for redesigned layout.
- `views/graph.ejs:82-92` — `.graph-detail-header` block removed; `.graph-detail` shell keeps only the body.
- `views/collection-graph.ejs:84-93` — same removal as `graph.ejs`.

**Test (new):**
- `tests/integration/knowledge-graph-neighbors.test.js` — verifies the neighbors endpoint returns direction + evidence per row.

---

## Task 1: Backend — Attach relationship evidence to the neighbors endpoint

**Files:**
- Modify: `routes/graph.js:156-191`
- Test: `tests/integration/knowledge-graph-neighbors.test.js` (new)

- [ ] **Step 1: Write the failing integration test**

Create a new file `tests/integration/knowledge-graph-neighbors.test.js`:

```javascript
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let focusEntityId;
let neighborEntityId;
let relationshipId;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  return agent
    .post('/login')
    .type('form')
    .send({ username: 'neighboradmin', password: 'testpassword99!', _csrf: csrf });
}

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  const db = require('../../database/db');

  await server.initApp();
  app = server.app;

  const bootstrapAgent = request.agent(app);
  const setupPage = await bootstrapAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await bootstrapAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'neighboradmin',
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  const collectionId = await db.collectionsAsync.create({
    name: 'Neighbor Evidence Test Collection',
    description: 'Collection for neighbor evidence tests',
    is_public: 1,
    is_world_public: 0,
    allow_export: 0,
    auto_group_pages: 0,
    createdBy: 1
  });

  const documentId = await db.documentsAsync.create({
    title: 'Neighbor Evidence Source Document',
    date_created: '1880-05-02',
    description: 'Doc for neighbor evidence test',
    image_path: '/uploads/test-neighbor-doc.png',
    metadata: { author: 'Test' }
  });
  await db.documentCollectionsAsync.add(documentId, collectionId);

  const transcriptId = await db.transcriptsAsync.create({
    document_id: documentId,
    content: 'Alice wrote to Bob about the harbour proposal.',
    transcriber: 'Test',
    version: 1,
    notes: null,
    is_best: true
  });

  focusEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'Alice Reed',
    description: 'Focus entity',
    properties: {}
  });

  neighborEntityId = await db.entities.create({
    entity_type: 'person',
    canonical_name: 'Bob Grant',
    description: 'Neighbour entity',
    properties: {}
  });

  relationshipId = await db.relationships.create({
    source_entity_id: focusEntityId,
    target_entity_id: neighborEntityId,
    relationship_type: 'authored',
    confidence: 0.9,
    properties: {}
  });

  const citationId = await db.citations.create({
    entity_id: null,
    relationship_id: relationshipId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_start: 0,
    passage_end: 46,
    passage_text: 'Alice wrote to Bob about the harbour proposal.',
    extraction_method: 'test',
    extraction_model: 'jest',
    confidence: 0.9
  });

  await db.citationsAsync.approve(citationId, 1, 'manual');
}, 30_000);

describe('GET /graph/entities/:id/neighbors', () => {
  it('returns direction and a relationship evidence excerpt per row', async () => {
    const agent = request.agent(app);
    await loginAsAdmin(agent);

    const res = await agent.get(`/graph/entities/${focusEntityId}/neighbors?depth=1`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.neighbors)).toBe(true);

    const row = res.body.neighbors.find((n) => Number(n.id) === neighborEntityId);
    expect(row).toBeDefined();
    expect(row.direction).toBe('outgoing');
    expect(row.relationship_id).toBe(relationshipId);
    expect(row.relationship_type).toBe('authored');
    expect(row.evidence_text).toBe('Alice wrote to Bob about the harbour proposal.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/integration/knowledge-graph-neighbors.test.js --runInBand`
Expected: FAIL — the test expects `evidence_text` on the row but the endpoint currently does not attach it.

- [ ] **Step 3: Attach evidence excerpts in the neighbors route handler**

Replace the body of the handler in `routes/graph.js:156-191` with:

```javascript
router.get('/entities/:id/neighbors', async (req, res) => {
  const stores = graphStores();
  if (!stores.entities || !stores.graphAccess) {
    return graphNotReady(res);
  }

  const id = parseInt(req.params.id, 10);
  const depth = Math.min(2, Math.max(1, parseInt(req.query.depth, 10) || 1));
  if (!Number.isInteger(id) || !(await canAccessEntity(stores.graphAccess, id, req))) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const entity = await stores.entities.getById(id);
  if (!entity) {
    return res.status(404).json({ error: 'Entity not found.' });
  }

  const collectionId = collectionFilterId(req);
  const relType = req.query.relType || null;
  const { userId, isAdmin, accessAll } = accessOpts(req);
  const neighbors = stores.graphAccess && typeof stores.graphAccess.getNeighbors === 'function'
    ? await stores.graphAccess.getNeighbors(id, userId, isAdmin, accessAll, collectionId)
    : [];

  const accessChecks = await Promise.all(
    neighbors.map(async (neighbor) => ({
      neighbor,
      allowed: await canAccessEntity(stores.graphAccess, neighbor.id, req)
    }))
  );
  let accessible = accessChecks.filter((c) => c.allowed).map((c) => c.neighbor);
  if (relType) {
    accessible = accessible.filter((n) => n.relationship_type === relType);
  }

  const relationshipIds = Array.from(new Set(
    accessible.map((n) => n.relationship_id).filter((value) => Number.isInteger(value))
  ));
  const relationshipCitations = relationshipIds.length && stores.citations && stores.citations.getByRelationshipIds
    ? await stores.citations.getByRelationshipIds(relationshipIds, { approvalStatus: 'approved', collectionId })
    : [];
  const firstExcerptByRelationship = new Map();
  for (const citation of relationshipCitations) {
    if (!firstExcerptByRelationship.has(citation.relationship_id) && citation.passage_text) {
      firstExcerptByRelationship.set(citation.relationship_id, citation.passage_text);
    }
  }

  const enrichedNeighbors = accessible.map((neighbor) => ({
    ...neighbor,
    evidence_text: firstExcerptByRelationship.get(neighbor.relationship_id) || null
  }));

  return res.json({ entity, neighbors: enrichedNeighbors, depth });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/integration/knowledge-graph-neighbors.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Run the existing knowledge graph integration test as a regression check**

Run: `npx jest tests/integration/knowledge-graph.test.js --runInBand`
Expected: PASS — the existing tests should still pass.

- [ ] **Step 6: Commit**

```bash
git add routes/graph.js tests/integration/knowledge-graph-neighbors.test.js
git commit -m "feat(graph): attach relationship evidence to neighbors endpoint"
```

---

## Task 2: Client — Preserve direction and evidence in `dedupeNeighbors`

**Files:**
- Modify: `public/js/graph-explorer.js:565-594`

The current `dedupeNeighbors` collapses every relationship into a single comma-joined string per neighbour and throws away direction + relationship_id. The new version produces one row per (neighborId, direction, relationship_type) tuple, preserving `relationship_id` and `evidence_text` from Task 1. Display formatting (arrow, label humanising) happens at render time, not here.

- [ ] **Step 1: Replace `dedupeNeighbors` with a direction-aware version**

Find the current implementation at `public/js/graph-explorer.js:565-594`:

```javascript
function dedupeNeighbors(neighbors) {
  var map = new Map();
  safeArray(neighbors).forEach(function(n) {
    var id = Number(n.id);
    if (!map.has(id)) {
      map.set(id, {
        id: n.id,
        canonical_name: n.canonical_name || n.name,
        entity_type: n.entity_type,
        description: n.description || '',
        relationshipTypes: new Set(),
        relationshipCount: 0
      });
    }
    var entry = map.get(id);
    var rt = String(n.relationship_type || n.type || 'related_to');
    entry.relationshipTypes.add(rt);
    entry.relationshipCount += 1;
  });
  return Array.from(map.values()).map(function(entry) {
    return {
      id: entry.id,
      canonical_name: entry.canonical_name,
      entity_type: entry.entity_type,
      description: entry.description,
      relationship_type: Array.from(entry.relationshipTypes).map(function(t) { return t.replace(/_/g, ' '); }).join(', '),
      relationshipCount: entry.relationshipCount
    };
  });
}
```

Replace it with:

```javascript
function dedupeNeighbors(neighbors) {
  // One row per (neighborId, direction, relationship_type). Preserves
  // relationship_id and evidence_text so the detail pane can render a
  // directional row with an excerpt underneath.
  var seen = new Map();
  var rows = [];
  safeArray(neighbors).forEach(function(n) {
    var id = Number(n.id);
    var direction = n.direction === 'incoming' ? 'incoming' : 'outgoing';
    var relType = String(n.relationship_type || n.type || 'related_to');
    var key = id + '|' + direction + '|' + relType;
    if (seen.has(key)) return;
    seen.set(key, true);
    rows.push({
      id: n.id,
      canonical_name: n.canonical_name || n.name,
      entity_type: n.entity_type,
      description: n.description || '',
      relationship_id: n.relationship_id != null ? Number(n.relationship_id) : null,
      relationship_type: relType,
      direction: direction,
      evidence_text: n.evidence_text || null
    });
  });
  return rows;
}
```

- [ ] **Step 2: Audit every existing reader of `dedupeNeighbors` output**

Run: `grep -n "relationship_type\|relationshipCount\|\\.neighbor\\." public/js/graph-explorer.js`

Expected findings and required changes:

1. `renderGraphCanvas` / `forceLayout` / `renderDocumentGraphCanvas` — these read `neighbor.relationship_type` on the edges to draw the small label next to each line. Those sites keep working because `relationship_type` is still a string; it is just the raw un-humanised form now. Any site that calls `.replace(/_/g, ' ')` on it stays correct.

2. `renderDetail` — current implementation reads `neighbor.relationship_type` and joins with `, `. This is fully replaced in Task 3.

3. The `state.selectedNeighbors` count shown as "N relationships" still works because it is `.length` on the array.

- [ ] **Step 3: Smoke test in a browser**

Start the dev server and open any entity in the graph explorer. Confirm the canvas still renders labels on edges and the node cards still appear. The detail pane will still be using the old `renderDetail`, so it will temporarily show the old layout but with one-row-per-direction neighbour data visible in the connections list. That is expected.

- [ ] **Step 4: Commit**

```bash
git add public/js/graph-explorer.js
git commit -m "refactor(graph): preserve direction + evidence in dedupeNeighbors"
```

---

## Task 3: Client — Rewrite `renderDetail` with helpers and the new layout

**Files:**
- Modify: `public/js/graph-explorer.js:739-861`

`renderDetail` is replaced entirely. Three small pure helpers are added inside the IIFE above it:

- `groupCitationsByDocument(citations)` — groups by `document_id`, keeps up to three passages per doc, sorts by citation count desc.
- `buildAliasLine(aliases, maxInline)` — returns an HTML string for inline alias display with "+N more" collapsing.
- `humaniseRelType(relType)` — underscore → space; one place, used by connection rows.

- [ ] **Step 1: Add the three helpers above `renderDetail`**

Insert the following helpers immediately before `function renderDetail` at `public/js/graph-explorer.js:739`:

```javascript
function humaniseRelType(relType) {
  return String(relType || 'related_to').replace(/_/g, ' ');
}

function groupCitationsByDocument(citations) {
  var byDoc = new Map();
  safeArray(citations).forEach(function(citation) {
    var docId = citation.document_id;
    if (!docId) return;
    if (!byDoc.has(docId)) {
      byDoc.set(docId, {
        documentId: docId,
        documentTitle: citation.document_title || ('Document #' + docId),
        citationCount: 0,
        passages: []
      });
    }
    var entry = byDoc.get(docId);
    entry.citationCount += 1;
    var excerpt = normalizeCitationExcerpt(citation.passage_text);
    if (excerpt && entry.passages.length < 3) {
      entry.passages.push(excerpt);
    }
  });
  return Array.from(byDoc.values()).sort(function(a, b) {
    return b.citationCount - a.citationCount;
  });
}

function buildAliasLine(aliases, maxInline) {
  var list = safeArray(aliases)
    .map(function(a) { return String(a.alias || a.label || a.canonical_name || '').trim(); })
    .filter(Boolean);
  if (!list.length) return '';
  var limit = maxInline || 3;
  if (list.length <= limit) {
    return 'Also known as: ' + list.map(escHtml).join(', ');
  }
  var head = list.slice(0, limit).map(escHtml).join(', ');
  var extra = list.length - limit;
  return 'Also known as: ' + head + ' <span class="graph-alias-more">+' + extra + ' more</span>';
}
```

- [ ] **Step 2: Replace `renderDetail` with the new layout**

Find the current `renderDetail` at `public/js/graph-explorer.js:739-861` and replace the entire function with:

```javascript
function renderDetail(detail, neighbors, container, onSelect) {
  var entity = detail && detail.entity ? detail.entity : {};
  var aliases = safeArray(detail.aliases);
  var dates = safeArray(detail.dates);
  var citations = safeArray(detail.citations);

  var hasSources = citations.length > 0;
  var hasConnections = neighbors.length > 0;
  var hasDates = dates.length > 0;
  var hasDescription = !!(entity.description && String(entity.description).trim());
  var hasAnyContent = hasSources || hasConnections || hasDates || hasDescription || aliases.length > 0;

  // --- Header ---
  var aliasLine = buildAliasLine(aliases, 3);
  var headerHtml = ''
    + '<div class="graph-detail-header-compact">'
    +   '<span class="entity-type-badge ' + entityTypeClass(entity.entity_type) + '">'
    +     escHtml(entityTypeLabel(entity.entity_type))
    +   '</span>'
    +   '<h3 class="graph-detail-name">' + escHtml(entity.canonical_name || entity.name || 'Entity') + '</h3>'
    +   (aliasLine ? '<div class="graph-detail-aliases-inline">' + aliasLine + '</div>' : '')
    +   (hasDescription ? '<p class="graph-detail-description">' + escHtml(entity.description) + '</p>' : '')
    + '</div>';

  if (!hasAnyContent) {
    container.innerHTML = headerHtml + '<div class="graph-detail-empty-fallback">No approved details yet for this entity.</div>';
    return;
  }

  // --- Sources (merged) ---
  var sourcesHtml = '';
  if (hasSources) {
    var grouped = groupCitationsByDocument(citations);
    var passageTotal = citations.length;
    var docTotal = grouped.length;
    var countPill = docTotal + (docTotal === 1 ? ' document · ' : ' documents · ') + passageTotal + (passageTotal === 1 ? ' passage' : ' passages');
    var cards = grouped.map(function(entry) {
      var href = documentLinkHref(entry.documentId);
      var passageHtml = entry.passages.map(function(text) {
        return '<blockquote class="graph-citation-quote">' + escHtml(text) + '</blockquote>';
      }).join('');
      return ''
        + '<div class="graph-source-card">'
        +   '<div class="graph-source-card-header">'
        +     '<a class="graph-citation-link" href="' + href + '">' + escHtml(entry.documentTitle) + '</a>'
        +     '<span class="graph-source-card-count">' + formatCount(entry.citationCount, 'passage', 'passages') + '</span>'
        +   '</div>'
        +   passageHtml
        +   '<a class="btn-secondary btn-sm graph-source-card-action" href="' + href + '">Open document</a>'
        + '</div>';
    }).join('');
    sourcesHtml = ''
      + '<hr class="graph-detail-divider">'
      + '<section class="graph-detail-section">'
      +   '<div class="graph-detail-section-label">Sources <span class="graph-detail-section-count">' + escHtml(countPill) + '</span></div>'
      +   '<div class="graph-citation-list">' + cards + '</div>'
      + '</section>';
  }

  // --- Connections (directional) ---
  var connectionsHtml = '';
  if (hasConnections) {
    var rows = neighbors.map(function(neighbor) {
      var arrow = neighbor.direction === 'incoming' ? '&larr;' : '&rarr;';
      var relLabel = escHtml(humaniseRelType(neighbor.relationship_type));
      var typeBadge = '<span class="entity-type-badge ' + entityTypeClass(neighbor.entity_type) + '">'
        + escHtml(entityTypeLabel(neighbor.entity_type))
        + '</span>';
      var evidence = neighbor.evidence_text
        ? '<div class="graph-connection-evidence">' + escHtml(normalizeCitationExcerpt(neighbor.evidence_text)) + '</div>'
        : '';
      return ''
        + '<button type="button" class="graph-connection-row" data-neighbor-id="' + escHtml(neighbor.id) + '">'
        +   '<span class="graph-connection-arrow">' + arrow + '</span>'
        +   '<span class="graph-connection-rel">' + relLabel + '</span>'
        +   '<span class="graph-connection-name">' + escHtml(neighbor.canonical_name || 'Entity') + typeBadge + '</span>'
        +   evidence
        + '</button>';
    }).join('');
    connectionsHtml = ''
      + '<hr class="graph-detail-divider">'
      + '<section class="graph-detail-section">'
      +   '<div class="graph-detail-section-label">Connections <span class="graph-detail-section-count">' + neighbors.length + '</span></div>'
      +   '<div class="graph-connection-list">' + rows + '</div>'
      + '</section>';
  }

  // --- Dates (conditional) ---
  var datesHtml = '';
  if (hasDates) {
    var dateCards = dates.map(function(date) {
      var earliest = date.earliest || '';
      var latest = date.latest && date.latest !== date.earliest ? ' to ' + date.latest : '';
      return ''
        + '<div class="graph-detail-card">'
        +   '<strong>' + escHtml(date.label || date.mention || '') + '</strong>'
        +   '<div class="graph-muted">' + escHtml(earliest) + escHtml(latest) + '</div>'
        + '</div>';
    }).join('');
    datesHtml = ''
      + '<hr class="graph-detail-divider">'
      + '<section class="graph-detail-section">'
      +   '<div class="graph-detail-section-label">Timeline <span class="graph-detail-section-count">' + dates.length + '</span></div>'
      +   '<div class="graph-detail-list">' + dateCards + '</div>'
      + '</section>';
  }

  container.innerHTML = headerHtml + sourcesHtml + connectionsHtml + datesHtml;

  // Wire connection rows to select the neighbour via the provided callback.
  if (typeof onSelect === 'function') {
    var connectionButtons = container.querySelectorAll('.graph-connection-row[data-neighbor-id]');
    connectionButtons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var nid = Number(btn.getAttribute('data-neighbor-id'));
        if (Number.isInteger(nid)) onSelect(nid);
      });
    });
  }
}
```

- [ ] **Step 3: Pass `loadEntity` as the `onSelect` callback**

Find the `renderDetail` call inside `loadEntity` at `public/js/graph-explorer.js:964-966`:

```javascript
        if (detailBody) {
          renderDetail(detail, neighbors, detailBody);
        }
```

Replace with:

```javascript
        if (detailBody) {
          renderDetail(detail, neighbors, detailBody, loadEntity);
        }
```

- [ ] **Step 4: Remove the chrome title/subtitle writes that the new header replaces**

Inside `loadEntity` at `public/js/graph-explorer.js:954-955`, the current lines are:

```javascript
        if (detailTitle) detailTitle.textContent = detail.entity.canonical_name || detail.entity.name || 'Entity';
        if (detailSubtitle) detailSubtitle.textContent = `${entityTypeLabel(detail.entity.entity_type)} · ${formatCount(neighbors.length, 'neighbor', 'neighbors')}`;
```

These two lines target the `#graph-detail-title` and `#graph-detail-subtitle` elements that will be removed from both EJS templates in Task 4. Replace both with a single guarded no-op so the JS stays compatible if either template is ever rehydrated:

```javascript
        if (detailTitle) detailTitle.textContent = '';
        if (detailSubtitle) detailSubtitle.textContent = '';
```

These guards become harmless dead code after Task 4 because `qs('#graph-detail-title', panel)` returns null for a removed element, so the `if` branch never fires.

- [ ] **Step 5: Smoke test in a browser**

Start the dev server. Open the global graph explorer (`/graph`) and click a few entities with different shapes:

- One with no aliases, no citations, no connections → single empty-state fallback line.
- One with a handful of citations in one document → single Sources card grouped under that doc.
- One with citations across two or more documents → multiple Sources cards, sorted by passage count desc.
- One with a mix of incoming and outgoing connections → rows show `→` and `←` correctly with the humanised relationship label.
- A connection row that has a relationship citation → evidence excerpt appears under the row.

Clicking a connection row should load that neighbour as the new focus entity.

- [ ] **Step 6: Commit**

```bash
git add public/js/graph-explorer.js
git commit -m "feat(graph): rewrite detail pane with merged sources and directional connections"
```

---

## Task 4: Templates — Remove the redundant `.graph-detail-header` block

**Files:**
- Modify: `views/graph.ejs:82-92`
- Modify: `views/collection-graph.ejs:84-93`

The detail body now owns its own header. The `.graph-detail-header` chrome above the body becomes dead visual real estate and must be removed from both templates.

- [ ] **Step 1: Remove the chrome header in `views/graph.ejs`**

Find this block in `views/graph.ejs`:

```ejs
      <aside class="graph-detail">
        <div class="graph-detail-header">
          <p class="kg-panel-eyebrow">Details</p>
          <h2 id="graph-detail-title">No entity selected</h2>
          <p class="graph-muted" id="graph-detail-subtitle">Search or click a node to begin.</p>
        </div>
        <div class="graph-detail-body" id="graph-detail-body">
          <div class="graph-empty-state">Entity metadata, aliases, citations, and relationships appear here.</div>
        </div>
      </aside>
```

Replace with:

```ejs
      <aside class="graph-detail">
        <div class="graph-detail-body" id="graph-detail-body">
          <div class="graph-empty-state">Select an entity to see its sources and connections.</div>
        </div>
      </aside>
```

- [ ] **Step 2: Remove the same block in `views/collection-graph.ejs`**

Find the equivalent block in `views/collection-graph.ejs`:

```ejs
      <aside class="graph-detail">
        <div class="graph-detail-header">
          <p class="kg-panel-eyebrow">Details</p>
          <h2 id="graph-detail-title">No entity selected</h2>
          <p class="graph-muted" id="graph-detail-subtitle">Search or click a node to begin.</p>
        </div>
        <div class="graph-detail-body" id="graph-detail-body">
          <div class="graph-empty-state">Entity metadata, aliases, citations, and relationships appear here.</div>
        </div>
      </aside>
```

Replace with:

```ejs
      <aside class="graph-detail">
        <div class="graph-detail-body" id="graph-detail-body">
          <div class="graph-empty-state">Select an entity to see its sources and connections.</div>
        </div>
      </aside>
```

- [ ] **Step 3: Smoke test both views**

Open `/graph` and a collection graph page (e.g. `/collections/<id>/graph`). Confirm:

- The right-hand pane has no floating "Details" eyebrow or stale "No entity selected" title above the body.
- Clicking an entity renders the new compact header inside the body.
- Before any entity is selected, the body shows "Select an entity to see its sources and connections."

- [ ] **Step 4: Commit**

```bash
git add views/graph.ejs views/collection-graph.ejs
git commit -m "chore(graph): drop duplicate detail header from graph templates"
```

---

## Task 5: CSS — Add redesign rules and drop the unused stats-tabs rules

**Files:**
- Modify: `public/css/style.css:2970-3080`

Remove the `.graph-detail-tab*` rules (no longer rendered). Add rules for the new compact header, inline aliases, section label, dividers, source card, connection row, and empty fallback.

- [ ] **Step 1: Delete the `.graph-detail-tabs` and `.graph-detail-tab*` rules**

Find and delete the rules at `public/css/style.css:2970-2996`:

```css
.graph-detail-tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  margin-top: 10px;
  margin-bottom: 18px;
}

.graph-detail-tab {
  color: var(--ink-muted);
  font-size: 0.8rem;
  line-height: 1.3;
  padding: 0 10px 0 0;
}

.graph-detail-tab strong {
  color: var(--ink);
  font-weight: 600;
  font-size: 0.85rem;
}

.graph-detail-tab + .graph-detail-tab::before {
  content: '·';
  margin-right: 10px;
  color: var(--border, #ccc7be);
}
```

Run `grep -n "graph-detail-tab" public/css/style.css` afterwards to confirm only the `#document-knowledge-graph .kg-document-stats .graph-detail-tab` override at `:2266` remains. That override is used by the document knowledge graph tab and is out of scope for this redesign — leave it alone.

- [ ] **Step 2: Add the new redesign rules**

Append the following rules at the end of the `.graph-detail` rule block (right after the existing `.graph-empty-state--compact` rule at `public/css/style.css:3080`):

```css
.graph-detail-header-compact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}

.graph-detail-header-compact .entity-type-badge {
  align-self: flex-start;
}

.graph-detail-name {
  font-family: 'EB Garamond', Georgia, serif;
  font-size: 1.4rem;
  font-weight: 600;
  margin: 2px 0 0;
  line-height: 1.2;
  color: var(--ink);
}

.graph-detail-aliases-inline {
  color: var(--ink-muted);
  font-style: italic;
  font-size: 0.88rem;
  margin-top: 2px;
}

.graph-detail-aliases-inline .graph-alias-more {
  font-style: normal;
  color: var(--ink-soft);
  font-size: 0.78rem;
  margin-left: 4px;
}

.graph-detail-divider {
  border: 0;
  border-top: 1px solid var(--border-light);
  margin: 18px 0 14px;
}

.graph-detail-section-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: 10px;
}

.graph-detail-section-count {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--ink);
  background: var(--surface-alt);
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.04em;
  text-transform: none;
}

.graph-source-card {
  border: 1px solid var(--border-light);
  border-radius: 14px;
  background: var(--surface-alt);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.graph-source-card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.graph-source-card-count {
  font-size: 0.72rem;
  color: var(--ink-soft);
  white-space: nowrap;
}

.graph-source-card-action {
  align-self: flex-start;
  margin-top: 2px;
}

.graph-connection-list {
  display: flex;
  flex-direction: column;
}

.graph-connection-row {
  display: grid;
  grid-template-columns: 18px 110px 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 4px 10px;
  width: 100%;
  padding: 10px 4px;
  border: 0;
  border-bottom: 1px dashed var(--border-light);
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--ink);
}

.graph-connection-row:last-child {
  border-bottom: 0;
}

.graph-connection-row:hover,
.graph-connection-row:focus-visible {
  background: var(--surface-alt);
  outline: none;
}

.graph-connection-arrow {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 1rem;
  color: var(--accent-dark, #7c4d2e);
  text-align: center;
}

.graph-connection-rel {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 0.74rem;
  color: var(--ink-soft);
  text-transform: lowercase;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.graph-connection-name {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--ink);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.graph-connection-evidence {
  grid-column: 2 / -1;
  font-style: italic;
  font-size: 0.82rem;
  color: var(--ink-muted);
  line-height: 1.4;
  padding-top: 2px;
}

.graph-detail-empty-fallback {
  margin-top: 18px;
  padding: 16px 0;
  color: var(--ink-muted);
  font-style: italic;
  text-align: center;
  border-top: 1px solid var(--border-light);
}
```

- [ ] **Step 3: Visual check in both views**

Reload `/graph` and a collection graph page. Confirm:

- The new header has type badge → name → aliases stacked with consistent spacing.
- Section labels read as small uppercase with a count pill, followed by a subtle divider between sections.
- Connection rows line up in a tidy column (arrow, relationship label, name), evidence excerpts sit indented below when present.
- Hover on a connection row highlights with a warm tint.
- An entity with nothing shows the italic "No approved details yet for this entity." fallback.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "style(graph): add redesigned detail pane rules, drop stats tabs css"
```

---

## Task 6: Verification — Full test run and cross-view smoke test

**Files:**
- No edits. Verification only.

- [ ] **Step 1: Run the full Jest suite**

Run: `npm test`
Expected: ALL PASS. Note any failures and resolve them before proceeding. In particular, the new `tests/integration/knowledge-graph-neighbors.test.js` should pass, and the existing `tests/integration/knowledge-graph.test.js` should still pass.

- [ ] **Step 2: Smoke-test the global graph explorer**

Load `/graph`. For an entity with real data from your local dataset, confirm:

- Only one compact header renders (type badge → name → aliases → optional description).
- No `Details` eyebrow, no stats row, no duplicate entity card.
- Sources section lists each document once, with passage count and up to 3 excerpts per doc.
- Connections section shows directional arrows, humanised relationship labels, and evidence excerpts where available.
- Clicking a connection row loads that neighbour into the pane.
- An entity with no data shows the "No approved details yet for this entity." fallback.

- [ ] **Step 3: Smoke-test the per-collection graph explorer**

Load `/collections/<id>/graph` for a collection with entities. Repeat the checks from Step 2 inside the collection scope. Confirm the collection hero still renders above the graph toolbar, unchanged.

- [ ] **Step 4: Smoke-test the document knowledge tab**

Load a document page with an approved entity extraction. Open the knowledge tab. Confirm the document knowledge graph, which reuses `ENTITY_TYPE_LABELS` and the dedupe helpers, still renders correctly. This catches regressions from the `dedupeNeighbors` shape change.

- [ ] **Step 5: Commit any verification fixups and push**

If Steps 1–4 surface a regression, fix it, commit with a focused message, and re-run `npm test`. When everything is green:

```bash
git log --oneline -10
```

Review the last commits:

```
feat(graph): attach relationship evidence to neighbors endpoint
refactor(graph): preserve direction + evidence in dedupeNeighbors
feat(graph): rewrite detail pane with merged sources and directional connections
chore(graph): drop duplicate detail header from graph templates
style(graph): add redesigned detail pane rules, drop stats tabs css
```

Do not push automatically. The user will push when they are ready.

---

## Self-review notes

- **Spec coverage.** Header redundancy → Task 3 + Task 4. Stats row → Task 3 (removed entirely) + Task 5 (CSS deleted). Empty Dates section → Task 3 (conditional). Citations/Cited-in-documents duplication → Task 3 (`groupCitationsByDocument`). Connections direction + evidence → Task 1 (backend) + Task 2 (client dedup) + Task 3 (render). Empty-entity fallback → Task 3. Section dividers → Task 5. Success criteria from the spec all map onto tasks.
- **Out-of-scope guard rails.** No changes to sidebar, canvas, toolbar filters, permissions, or extraction. The only backend edit is one handler body in `routes/graph.js`; no db.js changes.
- **Type consistency.** `dedupeNeighbors` output in Task 2 matches exactly what Task 3 reads: `id`, `canonical_name`, `entity_type`, `description`, `relationship_id`, `relationship_type`, `direction`, `evidence_text`. The neighbors endpoint in Task 1 returns `relationship_id`, `direction`, `relationship_type`, `evidence_text` — same shape.
- **No placeholders.** Every step has exact code. No "TBD", no "handle edge cases", no "similar to Task N".
- **TDD where it fits.** Task 1 is TDD because the backend has a Jest+supertest harness. Tasks 2–5 are direct refactors with manual smoke tests — consistent with the project's existing pattern of no client-JS unit tests.
