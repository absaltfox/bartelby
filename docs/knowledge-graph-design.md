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

### Authority Link Suggestions

- Stored in `authority_link_suggestions`
- Represent medium-confidence candidate links from an entity to an existing
  authority
- Remain review metadata until explicitly approved

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

### Citations

- Stored in `citations`
- Tie extracted evidence back to a transcript and a document
- Can point to either an entity or a relationship
- Carry an explicit approval lifecycle: `pending`, `approved`, or `rejected`
- Support auto-approval, manual approval, rejection, and later evidence removal

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
- Review actions (approve/reject/delete) support in-place updates via JSON so
  triage can continue without full-page reload jumps
- Citations can later be approved, rejected, or deleted from the admin UI
- Review operates on citation evidence, not on the entity nodes alone
- Date citations may link directly to `date_expressions` through
  `citations.date_expression_id`, so reviewers can confirm the specific
  normalized date claim rather than only the owning entity

### Merge Entities

- Duplicate entities can be merged in the admin UI
- The merge workflow resolves one canonical entity and folds another into it
- Entity merge is now the duplicate-row cleanup tool rather than the main
  cross-document identity workflow
- Entities assigned to different authorities must be reassigned before they can
  be merged

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
