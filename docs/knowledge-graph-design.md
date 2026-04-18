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

- Canonical nodes in the graph
- Stored in `entities`
- Have an `entity_type`, canonical name, optional description, and JSON
  properties

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

### Aliases

- Stored in `entity_aliases`
- Track alternate names and extracted mentions for an entity
- Used for searching and for entity resolution during extraction

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
- Entity aliases are deduplicated where possible
- Date expressions are attached to the referenced subject entity rather than
  creating a separate date node
- Relationships are deduplicated by source, target, and type
- Citations are always written for the transcript and document being processed

## Review and Curation

### Review Extra Evidence

- The review workflow lives in `review-extractions`
- High-confidence citations are auto-approved during extraction
- Lower-confidence citations remain hidden until a human approves them
- Review now handles three evidence kinds:
  entity evidence, relationship evidence, and date-expression evidence
- Citations can later be approved, rejected, or deleted from the admin UI
- Review operates on citation evidence, not on the entity nodes alone
- Date citations may link directly to `date_expressions` through
  `citations.date_expression_id`, so reviewers can confirm the specific
  normalized date claim rather than only the owning entity

### Merge Entities

- Duplicate entities can be merged in the admin UI
- The merge workflow resolves one canonical entity and folds another into it

### Entity Detail

- Entity detail pages show aliases, dates, citations, and relationships
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

This means the graph is citation-backed and document-scoped, not globally
visible by default.

## Admin Information Architecture

The admin graph tools now live under a single `Knowledge` section:

- `/admin/knowledge` overview
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
