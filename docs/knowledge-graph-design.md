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
  (0.75–0.91) enter the pending review queue; below 0.75 are discarded

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
- Authority detail pages show rolled-up aliases, citations, and relationships
  across the member entities
- Authorities can also be merged when two authority records represent the same
  subject

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
