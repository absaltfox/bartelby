# Knowledge Graph Design

## Overview

Bartelby's knowledge graph is built from transcripts, not directly from raw
uploads. The current implementation lives behind the admin `Knowledge` section
at `/admin/knowledge`, with contextual shortcuts from admin document and
collection pages.

The graph is designed to be citation-backed and permission-scoped. Users should
only see graph evidence that comes from documents they are allowed to access.

## Core Model

### Entities

- Canonical nodes in the graph, scoped to a single document
- Stored in `entities`
- Represent one distinct subject as attested by one transcript — the "person
  record" in prosopographical terms
- Have an `entity_type`, canonical name, optional description, JSON
  properties, and an optional `authority_id`
- Remain the evidence-bearing layer: citations, relationships, and dates
  attach to entities
- Never merged across documents at extraction time; cross-document identity
  is the authority layer's responsibility

Common entity types include:

- `person`
- `place`
- `event`
- `organization`
- `topic`
- `artifact`
- `claim`
- `role`

The `role` entity type models positions and titles held by persons within
organizations, enabling tripartite (Person → Role → Organization) modeling.
A person may hold multiple roles at different organizations or at different
times within the same organization; the role entity captures the intermediate
node that connects a person to an organization with context about the
position itself.

The schema still supports a legacy `date` entity type, but current extraction
does not create standalone date nodes for explorer use.

### Authorities

- Stored in `authorities`
- The sole mechanism for cross-document identity
- Represent editorial assertions that multiple entity records (from different
  documents) refer to the same real-world subject
- Have an `authority_type`, canonical name, optional description, JSON
  properties, and nullable placeholder external-id fields for future authority
  source integration
- Populated via the authority suggestion job (async, human-reviewed) rather
  than at extraction time
- Drive authority-first graph focus in the explorer when an entity has an
  assigned authority

### Three-Layer Graph Model

Bartelby keeps three related graph layers separate:

- **Document entities** are the evidence layer. They remain scoped to one
  transcript/document and carry citations, aliases, date expressions, and
  extracted relationships.
- **Authorities** are the identity layer. They assert that multiple
  document-scoped entities refer to the same real-world subject.
- **Derived authority graph projections** are the corpus/collection browsing
  layer. Archive-wide and collection-wide explorer views collapse visible
  authority-linked entities into one authority node, while unresolved entities
  remain visible as entity nodes.

Authority-to-authority edges are not stored as primary extracted facts in the
current model. They are derived at query time from approved entity-to-entity
relationships between visible member entities. If Bartelby later supports
explicitly curated authority relationships, those should be modeled as
separate editorial assertions with their own provenance and review lifecycle.

Large collection and corpus graphs are rendered as ranked neighborhoods rather
than full-collection network diagrams. The explorer loads a limited slice of
the strongest visible neighbors first, ranked by citation, document,
relationship, and member counts, then exposes overflow metadata so users can
load additional connections without forcing the browser to lay out every
possible node at once.

### Aliases

- Stored in `entity_aliases`
- Track alternate name forms used for an entity **within its source document**
- Scoped to the document by construction: because entities are created fresh
  per transcript, aliases written during extraction belong to that
  transcript's context
- Used by the authority suggestion pipeline as richer embedding input

### Authority Suggestion Jobs

- Stored in `authority_suggestion_jobs`
- An async job type registered in the background worker loop
- Runs a four-stage pipeline: normalise → fuzzy pre-filter (inverted token
  index) → embed (`all-MiniLM-L6-v2` via `@xenova/transformers`) → write
  suggestions
- Triggered automatically after extraction completes for a collection's
  document, or manually from the admin UI (per-collection or full-corpus)
- High-confidence pairs (≥ 0.92 cosine) are auto-approved; mid-confidence
  (0.75–0.91) enter the pending review queue; below 0.75 are discarded. Exact
  canonical-name matches for `person` and `place` entities can auto-approve at
  the pending threshold when neither name matches an active generic authority
  term. Other entity types keep the embedding auto-approval threshold unless
  reviewed by a human.
- Active generic authority terms suppress exact bare-name suggestions before
  they reach review. These terms live in `authority_generic_terms` and are
  managed from Knowledge → Generic Terms.

**Containment shortcut in fuzzy pre-filter (A2.1, added 2026-06-13):** Alongside
the max-denominator `similarityScore`, the fuzzy pre-filter also promotes any
pair where one canonical name's significant tokens are a leading prefix of the
other's (with the smaller side having ≥1 significant token). This captures
asymmetric "City" ↔ "City, Province" pairs that fall below the 0.6 default
threshold (e.g., `Victoria` ↔ `Victoria, British Columbia` scores 1/3 = 0.33 by
the token-set metric but the single token `victoria` is the leading prefix of
`victoria british columbia`). Leading-prefix is more conservative than pure set
membership and avoids surname-only false positives like `A. Reed ↔ Alice Reed`.
The shortcut does not bypass the embedding stage; it only adds the pair as a
candidate.

**Exact-match gate uses normalizeForMatching (A3.1, added 2026-06-13):** The
`auto_approve_exact` decision compares canonical names via `normalizeForMatching`,
which expands 19th-century abbreviations (`Wm./Jno./Chas./...`) and strips
honorifics (`Mr/Mrs/Dr/Capt/...`). So `Wm. Jessop` auto-approves to a `William
Jessop` authority at the pending threshold; `Mr. Jessop` auto-approves to
`Jessop`. The gate still respects `EXACT_NAME_AUTO_APPROVE_TYPES = {person,
place}` (per E1.4, `role` does not auto-approve). Aliases are NOT cross-producted
into this gate (per A3.2) — bad LLM-extracted aliases stay as embedding input
only and don't short-circuit curator review.

### Authority Link Suggestions

- Stored in `authority_link_suggestions`
- Represent medium-confidence candidate links from an entity to an existing
  authority
- Remain review metadata until explicitly approved

**Suggestion disambiguation grouping (curator-velocity U3, added 2026-06-12):**
When an entity has two or more pending authority-link suggestions, they are
grouped together to enable curators to resolve cross-authority conflicts in one
workflow. When ≥2 pending suggestions exist for the same `entity_id`, the
authority-suggestions review UI renders them as a single disambiguation card
rather than separate rows.

Two transactional endpoints enable grouped resolution:

- `POST /admin/knowledge/authorities/suggestions/disambiguation/:entityId/approve` —
  Approve one suggested authority link, cascade-reject all other pending
  suggestions for that entity, and create the entity-to-authority link. Request
  body: `{ suggestionId: number }`. Returns: `{ success, entityId,
  approvedSuggestionId, removedSiblingIds }`.
- `POST /admin/knowledge/authorities/suggestions/disambiguation/:entityId/new-authority` —
  Reject all pending suggestions for the entity and create a new authority with
  provided metadata, then link the entity to it. Request body: `{ authorityType,
  canonicalName, description?, properties? }`. Returns: `{ success, entityId,
  authorityId, removedSuggestionIds }`.

Both endpoints preserve atomicity and audit logging. Per
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md),
disambiguation grouping improves curator UX when the embedding model returns
multiple conflicting matches (U7).

### Dates

- Stored in `date_expressions`
- Represent normalized temporal expressions attached directly to the entity
  they describe
- Include earliest/latest bounds, precision, qualifier, and calendar
- Current extraction requires an `entity_mention` so each date expression is
  anchored to a person, event, organization, or other subject entity instead
  of becoming a free-floating date node

### Relationships

- Stored in `relationships`
- Connect two entities with a controlled relationship type
- May carry confidence, date bounds, and other properties

**Relationship frequency annotation (curator-velocity U1, added 2026-06-12):** The
`relationship_types.frequency` column holds TEXT values (`rare`, `medium`,
`common`) to support curator annotation of link prevalence. This column is
unrelated to the pre-existing `relationship_types.category` column, which groups
relationship types by subject entity pairing (e.g., `person-to-organization`).
The frequency annotation drives sorting in the citation review queue (see
"Citation review queue sort" below). Per
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md),
frequency grouping surfaces rare relationships for expedited review (U1).

### Relationship Vocabulary Aliases

The `relationship_type_aliases` table enables curators to define canonical
relationship types and maintain mappings to alternative or historical terms
without changing extracted relationships retroactively.

**Write-time coercion:** When a relationship is written, the worker queries
the alias table first. If the extracted relationship type matches a curator-defined
alias, the worker writes the canonical form to `relationships.relationship_type`.
If the LLM emits a deprecated canonical type, the worker does not create a new
relationship with that deprecated type. It can still coerce through an active
alias; otherwise it falls back to `related_to` and preserves the original
extracted term in `properties.original_relationship_type` for troubleshooting
and curator review. Unknown non-vocabulary types follow the same `related_to`
fallback path.

**Seeded canonical→alias mappings** include:
- `mentions` → `mentioned_in` (bidirectional)
- `holds_role_in` → `holds_position`
- (additional pairs defined per domain)

Vocabulary normalization through an admin SQL migration UI (for re-mapping
existing relationships and entities) is planned as a deferred future workstream
(E2.2); currently, curation focuses on forward consistency and fallback
provenance tracking via `properties.original_relationship_type`.

### Vocabulary Management Surface (C4)

Curators manage the controlled `relationship_types` vocabulary and its
`relationship_type_aliases` from the admin surface at
`/admin/knowledge/vocabularies/relationship-types`
(`routes/admin-vocabularies.js`, view
`views/admin/vocabulary-relationship-types.ejs`).

**Types tab:**
- Lists every canonical relationship type with its per-type usage
  count (`COUNT(*) FROM relationships WHERE relationship_type = name`)
  so curators can see deprecation blast radius before clicking.
- Each row exposes inline editing of `label`, `category`, `frequency`
  (`rare` / `medium` / `common` — drives the U1.3 rare-type-first
  sort), `source_type`, `target_type`, and `inverse_name`.
- The category input is an `<input list="rel-categories">` against a
  `<datalist>` of distinct seeded categories (document / general /
  spatial / organizational / interpretive / familial / event /
  artifact / temporal). The datalist is a soft hint, so a curator
  who genuinely wants a new family can type it directly; existing
  families autocomplete to prevent typo-fragmentation.
- POST handlers redirect with `&savedName=<name>` and the next render
  highlights the matching row with a 2.4s fade so the curator sees
  exactly which row's edit was persisted.
- The `name` (PK) is intentionally **not editable in v1**: every
  relationship row joins on this column. Renaming is the
  deprecate-and-recreate pattern. C3-family follow-up may revisit.
- Deprecation blocks new controlled writes:
  - `relationship_types.deprecated_at` (migration v49) is the marker
    — non-NULL = deprecated.
  - Existing relationships keep their type unchanged.
  - The worker ignores deprecated canonical names for new LLM writes and
    applies the alias-or-`related_to` fallback described above.
  - The C2 curator-authoring dropdown
    ([routes/admin-relationships.js GET /new](../routes/admin-relationships.js))
    calls `listActive()` to filter deprecated out.
  - Manual POST validation rejects explicitly deprecated relationship types.
  - Reactivation clears `deprecated_at` and the type returns to the
    dropdown.
- Inline edits are dirty-row aware. The table warns when navigation or a
  single-row submit would abandon other changed rows, and "Save all changed
  rows" writes the modified vocabulary rows inside one database transaction.

**Aliases tab:**
- Lists every `relationship_type_aliases` row (alias_type →
  canonical_type, plus notes and creation timestamp).
- Add form requires both columns; the canonical_type must exist
  (active or deprecated). UNIQUE on `alias_type` surfaces as a
  friendly error.
- Delete removes the mapping outright. No soft-delete because
  aliases are pure lookup metadata.

**Audit log:**
- `admin.relationship_type_created`
- `admin.relationship_type_updated` (with diff payload)
- `admin.relationship_type_deprecated`
- `admin.relationship_type_reactivated`
- `admin.relationship_type_alias_added`
- `admin.relationship_type_alias_removed`

**Deferred from C4 v1 (flagged):**
- **entity_types vocabulary** — hardcoded enum in
  `routes/admin-entities.js`. Requires schema + code coordination
  (the LLM extraction prompt references the enum, and several
  hardcoded validation paths assume the eight values). Future work.
- **voice_role vocabulary** — foundational; stays code-managed (CHECK
  constraint in the schema).
- **Rename of a canonical type** — every relationship row joins on
  `relationship_types.name`. Cascade design is a C3-family piece.
- **Authority generic terms** — already shipped under A4.4 at
  `/admin/knowledge/authorities/generic-terms`. Linked from the
  vocabulary nav for discoverability but not re-implemented here.

### Citations

- Stored in `citations`
- Tie extracted evidence back to a transcript and a document
- Can point to either an entity or a relationship
- Carry an explicit approval lifecycle: `pending`, `approved`, or `rejected`
- Support auto-approval, manual approval, rejection, and later evidence removal

#### `extraction_method` enum (C5.1)

Citations carry an `extraction_method` provenance column. The canonical
values, defined in `utils/knowledge-approval.js` as the frozen
`EXTRACTION_METHODS` enum and validated by `isValidExtractionMethod`, are:

- `llm_auto` — single-document LLM extraction (the historical default)
- `llm_batch` — batch / multi-document LLM extraction
- `manual` — curator-authored citation; see "Manual citation contract" below
- `imported` — bulk import from an external source

Validation is enforced at the app layer (writes go through
`citations.create`). We deliberately do **not** add a SQL `CHECK`
constraint to the existing `extraction_method TEXT` column because
adding one to an existing SQLite column requires a full table
recreation. The enum is the single source of truth; never hand-type
the string.

#### Manual citation contract (C5.3)

Citations created by a curator (via the C1 entity-authoring path or the
C2 relationship-authoring path) carry a strict provenance shape:

- `extraction_method = 'manual'`
- `extraction_model = NULL` (no LLM produced it)
- `confidence = 1.0` (the curator's assertion is the highest-confidence
  signal in the system)
- `approval_status = 'approved'` on creation — the curator's authoring
  action **is** the approval signal. There is no separate review step.
- `approval_method = 'manual'`, `approved_by_user_id = <curator id>`

These citations bypass the auto-approve threshold logic in
`deriveCitationApproval` because the explicit `approval_status` is
honored by `citations.create`.

#### Source filter on the review queue (C5.2)

`/admin/knowledge/review-extractions?source=<method>` filters the queue
by `extraction_method`. The Source dropdown alongside the existing
Filter type and Sort dropdowns offers each canonical value (or "All
sources" with no filter). Curators can narrow to LLM-extracted vs.
manually-authored evidence; combining filters is supported (Source +
Filter type + Sort all preserve each other).

### Curator-Authored Citations (C1, C2)

In addition to the LLM extraction pipeline, curators can author
citations from scratch via two admin paths. This realizes the
"Curator Is the Expert" principle (see
[development-principles.md](./development-principles.md)) — curators
are not merely reviewers of LLM output; they are first-class authors.

#### Author an entity from scratch (C1)

- `GET /admin/knowledge/entities/new` renders the entity-authoring form
  (`routes/admin-entities.js`, view `views/admin/entity-new.ejs`).
- Required fields: `entity_type` (any canonical type from
  `ENTITY_TYPES`, including `role` per E1), `canonical_name`, plus a
  required transcript span (transcript ID + verbatim text + optional
  disambiguating start offset).
- Optional fields: `description`, `authority_id` (link to an existing
  authority).
- Entry points: the standalone admin form, plus a "Create entity for
  this transcript" link on the document reading surface
  (`views/partials/document-create-entity-link.ejs`, admin-gated).
- `POST /admin/knowledge/entities/new` transactionally inserts the
  entity row AND a manual citation pointing at the resolved transcript
  span. Failure of either insert rolls back both. On success, the
  curator lands on the new entity-detail page.
- The authority and transcript inputs use the shared
  `views/partials/typeahead-picker.ejs` partial against the existing
  `authorities/api/search` and `api/documents/search` endpoints.
  Curators search by canonical name rather than ID.
- The document reading view's "Create entity from transcript" button
  captures `window.getSelection()` via
  `public/js/document-selection-prefill.js` and routes to
  `/admin/knowledge/entities/new` with `verbatim` and `passageStart`
  pre-populated. When text is selected, the button shows a short selected-text
  hint. A `<noscript>` fallback link with just `transcriptId` remains for
  JS-off users.

#### Author a relationship from scratch (C2)

- `GET /admin/knowledge/relationships/new` renders the
  relationship-authoring form (`routes/admin-relationships.js`, view
  `views/admin/relationship-new.ejs`).
- Required fields: source entity ID, target entity ID,
  `relationship_type` (from the controlled vocabulary, with a free-text
  fallback when the table is empty), plus a required transcript span.
- Optional fields: `start_date` and `end_date` (per E6),
  `voice_role` from the `author` / `speaker` / `described_subject`
  enum (per E5).
- Entry points: the standalone admin form, plus "+ Add relationship
  from this entity" on `entity-detail` (prefills sourceEntityId) and
  "+ Add relationship involving this authority's members" on
  `authority-detail` (links without prefill since authority groups
  multiple member entities).
- `POST /admin/knowledge/relationships/new` transactionally inserts the
  relationship row AND a manual citation pointing at the resolved
  transcript span. Validates that both source and target entities
  exist before insert, rejects same-entity source/target pairs, rejects
  deprecated relationship types, and enforces `relationship_types.source_type`
  / `target_type` constraints when the selected controlled vocabulary row
  defines them.
- The source / target entity inputs use the shared typeahead picker
  against `entities/api/search`. After a controlled relationship type is
  selected, the inputs add type filters from that vocabulary row so curators
  search only compatible entity types. Authority-detail's "+ Add relationship
  from a member" dropdown (a native `<details>` disclosure) deep-links
  each member as `sourceEntityId`, replacing the earlier single link
  that landed cold.

#### Entity correction tools (C3, U5)

Entity detail links to two dedicated curator correction pages. The pages use the
admin workspace shell so the high-risk controls have room for warnings,
evidence previews, and audit context, while the canonical POST endpoints remain
unchanged:

- **Edit entity** updates `entity_type`, `canonical_name`, `description`,
  JSON `properties`, and aliases. Each changed field writes an `entity_changes`
  audit row with old value, new value, user id, timestamp, and optional note.
  If `entity_type` changes and the existing authority's type no longer matches,
  the entity's `authority_id` is dropped; citations and sentiment annotations
  remain attached to the entity record.
- **Split entity** creates a new entity from the current one and records an
  `entity_splits` audit row with the source entity, created entity, user, and
  required split note. The UI defaults to leaving all citations, aliases, and
  relationships on the original entity; the curator opts specific rows into the
  new entity. "Link new entity to same authority" is available but unchecked by
  default. Reversal uses the existing merge workflow rather than a custom undo.

Read routes:

- `GET /admin/knowledge/entities/:id/edit`
- `GET /admin/knowledge/entities/:id/split`

Write routes:

- `POST /admin/knowledge/entities/:id/edit`
- `POST /admin/knowledge/entities/:id/split`

#### Shared verbatim resolver (`utils/citation-evidence.js`)

C1 and C2 both validate curator-supplied transcript spans via the
shared `resolveCitationEvidence` helper. The resolver mirrors the E3
mention-resolution pattern (see "Mention resolution and ambiguity"
below): the verbatim text is authoritative; the curator-supplied
`claimedStart` is a hint used only to disambiguate when the verbatim
appears multiple times in the transcript. This applies the
"Trust LLM Verbatim, Not LLM Offsets" discipline from
[development-principles.md](./development-principles.md) to
curator-supplied offsets as well.

### Curator mutation atomicity

Multi-step curator writes use `db.withTransactionAsync(fn)`. Local SQLite uses
`BEGIN` / `COMMIT` / `ROLLBACK`; Turso uses the libSQL write transaction API so
dependent statements share one transaction instead of auto-committing per
statement. Transaction state is request-local via Node `AsyncLocalStorage`,
so overlapping curator requests do not share a transaction driver. Nested
`withTransactionAsync(fn)` calls reuse the active transaction context rather
than opening a second transaction. This helper is required for manual entity
creation, manual relationship creation, phrase-target promotion, authority
disambiguation, authority creation from disambiguation, authority suggestion
approval, authority merges, entity edits, entity splits, and other future
workflows that write more than one row for one curator action.

### Sentiment phrase-target reconciliation (S3)

Sentiment annotations with `target_kind='phrase'` represent sentiment
about a referent the entity pipeline hasn't yet modeled (~54% of
annotations in the seeded corpus). The admin surface at
`/admin/knowledge/sentiment/phrase-targets`
(`routes/admin-sentiment-phrase-targets.js`, view
`views/admin/sentiment-phrase-targets.ejs`) aggregates these phrases
by normalized verbatim. The workspace supports search, pagination, collection,
polarity, and frequency filters, then offers terminal actions per row:

**Promote to entity.** Curator picks `entity_type` (seeded from the
rule-based `utils/sentiment-phrase-typing.js` suggestion) and
`canonical_name` (defaults to the phrase verbatim). The handler
transactionally:
- Creates the entity with `properties.promoted_from_phrase` set
  (audit trail of where the entity came from).
- UPDATEs every matching annotation: `target_kind='entity'`,
  `target_entity_id=<new id>`. `target_phrase` is **preserved**
  (audit trail of the original LLM output).
- INSERTs one manual citation per annotation on the new entity,
  using the annotation's transcript span as `passage_start` /
  `passage_end` / `passage_text=<phrase>`. Citations follow the
  C5.3 manual-citation contract (`extraction_method='manual'`,
  `confidence=1.0`, `approval_status='approved'`).
- Audit-logged as `admin.sentiment_phrase_promoted`.

**Promote to existing entity.** Curator selects an existing entity via the
shared typeahead picker. The handler transactionally retargets matching phrase
annotations to that entity and inserts approved manual citations. As with
promote-to-new, `target_phrase` is preserved as an audit trail of the original
LLM output. Promote, promote-to-existing, and suppress actions preserve the
current phrase-target workspace context (`q`, collection, polarity,
`minFrequency`, and page) when redirecting back to the list.

**Suppress.** Curator decides the phrase is not entity-worthy. Adds
a row to `sentiment_phrase_suppressions` keyed by the normalized
form (lowercased, whitespace-collapsed, trimmed). The listing query
LEFT-JOINs this table and filters out matches from the Active tab.
Audit-logged as `admin.sentiment_phrase_suppressed`.

`sentiment_phrase_suppressions` is intentionally **separate** from
`authority_generic_terms`: the latter suppresses class-name authority
clusters (a different signal); conflating them would obscure each
table's semantics. Per S3.3.

**Auto-typing.** `utils/sentiment-phrase-typing.js` returns a
suggested `entity_type` from surface-form heuristics (honorific
prefix → person; trailing role/place/event/organization keywords;
fallback → topic). v1 is rule-based; LLM-driven typing is the future
enhancement.

**Deferred from S3:**
- **Bulk promote / suppress** — per-phrase decision for now.
- **Cluster-aware suggestions** — Phase 2c clusters could group similar
  phrases; integration deferred.

### Voice Attribution

Relationships (and their mirrors in `sentiment_annotations`) carry three voice
columns to capture which party is asserting, describing, or experiencing a
claim:

- `voice_role` — A CHECK enum constraint: `author` (extracted party is the
  text's author/narrator), `speaker` (quoted or reported speech), or
  `described_subject` (the relationship describes a property of the entity
  rather than an assertion by it)
- `expressed_by_entity_id` — Foreign key to the entity making an assertion
  (used when `voice_role = 'author'` or `'speaker'`)
- `described_subject_entity_id` — Foreign key to the entity being described
  (used when `voice_role = 'described_subject'`)

**Default behavior:** Newly extracted relationships default to `voice_role =
'author'` with `expressed_by_entity_id` set to the relationship source. NULL
values on existing rows indicate unattributed relationships (relationships
extracted before voice attribution was implemented).

**UI surface:** The unified `views/partials/voice-badge.ejs` partial surfaces
voice information across review-extractions cards, entity-detail pages, and
authority-detail pages. The authority-detail page rendering is JavaScript-driven
via `public/js/authority-detail-page.js` and renders voice badges alongside
relationship assertions. Attribution entity hydration is best-effort; badge
text renders with or without the entity link depending on link availability.
Pinning entity references to badge rendering is a deferred follow-up.

The `sentiment_annotations` schema mirrors this structure for sentiment claims,
enabling the same voice-attribution workflow for both relationship and sentiment
evidence.

## Extraction Workflow

Knowledge graph extraction starts from a transcript and is queued as a durable
`extraction_jobs` row.

### Automatic Queueing

- New AI transcripts automatically enqueue a knowledge extraction job
- The worker picks up the job later and extracts graph data

### Manual Re-Extraction

- The admin Knowledge page supports re-running extraction for a single
  document or an entire collection
- These reruns queue fresh extraction jobs with `reset_existing = true`
- When the worker starts such a job, it clears the prior transcript-scoped
  graph artifacts before writing new ones

### Worker Behavior

- The worker resolves the active transcript for the job
- An LLM prompt extracts entities, dates, and relationships from transcript
  content
- Entity aliases are deduplicated within the current transcript only (not
  across documents)
- Each extracted entity is created fresh — no cross-document entity
  resolution occurs
- No authority assignment happens during extraction; that is deferred to the
  authority suggestion job
- Date expressions are attached to the referenced subject entity rather than
  creating a separate date node
- Relationships are deduplicated by source, target, and type within the
  transcript
- Citations are always written for the transcript and document being processed

### Verbatim evidence validation

Graph extraction follows the same "Trust Verbatim, Not Offsets" discipline as
sentiment extraction. For entity mentions, date mentions, and relationship
evidence, the worker locates the LLM-supplied verbatim text in the transcript
before writing a citation. LLM offsets are used only as tie-breakers when the
same verbatim appears more than once. If the verbatim cannot be found, the
artifact is dropped and no fallback LLM text is stored as citation evidence.

`extraction_jobs` records four drop/quality counters:

- `dropped_verbatim_mismatch_count` — extracted entity/date/relationship
  evidence whose verbatim could not be found in the transcript.
- `dropped_unknown_entity_mention_count` — date or relationship artifacts
  whose subject/source/target mention did not resolve to an extracted entity.
- `unresolved_relationship_count` — unresolved relationship mentions.
- `unresolved_date_count` — unresolved date subject mentions.

Admin extraction job rows surface these counters. The admin review route also
exposes an audit JSON report for historical citations whose `passage_text` is
not found in the source transcript; the report returns counts and sample rows
only and never rewrites or deletes contaminated historical evidence.

### Mention resolution and ambiguity (E3, added 2026-06-07)

Mentions on dates and relationships resolve to entities via the
in-run `mentionToEntityId` lookup. The seeded map includes raw
lowercase, `normalizeComparable`, and `normalizeForMatching` forms.
Lookups go through `resolveMentionToEntity` which tries all three
normalization passes on miss before returning null.

When two distinct entities in the same run reduce to the same
normalized key (e.g., "Capt. John Jessop" and "Mr. John Jessop"
both reduce to `john jessop` under `normalizeForMatching`), the
key is **collided**: it is removed from the routing map and added
to a `collidedKeys` Set. Subsequent lookups through that key are
refused and an "ambiguous mention" WARN is logged instead of
arbitrarily routing to whichever entity won the seeding race.

Per-job counters on `extraction_jobs` accumulate the dropped-vs-resolved rate
so the operator can verify the fix's effect on new extractions. Counters are
surfaced inline on extraction done rows in `/admin/jobs`.

To recover historically dropped relationships/dates (extractions
that ran before E3 landed), an admin must re-extract the affected
collections manually — see
[docs/background-jobs.md](./background-jobs.md). Re-extraction is
never auto-queued post-fix.

### Authority Suggestion (post-extraction)

- After each extraction job completes, a scoped `authority_suggestion_job` is
  automatically queued for any collection the document belongs to, provided no
  suggestion job is already pending or running for that collection (debounce)
- Curators can also trigger a per-collection or full-corpus suggestion run
  manually from the Knowledge → Authorities admin page
- Legacy entities that predate the async suggestion pipeline can be reprocessed
  by running the suggestion job manually
- Pending authority-link suggestions that predate a narrower auto-approval rule
  can be backfilled once with
  `npm run backfill:exact-authority-suggestions -- --apply`; the script uses
  the same approval path as manual review and defaults to a dry run unless
  `--apply` is passed.

**Per-collection backfill (admin-triggered):** When the authority
suggestion pipeline must be re-run across the corpus — after a fix to
the embedding worker, the fuzzy pre-filter, or any other pipeline
component — the canonical admin path is `/admin/knowledge/authorities/backfill`.
The page lists collections in `sentiment_enabled DESC` order with
entity-count preview-of-scope; one click per collection. The per-row
submit reuses the same idempotent POST endpoint as post-extraction
auto-queueing, ensuring a single canonical write path. See
[docs/background-jobs.md](./background-jobs.md) for retry semantics
and failure visibility.

## Review and Curation

### Review Extra Evidence

- The review workflow lives in `review-extractions`
- High-confidence citations are auto-approved during extraction
- Lower-confidence citations remain hidden until a human approves them
- Review now handles three evidence kinds:
  entity evidence, relationship evidence, and date-expression evidence
- Review cards show primary citation text plus supporting subject snippets when
  a claim span does not clearly anchor all involved entities
- The review queue can be filtered by evidence/entity type (for example date,
  relationship, person, or place) without leaving the page
- Relationship review explicitly surfaces source/target mention context so
  reviewers can verify that both sides of the edge are evidenced
- Review cards can open an in-context preview overlay that keeps the reviewer
  on the queue while showing the source document page beside the relevant
  transcript context
- The preview JSON can include lazily rendered context sections below the
  image/transcript preview: co-extracted entities from the same document,
  same-document relationships involving either party, and authority
  memberships/aliases for involved entities. These sections are collapsed in
  the modal surface so the primary evidence stays visually dominant.
- Review actions (approve/reject/delete) support in-place updates via JSON so
  triage can continue without full-page reload jumps
- Citations can later be approved, rejected, or deleted from the admin UI
- Review operates on citation evidence, not on the entity nodes alone
- Date citations may link directly to `date_expressions` through
  `citations.date_expression_id`, so reviewers can confirm the specific
  normalized date claim rather than only the owning entity

**Citation review queue sort (curator-velocity U2, added 2026-06-12):** The
`GET /admin/knowledge/review-extractions` endpoint accepts a `?sort=` query
parameter to reorder the pending review queue. Supported sort values are:

- `rare-type-first` (default): Sorts by `relationship_types.frequency` ascending
  (rare → medium → common), surfacing rare relationship types first per U1
- `newest`: Sorts by `citations.created_at` descending, showing most recently
  extracted evidence first
- `low-confidence-first`: Sorts by `citations.confidence` ascending (lowest
  confidence first, greatest review impact)

User sort preference is persisted in `users.preferences.reviewExtractionsSort`
(see "User preferences" below). The default sort (`rare-type-first`) applies to
new sessions until explicitly changed. Per
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md),
sort flexibility enables curators to optimize review workflow for different
curation goals (U2).

**Bulk review-extractions endpoints (curator-velocity U3, added 2026-06-12):** The
citation review queue supports three bulk-action endpoints for efficient triage:

- `POST /admin/knowledge/review-extractions/bulk/approve` — Approves up to 200
  citations in a single transaction. Request body: `{ ids: number[] }`. Response:
  `{ success: true, count: number }`.
- `POST /admin/knowledge/review-extractions/bulk/reject` — Rejects up to 200
  citations in a single transaction. Same request/response format.
- `POST /admin/knowledge/review-extractions/bulk/delete` — Deletes up to 200
  citations (removes evidence). Refuses if any row is already approved. Same
  request/response format.

All bulk endpoints are audit-logged. CRITICAL implementation detail: bulk routes
must be registered BEFORE the per-row `/:id/{approve,reject,delete}` routes in
Express, otherwise `/bulk/reject` is matched as `/:id/reject` with `id='bulk'`.
See [docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md)
(U3) for motivation and rollout context.

### Merge Entities

- Duplicate entities can be merged in the admin UI
- The merge workflow resolves one canonical entity and folds another into it
- Entity merge is now the duplicate-row cleanup tool rather than the main
  cross-document identity workflow
- Entities assigned to different authorities must be reassigned before they can
  be merged

### User Preferences

The `users.preferences` column is a JSON bag for curator UI settings. The bag
supports atomic partial updates via the `usersAsync.getPreferences` and
`setPreferences` API: passing `null` for a key removes it from the bag; new
keys are added or existing keys are updated on subsequent calls.

**Known preference keys:**

- `reviewExtractionsSort` — curator's preferred sort order for the citation
  review queue (values: `rare-type-first`, `newest`, `low-confidence-first`;
  persists the `?sort=` query selection). Initialized to `null`; when null, the
  default sort (`rare-type-first`) is applied server-side.

Future preference settings will piggyback on the same bag to avoid schema
migrations. Per
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md),
the preferences column enables per-curator workflow optimization (U2).

### Authorities Workspace

- The admin `Authorities` workspace lists authority clusters, member entities,
  document coverage, and pending authority-link suggestions
- The authorities table supports filtering by authority type, sorting by type,
  member count, and document count, and batch operations for deleting selected
  authorities or merging selected authorities into a chosen same-type target
- Authority detail pages are curator workspaces: they show compact authority
  counts, a searchable linked-entity browser, contextual approved citation
  evidence and connected edges for the selected member entity, rolled-up
  aliases, and authority merge controls
- Individual authority members can be unlinked from an authority or reassigned
  to another same-type authority from the detail page; reassignment preserves
  the entity as the evidence-bearing record and only changes its
  cross-document identity link
- Authorities can also be merged when two authority records represent the same
  subject

### Authority chronology view (U6)

`/admin/knowledge/authorities/:id/chronology` renders a merged
timeline of every signal type attached to the authority's member
entities. Four signal types contribute:

| kind | source | sortDate |
| --- | --- | --- |
| `citation` | `citations` where `entity_id` ∈ members | `documents.date_created` (falls back to `citations.created_at`) |
| `relationship` | `relationships` where source or target ∈ members | `relationships.start_date` (falls back to `created_at`) |
| `sentiment` | `sentiment_annotations` where `target_entity_id` ∈ members and `target_kind='entity'` | `emotion_about_earliest` (falls back to `extracted_at`) |
| `date` | `date_expressions` where `entity_id` ∈ members | `earliest` |

Each signal is fetched with its own narrow query (bounded by
member-id IN-clause + date-range filter); merge + sort + cursor-slice
happens in JS. Cursor encodes `(sortDate, kind, id)` as base64 JSON
so pagination is safe under concurrent inserts.

Server-rendered first page (~50 events) groups events into year
buckets with `position: sticky` headers. Subsequent pages append via
`public/js/authority-chronology.js` (IntersectionObserver on a
sentinel; falls back to scroll listener).

Filters in v1: date range (`since` / `until`), collection, signal-type
multiselect. Collection filtering is evidence-scoped: relationship and date
signals must join through approved citation evidence in documents belonging to
the selected collection, rather than leaking same-authority facts from other
collections. Finer per-signal filters (relationship type, voice role, polarity)
deferred until curators report they're missed per U6.3.

**Per-signal-type query cap.** Each of the four per-signal queries
applies a hard `LIMIT 2000` safety rail. Authorities with extreme
event density (>2,000 events of any single signal type) will have
later events silently truncated in v1. The cap is generous for the
seeded corpus's largest authority (Victoria, ~125 members); revisit
when an authority reports a missing event past the cutoff.

**Deferred from U6 v1:**
- Visualization (timeline chart, graph view) — Phase 4 research surfaces.
- Cross-authority comparison.
- DOM virtualization for >1,000-event authorities — accepted browser-side scroll lag in v1.
- Export to CSV / JSON / TEI.
- Server-side cursor optimization — the model still loads the
  per-signal capped batches in memory before applying the cursor
  slice. For authorities approaching the 2,000-per-signal cap, every
  page request re-issues all four queries. Migrating to a SQL-side
  cursor (e.g., `WHERE sort_date > ?` per signal) is the natural
  v2 optimization.

### Review surface (admin)

The `/admin/knowledge/authorities/suggestions` page renders 25 suggestions per
server response and uses cursor pagination via
`GET /admin/knowledge/authorities/suggestions.json` for "Load more" (params:
`status`, `nameSignal`, `limit`, `beforeCreatedAt`, `beforeId`,
`beforeExactNameMatch`; response:
`{ suggestions, nextCursor }`).

Pending suggestions default to sorting exact canonical-name matches first while
preserving their original confidence. The `nameSignal=exact` filter narrows the
queue to rows where the entity and suggested authority canonical names match
case/trim-insensitively. This filter is a manual-review fast lane for
non-auto-approved types; exact `person` and `place` names may already have been
auto-approved by the authority suggestion job.

**Match method filter (curator-velocity U7, added 2026-06-12):** The
authority-suggestions query endpoint now accepts a `?matchMethod=` parameter
(replacing the binary `?nameSignal=exact` filter) to filter by the underlying
`authority_link_suggestions.match_method` column values. The `matchMethod`
parameter accepts one or more values matching the actual embedding/matching
strategy used: `exact_canonical`, `fuzzy_match`, `embedding_match`, etc.
Multiple values can be passed as comma-separated or repeated query params to
OR-combine them (e.g., `?matchMethod=exact_canonical,embedding_match`).

For backward compatibility, the legacy `?nameSignal=exact` query continues to
work and is internally mapped to `?matchMethod=exact_canonical`. Per
[docs/reviews/2026-05-31-entity-extraction-historian-lens.md](../docs/reviews/2026-05-31-entity-extraction-historian-lens.md),
the `matchMethod` filter provides fine-grained control over which suggestion
sources to review, supporting both high-confidence exact matches and
embedding-based discovery (U8).

### Generic Authority Terms

Generic terms prevent bare class-like labels such as `High School` or
`School Board` from becoming conceptual authority clusters. Matching is exact
after normalization, so an active term for `High School` suppresses `High
School` but not qualified names such as `Victoria High School`.

Terms can be global or scoped to one `entity_type`. Their statuses are:

- `active` — suppresses authority-link suggestions
- `suggested` — visible for curator review, but operationally inert
- `rejected` — retained history for a rejected learned suggestion
- `disabled` — previously active or suggested, but no longer applied

Generic-term learning is controlled by
`authority_generic_learning_enabled`,
`authority_generic_learning_min_rejections`, and
`authority_generic_learning_min_seen`. Repeated rejections of exact-name
authority suggestions can create a `suggested` term once the configured counts
are met. Extraction can also store a `genericity` hint in entity properties and
propose terms, but those hints do not suppress linking unless a curator
approves the term.

Suggestions are only actionable for entities that do not already have an
authority link. If an entity is already linked to any authority, new suggestion
writes are skipped and any existing pending suggestions for that entity are
reconciled to `rejected`; changing an established authority assignment should
happen through the explicit authority merge/reassignment workflows instead of
the suggestion queue. Schema initialization cleans up existing stale rows, and
future authority assignment/write paths normalize pending suggestions for the
linked entity as part of the same workflow. Pending counts and pending tabs
also defensively exclude any already-linked residue.

Per-row actions are handled via JSON endpoints:

- `POST /admin/knowledge/authorities/suggestions/:id/approve` →
  `{ success, suggestionId, removedSiblingIds }`. Approve cascade-rejects all
  other pending suggestions for the same entity; their ids are returned so the
  client can fade them out of the list.
- `POST /admin/knowledge/authorities/suggestions/:id/reject` →
  `{ success, suggestionId }`. No sibling effect.

Bulk actions are exposed at:

- `POST /admin/knowledge/authorities/suggestions/bulk/approve`
- `POST /admin/knowledge/authorities/suggestions/bulk/reject`

Both accept `{ ids: [int...] }` (max 200) and return
`{ results: [{ id, success, error?, removedSiblingIds? }], removedIds }`. Bulk
processing is per-id; mid-batch cascade-reject collisions surface as
`error: 'already_reviewed'` and are still included in `removedIds` so the
client removes them.

The legacy entity-detail endpoints in `routes/admin-entities.js`
(`POST /admin/knowledge/entities/:id/authority-suggestions/:suggestionId/approve|reject`)
are preserved for the entity-detail surface and continue to redirect to
`/admin/knowledge/entities/:id`.

### Entity Detail

- Entity detail pages show aliases, dates, citations, relationships, authority
  assignment, linked entities, and pending authority suggestions
- These pages are administrative tools for graph inspection and cleanup

## Access Rules

Graph visibility is permission-scoped through document access.

- Admins and access-all users can see the full graph
- Other users can only access entities that are evidenced by documents they can
  view
- Only approved citations contribute to visible entities, relationships, and
  graph search results
- Search and browse operations use document-level access filters
- Document-specific graph panels only expose graph data for documents the user
  can already open
- Authority-backed graph focus only expands through member entities that remain
  visible after the same document/collection access rules are applied
- Authority-first corpus and collection graph nodes only count visible member
  entities, documents, and citations; hidden authority members must not be
  inferable through graph counts or neighbor aggregation

This means the graph is citation-backed and document-scoped, not globally
visible by default.

## Admin Information Architecture

The admin graph tools now live under a single `Knowledge` section:

- `/admin/knowledge` overview
- `/admin/knowledge/authorities`
- `/admin/knowledge/authorities/suggestions`
- `/admin/knowledge/entities`
- `/admin/knowledge/review-extractions`
- `/admin/knowledge/entities/merge`

The same functionality is also reachable from contextual shortcuts in:

- Admin Documents
- Admin Collections
- Collection-level graph navigation at `/collections/:id/graph`

Those shortcuts all route through the same backend rerun queue.

## Rerun Semantics

Reruns are intentionally reset-aware.

- Rerun jobs are marked with `reset_existing = 1`
- The worker removes the prior citations for that transcript before re-running
- Orphaned relationships and entities are deleted only if they are no longer
  referenced anywhere else
- Alias and date-expression rows are also cleaned up when the owning entity is
  deleted

This keeps reruns from accumulating duplicate graph evidence while still
protecting shared entities that are referenced by other transcripts.

## Practical Notes

- Extraction jobs are designed to be durable and resumable through the admin
  job queue
- The default provider is used for reruns unless the job already carries a
  provider choice
- The graph is intended to stay conservative and citation-based rather than
  speculative
- Pending authority suggestions must not affect graph results until explicitly
  approved
