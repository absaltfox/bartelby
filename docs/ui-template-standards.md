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

1. Remove duplicate shared script loading.
   Example: `views/document.ejs` currently loads `/js/app.js` even though it is
   already loaded by `views/partials/footer.ejs`.

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

## CSRF

Every mutating HTML form must include a CSRF token. GET forms should not.

AJAX-based actions must use the shared CSRF meta token pattern consistently.

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

## Page Archetypes

The app should standardize around these page families:

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

