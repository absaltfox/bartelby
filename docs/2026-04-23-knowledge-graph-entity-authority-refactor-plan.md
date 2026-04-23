# Knowledge Graph: Entity–Authority Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entities document-scoped attestation records and introduce an async authority suggestion job powered by local embeddings and fuzzy name matching, replacing the current cross-document entity collapsing at extraction time.

**Architecture:** `resolveEntity` is replaced by a synchronous, Map-scoped variant that only deduplicates within the current transcript. A new `authority_suggestion_jobs` worker uses a token-inverted-index fuzzy pre-filter followed by `@xenova/transformers` cosine similarity to propose authority links, which flow into the existing `authority_link_suggestions` review UI. Migration wipes extracted graph evidence and re-queues extraction from all best transcripts.

**Tech Stack:** Node.js, SQLite (sqljs/better-sqlite3/turso), `@xenova/transformers` (all-MiniLM-L6-v2), existing Jest + supertest test harness.

**Spec:** `docs/2026-04-23-knowledge-graph-entity-authority-refactor.md`

---

## File Map

**New files:**
- `utils/entity-embedding.js` — builds text representation for embedding; pure, no DB
- `utils/authority-suggestion-pipeline.js` — fuzzy pre-filter (inverted token index) + cosine scoring
- `utils/worker-authority-suggestion.js` — job worker: claims job, runs pipeline, writes results
- `scripts/reset-graph-evidence.js` — one-time migration: wipe graph tables + re-queue extractions
- `tests/unit/resolve-entity-in-scope.test.js`
- `tests/unit/entity-embedding.test.js`
- `tests/unit/authority-suggestion-pipeline.test.js`
- `tests/integration/authority-suggestion-worker.test.js`

**Modified files:**
- `utils/entity-resolution.js` — add `resolveEntityInScope` (synchronous, Map-based)
- `utils/worker-extraction.js` — use `resolveEntityInScope`, remove `ensureEntityAuthority` call, add post-extraction suggestion job trigger
- `database/db.js` — add `authority_suggestion_jobs` table in `initializeSchema`, export model
- `database/models/jobs.js` — add `authoritySuggestionJobs` model object
- `utils/worker.js` — register `runAuthoritySuggestionWorkerCycle`
- `routes/admin-authorities.js` — add POST route to trigger suggestion job
- `views/admin/authorities.ejs` — add "Run authority suggestion" button
- `docs/knowledge-graph-design.md` — update entity/alias/authority descriptions

---

## Task 1: Add `resolveEntityInScope` to entity-resolution.js

**Files:**
- Modify: `utils/entity-resolution.js`
- Test: `tests/unit/resolve-entity-in-scope.test.js`

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/resolve-entity-in-scope.test.js`:

```js
'use strict';

const { resolveEntityInScope, normalizeForMatching } = require('../../utils/entity-resolution');

describe('resolveEntityInScope', () => {
  let scope;

  beforeEach(() => {
    scope = new Map();
    scope.set('alice reed', 42);
    scope.set('alice', 42);
    scope.set('william henry', 99);
    scope.set('william', 99);
  });

  it('returns null when scope is empty', () => {
    expect(resolveEntityInScope('Bob Grant', 'Bob Grant', 'person', new Map())).toBeNull();
  });

  it('matches by exact normalised canonical name', () => {
    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', scope);
    expect(result).toEqual({ entityId: 42, matchType: 'scope_canonical' });
  });

  it('matches after abbreviation expansion (Wm. → william)', () => {
    const result = resolveEntityInScope('Wm. Henry', 'Wm. Henry', 'person', scope);
    expect(result).toEqual({ entityId: 99, matchType: 'scope_fuzzy' });
  });

  it('returns null for an entity not in scope', () => {
    const result = resolveEntityInScope('Bob Grant', 'Bob Grant', 'person', scope);
    expect(result).toBeNull();
  });

  it('returns null when scope contains the name but entity_type differs (different Map has no type)', () => {
    // scope is a flat name→id map; type filtering is the caller's responsibility
    // resolveEntityInScope itself does not filter by type — that is handled
    // upstream by building separate scopes per type if needed.
    // This test just documents that behaviour.
    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'place', scope);
    expect(result).toEqual({ entityId: 42, matchType: 'scope_canonical' });
  });
});
```

- [ ] **Step 1.2: Run test to confirm it fails**

```bash
npx jest tests/unit/resolve-entity-in-scope.test.js --no-coverage
```

Expected: `FAIL` — `resolveEntityInScope is not a function`

- [ ] **Step 1.3: Implement `resolveEntityInScope` in entity-resolution.js**

Add this function after `normalizeForMatching` (around line 88) and export it:

```js
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
```

Add `resolveEntityInScope` to the `module.exports` at the bottom of the file:

```js
module.exports = {
  normalizeComparable,
  similarityScore,
  normalizeForMatching,
  expandAbbreviations,
  stripHonorifics,
  resolveEntity,
  resolveEntityInScope,   // ← add this
  suggestMerges,
  mergeEntities
};
```

- [ ] **Step 1.4: Run test to confirm it passes**

```bash
npx jest tests/unit/resolve-entity-in-scope.test.js --no-coverage
```

Expected: `PASS` — 5 tests pass

- [ ] **Step 1.5: Commit**

```bash
git add utils/entity-resolution.js tests/unit/resolve-entity-in-scope.test.js
git commit -m "feat(kg): add resolveEntityInScope for intra-document deduplication"
```

---

## Task 2: Update worker-extraction.js

Swap the global `resolveEntity` call for `resolveEntityInScope`, and remove the `ensureEntityAuthority` call. Entities will no longer be auto-assigned to authorities at extraction time.

**Files:**
- Modify: `utils/worker-extraction.js`
- Test: `tests/unit/worker-extraction.test.js` (existing file — add tests)

- [ ] **Step 2.1: Write the failing tests**

Open `tests/unit/worker-extraction.test.js`. Find the `describe` block (or add one) and add:

```js
it('does not resolve entities across document boundaries', async () => {
  // The existing resolveEntity was async and hit the DB.
  // resolveEntityInScope is sync and only sees the current-run Map.
  // Verify: if an entity with the same name exists in the DB from a prior run,
  // extraction still creates a NEW entity for the current document.
  const { resolveEntityInScope } = require('../../utils/entity-resolution');

  const emptyScope = new Map();
  // Simulate a name that would have matched in the old global DB search
  const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', emptyScope);
  expect(result).toBeNull(); // empty scope → always creates new entity
});

it('resolveEntityInScope deduplicates within the same extraction run', () => {
  const { resolveEntityInScope } = require('../../utils/entity-resolution');
  const scope = new Map();
  scope.set('alice reed', 7);
  scope.set('alice', 7);

  const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', scope);
  expect(result).toEqual({ entityId: 7, matchType: 'scope_canonical' });
});
```

- [ ] **Step 2.2: Run tests to confirm they fail or already pass**

```bash
npx jest tests/unit/worker-extraction.test.js --no-coverage
```

Note the current state. If the new tests pass immediately it means the logic already exists — verify the implementation step below is still needed.

- [ ] **Step 2.3: Replace `resolveEntity` with `resolveEntityInScope` in worker-extraction.js**

At the top of `utils/worker-extraction.js`, the `resolveEntity` import is inside the function via `require('./entity-resolution')`. Find the extraction loop (around line 118) where `resolveEntity` is called:

```js
// BEFORE — remove this line:
const { resolveEntity } = require('./entity-resolution');

// BEFORE — remove this call:
const resolved = await resolveEntity(mention, normalized, entityType);
```

Replace with:

```js
// AFTER — add at top of the function (alongside other requires):
const { resolveEntityInScope } = require('./entity-resolution');

// AFTER — replace the resolveEntity call:
const resolved = resolveEntityInScope(mention, normalized, entityType, mentionToEntityId);
```

The `mentionToEntityId` Map is already built in the function — it's on line ~120. `resolveEntityInScope` is synchronous so remove the `await`.

Also update the two Map assignments below (around lines 158–159) to store the expanded key alongside the raw key so future mentions in the same transcript can match by either form:

```js
// After creating or resolving an entity, register both raw and expanded forms:
const { normalizeComparable, normalizeForMatching } = require('./entity-resolution');
mentionToEntityId.set(normalizeComparable(mention), entityId);
mentionToEntityId.set(normalizeComparable(normalized), entityId);
mentionToEntityId.set(normalizeForMatching(mention), entityId);
mentionToEntityId.set(normalizeForMatching(normalized), entityId);
```

- [ ] **Step 2.4: Remove `ensureEntityAuthority` call**

Find and delete the block (around line 152–156):

```js
// DELETE this entire block:
await ensureEntityAuthority(entityId, {
  mention,
  normalized,
  entityType
});
```

Also remove the import at the top of the function if `ensureEntityAuthority` is no longer used:

```js
// DELETE:
const { ensureEntityAuthority } = require('./authority-resolution');
```

- [ ] **Step 2.5: Run the full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass. If any test relies on `ensureEntityAuthority` being called during extraction, update it to expect no authority assignment.

- [ ] **Step 2.6: Commit**

```bash
git add utils/worker-extraction.js tests/unit/worker-extraction.test.js
git commit -m "feat(kg): scope entity resolution to current transcript, remove inline authority assignment"
```

---

## Task 3: Add `authority_suggestion_jobs` schema and model

**Files:**
- Modify: `database/db.js` — add table in `initializeSchema`
- Modify: `database/models/jobs.js` — add `authoritySuggestionJobs` model
- Modify: `database/db.js` — export `authoritySuggestionJobsAsync`

- [ ] **Step 3.1: Add table to `initializeSchema` in db.js**

In `database/db.js`, find the block ending around line 232 that contains `authority_resolution_jobs`. Append the new table definition immediately before the closing backtick and `);`:

```js
// Add before the closing `); of the authority_resolution_jobs block:

  CREATE TABLE IF NOT EXISTS authority_suggestion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    entity_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    suggestion_count INTEGER NOT NULL DEFAULT 0,
    auto_approved_count INTEGER NOT NULL DEFAULT 0,
    fuzzy_threshold REAL NOT NULL DEFAULT 0.6,
    pending_threshold REAL NOT NULL DEFAULT 0.75,
    auto_approve_threshold REAL NOT NULL DEFAULT 0.92,
    requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_authority_suggestion_jobs_status ON authority_suggestion_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_authority_suggestion_jobs_collection ON authority_suggestion_jobs(collection_id);
```

- [ ] **Step 3.2: Add `authoritySuggestionJobs` to jobs.js**

In `database/models/jobs.js`, add the following object after the `authorityResolutionJobs` object (before the closing `return` statement or wherever the model objects are returned):

```js
const authoritySuggestionJobs = {
  async create({ collection_id = null, fuzzy_threshold = 0.6, pending_threshold = 0.75, auto_approve_threshold = 0.92, requested_by_user_id = null } = {}) {
    const result = await runAsync(`
      INSERT INTO authority_suggestion_jobs
        (collection_id, fuzzy_threshold, pending_threshold, auto_approve_threshold, requested_by_user_id, status)
      VALUES (?, ?, ?, ?, ?, 'queued')
    `, [
      collection_id != null ? Number(collection_id) : null,
      fuzzy_threshold,
      pending_threshold,
      auto_approve_threshold,
      requested_by_user_id != null ? Number(requested_by_user_id) : null
    ]);
    await saveDatabase();
    return result.lastInsertRowid;
  },

  async getById(id) {
    return await getAsync('SELECT * FROM authority_suggestion_jobs WHERE id = ?', [id]);
  },

  async hasPendingOrRunningForCollection(collection_id) {
    const row = await getAsync(`
      SELECT id FROM authority_suggestion_jobs
      WHERE collection_id IS ? AND status IN ('queued', 'running')
      LIMIT 1
    `, [collection_id != null ? Number(collection_id) : null]);
    return !!row;
  },

  async claimNextQueued() {
    return await withExclusiveLock(async () => {
      const job = await getAsync(`
        SELECT * FROM authority_suggestion_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      if (!job) return null;
      const result = await runAsyncWithoutSave(`
        UPDATE authority_suggestion_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            completed_at = NULL,
            error = NULL,
            attempts = attempts + 1
        WHERE id = ? AND status = 'queued'
      `, [job.id]);
      if (!result || !result.changes) return null;
      return await this.getById(job.id);
    });
  },

  async appendLog(id, text) {
    await runAsyncWithoutSave(
      'UPDATE authority_suggestion_jobs SET log = log || ? WHERE id = ?',
      [text, id]
    );
    await saveDatabase();
  },

  async markDone(id, { entityCount, candidateCount, suggestionCount, autoApprovedCount } = {}) {
    await runAsyncWithoutSave(`
      UPDATE authority_suggestion_jobs
      SET status = 'done',
          entity_count = COALESCE(?, entity_count),
          candidate_count = COALESCE(?, candidate_count),
          suggestion_count = COALESCE(?, suggestion_count),
          auto_approved_count = COALESCE(?, auto_approved_count),
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      Number.isInteger(entityCount) ? entityCount : null,
      Number.isInteger(candidateCount) ? candidateCount : null,
      Number.isInteger(suggestionCount) ? suggestionCount : null,
      Number.isInteger(autoApprovedCount) ? autoApprovedCount : null,
      id
    ]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await runAsyncWithoutSave(`
      UPDATE authority_suggestion_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error || 'Unknown error', id]);
    await saveDatabase();
  }
};
```

Make sure `authoritySuggestionJobs` is included in the object returned by the module factory function (find the `return {` statement and add it):

```js
// In the return statement, add:
authoritySuggestionJobs,
authoritySuggestionJobsAsync: authoritySuggestionJobs,
```

- [ ] **Step 3.3: Export from db.js**

In `database/db.js`, find the line (around 912) that requires `./models/jobs` and add `authoritySuggestionJobs` and `authoritySuggestionJobsAsync` to the destructured import and the exports block:

```js
// Modify the require line — add the new names:
const { ..., authoritySuggestionJobs, authoritySuggestionJobsAsync } = require('./models/jobs')(...);

// Add to the module.exports block:
authoritySuggestionJobs,
authoritySuggestionJobsAsync,
```

- [ ] **Step 3.4: Run the test suite to confirm schema applies cleanly**

```bash
npx jest --no-coverage
```

Expected: all tests pass. The `sqljs` test environment applies `initializeSchema` on startup, so if the DDL has a syntax error it will fail here.

- [ ] **Step 3.5: Commit**

```bash
git add database/db.js database/models/jobs.js
git commit -m "feat(kg): add authority_suggestion_jobs table and model"
```

---

## Task 4: Add `utils/entity-embedding.js`

Pure module. No DB calls. Builds the structured text string fed to the embedding model.

**Files:**
- Create: `utils/entity-embedding.js`
- Test: `tests/unit/entity-embedding.test.js`

- [ ] **Step 4.1: Write the failing tests**

Create `tests/unit/entity-embedding.test.js`:

```js
'use strict';

const { buildEntityText } = require('../../utils/entity-embedding');

describe('buildEntityText', () => {
  it('builds text with name, type, aliases, and citation', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const aliases = ['Mrs. Reed', 'A. Reed'];
    const citation = 'Alice Reed wrote to Bob Grant about harbour plans in 1842.';
    const text = buildEntityText(entity, aliases, citation);
    expect(text).toBe(
      'person: Alice Reed. Also known as: Mrs. Reed, A. Reed.\n' +
      'Evidence: "Alice Reed wrote to Bob Grant about harbour plans in 1842."'
    );
  });

  it('omits the Also known as line when there are no aliases', () => {
    const entity = { entity_type: 'place', canonical_name: 'Halifax' };
    const text = buildEntityText(entity, [], null);
    expect(text).toBe('place: Halifax.');
  });

  it('omits the Evidence line when citation is null', () => {
    const entity = { entity_type: 'person', canonical_name: 'Bob Grant' };
    const text = buildEntityText(entity, ['B. Grant'], null);
    expect(text).toBe('person: Bob Grant. Also known as: B. Grant.');
  });

  it('truncates citation passages longer than 120 chars', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const longCitation = 'A'.repeat(200);
    const text = buildEntityText(entity, [], longCitation);
    expect(text).toContain('Evidence: "' + 'A'.repeat(120) + '"');
    expect(text.length).toBeLessThan(200);
  });

  it('deduplicates aliases that match the canonical name', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const text = buildEntityText(entity, ['Alice Reed', 'Mrs. Reed'], null);
    expect(text).toBe('person: Alice Reed. Also known as: Mrs. Reed.');
  });
});
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
npx jest tests/unit/entity-embedding.test.js --no-coverage
```

Expected: `FAIL` — `Cannot find module '../../utils/entity-embedding'`

- [ ] **Step 4.3: Implement `utils/entity-embedding.js`**

```js
'use strict';

const MAX_CITATION_LENGTH = 120;

/**
 * Build a structured text representation of an entity for embedding.
 * @param {object} entity - { entity_type, canonical_name }
 * @param {string[]} aliases - alternate name forms (canonical name is deduplicated out)
 * @param {string|null} citation - first citation passage text, or null
 * @returns {string}
 */
function buildEntityText(entity, aliases, citation) {
  const canonicalLower = (entity.canonical_name || '').toLowerCase().trim();
  const dedupedAliases = (aliases || []).filter(
    (a) => a && a.toLowerCase().trim() !== canonicalLower
  );

  let text = `${entity.entity_type}: ${entity.canonical_name}.`;

  if (dedupedAliases.length > 0) {
    text += ` Also known as: ${dedupedAliases.join(', ')}.`;
  }

  if (citation) {
    const truncated = String(citation).slice(0, MAX_CITATION_LENGTH);
    text += `\nEvidence: "${truncated}"`;
  }

  return text;
}

module.exports = { buildEntityText };
```

- [ ] **Step 4.4: Run tests to confirm they pass**

```bash
npx jest tests/unit/entity-embedding.test.js --no-coverage
```

Expected: `PASS` — 5 tests pass

- [ ] **Step 4.5: Commit**

```bash
git add utils/entity-embedding.js tests/unit/entity-embedding.test.js
git commit -m "feat(kg): add entity embedding text builder"
```

---

## Task 5: Add `utils/authority-suggestion-pipeline.js`

Fuzzy pre-filter (inverted token index) and cosine similarity scoring. The embedding function is injected as a parameter so tests can supply a mock.

**Files:**
- Create: `utils/authority-suggestion-pipeline.js`
- Test: `tests/unit/authority-suggestion-pipeline.test.js`

- [ ] **Step 5.1: Write the failing tests**

Create `tests/unit/authority-suggestion-pipeline.test.js`:

```js
'use strict';

const { buildCandidatePairs, cosineSimilarity } = require('../../utils/authority-suggestion-pipeline');

describe('buildCandidatePairs', () => {
  const entities = [
    { id: 1, entity_type: 'person', canonical_name: 'Alice Reed' },
    { id: 2, entity_type: 'person', canonical_name: 'A. Reed' },
    { id: 3, entity_type: 'person', canonical_name: 'Bob Grant' },
    { id: 4, entity_type: 'place',  canonical_name: 'Alice Street' },
  ];

  it('finds candidate pair for similar names of the same type', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const ids = pairs.map(p => [p.entityA.id, p.entityB.id].sort((a,b)=>a-b));
    expect(ids).toContainEqual([1, 2]); // Alice Reed + A. Reed share token 'reed'
  });

  it('does not pair entities of different types', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const crossType = pairs.filter(p => p.entityA.entity_type !== p.entityB.entity_type);
    expect(crossType).toHaveLength(0);
  });

  it('does not pair an entity with itself', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const selfPairs = pairs.filter(p => p.entityA.id === p.entityB.id);
    expect(selfPairs).toHaveLength(0);
  });

  it('does not produce duplicate pairs (A,B) and (B,A)', () => {
    const pairs = buildCandidatePairs(entities, 0.4);
    const seen = new Set();
    for (const p of pairs) {
      const key = [p.entityA.id, p.entityB.id].sort((a,b)=>a-b).join('-');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('respects the fuzzy threshold', () => {
    // At threshold 1.0 only exact-token matches qualify — Alice Reed / A. Reed
    // share only 'reed'; similarity is 0.5 (1 common / 2 max tokens)
    // so they should be excluded at threshold 0.6
    const pairs = buildCandidatePairs(entities, 0.6);
    const reedPair = pairs.find(p =>
      (p.entityA.id === 1 && p.entityB.id === 2) ||
      (p.entityA.id === 2 && p.entityB.id === 1)
    );
    // 'alice' vs 'a', 'reed' vs 'reed' — similarity = 1/2 = 0.5 → below 0.6
    expect(reedPair).toBeUndefined();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns a value between 0 and 1 for similar vectors', () => {
    const sim = cosineSimilarity([1, 2, 3], [1, 2, 4]);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});
```

- [ ] **Step 5.2: Run tests to confirm they fail**

```bash
npx jest tests/unit/authority-suggestion-pipeline.test.js --no-coverage
```

Expected: `FAIL` — module not found

- [ ] **Step 5.3: Implement `utils/authority-suggestion-pipeline.js`**

```js
'use strict';

const { normalizeComparable, similarityScore, normalizeForMatching } = require('./entity-resolution');

const STOPWORDS = new Set(['the', 'of', 'and', 'in', 'at', 'to', 'a', 'an', 'de', 'van', 'von']);

/**
 * Build an inverted index: significant token → list of entity ids sharing that token.
 * Only includes tokens that are not stopwords and are >= 2 chars.
 */
function buildTokenIndex(entities) {
  const index = new Map(); // token → Set<entityIndex>
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const normalized = normalizeComparable(entity.canonical_name);
    const tokens = normalized.split(' ').filter(t => t.length >= 2 && !STOPWORDS.has(t));
    for (const token of tokens) {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(i);
    }
  }
  return index;
}

/**
 * Find candidate entity pairs within the same entity_type using an inverted
 * token index, then filter by token-set similarity >= fuzzyThreshold.
 * Returns [{entityA, entityB, fuzzySimilarity}].
 */
function buildCandidatePairs(entities, fuzzyThreshold = 0.6) {
  // Group entities by type first — never compare across types
  const byType = new Map();
  for (let i = 0; i < entities.length; i++) {
    const type = entities[i].entity_type;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(i);
  }

  const pairs = [];
  const seen = new Set(); // deduplicate (i, j) pairs

  for (const [, indices] of byType) {
    // Build token index for this type's subset
    const subset = indices.map(i => entities[i]);
    const tokenIndex = buildTokenIndex(subset);

    for (let si = 0; si < subset.length; si++) {
      const entity = subset[si];
      const normalizedA = normalizeForMatching(entity.canonical_name);
      const tokens = normalizeComparable(entity.canonical_name)
        .split(' ')
        .filter(t => t.length >= 2 && !STOPWORDS.has(t));

      // Collect candidates: other entities sharing at least one token
      const candidates = new Set();
      for (const token of tokens) {
        if (tokenIndex.has(token)) {
          for (const sj of tokenIndex.get(token)) {
            if (sj !== si) candidates.add(sj);
          }
        }
      }

      for (const sj of candidates) {
        const lo = Math.min(si, sj);
        const hi = Math.max(si, sj);
        const pairKey = `${lo}:${hi}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const normalizedB = normalizeForMatching(subset[sj].canonical_name);
        const similarity = similarityScore(normalizedA, normalizedB);
        if (similarity >= fuzzyThreshold) {
          pairs.push({ entityA: subset[lo], entityB: subset[hi], fuzzySimilarity: similarity });
        }
      }
    }
  }

  return pairs;
}

/**
 * Cosine similarity between two numeric arrays.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Score candidate pairs using a provided embed function.
 * embedFn: async (texts: string[]) => number[][] — returns one embedding per input.
 * Returns [{entityA, entityB, fuzzySimilarity, embeddingSimilarity}].
 */
async function scorePairs(pairs, embedFn, entityTextFn) {
  if (pairs.length === 0) return [];

  // Collect unique entity IDs needed
  const entityIds = [...new Set(pairs.flatMap(p => [p.entityA.id, p.entityB.id]))];
  const texts = entityIds.map(id => {
    const entity = pairs.find(p => p.entityA.id === id || p.entityB.id === id);
    return entityTextFn(entity.entityA.id === id ? entity.entityA : entity.entityB);
  });

  const embeddings = await embedFn(texts);
  const embeddingByEntityId = new Map();
  for (let i = 0; i < entityIds.length; i++) {
    embeddingByEntityId.set(entityIds[i], embeddings[i]);
  }

  return pairs.map(pair => ({
    ...pair,
    embeddingSimilarity: cosineSimilarity(
      embeddingByEntityId.get(pair.entityA.id),
      embeddingByEntityId.get(pair.entityB.id)
    )
  }));
}

module.exports = { buildCandidatePairs, cosineSimilarity, scorePairs };
```

- [ ] **Step 5.4: Run tests to confirm they pass**

```bash
npx jest tests/unit/authority-suggestion-pipeline.test.js --no-coverage
```

Expected: `PASS`

- [ ] **Step 5.5: Run the full suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass

- [ ] **Step 5.6: Commit**

```bash
git add utils/authority-suggestion-pipeline.js tests/unit/authority-suggestion-pipeline.test.js
git commit -m "feat(kg): add authority suggestion fuzzy pre-filter and cosine scoring pipeline"
```

---

## Task 6: Add `utils/worker-authority-suggestion.js` + integration test

**Files:**
- Create: `utils/worker-authority-suggestion.js`
- Test: `tests/integration/authority-suggestion-worker.test.js`

- [ ] **Step 6.1: Install `@xenova/transformers`**

```bash
npm install @xenova/transformers
```

Verify it appears in `package.json` dependencies. Commit the lockfile change separately at the end of this task.

- [ ] **Step 6.2: Write the failing integration test**

Create `tests/integration/authority-suggestion-worker.test.js`:

```js
'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

// Mock @xenova/transformers to avoid downloading the model in CI
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn().mockResolvedValue(
    // Fake embedder: returns a deterministic float32 array based on string content
    async function fakeEmbedder(texts) {
      return texts.map(text => ({
        data: Float32Array.from({ length: 384 }, (_, i) =>
          Math.sin(text.charCodeAt(i % text.length) + i)
        )
      }));
    }
  )
}));

let db;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
}, 30_000);

describe('authority suggestion worker', () => {
  it('creates pending suggestions for entities with similar names across documents', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');

    // Create two documents with overlapping entity names
    const docAId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc A', date_created: '1880-01-01',
      description: null, image_path: '/uploads/sug-a.png', metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc B', date_created: '1880-01-02',
      description: null, image_path: '/uploads/sug-b.png', metadata: {}
    });

    // Entity from doc A
    const entityAId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Alice Reed',
      description: null, properties: {}
    });
    await db.entityAliasesAsync.createIfMissing({ entity_id: entityAId, alias: 'Alice Reed', source: 'extracted' });

    const transcriptAId = await db.transcriptsAsync.create({
      document_id: docAId, content: 'Alice Reed wrote a letter.', transcriber: 'Test',
      version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityAId, relationship_id: null, transcript_id: transcriptAId,
      document_id: docAId, passage_start: 0, passage_end: 10, passage_text: 'Alice Reed',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9,
      approval_status: 'approved', approval_method: 'manual'
    });

    // Entity from doc B — similar name, different entity row
    const entityBId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Alice Reed',
      description: null, properties: {}
    });
    await db.entityAliasesAsync.createIfMissing({ entity_id: entityBId, alias: 'A. Reed', source: 'extracted' });

    const transcriptBId = await db.transcriptsAsync.create({
      document_id: docBId, content: 'A. Reed replied.', transcriber: 'Test',
      version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityBId, relationship_id: null, transcript_id: transcriptBId,
      document_id: docBId, passage_start: 0, passage_end: 7, passage_text: 'A. Reed',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9,
      approval_status: 'approved', approval_method: 'manual'
    });

    // Queue and run a full-corpus suggestion job with a low auto_approve_threshold
    // so the mocked embedder (which produces high similarity for same-name entities)
    // creates an approved link or pending suggestion
    const jobId = await db.authoritySuggestionJobsAsync.create({
      collection_id: null,
      fuzzy_threshold: 0.3,      // low so token-overlap 'alice'+'reed' qualifies
      pending_threshold: 0.5,    // low so mock embedder triggers suggestions
      auto_approve_threshold: 2.0 // above 1.0 → nothing auto-approved; all pending
    });

    await runAuthoritySuggestionWorkerCycle();

    const job = await db.authoritySuggestionJobsAsync.getById(jobId);
    expect(job.status).toBe('done');
    expect(job.candidate_count).toBeGreaterThan(0);
    expect(job.suggestion_count).toBeGreaterThan(0);

    // Both entities should now have suggestions pointing to an authority
    const suggestionsA = await db.authorityLinkSuggestionsAsync.getByEntityId(entityAId);
    const suggestionsB = await db.authorityLinkSuggestionsAsync.getByEntityId(entityBId);
    expect(suggestionsA.length + suggestionsB.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6.3: Run the integration test to confirm it fails**

```bash
npx jest tests/integration/authority-suggestion-worker.test.js --no-coverage
```

Expected: `FAIL` — `runAuthoritySuggestionWorkerCycle is not a function`

- [ ] **Step 6.4: Implement `utils/worker-authority-suggestion.js`**

```js
'use strict';

const { buildEntityText } = require('./entity-embedding');
const { buildCandidatePairs, cosineSimilarity } = require('./authority-suggestion-pipeline');

let isBusy = false;

function makeLogger(job, authoritySuggestionJobs) {
  return async function logLine(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await authoritySuggestionJobs.appendLog(job.id, line);
  };
}

/**
 * Build the embed function from @xenova/transformers.
 * Returns async (texts: string[]) => number[][]
 */
async function makeEmbedFn() {
  const { pipeline } = require('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true
  });
  return async function embed(texts) {
    const results = await embedder(texts, { pooling: 'mean', normalize: true });
    return results.map(r => Array.from(r.data));
  };
}

/**
 * Load all entities in scope, with their aliases and first approved citation passage.
 */
async function loadEntitiesInScope(collectionId, db) {
  const { entities, entityAliases, citations } = db;
  let rows;
  if (collectionId != null) {
    // Scope to entities cited in documents belonging to this collection
    rows = await db.allAsync(`
      SELECT DISTINCT e.*
      FROM entities e
      INNER JOIN citations c ON c.entity_id = e.id
      INNER JOIN document_collections dc ON dc.document_id = c.document_id
      WHERE dc.collection_id = ?
    `, [collectionId]);
  } else {
    rows = await entities.getAll(100000, 0);
  }

  // Enrich with aliases and first citation passage
  const enriched = await Promise.all(rows.map(async (entity) => {
    const aliases = await entityAliases.getByEntityId(entity.id);
    const aliasTexts = aliases.map(a => a.alias).filter(Boolean);
    const firstCitation = await db.getAsync(`
      SELECT passage_text FROM citations
      WHERE entity_id = ? AND approval_status = 'approved'
      ORDER BY id ASC LIMIT 1
    `, [entity.id]);
    return {
      ...entity,
      aliases: aliasTexts,
      citationPassage: firstCitation?.passage_text || null
    };
  }));
  return enriched;
}

/**
 * Ensure an authority exists for a given entity canonical name + type.
 * Returns the authority id.
 */
async function ensureAuthority(entity, db) {
  const existing = await db.getAsync(
    'SELECT id FROM authorities WHERE authority_type = ? AND canonical_name = ?',
    [entity.entity_type, entity.canonical_name]
  );
  if (existing) return existing.id;
  const result = await db.runAsync(
    'INSERT INTO authorities (authority_type, canonical_name, properties) VALUES (?, ?, ?)',
    [entity.entity_type, entity.canonical_name, '{}']
  );
  await db.saveDatabase();
  return result.lastInsertRowid;
}

async function runAuthoritySuggestionWorkerCycle() {
  const dbModule = require('../database/db');
  const { authoritySuggestionJobsAsync, authorityLinkSuggestionsAsync } = dbModule;

  const job = await authoritySuggestionJobsAsync.claimNextQueued();
  if (!job) return;

  const logLine = makeLogger(job, authoritySuggestionJobsAsync);
  await logLine(`Authority suggestion job #${job.id} started. Scope: ${job.collection_id != null ? `collection #${job.collection_id}` : 'full corpus'}.`);

  let entityCount = 0, candidateCount = 0, suggestionCount = 0, autoApprovedCount = 0;

  try {
    const entities = await loadEntitiesInScope(job.collection_id, dbModule);
    entityCount = entities.length;
    await logLine(`Loaded ${entityCount} entities.`);

    const pairs = buildCandidatePairs(entities, job.fuzzy_threshold);
    candidateCount = pairs.length;
    await logLine(`Fuzzy pre-filter produced ${candidateCount} candidate pairs.`);

    if (candidateCount === 0) {
      await authoritySuggestionJobsAsync.markDone(job.id, { entityCount, candidateCount, suggestionCount, autoApprovedCount });
      return;
    }

    const embedFn = await makeEmbedFn();

    // Build entity text for each unique entity in the candidate pairs
    const entityMap = new Map();
    for (const p of pairs) {
      for (const entity of [p.entityA, p.entityB]) {
        if (!entityMap.has(entity.id)) entityMap.set(entity.id, entity);
      }
    }
    const uniqueEntities = [...entityMap.values()];
    const texts = uniqueEntities.map(e => buildEntityText(e, e.aliases || [], e.citationPassage || null));
    await logLine(`Embedding ${uniqueEntities.length} unique entities...`);

    const rawEmbeddings = await embedFn(texts);
    const embeddingById = new Map();
    for (let i = 0; i < uniqueEntities.length; i++) {
      embeddingById.set(uniqueEntities[i].id, rawEmbeddings[i]);
    }

    for (const pair of pairs) {
      const embA = embeddingById.get(pair.entityA.id);
      const embB = embeddingById.get(pair.entityB.id);
      const similarity = cosineSimilarity(embA, embB);

      if (similarity < job.pending_threshold) continue;

      // Find or create an authority for the higher-confidence entity
      const canonicalEntity = pair.entityA;
      const memberEntity = pair.entityB;
      const authorityId = await ensureAuthority(canonicalEntity, dbModule);

      if (similarity >= job.auto_approve_threshold) {
        // Auto-approve: assign directly
        await dbModule.runAsync(
          'UPDATE entities SET authority_id = ? WHERE id = ?',
          [authorityId, memberEntity.id]
        );
        await dbModule.runAsync(
          'UPDATE entities SET authority_id = ? WHERE id = ?',
          [authorityId, canonicalEntity.id]
        );
        await dbModule.saveDatabase();
        autoApprovedCount++;
        await logLine(`Auto-approved: entity #${memberEntity.id} → authority #${authorityId} (similarity ${similarity.toFixed(3)})`);
      } else {
        // Pending suggestion
        await authorityLinkSuggestionsAsync.createIfMissing({
          entity_id: memberEntity.id,
          suggested_authority_id: authorityId,
          confidence: similarity,
          match_method: 'embedding'
        });
        suggestionCount++;
      }
    }

    await logLine(`Done. Suggestions: ${suggestionCount} pending, ${autoApprovedCount} auto-approved.`);
    await authoritySuggestionJobsAsync.markDone(job.id, { entityCount, candidateCount, suggestionCount, autoApprovedCount });
  } catch (err) {
    await logLine(`ERROR: ${err.message}`);
    await authoritySuggestionJobsAsync.markFailed(job.id, err.message);
  }
}

module.exports = { runAuthoritySuggestionWorkerCycle };
```

- [ ] **Step 6.5: Run the integration test**

```bash
npx jest tests/integration/authority-suggestion-worker.test.js --no-coverage
```

Expected: `PASS`

- [ ] **Step 6.6: Run the full suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass

- [ ] **Step 6.7: Commit**

```bash
git add utils/worker-authority-suggestion.js utils/entity-embedding.js \
        tests/integration/authority-suggestion-worker.test.js \
        package.json package-lock.json
git commit -m "feat(kg): add authority suggestion worker with embedding pipeline"
```

---

## Task 7: Register worker in `worker.js` + post-extraction trigger

**Files:**
- Modify: `utils/worker.js`
- Modify: `utils/worker-extraction.js`

- [ ] **Step 7.1: Register `runAuthoritySuggestionWorkerCycle` in worker.js**

In `utils/worker.js`, add the import alongside the other worker imports:

```js
const { runAuthoritySuggestionWorkerCycle } = require('./worker-authority-suggestion');
```

Add a busy flag and tick function alongside the existing authority resolution ones:

```js
let authoritySuggestionBusy = false;

async function tickAuthoritySuggestionJobs() {
  if (authoritySuggestionBusy) return;
  authoritySuggestionBusy = true;
  try {
    await runAuthoritySuggestionWorkerCycle();
  } catch (err) {
    console.error('[worker] authority suggestion worker cycle failed:', err.message);
  } finally {
    authoritySuggestionBusy = false;
  }
}
```

Add `tickAuthoritySuggestionJobs` to the worker's poll interval alongside `tickAuthorityResolutionJobs`. Find where `setInterval` calls are made and add:

```js
setInterval(tickAuthoritySuggestionJobs, BATCH_POLL_MS);
```

- [ ] **Step 7.2: Add post-extraction trigger in worker-extraction.js**

In `utils/worker-extraction.js`, find where `extractionJobs.markDone` is called for single (non-batch) jobs (around line 304). After the `markDone` call, add the suggestion job trigger:

```js
if (job.job_kind !== 'batch') {
  await extractionJobs.markDone(job.id, {
    entity_count: entityCount,
    relationship_count: relationshipCount
  });

  // Post-extraction: queue a scoped authority suggestion job if the document
  // belongs to a collection and no suggestion job is already pending/running.
  try {
    const { authoritySuggestionJobsAsync, documentCollectionsAsync } = require('../database/db');
    const memberships = await documentCollectionsAsync.getByDocumentId(doc.id);
    for (const membership of memberships) {
      const alreadyQueued = await authoritySuggestionJobsAsync.hasPendingOrRunningForCollection(
        membership.collection_id
      );
      if (!alreadyQueued) {
        await authoritySuggestionJobsAsync.create({ collection_id: membership.collection_id });
      }
    }
  } catch (triggerErr) {
    // Non-fatal — log but don't fail the extraction job
    console.error('[worker-extraction] failed to queue authority suggestion job:', triggerErr.message);
  }
}
```

- [ ] **Step 7.3: Run the full suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass

- [ ] **Step 7.4: Commit**

```bash
git add utils/worker.js utils/worker-extraction.js
git commit -m "feat(kg): register authority suggestion worker and add post-extraction trigger"
```

---

## Task 8: Admin routes for triggering suggestion jobs

**Files:**
- Modify: `routes/admin-authorities.js`
- Modify: `server.js` (if a new route file is added — check existing mount points first)

- [ ] **Step 8.1: Add POST route to trigger a suggestion job**

In `routes/admin-authorities.js`, add two routes after the existing GET routes:

```js
// POST /admin/knowledge/authorities/suggestion-jobs — full-corpus run
router.post('/suggestion-jobs', asyncHandler(async (req, res) => {
  const { authoritySuggestionJobsAsync } = require('../database/db');
  const jobId = await authoritySuggestionJobsAsync.create({
    collection_id: null,
    requested_by_user_id: req.user?.id || null
  });
  return res.redirect(`/admin/knowledge/authorities?suggestionJobQueued=${jobId}`);
}));

// POST /admin/knowledge/authorities/suggestion-jobs/collection/:id — scoped run
router.post('/suggestion-jobs/collection/:id', asyncHandler(async (req, res) => {
  const { authoritySuggestionJobsAsync } = require('../database/db');
  const collectionId = parseInt(req.params.id, 10);
  if (!Number.isInteger(collectionId)) {
    return res.redirect('/admin/knowledge/authorities?error=' + encodeURIComponent('Invalid collection id.'));
  }
  const alreadyQueued = await authoritySuggestionJobsAsync.hasPendingOrRunningForCollection(collectionId);
  if (alreadyQueued) {
    return res.redirect('/admin/knowledge/authorities?error=' + encodeURIComponent('An authority suggestion job for this collection is already running or queued.'));
  }
  const jobId = await authoritySuggestionJobsAsync.create({
    collection_id: collectionId,
    requested_by_user_id: req.user?.id || null
  });
  return res.redirect(`/admin/knowledge/authorities?suggestionJobQueued=${jobId}`);
}));
```

- [ ] **Step 8.2: Add CSRF middleware to the new routes**

The routes file already applies `validateCsrf` globally via `router.use`. Verify this is the case at the top of `routes/admin-authorities.js`:

```js
// Should already be present — confirm it's there:
router.use(requireAdmin);
// If validateCsrf is applied at the server level for all admin routes,
// no additional changes needed. If not, add:
router.use(validateCsrf);
```

- [ ] **Step 8.3: Run the full suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass

- [ ] **Step 8.4: Commit**

```bash
git add routes/admin-authorities.js
git commit -m "feat(kg): add admin routes to trigger authority suggestion jobs"
```

---

## Task 9: Admin UI — add trigger buttons

**Files:**
- Modify: `views/admin/authorities.ejs` (or the authorities index view — check actual filename)

- [ ] **Step 9.1: Find the authorities index view**

```bash
ls views/admin/ | grep -i author
```

Identify the correct template file name.

- [ ] **Step 9.2: Add the full-corpus trigger button**

In the authorities index view, add a form button in the page header or actions section. The form must include the CSRF token (already available as `csrfToken` in the view locals):

```html
<form method="POST" action="/admin/knowledge/authorities/suggestion-jobs"
      style="display:inline;">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <button type="submit" class="btn btn-secondary btn-sm">
    Run authority suggestion (full corpus)
  </button>
</form>
```

- [ ] **Step 9.3: Add success/error flash display**

In the same view, add a check for the `suggestionJobQueued` query param (parallel to how other success states are displayed):

```html
<% if (query.suggestionJobQueued) { %>
  <div class="alert alert-success">
    Authority suggestion job #<%= escapeHtml(String(query.suggestionJobQueued)) %> queued.
  </div>
<% } %>
```

- [ ] **Step 9.4: Start the server and verify the button works manually**

```bash
npm start
```

Navigate to `http://localhost:3000/admin/knowledge/authorities`, click the button, confirm you are redirected back with the success message and that a job row appears in the Jobs tab.

- [ ] **Step 9.5: Commit**

```bash
git add views/admin/
git commit -m "feat(kg): add authority suggestion trigger buttons to admin UI"
```

---

## Task 10: Migration scripts

**Files:**
- Create: `scripts/reset-graph-evidence.js`

- [ ] **Step 10.1: Create `scripts/reset-graph-evidence.js`**

This is a one-time operator script. It is NOT run automatically — an admin runs it manually before re-queuing extractions.

```js
#!/usr/bin/env node
'use strict';

/**
 * One-time migration: wipe extracted graph evidence and re-queue extraction
 * for all best transcripts. Run ONCE after deploying the new extraction worker.
 *
 * Usage:
 *   node scripts/reset-graph-evidence.js [--dry-run]
 *
 * --dry-run: print what would be deleted/queued without making changes.
 */

process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || 'better-sqlite3';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const server = require('../server');
  await server.initApp();
  const db = require('../database/db');

  console.log(isDryRun ? '[dry-run] Would wipe:' : 'Wiping:');

  const tables = [
    'authority_link_suggestions',
    'authority_resolution_jobs',
    'authority_suggestion_jobs',
    'citations',
    'relationships',
    'date_expressions',
    'entity_aliases',
    'entities'
  ];

  for (const table of tables) {
    const count = await db.getAsync(`SELECT COUNT(*) as n FROM ${table}`);
    console.log(`  ${table}: ${count.n} rows`);
    if (!isDryRun) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  }

  // Re-queue extraction for all best transcripts
  const transcripts = await db.allAsync(`
    SELECT t.id, t.document_id, d.title
    FROM transcripts t
    INNER JOIN documents d ON d.id = t.document_id
    WHERE t.is_best = 1
    ORDER BY t.id ASC
  `);

  console.log(`\n${isDryRun ? '[dry-run] Would queue' : 'Queueing'} ${transcripts.length} extraction jobs:`);

  if (!isDryRun) {
    for (const transcript of transcripts) {
      await db.runAsync(`
        INSERT INTO extraction_jobs
          (document_id, transcript_id, status, reset_existing, log)
        VALUES (?, ?, 'queued', 0, '')
      `, [transcript.document_id, transcript.id]);
      process.stdout.write('.');
    }
    console.log('\nDone.');
    await db.saveDatabase();
  } else {
    for (const t of transcripts) {
      console.log(`  doc #${t.document_id} — ${t.title}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 10.2: Test with --dry-run against the local DB**

```bash
node scripts/reset-graph-evidence.js --dry-run
```

Expected: prints counts for each table and lists transcripts that would be queued. No data changes.

- [ ] **Step 10.3: Commit**

```bash
git add scripts/reset-graph-evidence.js
git commit -m "feat(kg): add reset-graph-evidence migration script for one-time re-extraction"
```

---

## Task 11: Update `docs/knowledge-graph-design.md`

**Files:**
- Modify: `docs/knowledge-graph-design.md`

- [ ] **Step 11.1: Update the Entities, Aliases, and Authorities sections**

Replace the current descriptions in the Core Model section with:

```markdown
### Entities

- Canonical nodes in the graph, scoped to a single document
- Stored in `entities`
- Represent one distinct subject as attested by one transcript — the "person record" in prosopographical terms
- Have an `entity_type`, canonical name, optional description, JSON properties, and an optional `authority_id`
- Remain the evidence-bearing layer: citations, relationships, and dates attach to entities
- Never merged across documents at extraction time; cross-document identity is the authority layer's responsibility

### Aliases

- Stored in `entity_aliases`
- Track alternate name forms used for this entity **within its source document**
- Scoped to the document by construction: because entities are created fresh per transcript, aliases written during extraction belong to that transcript's context
- Used by the authority suggestion pipeline as richer embedding input

### Authorities

- Stored in `authorities`
- The sole mechanism for cross-document identity
- Represent editorial assertions that multiple entity records (from different documents) refer to the same real-world subject
- Populated via the authority suggestion job (async, human-reviewed) rather than at extraction time
- Drive authority-first graph focus in the explorer when an entity has an assigned authority

### Authority Suggestion Jobs

- Stored in `authority_suggestion_jobs`
- An async job type registered in the background worker loop
- Runs a four-stage pipeline: normalise → fuzzy pre-filter (inverted token index) → embed (all-MiniLM-L6-v2 via @xenova/transformers) → write suggestions
- Triggered automatically after extraction completes for a collection, or manually from the admin UI
- High-confidence pairs (≥ 0.92 cosine) are auto-approved; mid-confidence (0.75–0.91) enter the pending review queue
```

Also update the **Extraction Workflow / Worker Behavior** section:

```markdown
### Worker Behavior

- The worker resolves the active transcript for the job
- An LLM prompt extracts entities, dates, and relationships from transcript content
- Entity aliases are deduplicated within the current transcript only (not across documents)
- Each extracted entity is created fresh — no cross-document entity resolution occurs
- No authority assignment happens during extraction; that is deferred to the authority suggestion job
- Relationships are deduplicated by source, target, and type within the transcript
- Citations are always written for the transcript and document being processed
```

- [ ] **Step 11.2: Commit**

```bash
git add docs/knowledge-graph-design.md
git commit -m "docs(kg): update entity/alias/authority model to reflect document-scoped extraction"
```

---

## Final Verification

- [ ] **Run the full test suite one final time**

```bash
npx jest --no-coverage
```

Expected: all tests pass, no warnings.

- [ ] **Confirm migration script runs cleanly in dry-run mode**

```bash
node scripts/reset-graph-evidence.js --dry-run
```

- [ ] **Start the server and verify:**
  - Admin → Knowledge → Authorities shows the "Run authority suggestion" button
  - Clicking it queues a job and redirects with the success message
  - The Jobs tab shows the new job type
  - Extraction of a new document (if test data available) triggers a scoped suggestion job automatically

```bash
npm start
```
