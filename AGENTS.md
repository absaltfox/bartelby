# Agent Guide

This file is the fast-start guide for AI coding agents working in this
repository.

## Read This First

Before making changes, review these documents in this order:

1. [README.md](./README.md)
2. [docs/architecture.md](./docs/architecture.md)
3. [docs/development-principles.md](./docs/development-principles.md)
4. [docs/local-development.md](./docs/local-development.md)
5. [CONTRIBUTING.md](./CONTRIBUTING.md)

Then read the subsystem-specific docs that match the task:

- UI, EJS, CSS, admin layout, navigation, width, spacing, forms, tables, and
  visual hierarchy:
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
- Knowledge graph extraction, approval, review, entities, and graph explorer:
  [docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md)
- Deployment, Docker, Fly, Turso, and S3 expectations:
  [DEPLOY.md](./DEPLOY.md)

## Non-Negotiable Project Rules

- Do not introduce new UI conventions without updating
  [docs/ui-template-standards.md](./docs/ui-template-standards.md).
- Do not introduce new page-width conventions when an existing shell archetype
  already fits.
- Keep behavior compatible across local development, Docker, and Fly.
- Respect collection/document permissions for all derived features.
- Prefer durable, database-backed jobs for restart-sensitive workflows.
- Do not duplicate existing backend workflows when a canonical path already
  exists.

## UI Work

If a task touches:

- `views/`
- `views/partials/`
- `public/css/style.css`
- page JS loaded from templates

you must follow
[docs/ui-template-standards.md](./docs/ui-template-standards.md).

In particular:

- use the documented shell width archetypes
- preserve nav hierarchy
- preserve shared spacing rhythm
- avoid new inline behavior/style patterns
- prefer shared partials and shared JS over one-off page logic

## Knowledge Graph Work

If a task touches:

- extraction
- entity approval/rejection
- graph visibility
- admin knowledge screens
- collection/document graph views

you must follow
[docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md) and ensure
that any workflow changes remain consistent with
[docs/development-principles.md](./docs/development-principles.md).

## Documentation Rule

If you add or change:

- a subsystem convention
- a workflow expectation
- a UI/layout rule
- an operational behavior that future contributors need to know

update the relevant documentation in the same change.
