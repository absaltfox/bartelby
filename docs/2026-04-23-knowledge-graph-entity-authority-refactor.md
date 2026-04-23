# Knowledge Graph: Entity–Authority Refactor

**Date:** 2026-04-23
**Status:** Approved — ready for implementation planning

## Background

Bartelby's knowledge graph was built with a cross-document entity resolution step
(`resolveEntity`) that silently merges mentions from different documents at
extraction time. Authorities were added later as an identity layer, but because
`resolveEntity` already collapses many cross-document mentions, authorities only
catch the cases the extractor wasn't confident about.

This is architecturally inconsistent with digital humanities best practice
(specifically the prosopographical model used by projects like *People of Medieval
Scotland* and SNAP), which separates:

- **Person Record** — what a specific source attests (document-scoped)
- **Person** — the editorial assertion that multiple records refer to the same
  historical individual (cross-document, explicitly curated)

The refactor realigns the data model with this separation. Entities become
document-scoped attestation records. Authorities become the sole mechanism for
cross-document identity, driven by an async suggestion pipeline using local
embeddings and fuzzy name matching, with human review.

## Goals

1. Entity extraction produces one entity per distinct subject per document.
   Cross-document identity is never asserted at extraction time.
2. Authority suggestion becomes a first-class async job, visible and
   manageable in the Jobs tab.
3. The suggestion pipeline scales to ~20,000 documents with high cross-collection
   entity recurrence, using a local embedding model at no API cost.
4. The existing authority suggestion review UI is reused unchanged.
5. Existing manually-curated authority records are preserved through migration.

## Data Model

The entity, alias, authority, citation, and relationship schemas are unchanged.
The only schema addition is the new `authority_suggestion_jobs` table. All
behaviour changes follow from changes to the extraction worker.

| Layer | Scope | Role |
|---|---|---|
| **Entity** | Document-scoped | Attestation record — one per distinct subject per transcript |
| **Alias** | Entity-scoped | Name variants within that entity's source document |
| **Authority** | Corpus-wide | Editorial identity cluster — groups entities believed to be the same real-world subject |
| **Citation** | Unchanged | Links entity or relationship to transcript + document |
| **`authority_link_suggestions`** | Unchanged | Pending authority links awaiting human review |

### New: `authority_suggestion_jobs` table

Mirrors the pattern of `extraction_jobs` and `authority_resolution_jobs`.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `collection_id` | integer nullable | NULL = full-corpus run; set = scoped to that collection |
| `status` | text | `pending`, `running`, `done`, `failed` |
| `entity_count` | integer | Entities scanned |
| `candidate_count` | integer | Pairs surviving the fuzzy pre-filter |
| `suggestion_count` | integer | Suggestions written |
| `auto_approved_count` | integer | Auto-approved links written directly |
| `fuzzy_threshold` | real | Token-set similarity threshold used (default 0.6) |
| `pending_threshold` | real | Embedding similarity threshold for pending suggestions (default 0.75) |
| `auto_approve_threshold` | real | Embedding similarity threshold for auto-approval (default 0.92) |
| `requested_by_user_id` | integer nullable | NULL for automatic triggers |
| `created_at` | datetime | |
| `started_at` | datetime nullable | |
| `completed_at` | datetime nullable | |
| `log` | text | Running log, same pattern as extraction jobs |

## Section 1: Extraction Pipeline Changes

### 1.1 `resolveEntity` scope: global → intra-document

`resolveEntity` currently searches the global entity and alias pool across all
documents. Under the new model it only deduplicates within the current extraction
run, using the `mentionToEntityId` Map already built during processing.

**Before:**
```js
// Queries the full entity + alias DB tables
const resolved = await resolveEntity(mention, normalized, entityType);
```

**After:**
```js
// Only consults entities created in this extraction run
const resolved = resolveEntityInScope(mention, normalized, entityType, mentionToEntityId);
```

`resolveEntityInScope` is a synchronous function — it checks the Map by
normalised name, returns a match if found, null otherwise. No DB call needed.
The existing fuzzy/abbreviation-expansion logic is retained for intra-document
deduplication (e.g. "Wm. Henry" and "William Henry" in the same document should
still collapse).

### 1.2 Alias scope: document-scoped by construction

Because entities are created fresh per document, all aliases written during
extraction are automatically scoped to that document's entity. No schema or
code change is needed here — the behaviour follows from 1.1.

Aliases remain valuable: they are included in the embedding representation
used by the authority suggestion pipeline, providing richer signal about
how a subject was named in its source document.

### 1.3 `ensureEntityAuthority` removed from extraction

The call to `ensureEntityAuthority` after each entity creation is removed.
Extraction produces entities with no authority assignment. Authority assignment
is entirely the responsibility of the suggestion job, reviewed by a human.

The `ensureEntityAuthority` utility and `authority_resolution_jobs` infrastructure
are retained — they serve the separate backfill workflow for manually-triggered
authority resolution.

## Section 2: Authority Suggestion Job

### 2.1 Pipeline

The job runs four stages:

1. **Normalise** — strip honorifics, expand historical abbreviations, lowercase.
   Reuses `normalizeForMatching` from `utils/entity-resolution.js`.

2. **Fuzzy pre-filter** — compute token-set similarity between all entity pairs
   of the same `entity_type` within scope. Pairs below the configurable
   `fuzzy_threshold` (default 0.6) are discarded. This reduces the embedding
   workload by ~99% for a typical corpus. To keep the O(n²) comparison
   practical, entities are first bucketed by their most distinctive token
   (longest non-stopword), so only entities sharing at least one significant
   name token are compared.

3. **Embed + score** — build a text representation for each surviving candidate
   entity and embed it using `@xenova/transformers` with `all-MiniLM-L6-v2`.
   Compute cosine similarity between each pair's embeddings. This is the
   confidence score.

4. **Write suggestions** — apply confidence thresholds (see 2.3) and write
   results to `authority_link_suggestions` or directly as approved authority
   links.

### 2.2 Entity embedding representation

Each entity is represented as a structured text string before embedding:

```
[entity_type]: [canonical_name]. Also known as: [alias_1], [alias_2].
Evidence: "[first citation passage, max 120 chars]"
```

Example:
```
person: Alice Reed. Also known as: Mrs. Reed.
Evidence: "Alice Reed wrote to Bob Grant about harbour plans in 1842."
```

Entities with no aliases fall back to `[type]: [canonical_name]`. Entities with
no approved citations omit the Evidence line.

### 2.3 Confidence thresholds

| Range | Action |
|---|---|
| ≥ 0.92 (`auto_approve_threshold`) | Auto-approve: write directly as approved authority link |
| 0.75–0.91 (`pending_threshold`) | Pending: write to `authority_link_suggestions` as `pending` |
| < 0.75 | Discard: not surfaced |

All thresholds are configurable per job invocation. A curator running a
careful collection pass can lower `pending_threshold` to 0.65 to surface
more candidates for review.

### 2.4 Worker implementation

New file: `utils/worker-authority-suggestion.js`

Follows the same module structure as `utils/worker-authority-resolution.js`:
- Module-level `isBusy` flag
- Exported function: `runAuthoritySuggestionWorkerCycle`
- Registered in the background worker loop alongside other worker types
- Progress written to `authority_suggestion_jobs.log` as JSON lines

The `@xenova/transformers` pipeline is initialised once per worker cycle and
cached for the duration of the job to avoid repeated model load overhead.

## Section 3: Triggering, Migration & Integration

### 3.1 Triggering

**Post-extraction (automatic):**
When an `extraction_job` transitions to `done`, the extraction worker checks
whether any affected documents belong to a collection. If so, it enqueues one
`authority_suggestion_job` scoped to that collection. Debounced: if a suggestion
job for that collection is already `pending` or `running`, no duplicate is
created.

**Manual per-collection:**
A "Run authority suggestion" button on each collection's admin page queues a
scoped job. The button shows the last-run timestamp and current status.

**Manual full-corpus:**
A "Run authority suggestion (full corpus)" button on the Knowledge overview page
queues a job with `collection_id = NULL`. Scans all entities regardless of
collection.

### 3.2 Migration

The migration runs in four steps. It is a one-time operation coordinated by the
deploying admin.

**Step 1 — Deploy new extraction worker**
Deploy the updated worker with `resolveEntity` scoped to intra-document and
`ensureEntityAuthority` removed. No data changes yet. New extractions from this
point will produce document-scoped entities.

**Step 2 — Wipe extracted graph evidence**
A one-time migration script truncates:
- `entities`
- `entity_aliases`
- `citations`
- `relationships`
- `date_expressions`
- `authority_link_suggestions`
- `authority_resolution_jobs`

Preserved: `authorities` (manually curated), `transcripts`, `documents`,
`collections`, `users`, all job logs for transcription.

**Step 3 — Re-queue extraction**
A migration script enqueues `extraction_jobs` for every transcript where
`is_best = 1`. The existing background worker processes them in order.
No manual intervention required beyond kicking off the script.

**Step 4 — Authority suggestion runs automatically**
As each collection's extraction completes, the post-extraction trigger queues
a scoped authority suggestion job. A full-corpus manual run is available once
all collections are done.

### 3.3 Admin UI integration

**Jobs tab:** `authority_suggestion_jobs` appear as a new job type. Displayed
fields: scope (collection name or "Full corpus"), entities scanned, candidate
pairs, suggestions written, auto-approved, elapsed time.

**Knowledge / Authorities workspace:** "Run authority suggestion" button per
collection and a full-corpus button on the overview. Each shows last-run time
and links to the most recent job log.

**Review queue:** Unchanged. Pending suggestions from the new pipeline flow
into the existing `authority_link_suggestions` review UI.

## Testing

**Unit tests:**
- `resolveEntityInScope` — verify it matches within the same extraction run and
  never matches entities from a different document
- Embedding representation builder — verify output format for entity with/without
  aliases, with/without citations
- Fuzzy pre-filter — verify candidate pairs produced for known name variant sets
  (e.g. "Wm. Henry" / "William Henry", "Alice Reed" / "A. Reed")

**Integration tests:**
- Seed two documents with overlapping entity names; run the suggestion worker;
  assert correct `authority_link_suggestions` rows with expected confidence bands
- Verify auto-approve threshold produces approved authority links directly without
  pending review rows
- Verify post-extraction trigger queues a scoped suggestion job and does not
  create a duplicate if one is already pending

## Reference Documents

- [docs/knowledge-graph-design.md](../knowledge-graph-design.md) — core model,
  extraction workflow, authority resolution
- [docs/background-jobs.md](../background-jobs.md) — worker loop, busy flag
  pattern, job table conventions
- [docs/development-principles.md](../development-principles.md) — Keep Evidence
  Traceable, Documentation Principle
