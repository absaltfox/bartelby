# UI and Template Standards

## Purpose

This document defines the presentation-layer standards for Bartelby:

- EJS template structure
- shared partial usage
- CSS organization
- client-side behavior ownership
- accessibility and usability minimums
- page-level UI conventions

It is based on a full audit of the current `views/` templates and
`public/css/style.css`. Its goal is to stop further drift, guide the cleanup
work, and give future changes a consistent target.

## Scope

These standards apply to:

- all files in `views/`
- all shared partials in `views/partials/`
- all page-specific and shared client scripts referenced by templates
- `public/css/style.css`

These standards also apply to new UI work added later unless a page has an
explicit, documented exception.

## Core Principles

1. Templates should describe structure and content, not own application logic.
2. Shared UI behavior should live in shared JS, not be reimplemented inline per
   template.
3. Shared components should have one canonical CSS definition.
4. Accessibility is part of the baseline, not a later enhancement.
5. Repeated page patterns should be extracted before they drift.
6. The main navigation level on a page must always be visually stronger than any
   child navigation level.

## Composition Principles

Cross-cutting visual and information-architecture rules for any page in the
workspace. Specific page families (detail, list, workflow) add more constraints
on top of these — see § Entity detail — actions after context and § Curator
action toolbar. These principles were distilled from the entity-detail
redesign; regressions here tend to surface as the same class of "why does this
page feel off" bug reports.

1. **Interactive elements must contrast with their container.**
   Buttons, inputs, and other affordances must sit on a background token that
   is one step lighter or darker than the surface they occupy. A
   `.btn-secondary` (`--parchment-alt`) inside a `--parchment-alt` panel
   produces zero affordance; users read it as label text, not as something to
   click. Use design tokens rather than eyeballing hex values.

2. **Match visual weight to consequence.**
   Destructive actions must not share an equal-weight container with routine
   corrections. Delete gets its own visual region (red-tinted card, page
   end); Correct/Author sit in the neutral end-of-record cluster. Restates
   § Actions in operational terms.

3. **Sections size to their content, not to their peers.**
   Multi-column card rows must use `align-items: start` so a sparse card does
   not stretch to match a dense neighbor. Empty sections must not render at
   all — hide the card when there is nothing to say. A card exists to signal
   that a section carries weight; empty cards break that contract.

4. **Density comes from typography and whitespace, not from nested chrome.**
   Lists inside a detail card use hairline dividers and text weight, not
   nested card chrome (border + background + radius per row). Reserve card
   chrome for section boundaries. Row-level chrome ("card inside a card")
   inflates height without adding legibility.

5. **Contextual actions live with what they mutate.**
   An action that only affects one section's data belongs in that section's
   header as a quiet ghost button (e.g., "Edit identity" in the Identity
   card header, "Add relationship" in the Connected edges header).
   Cross-cutting mutations (Edit / Split / Merge / Delete) belong in the
   page-level actions cluster, not in individual card headers. Extends
   § Curator Consequence Text.

6. **Do not repeat what the header already shows.**
   Section content omits fields already surfaced in the page header (title,
   type badge, id meta line). A Properties section that lists the entity's
   ID, type, and canonical name is noise; show only the fields not already
   visible.

7. **Status is coded at the row's edge, not only in a badge.**
   Any list of records that carry an approval / review state (citations,
   extraction review queue, authority suggestions) should use a colored
   edge marker in addition to a text badge, so a curator can scan a stack
   of evidence without reading each row.

## Current Priority Issues

These issues should be treated as the first cleanup tranche because they affect
either correctness or system-wide maintainability:

1. Keep shared jobs and filter contracts explicit.
   Jobs pages must mark the subject cell with `data-job-cell="subject"` and
   pass mode-aware endpoint config (`apiBasesByType`, `pollUrl`) into
   `jobs-page.js`. Filter sidebars must normalize multiselect values in the
   submit handler and use `requestSubmit()` for autosubmit so the same
   normalization path still runs.

2. Remove hardcoded admin-only polling paths from shared pages.
   Example: the document page should not poll `/admin/jobs/api/:id` unless the
   page is explicitly admin-only.

3. Harden shared partial locals.
   Shared partials like the footer must not assume optional locals are always
   present.

4. Consolidate duplicate CSS component definitions.
   Reopened selectors for the same component should be collapsed into one
   canonical definition plus one responsive override block per breakpoint.

5. Extract repeated page families into shared partials and scripts.
   The highest-value candidates are:
   - filter sidebars and multi-select behavior
   - import wizard markup
   - jobs table polling and row updates

## Template Structure Standards

## Page Shell

All full-page templates should follow this order:

1. include the shared header
2. render page-level shell and content
3. load page-specific scripts only
4. include the shared footer

Rules:

- shared scripts belong in shared partials or shared script files, not in page
  templates
- page templates may load page-specific JS files
- page templates should not load a shared script that the footer already loads

### Knowledge Workbench Rail

The Knowledge admin section is the approved exception to the default horizontal
admin subnav convention. Knowledge pages should include
`views/partials/knowledge-nav.ejs`, which renders the reusable
`knowledge-workbench-rail` grouped by curator job:

- Overview
- Review
- Correct
- Reconcile
- Maintain

Desktop Knowledge pages may place the rail as a left workbench column inside
the existing `admin-page--workspace` shell. Mobile Knowledge pages should keep
the same groups as horizontally scrollable sections using CSS only; do not add
page-specific navigation scripts or change route URLs to support the rail.

The global admin nav remains visually stronger than the Knowledge rail.
Workbench links should appear exactly once in the rail and remain grouped by
the curator task they support, not by implementation module.

The rail partial must be rendered as a **direct child** of the
`admin-page--workspace` wrapper. The desktop layout uses
`.admin-page--workspace:has(> .knowledge-workbench-rail)` to convert the page
into a sticky-rail / content grid; wrapping the include in any other container
silently falls back to the mobile horizontal-scroll variant on desktop.

#### Required child order for `.admin-page--workspace` on Knowledge pages

Direct children of `.admin-page--workspace` on Knowledge pages MUST appear in
this order:

1. `<%- include('../partials/admin-nav') %>`
2. `<%- include('../partials/knowledge-nav', { activeKnowledgePage: '...' }) %>`
3. `<div class="admin-header">…</div>`
4. Any success/error alert blocks
5. Page content sections

**Canonical example:** `views/admin/entity-detail.ejs` (lines 3–14).

Do not insert `admin-header` between the two nav includes. The CSS selector
`.admin-page--workspace:has(> .knowledge-workbench-rail)` will still match
either ordering, but the rail visibly shifts vertical position when the order
drifts between sibling pages — curators see the rail jump up or down as they
move through the workbench.

`views/partials/knowledge-nav.ejs` accepts two optional locals so the same
rail can serve both the global admin workbench and the collection-scoped
manage workbench:

- `urlPrefix` — string prepended to every group-item `href`. Defaults to
  `/admin/knowledge`. The manage workbench passes
  `/manage/collections/<%= collection.id %>/knowledge` so the same items
  resolve to collection-scoped routes without duplicating the link
  catalog.
- `isAdmin` — when `false`, items and groups marked `adminOnly: true` in
  the rail's group definition are hidden per the
  hide-unavailable-actions rule. Defaults to `true`. The manage
  workbench passes `false` so global-only maintenance items (entity
  merge, generic terms, sentiment clusters, sentiment review, the entire
  Maintain group) are dropped from the rail for non-admin managers.

The manage-collection composition renders **three** direct children of
the workspace: the global `admin-nav`, the `knowledge-workbench-rail`,
and a `manage-collection-shell` content column. The desktop grid for
this three-direct-child layout is keyed by
`.admin-page--workspace:has(> .knowledge-workbench-rail):has(> .manage-collection-shell)`
in `public/css/style.css` and lays out admin-nav / rail / shell in a
single row at desktop widths. The two-child admin variant
(`admin-page--workspace > admin-nav + knowledge-workbench-rail + page-body`)
continues to work unchanged.

Reusable knowledge list bodies live under `views/partials/knowledge/`
and are shared between the admin and manage workbenches so the two
surfaces stay in sync without template forks:

- `views/partials/knowledge/review-extractions-list.ejs`
- `views/partials/knowledge/authority-suggestions-list.ejs`
- `views/partials/knowledge/entities-list.ejs`
- `views/partials/knowledge/authorities-list.ejs`
- `views/partials/knowledge/phrase-targets-list.ejs`

Each partial expects the same set of locals from either the admin or
manage page wrapper (record list, pagination metadata, `csrfToken`,
`urlPrefix`, and the `isAdmin` flag governing inline action visibility)
and renders the list body only — the page wrapper supplies the page
title, breadcrumbs, surrounding shell, and rail include.

### Curator Consequence Text

AI-assisted curator actions should explain the downstream consequence at the
point of decision. Use shared muted helper text such as `curator-action-note`
near approve/reject/delete/correct/merge/split controls when the action changes
graph visibility, evidence ownership, audit history, or record consolidation.

Consequence text should be short and concrete:

- Approve makes evidence eligible for visible graph views.
- Reject hides evidence from graph views but keeps review history.
- Delete removes the citation evidence record.
- Edit preserves attached evidence.
- Split moves only selected evidence.
- Merge consolidates records.

Bulk confirmations should mirror the same consequence language as the
per-record controls.

### Grouped Action Toolbars

When a section presents two or more closely related action buttons as a
labelled group (for example, Navigate / Correct / Author rows on
`views/admin/entity-detail.ejs`), give each group an accessible name. A bare
`<section>` without an accessible name collapses to a generic `<div>` for
assistive tech, so the visual grouping is not conveyed. Either:

- give the label paragraph an `id` and reference it from the wrapping
  `<section aria-labelledby="...">`, or
- use `<div role="group" aria-label="...">` when no visible label exists.

The first form is preferred when the page already renders a visible group
label, since the visible text and the accessible name stay in sync.

### Curator action toolbar

The horizontal `.curator-action-toolbar` cluster is reserved for
**pure navigation entry-points** (e.g., "Back to authorities", "Review
suggestions", "Chronology") at the top of a workspace or index page. It
orients the curator before they begin work.

Mutation actions (Correct, Author, Delete, Merge) MUST NOT appear in a
top toolbar on any curator page, including workspace pages —
see § Actions after context. Placing mutation controls before the
evidence that would inform them conflicts with
[docs/development-principles.md § Curator Is the Expert; LLM Is Scaffolding](./development-principles.md#curator-is-the-expert-llm-is-scaffolding).

Follows the `aria-labelledby` requirement from § Grouped Action Toolbars
above.

```html
<div class="curator-action-toolbar">
  <section class="curator-action-group" aria-labelledby="curator-action-navigate">
    <p class="curator-action-group-label" id="curator-action-navigate">Navigate</p>
    <div class="curator-action-buttons"> … </div>
  </section>
  <section class="curator-action-group curator-action-group--primary" aria-labelledby="curator-action-correct">
    <p class="curator-action-group-label" id="curator-action-correct">Correct</p>
    <div class="curator-action-buttons"> … </div>
    <p class="curator-action-note">Consequence text explaining what a correction
      actually mutates.</p>
  </section>
  <section class="curator-action-group" aria-labelledby="curator-action-author">
    <p class="curator-action-group-label" id="curator-action-author">Author</p>
    <div class="curator-action-buttons"> … </div>
    <p class="curator-action-note">Creates citation-backed evidence from this entity.</p>
  </section>
</div>
```

The consequence text (`.curator-action-note`) MUST appear inside the group
whose actions mutate corpus state.

### Actions after context

**All curator pages that expose mutation actions** — detail pages
(entity, authority), workspace pages, and any future inspect-and-decide
surface — MUST sequence the layout as **information first, actions
after**. Curators are experts reading the evidence; the record must be
visible before the mutations that would act on it. This is a
consequence of
[docs/development-principles.md § Curator Is the Expert; LLM Is Scaffolding](./development-principles.md#curator-is-the-expert-llm-is-scaffolding).

Applies to:

- **Detail pages** (entity, authority) — sequence: header → structured
  facts → edges → citations → curator actions cluster → danger panel.
  Mutation actions live at end of the reading flow; contextual ghost
  actions in a section header are allowed when the action mutates only
  that section's data (e.g., "Edit identity" in the Identity card,
  "Add relationship" in the Connected edges card).
- **Workspace pages** (authority-detail's member browser, and similar
  future surfaces) — the primary workspace panels come first;
  contextual mutation affordances live inside the row or panel they
  act on (e.g., `+ Add relationship` in the Selected member panel
  header). Page-level mutation clusters, if needed, follow the
  workspace panels — never precede them.

Required elements:

1. **Header** — breadcrumbs, `<h1>` title, and a single-line inline
   meta row that summarizes the record (type badge, id, key
   metrics, and any pure-navigation sub-links like Chronology or a
   count-badged Review-suggestions link). See § Header meta line
   below.
2. Content: identity → structured facts → edges → citations →
   history (or the workspace-equivalent primary panels)
3. `entity-detail__record-actions` on detail pages — the end-of-record
   curator actions cluster (Correct, Author rows), each with its own
   consequence text. Workspace pages skip this block when contextual
   affordances already cover the mutation surface.
4. `.workspace-danger` — a visible but subdued red-tinted card
   containing the single irreversible action (Delete, Merge). Always
   the final section on the page.

The destructive action never appears alongside routine corrections as
an equal-weight control (see § Actions: avoid mixing navigation and
destructive behavior in the same visual treatment).

Every action group with a visible label MUST reference that label via
`aria-labelledby` (see § Grouped Action Toolbars).

Citations and connected edges MUST use the shared `.workspace-citation`
and `.workspace-edge` patterns so the two pages share the same visual
grammar (Composition Principle #4 — density comes from typography, not
per-page chrome). See CSS block in `public/css/style.css`.

**Canonical example:** `views/admin/entity-detail.ejs`. Applied to
`views/admin/authority-detail.ejs` for its Selected Member panel
Citations/Connected edges tabs (rendered by
`public/js/authority-detail-page.js`).

### Breadcrumbs

Every admin, manage, and workspace page MUST render breadcrumbs
via `views/partials/breadcrumbs.ejs` immediately after the
`admin-nav` / `knowledge-nav` includes and before the page header
(`.admin-header entity-header`). Breadcrumbs are the primary
back-navigation affordance across the app; when they're present, do
NOT add "← Back to X" buttons in the page body — the breadcrumb
already covers that path and the button is redundant chrome.

Crumb shape follows the actual admin hierarchy, not the URL literally:

- Top-level admin pages: `Admin → Knowledge`.
- Nested sections: `Admin → Knowledge → Authorities`,
  `Admin → Knowledge → Sentiment`, etc.
- Record pages: `Admin → Knowledge → Authorities → <canonical name>`.
- Record subpages: `Admin → Knowledge → Authorities → <name> → Chronology`,
  `→ Merge`, `→ Edit`, `→ Split`.
- The final crumb is the current page and MUST NOT be a link (the
  breadcrumbs partial handles this — pass it without an `href`).

The crumb partial has `aria-label="Breadcrumb"` and marks the current
page with `aria-current="page"`. Do not hand-roll breadcrumb markup;
always use the partial so the a11y semantics stay consistent.

Canonical example: every page under `/admin/knowledge/`.

### Header meta line

Detail-page headers use a **single-line inline meta row** below the
`<h1>`, not a card row of stats. Reasoning: five inert stat cards
across the top of a page eat vertical real estate without telling a
curator what to do; the same numbers rendered as a scannable muted
line orient the reader without competing with the working surface
below.

Structure:

- A single `<p>` (or equivalent) with class `entity-meta` (canonical
  entity-detail class; reuse on other detail pages so hover, color,
  and spacing stay consistent).
- Segments joined by a `·` separator (`<span class="entity-meta__sep"
  aria-hidden="true">·</span>`).
- Left-side segments name the record: type badge, `id N`, and any
  record-defining property (role, cluster kind, etc.).
- Middle segments are the record's count metrics — read as
  orientation, not as actions. For authority: N members, N
  documents, N aliases, N citations, N edges.
- **Counts MUST link to a filtered destination when one exists.**
  Any number in the meta line that names rows a curator could
  inspect (`N failed extractions`, `3 backfill jobs queued`,
  `2 pending suggestions`) MUST be wrapped in an `<a>` that
  navigates to the filtered view of those exact rows
  (`/admin/jobs?filter=failed&type=extraction`,
  `/admin/knowledge/authorities/suggestions`, etc.). Inert counts
  in a meta line are the same antipattern as inert stat cards —
  they occupy attention without offering an action. Only pure
  totals with no meaningful "show me those rows" destination stay
  as plain text (e.g., a corpus-wide total that has no filter).
  Style warning-tinted counts with `.entity-meta__warn` (used for
  "N failed"-style hints).
- Right-side segments (visually right-aligned via flex) hold
  **pure-navigation sub-links** — Chronology, Review suggestions,
  etc. These are plain text links (see § Element choice vs visual
  weight); if a sub-link points to a work queue, badge it with the
  pending count and hide the sub-link entirely when the count is
  zero (see § Hide unavailable actions).

Do NOT:

- Render top-of-page stat *cards* (`.authority-workspace-stats` and
  similar). If the numbers are worth surfacing, they belong in the
  meta line.
- Place mutation actions in the meta line. It is for orientation
  and navigation only.
- Introduce a separate `<nav>` band between the header and the
  first section for two floating links. Fold those links into the
  meta line so they inherit the header's context.

### Queue page

Curator queue pages (authority suggestions, extraction review, sentiment
review, entity suggestions, and future inspect-and-decide surfaces) share
one shape:

1. **Header** — title + one-line meta row (§ Header meta line). Include
   the queue's total volume in the meta so a curator sees the workload
   at a glance. Do NOT precede the queue with a card grid of
   `Pending / Approved / Rejected` stats; those numbers belong on the
   filter tabs, not floating above them.
2. **Filters** — one `.queue-filters` block that groups every filter
   axis (status, match method, collection, etc.). Each axis is a
   `.filter-chips-group` with a small uppercase label; grouping makes
   the two-axis case (status + method) scan as two decisions instead of
   one wall of chips.
3. **Filter tabs carry the counts** — status tabs get `<span class="filter-count">N</span>`
   badges. The per-axis label reads at a glance (`Pending 28`,
   `Approved 1`, `Rejected 56`, `All 85`) and eliminates the parallel
   stat block.
4. **Humanize enum labels** — DB-facing tokens (`exact_canonical`,
   `member_exact`) are lowercase snake_case; presented labels are
   Sentence case (`Exact canonical`, `Member exact`). The URL param
   stays raw.
5. **Bulk-selection toolbar and list** — the bulk toolbar and the
   list body are one visual section, so the mutation gateway hugs
   the evidence it will act on. Use `.bulk-toolbar--sticky` when the
   list runs long enough to scroll.
6. **Pagination** — when the queue exceeds one page, render a
   `.queue-pager` (Prev / `Page X of Y · N decisions` / Next) inside
   the `.queue-filters` block, below the axis chips. A one-page queue
   omits the pager entirely (never render an empty pager). Do NOT
   ship a "phase-1" truncation notice in place of pagination; if the
   store supports offset/cursor, wire it. Grouped and flat queues can
   use different pagination styles (Prev/Next page vs. load-more)
   depending on their store shape, but each must show a total count
   so a curator sees the workload.

Canonical example: `views/admin/authority-suggestions.ejs` (rendered by
`routes/admin-authorities.js` GET /suggestions).

Cites § Header meta line; § Actions after context (mutation actions,
including bulk selection, follow the evidence).

### Typography hierarchy

Every admin page must present a **visibly distinct** heading ladder
so the eye can locate itself. The rungs, in decreasing weight:

1. **Page `<h1>`** (inside `.admin-header entity-header`) — the
   record or page name. Set by
   `docs/ui-template-standards.md` § Header meta line.
2. **Section `<h2>`** — landmarks inside the page shell
   (`.knowledge-overview-header h2`, `.merge-step__header h2`, and
   similar). Below the page `<h1>`, above card headings.
3. **Card `<h2>`** or **card `<h3>`** — the heading INSIDE a card
   (`.graph-sidebar-header h2`, `.knowledge-task-card h3`,
   `.knowledge-guidance-card h3`). The smallest heading rung.
4. **Body copy** — muted description, list rows, etc.

Rules:

- Each rung MUST be visibly smaller than the one above and larger
  than the one below at the default viewport. If two adjacent rungs
  collide (page `<h1>` competes with section `<h2>`, section `<h2>`
  competes with card heading), the sizes are wrong — fix them, don't
  work around by removing headings.
- Exact rem values live in `public/css/style.css`, not in this doc,
  so the ladder can be tuned without a doc round-trip. The current
  values were established when we killed top-of-page stat cards and
  clarified the h1 / section-h2 / card-h3 gap; keep them
  proportional as you evolve.
- Do NOT use `<h1>` for anything below the page header. Do NOT
  demote a real section landmark to a `<p class="knowledge-card-label">`
  or similar just to avoid the heading — that hides structure from
  screen readers.
- Card body copy (`.knowledge-task-card > .muted`,
  `.knowledge-guidance-card > .muted`) is smaller and looser-lined
  than page body copy; it's supporting text under the card heading,
  not a second title.

### Casing

Page and section headings use **Title Case** — the established site
convention. Examples:

- Page `<h1>`: `Merge Entities`, `Edit Entity`, `Sentiment Review`,
  `Phrase Targets`.
- Section `<h2>`: `Queue Re-extraction`, `Authority Maintenance`.

Card headings and body copy:

- Task-card `<h3>` (imperative, actionable) — Title Case:
  `Re-run One Document`, `Queue Authority Backfill`.
- Guidance-card `<h3>` (informational, topical) — Sentence case:
  `Approval rules`, `Authority backfill`, `Batch behavior`.
- Buttons — Title Case for verb + noun labels:
  `Merge Authority`, `Queue Document Re-extraction`. Danger-zone
  buttons follow the same convention.
- Filter chips and status labels — Sentence case:
  `Exact canonical`, `Member exact`, `Pending`, `Approved`.

Do NOT flip a page's title from Title Case to sentence case without
also updating tests that assert the exact string. Integration tests
under `tests/integration/` frequently pin the h1 text with `toContain`.

### List row disambiguation

Curator lists frequently surface many rows that share a canonical
name — five entity records named "British Columbia," multiple
authorities called "John Smith," several documents titled
"Untitled." A row that shows only the canonical name is unusable in
that situation; the curator can't pick the right one to open.

When a list is expected to contain **homonymous rows**, surface a
**derived evidence hint** on each row that names *why this row is
this row*. Prefer a hint drawn from data already loaded for the
list so no extra query is needed:

- **Members list on authority-detail** — top-cited document per
  member, rendered as `mostly in <em>Newcombe Field Diary</em>`.
  Grouped from the citation rows already fetched by
  `citations.getByEntityIds`.
- **Entity suggestions / disambiguation groups** — the entity's
  source document + a short excerpt.
- **Duplicate authority candidates** — the top member name for
  each candidate, so a cluster of "Smith" authorities shows
  `John Smith · James Smith · …` rather than five identical rows.

Style the hint as small muted text on its own line under the row
name (`.authority-member-row-evidence` is the canonical example).
Rows that have no data to disambiguate omit the hint entirely —
don't show `mostly in —` or an empty span.

Cites [docs/development-principles.md § Keep Evidence Traceable](./development-principles.md#keep-evidence-traceable):
the disambiguating hint is a curator-facing pointer back to the
evidence that makes the row unique.

### Conditional HTML Attributes

When an HTML attribute must appear only under a condition (for example
`aria-current`, `aria-selected`, `disabled`, `checked`, or a `data-*` flag),
emit the whole attribute through an EJS `<% if %>` block, not through a
`<%= %>` interpolation. `<%= %>` HTML-escapes its output, which converts the
quote characters inside the attribute value to `&quot;`, producing markup like
`aria-current=&quot;page&quot;` that browsers parse as the literal string
`"page"` rather than the intended attribute value. The safe pattern is:

```ejs
<a href="..." <% if (isActive) { %>aria-current="page"<% } %>>Label</a>
```

Avoid `<a aria-current="<%= isActive ? 'page' : '' %>">` for attributes whose
entire presence is conditional — prefer omitting the attribute entirely when
the condition is false.

### JSON bootstrap payloads must escape `<`

Server data passed into a page through a `<script type="application/json">`
block must have `<` escaped inside the template:

```ejs
<script id="page-config" type="application/json"><%- JSON.stringify({
  mode: 'admin',
  apiBase: apiBase
}).replace(/</g, '\\u003c') %></script>
```

The replacement value is a JSON unicode escape for `<` — backslash, `u`, `003c`
— not a literal `<`. `JSON.parse` turns it back into `<` on the client, so the
payload the page receives is unchanged while the markup can no longer be broken
out of.

`JSON.stringify` escapes quotes and backslashes but **not** `<`. Any string in
the payload containing `</script>` therefore closes the element early, and
everything after it parses as HTML. This was a live admin-session XSS (issue
#83) while the CSP still allowed inline scripts. The CSP now refuses them (see
"No inline scripts or event handlers" below), but that is a backstop, not a
reason to skip the escape: injected markup can still deface the page or post a
form.

Escape unconditionally, whether or not the value looks user-controlled. Payload
contents change: a key holding a module constant today holds `req.query.status`
after the next feature lands, and the omission is invisible at review time.

Validating the input at the route is a good second layer — allowlist enumerated
query parameters rather than passing `String(req.query.x || 'default')` straight
through — but it is not a substitute for escaping at the sink.

Prefer a shared helper over repeating `.replace(...)` at each call site. A
convention applied by hand at a dozen call sites will eventually be missed at one
of them, which is exactly how #83 happened.

## Shared Partials

Shared partials should only contain:

- shared markup
- shared semantics
- shared structure

Shared partials should not contain:

- page-specific fetch logic
- page-specific conditional branches unrelated to the component itself
- one-off inline scripts for a single page

Current canonical shared partials include:

- `views/partials/header.ejs`
- `views/partials/footer.ejs`
- `views/partials/admin-nav.ejs`
- `views/partials/knowledge-nav.ejs`
- `views/partials/manage-collection-nav.ejs`
- `views/partials/collection-hero.ejs`
- `views/partials/breadcrumbs.ejs` (see § Breadcrumbs)
- `views/partials/flash-alerts.ejs`

When a pattern appears in three or more templates, it should usually become a
shared partial or a shared helper partial.

## Template Logic

Allowed in EJS:

- small display conditionals
- compact formatting helpers
- simple loops over already-prepared view models

Avoid in EJS:

- large data transformation blocks
- repeated query-string builders across multiple pages
- JSON parsing and fallback normalization in multiple templates
- large script-generated HTML strings

If logic is reused or hard to scan, move it to:

- route/controller preparation
- a shared partial
- a client-side JS module

## Script Ownership Standards

### No inline scripts or event handlers

The Content-Security-Policy in `server.js` sets `script-src 'self'`. The browser
will not run an inline `<script>` body or an inline handler attribute
(`onclick="..."`), and it fails silently: the page renders and the script simply
never runs.

- Put behavior in a file under `public/js/` and load it with `<script src>`.
- Pass server data to it in a `<script type="application/json">` element (see
  "JSON bootstrap payloads must escape `<`" above) and read it with
  `JSON.parse(document.getElementById(id).textContent)`. Do not assign to a
  `window.__something` global from the template.
- Bind events with `addEventListener` in the page script.

`tests/unit/views-no-inline-script.test.js` scans every view for both and fails
on either.

## Shared Behavior

Shared behavior belongs in external JS modules.

Examples:

- header nav activation
- user-menu toggling
- modal open/close primitives
- shared filter dropdown behavior
- shared jobs polling behavior
- poll scheduling and backoff (`public/js/poll-scheduler.js`)
- mode-aware jobs table row refreshes using named cell hooks
- filter sidebar autosubmit/normalization flow

Do not keep these as inline `<script>` blocks inside partials.

### Polling

Page JS must not call `setInterval` or a self-rescheduling `setTimeout`
directly for polling. Use `window.PollScheduler`
(`public/js/poll-scheduler.js`, loaded from `partials/footer.ejs` so it is
available on every page):

- `PollScheduler.schedule(fn, delayMs)` — one-shot, for self-rescheduling
  polls;
- `PollScheduler.every(fn, intervalMs)` — repeating, and unlike `setInterval`
  it waits for each tick to settle so slow requests cannot stack;
- `PollScheduler.createBackoff(baseMs, maxMs)` — for error paths, which must
  back off rather than retry at a flat interval forever.

Both scheduling helpers refuse to fire while
`document.visibilityState === 'hidden'` and run immediately when the tab
returns to the foreground, so a backgrounded tab issues no requests and a
returning one shows fresh data at once. Every poll tick pays the full
per-request middleware cost, so this is not a micro-optimization.

Handles returned by these helpers are cancelled with `.cancel()`, not
`clearInterval`/`clearTimeout`.

## Page-Specific Behavior

Page-specific behavior may live in:

- a page-specific JS file in `public/js/`
- a small inline bootstrap block only when it is strictly limited to passing
  server data into the page

Allowed bootstrap example:

- assigning sanitized JSON data to `window.__pageData`, or emitting it in a
  `<script type="application/json">` block — in both cases escaping `<` per
  § JSON bootstrap payloads must escape `<`

Disallowed patterns:

- long imperative DOM scripts embedded in templates
- repeating the same dropdown or polling setup in multiple templates
- inline `onclick`, `onchange`, or `onerror` handlers

## Inline Styles

Inline `style=""` usage should be rare.

Allowed:

- one-off dynamic values that are truly presentational and hard to express any
  other way, such as a computed progress width
- transitional bootstrap hiding for JS-driven panels when no stable class is
  available yet

Disallowed:

- layout composition
- spacing decisions
- typography adjustments
- repeated modal sizing or panel visibility rules

If the same inline style appears in more than one place, it should become a CSS
class.

## CSS Standards

### Doc citations belong in CSS comments

Per [CLAUDE.md § Citation Requirement](../CLAUDE.md), any CSS block
that encodes a documented rule MUST cite the governing doc section
in a leading comment. Example (from `public/css/style.css`):

```css
/* Queue page filter cluster — per docs/ui-template-standards.md § Queue
   page (labeled axes, counts on tabs, no top stat-card block). Cites
   the same doc's § Composition Principles #4. */
.queue-filters { … }
```

Two reasons this matters more for CSS than for view templates: (1)
CSS rules travel across sections of the file and evolve
independently, so the "why" evaporates fast without an inline
pointer; (2) tuning a CSS value (padding, gap, font-size) often
looks purely cosmetic but is tightening a rule laid out in the
doc — the citation warns the next editor away from unmoored
"cleanup" that would drift back to the antipattern the rule fixed.

Also cite when removing a class that a doc used as a canonical
example, so the doc example can be updated in the same commit.

### Utility classes carry their own presentation

When a class is used bare (not always inside a container that
already gives it padding/border), it MUST style itself completely.
`.admin-search-input` is the canonical example: it started as
`{ min-width: 260px }` and relied on being inside `.edit-field`
for padding/border/focus. Once curators dropped the input straight
into a card body, it rendered as a browser-default `<input>` with
squished padding.

The fix: give `.admin-search-input` its own `padding`, `border`,
`background`, `border-radius`, focus outline, and font. Now the
class stands alone in any container. Follow the same principle for
any utility a page uses without a wrapper — do not lean on a
container's rules for base presentation.

## Design Tokens

Theme overrides should preserve the semantic split between `--accent`,
`--accent-hover`, and `--accent-dark`: use `--accent-hover` for hover states,
and reserve `--accent-dark` for pressed, active, or otherwise deepened states.
Any surface that uses `--accent-mid` as a background must pair it with
`color: var(--ink)` to maintain readable contrast.

## File Organization

`public/css/style.css` should be organized by component families, with each
component defined once.

Recommended order:

1. tokens
2. reset/base
3. typography
4. site shell
5. shared primitives
6. shared components
7. page families
8. responsive overrides

## Component Ownership

Each component should have:

- one canonical selector block
- one nearby set of related selectors
- one responsive override area per breakpoint

Avoid reopening the same selector in distant sections unless there is a very
clear reason and documentation.

## Loading States

Use the shared skeleton loader classes for content that is expected to arrive
shortly after the initial render, especially when the page shell and primary
actions are already usable. Skeletons should reserve the same general space as
the eventual content, include screen-reader-only loading text, and use
`aria-busy="true"` on the region being updated. Replace the skeleton with real
content as soon as the async request completes.

## Bulk Selection Toolbars

Use the shared `bulk-toolbar` class family for page-level selection and batch
actions. Page-specific toolbar classes may remain as compatibility hooks, but
they should be paired with the shared classes rather than defining a separate
visual pattern. The select-all control should use `bulk-toolbar-select-all`,
the selected count should use `bulk-toolbar-count`, and action groups should
use `bulk-toolbar-actions`.

## Naming

Prefer stable, purpose-driven component names over borrowed page names.

Good:

- `table-shell`
- `settings-table`
- `jobs-toolbar`
- `collection-hero-meta`

Avoid:

- using `users-table` for analytics tables
- using workflow classes for unrelated entity screens
- page-specific class names for components that exist elsewhere

## Breakpoints

Breakpoints should be consolidated rather than repeated ad hoc throughout the
file.

Preferred breakpoint set:

- `600px`
- `760px`
- `900px`

If additional breakpoints are needed, document why.

## Navigation Standards

## Hierarchy

Page navigation hierarchy must be visually obvious:

- global site nav is primary
- page or section nav is secondary
- in-page view switchers are tertiary

Child navigation must never visually overpower parent navigation.

Use only these two navigation patterns:

- primary section tabs:
  underline tabs for sibling pages or sections, used for document tabs, collection tabs, admin subnav, and manage subnav
- secondary view switchers:
  quieter segmented controls or compact subtabs for in-page mode changes such as analytics view switches

Do not introduce one-off tab styles for individual pages.

Alignment rules:

- admin and manage sub-nav groups should be left-justified within the page
  shell
- top-level and child admin sub-navs should span the available page width so
  their divider lines read as part of the page structure, not just the label
  cluster
- when a nav group becomes too wide for the viewport, it may fall back to
  horizontal scrolling on smaller screens
- child nav groups such as Logging and Knowledge should follow the same
  left-justified, full-width behavior as the top-level admin nav rather than
  inventing their own alignment
- the global site header uses three persistent zones: brand on the left,
  primary nav centered within the bar, and utility controls on the right
- the global header search is a single integrated field; Enter submits a
  normal `/search` query, while the visible `⌘K` affordance maps to Advanced
  Search through shared shell JavaScript

## Active States

Active states must be:

- present for all navigational groups
- consistent within a nav family
- handled by shared JS or by server-rendered classes

Avoid per-template nav activation scripts when a shared module can do it once.

## Forms Standards

## Labels and Hints

All form controls must have:

- a visible label
- clear hint text when the field is non-obvious
- required state that is visible in the label or surrounding UI

## Actions

Primary and secondary actions should be visually consistent across:

- settings pages
- import flows
- admin actions
- account actions

Rules:

- use buttons for actions
- use links for navigation
- avoid mixing navigation and destructive behavior in the same visual treatment

For the finer distinction between "action" and "navigation," and how
that decision separates from visual weight, see § Element choice vs
visual weight below.

Operational row actions should use one consistent button family:

- neutral actions such as `Open`, `Log`, `Continue`, `Retry`, `Filter`, and
  other non-destructive row/workspace actions should use the shared secondary
  button treatment
- positive mutating actions such as `Approve`, `Grant Access`, and similar
  commit actions may use the shared primary button treatment when they are the
  single dominant action in that row or card
- destructive actions such as `Delete`, `Remove`, or other irreversible
  operations should use the shared danger button treatment
- avoid mixing legacy one-off button classes with the shared button family in
  the same action row
- if a link is presented as a button, its hover and focus treatment must match
  the button family rather than reverting to text-link behavior

### Hide unavailable actions

Actions the current viewer cannot perform (role-gated, not-yet-eligible,
already-in-flight) MUST be hidden, not rendered as `disabled` with a tooltip.
Rationale: curators triage by scanning; a disabled button reads as "I could do
this if I fixed something," which wastes attention.

**Exceptions where `disabled` is acceptable:**

- The button's disabled state itself teaches the required precondition (e.g.,
  "Merge" disabled until both source and target are selected — see
  `views/admin/merge-entities.ejs`).
- An in-flight action where "Running…" is a status the curator must see; in
  this case, replace the button with a `status-badge status-running` chip
  rather than leaving `<button disabled>`.

For simple "user lacks permission" cases: omit the element entirely and let the
layout re-flow.

### Element choice vs visual weight

The rule "buttons for actions, links for navigation" mixes two
orthogonal decisions. Keep them separate.

**Element choice is semantic, non-negotiable.** It follows what the
control does at the transport layer, not how it looks:

- `<a href>` — anything that changes the URL. Includes
  "navigate to a form that will then mutate." A link to
  `/admin/knowledge/relationships/new?...` is still a link even
  though the destination is an authoring surface.
- `<button>` inside a `<form method="POST">` — anything that
  mutates state in place: submits, toggles, disclosures, menus.
- Never wrap a `<button>` in an `<a>` or vice versa. Accessibility
  (announced role, Enter/Space behavior, screen-reader navigation,
  right-click menus) depends on picking the correct element.

**Visual weight is chosen per container** based on the affordance's
role in that container, not on whether the element is an anchor or a
button. The same button family classes apply to both.

| Class | Use when |
|---|---|
| `btn-primary` | The single dominant action per row/card. Only one per group. Reserved for the action a curator will click most often in that context (Save, Approve, Edit entity as the primary correction). |
| `btn-secondary` | Co-equal alternatives to the primary. Row-level "Correct" cluster items (Split, Merge alongside Edit). |
| `btn-ghost` | Contextual affordance sitting inside another element's header. Muted, low-weight. `+ Add relationship` in an edges card header, `Edit identity` in an identity card. |
| plain text link (no button class) | Pure navigation to a sibling record with no authoring implied. `Open entity`, breadcrumbs, `Chronology`. |
| `btn-danger` | Only inside `.workspace-danger`. Never mixed with routine buttons. See § Danger zone. |

**Worked example.** In the authority-detail Selected member panel
header we present `Open entity` and `+ Add relationship`. Both are
`<a>` semantically (both change the URL). They get *different*
visual weight because they play different roles in the container:
`Open entity` is pure navigation to a sibling record and renders as
a plain text link; `+ Add relationship` is a contextual authoring
affordance in that panel's header and renders as `btn-ghost`. This
is not an inconsistency — it is what the rule looks like when the two
decisions (semantic element, visual weight) are made independently.

Cites [docs/development-principles.md § Curator Is the Expert; LLM Is Scaffolding](./development-principles.md#curator-is-the-expert-llm-is-scaffolding):
authoring affordances get more visual weight than pure navigation
because curator authorship is the primary work.

### Danger zone

Every detail page ends with a `.workspace-danger` section that
isolates the single irreversible action for that record (Delete,
Merge, Purge). The pattern is a landmark curators can recognize on
sight across pages.

Structure:

1. `<section class="workspace-danger">` with `aria-labelledby`
   referencing the title id.
2. A fixed title **`Danger zone`** — a constant landmark. The
   destructive verb goes on the button, not the title. Do NOT write
   `Danger zone — merge authorities`.
3. A one-sentence note that names the destructive verb ("Deletion
   removes …", "Merging is irreversible …") and states that the
   action cannot be undone.
4. A `<form method="POST">` (or `<a class="btn-danger">` when the
   action needs additional input on a dedicated page — see below)
   ending in a single `<button type="submit" class="btn-danger">`
   whose label is verb + noun ("Delete entity", "Merge authority").

Do NOT:

- Merge the destructive verb into the title. The title is a
  landmark; the button carries the verb.
- Place multiple destructive actions in one danger zone. If a
  record needs both Delete and Merge, promote the more complex
  action to a dedicated route (like
  `/admin/knowledge/entities/merge`) and keep the danger zone
  singular.
- Wrap the confirm control in an "are you sure?" collapsed
  disclosure. Use `data-confirm-message` on the form so the shared
  confirm dialog fires on submit.

When the destructive action needs additional inline input (target
selection, evidence review), do NOT stretch the danger zone into a
two-column layout with an embedded form. Instead, promote the action
to a dedicated route (`/admin/knowledge/<noun>/merge`) and let the
danger zone be a single-button link that navigates there. This keeps
every detail-page danger zone visually identical and lets the
picker/comparison surface breathe on its own page.

Canonical examples: `views/admin/entity-detail.ejs` (Delete),
`views/admin/authority-detail.ejs` (Merge — navigates to the
dedicated `/admin/knowledge/authorities/merge` page).

Cites § Actions (`avoid mixing navigation and destructive behavior
in the same visual treatment`) and § Actions after context (the
danger zone is always the final section on the page).

## CSRF

Every mutating HTML form must include a CSRF token. GET forms should not.

AJAX-based actions must use the shared CSRF meta token pattern consistently.

Treat the token as **opaque, and never cache or reuse it across responses**.
`ensureCsrfToken` (`middleware/csrf.js`) emits a freshly masked value on every
render — the session secret itself is never sent — so that a stable secret
does not sit inside a compressed response alongside the shell's reflected
`?q=` value, which together would be the BREACH precondition. Two renders of
the same session legitimately produce different token strings; both validate.
Read it from the rendered `_csrf` field or the `<meta name="csrf-token">` tag
at the moment you need it, and do not assert equality between tokens from
different responses.

## Shared Typeahead

Entity, authority, transcript, and similar lookup fields should use the shared
typeahead picker rather than custom page-specific autocomplete code. The picker
must support mouse and keyboard interaction: Down/Up move the active option,
Enter selects it, Escape closes the results, and `aria-activedescendant` /
`aria-expanded` reflect the current state. Pages may change the picker
`data-search-url` at runtime to add safe filters, such as relationship
source/target entity-type constraints.

## Correction Workspaces

High-risk curator correction flows, such as entity edit and entity split, should
use dedicated admin workspace pages rather than cramped dropdowns embedded in a
detail toolbar. Use the shared admin workspace shell, shared form classes, and a
short warning or risk note near the top when the action can change authority
membership, evidence ownership, or audit history.

Correction pages should:

- keep mutating POST contracts on the canonical backend workflow
- show the existing record context before the curator commits a change
- include evidence previews for opt-in moves such as split citations, aliases,
  dates, and relationships
- expose audit visibility when audit rows already exist for the workflow
- avoid inline styles, inline event handlers, and page-specific imperative
  scripts unless the behavior is promoted into a reusable shared component

## Dirty Multi-Row Forms

Editable admin tables that expose many independent row forms must protect
against silent loss. Track changed controls per row, warn before navigation or
single-row submit when other rows are dirty, and prefer a "Save all changed
rows" action when multiple edits are likely. Bulk save handlers should write
all changed rows in one transaction.

## Tables Standards

Operational tables are a major UI pattern in this app and must be standardized.

Required:

- `thead`
- `tbody`
- `th` with `scope="col"`
- `scope="row"` when row headers are used
- a consistent actions column treatment

Recommended:

- a wrapping container for overflow
- a consistent empty state directly below the section heading

Avoid:

- ad hoc table styles inline
- mixing multiple table component classes for convenience

## Modal Standards

Modals should use one shared structure:

- overlay
- dialog
- header
- body
- footer

Shared modal behavior should handle:

- open
- close
- escape key
- overlay click
- focus restoration where practical

Avoid page-specific modal scripts that reimplement the same close behavior.

### Evidence preview modal

Curator review queues that show an item alongside its supporting transcript
evidence MUST use the shared evidence preview modal pattern rather than
inventing a new overlay.

Structure:

- Root element: `<div class="modal-overlay">` with `role="dialog"`,
  `aria-modal="true"`, and `aria-labelledby` pointing to the modal title.
  Uses an `id` attribute (e.g., `id="review-preview-modal"`) as the JS hook
  — do not use `data-review-preview-modal`; the JS targets the `id` directly.
- Dialog wrapper: `<div class="modal-dialog review-preview-modal-dialog">`
- Header: `<div class="modal-header">` with a heading group and a close button
  carrying `aria-label="Close"`.
- Body: `<div class="modal-body review-preview-modal-body">` containing:
  - A metadata bar (`div.review-preview-meta`)
  - A two-panel layout (`div.review-preview-layout`):
    - Left panel (`section.review-preview-panel`): original document page image
      with speaker/timestamp label
    - Right panel (`section.review-preview-panel`): transcript context excerpt
      with passage note
  - A context section (`div.review-preview-context`) for lazily rendered
    corroborating evidence (co-extracted entities, same-document relationships,
    authority memberships)
  - A footer (`div.review-preview-footer`) with a link to open the full document

**Canonical example:** `views/admin/review-extractions.ejs` (lines 107–145)
with backing JS at `public/js/review-extractions.js`.

Do not invent a new preview modal for future review queues. Reuse this pattern
for sentiment review, phrase-target review, authority-suggestion review, and any
subsequent queue.

## Accessibility Standards

Minimum requirements:

- all controls have accessible names
- icon-only buttons have `aria-label`
- tables use proper header semantics
- menus use correct menu semantics or remain simple disclosure panels without
  `role="menu"`
- tabs use `role="tablist"` and selected state consistently
- hidden panels are controlled with semantic state, not only visual styling

Image behavior:

- decorative fallback behavior should not rely on inline handlers
- meaningful images need useful alt text
- purely decorative thumbnails may use empty alt text

## Usability Standards

## Empty States

Every empty state should answer:

- what is empty
- why it may be empty
- what the user can do next

The call to action must match the user role and context.

## Feedback States

Every async or background-driven page should expose:

- loading state
- success state
- failure state
- retry path when practical

Avoid pages that look stalled without any progress or explanatory copy.

## Density and Hierarchy

Pages should prefer:

- strong headings
- short subtitles
- lightweight metadata rows
- compact secondary controls

Avoid:

- large secondary controls competing with main nav
- oversized dense tables without grouping
- very wide account/settings tables without a responsive plan

## Workspace Toolbars

Long operational workspaces such as review queues, document grids, and other
selection-heavy admin pages may use a sticky toolbar when it materially helps
users keep filters, selection state, or bulk actions in reach.

Rules:

- sticky toolbars should remain visually attached to the page shell, not float
  like detached overlays
- use a subtle surface and border treatment rather than elevated modal styling
- keep sticky toolbars shallow and compact
- do not make ordinary page headers or navigation bars sticky unless the page
  family specifically requires it
- if a toolbar becomes visually noisy when sticky, prefer a static toolbar
  instead

## Spacing Rhythm

Vertical spacing must be deliberate and consistent across page shells.

Required baseline:

- the first section-level nav under the global site header must have a visible top inset; do not let page tabs sit flush against the site header
- top-level section nav and the page header block must have a distinct gap large enough to read them as separate layers
- when a page header is followed by a child sub-nav, that sub-nav should sit close enough to feel attached to the header, but not collapse into it
- content panels should start after another clear spacing step below the final nav or header row

Preferred shell rhythm:

- site header -> first page nav: small inset
- first page nav -> page header: medium gap
- page header -> child sub-nav: small-to-medium gap
- last header/nav row -> first content section: medium gap

Rules:

- never use negative margins to "pull" unrelated page regions together unless the pattern is documented and shared
- when introducing a new page family, define its spacing in shared shell/component rules rather than page-specific overrides
- if two adjacent UI layers feel visually fused, add spacing before adding borders or extra decorative separators

## Page Archetypes

The app should standardize around these page families:

## Width Archetypes

Admin and manage pages must use shared width archetypes rather than choosing
one-off max widths.

Use these page shell widths:

- workspace shell:
  around `1360px` max width for the full admin section and for dense
  operational pages such as logs, jobs, graph/knowledge review, entity
  management, and other table-or-grid-heavy workspaces
- standard shell:
  around `1100px` max width for non-admin dashboard, settings, and form-heavy
  pages

Current admin mapping:

- workspace shell:
  all `/admin` pages, including dashboard, settings, import, approval flows,
  documents, collections, users, jobs, logging, and knowledge pages

Admin forms should stay readable by constraining the form itself rather than
shrinking the whole page shell.

Rules:

- do not add page-specific max widths when an existing shell archetype fits
- all `/admin` pages should use the shared workspace shell unless there is a
  documented exception
- if a page needs a narrower reading measure, constrain the inner form or panel
  rather than changing the outer admin shell
- pages within the same family should share the same shell width unless there
  is a documented reason not to
- prefer semantic shell classes such as `admin-page--workspace` over
  presentation-only names such as `wide`

## List Pages

Examples:

- collections browsing
- document lists
- entity lists

Pattern:

- page header
- optional summary
- filters/search
- result list or table
- pagination
- empty state

Collections browsing may use the canonical reading-room homepage composition:
a server-prepared featured collection, a compact stacks row, and a recent
documents rail. Keep the template limited to prepared display fields, preserve
collection/document permission boundaries in the route or model helpers, and do
not add inert filter/sort/list/activity controls before those routes or
behaviors exist.

## Detail Pages

Examples:

- document view
- entity detail

Pattern:

- context header
- primary content
- supporting metadata/actions
- secondary tabs only when necessary

## Settings Pages

Examples:

- account
- LLM settings
- application settings
- analytics settings

Pattern:

- page header
- grouped sections
- one stable form layout
- consistent section spacing
- consistent save actions

## Jobs Pages

Examples:

- admin jobs
- manage jobs

Pattern:

- summary/filter bar
- jobs table
- inline status badges
- expandable logs
- shared polling behavior

## Multi-Step Wizards

Examples:

- import flow

Pattern:

- one shared step shell
- one shared step header treatment
- shared error, progress, and completion messaging
- page-specific data passed via JSON bootstrap only

## Definition of Done for UI Changes

A template or CSS change is not complete until:

1. it follows this document
2. it does not duplicate an existing component pattern
3. it does not add new inline behavior without justification
4. it uses semantic HTML for tables, forms, tabs, and actions
5. it works at desktop and mobile widths
6. it preserves nav hierarchy and readable information flow
7. it does not reopen an existing CSS component in a distant, conflicting way

## Cleanup Roadmap

The cleanup should happen in this order:

### Phase 1: Shared shell and correctness

- remove duplicate shared script loading
- harden shared partial locals
- move nav and user-menu behavior into shared JS
- fix role-inappropriate polling endpoints

### Phase 2: Shared component extraction

- shared filter sidebar partial and JS
- shared jobs polling/render helpers
- shared modal behavior
- shared alert and empty-state conventions

### Phase 3: Major page-family consolidation

- merge admin/manage import wizard templates
- refactor document page into partials
- consolidate jobs pages
- consolidate list/filter pages

### Phase 4: CSS consolidation

- collapse duplicate selectors
- reorganize component families
- remove styling by borrowed class name
- reduce inline-style dependencies

### Phase 5: Accessibility and polish

- table header scopes
- menu semantics
- icon button labels
- mobile review of dense tables and settings screens

## Review Checklist

Use this checklist for all future UI/template changes:

- Is this pattern already implemented elsewhere?
- Should this be a shared partial or shared JS module?
- Does the template contain too much logic?
- Are there new inline styles or inline handlers?
- Are semantics correct for forms, tables, tabs, and menus?
- Is the navigation hierarchy still obvious?
- Does the empty state tell the user what to do next?
- Is the CSS change adding a duplicate selector instead of extending the
  canonical component?
