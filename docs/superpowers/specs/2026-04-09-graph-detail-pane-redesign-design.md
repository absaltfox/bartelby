# Knowledge Graph Entity Detail Pane — Redesign

**Date:** 2026-04-09
**Status:** Design approved, ready for implementation plan
**Scope:** Client-side rendering changes in `public/js/graph-explorer.js` and
supporting CSS in `public/css/style.css`. Affects the entity detail pane used by
the global graph explorer (`views/graph.ejs`) and the per-collection graph
explorer (`views/collection-graph.ejs`).

## Context

The entity detail pane renders on the right side of the knowledge graph
explorer whenever the user selects an entity, either from the sidebar list or
by clicking a node on the canvas. The pane is the primary surface a researcher
uses to inspect what we know about an entity and navigate outward from it to
documents and related entities.

The current implementation — `renderDetail()` in
`public/js/graph-explorer.js` — has grown organically and accumulated a
handful of problems that make it hard to scan and waste vertical space. A
screenshot review of the Charles Dorsey entity surfaced five concrete issues
that motivated this redesign.

## Current issues

1. **Header repeated three times.** The pane chrome's "Details" eyebrow, the
   entity card inside the body, and the stats row all restate the entity name
   and type. The reader gets the same information three ways before reaching
   any actual content.

2. **Stats row adds no information.** The
   `<strong>N</strong> aliases · <strong>N</strong> citations · <strong>N</strong> neighbours`
   row just recounts data that is already visible in the sections below. It
   takes real estate and looks enough like buttons to create UX confusion.

3. **Empty "Dates" section.** After the extraction pipeline was changed to
   attach date expressions to described entities instead of creating standalone
   date entities, legacy entities will effectively never have dates. The
   section renders "No dates attached to this entity." on every entity, which
   is wasted space.

4. **"Citations" and "Cited in documents" duplicate each other.** Both are
   driven by `stores.citations.getByEntityId()`. The first renders one card per
   citation; the second groups citations by document. On any entity with a
   small number of citations, the same passage and document appear twice in a
   row.

5. **"Connected entities" lacks direction and evidence.** A row like
   "Charles Johnson — related to" gives no hint whether this entity acts on the
   neighbour or the neighbour acts on this entity, and there is no link to the
   passage that justifies the relationship.

## Approach

Approach A from the brainstorming session: **hierarchy and deduplication
inside the existing single-scroll layout.** We keep the mental model that
researchers already use — one scrollable pane with everything visible at once
— and fix the five issues directly. Approaches B (tabs) and C (summary +
accordions) were considered and rejected because they either hide data the
researcher wants to scan in one pass or require ranking heuristics we do not
yet have.

## Design

### Section 1 — Header

One compact block replaces the current chrome eyebrow + entity card + stats
row. It contains, top to bottom:

- **Type badge** — small pill using the existing `entity-type-badge` colour
  palette.
- **Canonical name** — displayed as the pane's primary heading.
- **Aliases inline** — rendered as "Also known as: alt1, alt2" when the
  entity has aliases. When there are more than three, display the first three
  followed by "+N more" which toggles the remaining aliases on click. No
  separate "Aliases" section.
- **Description** — optional, rendered below aliases when present.

The pane chrome's "Details" eyebrow in `graph.ejs` and `collection-graph.ejs`
stays but the current entity title/subtitle in that chrome is updated to serve
as a short subheading (type · selected-from source) rather than restating the
name. The redundant entity card inside the body is removed.

### Section 2 — Sources (merged)

A single "Sources" section replaces both the current Citations section and the
Cited in documents section. The data source is the `detail.citations` array
already returned by `/graph/entities/:id` — the client groups it by
`document_id` at render time, so no extra request is needed. The separate
`/graph/entities/:id/documents` endpoint is still used elsewhere and stays in
place, but this pane no longer calls it.

- **Section label** — "Sources" followed by a count pill:
  "N documents · M passages". Both counts come from the grouped result.
- **Cards** — one per document, ordered by passage count descending. Each
  card shows the linked document title, a passage count, up to three passage
  excerpts as italic blockquotes (to match the curation cap the other endpoint
  used), and an "Open document" action button.
- **Empty state** — the entire Sources section is hidden when the entity has
  zero citations. No "No citations attached" placeholder.

### Section 3 — Connections (directional)

Replaces the current "Connected entities" section. Same `dedupeNeighbors()`
pipeline feeds it, so the list is already collapsed to one row per neighbour.

- **Section label** — "Connections" with a count pill.
- **Row format** — each neighbour row has four horizontal slots:
  1. Direction indicator: `→` when the current entity is the source of the
     relationship, `←` when it is the target. The arrow uses the accent
     colour and a fixed width so the column lines up.
  2. Relationship label in lowercase, underscores replaced with spaces
     ("related to", "mentioned in"), fixed width for column alignment.
  3. Neighbour canonical name with an inline type pill.
  4. Optional evidence excerpt — when the relationship citation has a
     passage, it renders as a small italic line below the row.
- **Interaction** — clicking a row selects that neighbour (same behaviour as
  today's card, but the whole row is clickable).
- **Empty state** — section hidden when there are zero neighbours.

The relationship label and direction both come from the raw neighbour query
result. The current client computes direction implicitly from which endpoint
of the relationship matched the focus entity; this redesign makes it explicit
in the UI.

### Section 4 — Dates (conditional)

Not rendered unless the entity actually has at least one date expression
attached. When present, keep the current card style but under a "Timeline"
label and sorted chronologically by the earliest date. This lets the newly
fixed extraction pipeline populate it for future documents without showing an
empty section for every legacy entity in the meantime.

### Empty-entity fallback

When all four content sections (Sources, Connections, Dates, any description)
are empty, render a single friendly empty state in place of the section stack:

> No approved details yet for this entity.

This replaces the current behaviour of stacking four separate "No X attached"
placeholders.

### Section dividers

Between sections, use the same subtle horizontal divider already defined by
`--border-light`, not bold section headings. The small uppercase section
labels provide the structure; the dividers provide the rhythm. This removes
the flat h4 repetition in the current pane.

## Technical considerations

- **Data source for Sources:** `detail.citations` from the existing
  `/graph/entities/:id` response is grouped by `document_id` on the client. No
  new HTTP call and no backend change. The
  `/graph/entities/:id/documents` endpoint stays in place for other surfaces
  that use it.
- **Direction in Connections:** the neighbour rows currently come from
  `dedupeNeighbors()`, which stores aggregated relationship types per
  neighbour but does not preserve direction per relationship. The dedup pass
  needs to track whether each relationship had the focus entity as source or
  target, and expose a `direction` field on each neighbour (or on each
  relationship inside an aggregated neighbour). When a neighbour has mixed
  directions across multiple relationships, fall back to rendering one row
  per direction.
- **Evidence excerpts for Connections:** the neighbour query does not
  currently return relationship citation excerpts. Either extend the query to
  include them, or fetch them lazily when the detail pane renders. The spec
  prefers the former when cost is acceptable; implementation plan should pick
  based on query cost inspection.
- **No backend changes expected** beyond possibly extending the neighbour
  query to include one relationship citation excerpt per neighbour. All other
  data shapes already exist.
- **CSS touch is concentrated in `.graph-detail-*` rules.** New classes for
  the connection row layout, the inline alias list, and the source card
  header. The existing `.graph-citation-card`, `.graph-citation-quote`, and
  `.graph-detail-card` rules stay in use.

## Out of scope

- The sidebar entity list, the canvas rendering, the toolbar filters.
- Backend changes to citation approval, entity approval, or permissions.
- Any change to how dates are extracted or stored. The new extraction
  pipeline is already in place; this redesign just stops rendering an empty
  section when it has not yet populated any data.
- Tabs, accordions, or summary-ranking heuristics (explicitly rejected).

## Success criteria

1. The Charles Dorsey entity (and any other entity with similar data) renders
   without the three repeated headers, without the useless stats row, without
   an empty Dates section, and without duplicated citation content.
2. Connection rows show direction and read as a natural phrase:
   `Dorsey → related to → Johnson`.
3. An entity with no aliases, no sources, no connections, and no dates
   renders a single empty-state line rather than four stacked placeholders.
4. An entity with many sources (10+ documents) still fits in the pane without
   visual breakdown; card width and truncation behave gracefully.
5. Both `views/graph.ejs` and `views/collection-graph.ejs` show the new pane
   without template changes beyond removing the now-redundant title strings
   in the pane chrome.
