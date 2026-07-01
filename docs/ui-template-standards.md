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
- `views/partials/manage-nav.ejs`
- `views/partials/manage-collection-nav.ejs`
- `views/partials/collection-hero.ejs`

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

## Shared Behavior

Shared behavior belongs in external JS modules.

Examples:

- header nav activation
- user-menu toggling
- modal open/close primitives
- shared filter dropdown behavior
- shared jobs polling behavior
- mode-aware jobs table row refreshes using named cell hooks
- filter sidebar autosubmit/normalization flow

Do not keep these as inline `<script>` blocks inside partials.

## Page-Specific Behavior

Page-specific behavior may live in:

- a page-specific JS file in `public/js/`
- a small inline bootstrap block only when it is strictly limited to passing
  server data into the page

Allowed bootstrap example:

- assigning sanitized JSON data to `window.__pageData`

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

## CSRF

Every mutating HTML form must include a CSRF token. GET forms should not.

AJAX-based actions must use the shared CSRF meta token pattern consistently.

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
