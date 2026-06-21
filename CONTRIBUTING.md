# Contributing

## Start Here

Before making changes, read:

- [AGENTS.md](./AGENTS.md)
- [Claude.md](./Claude.md)
- [README.md](./README.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/development-principles.md](./docs/development-principles.md)
- [docs/local-development.md](./docs/local-development.md)
- [docs/curator-ux-testing.md](./docs/curator-ux-testing.md)

If your work touches the presentation layer, also read:

- [docs/ui-template-standards.md](./docs/ui-template-standards.md)

If your work touches graph extraction or review flows, also read:

- [docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md)

## Working Style

- Keep changes focused on the task at hand
- Do not revert unrelated local changes
- Prefer small, readable patches over broad rewrites
- Reuse existing backend paths instead of duplicating workflow logic
- Update docs when a subsystem’s behavior or rules materially change

## Codebase Expectations

### Durability

- Use database-backed jobs for long-running or restart-sensitive work
- Avoid fragile in-process background workflows when a queue is more appropriate

### Portability

- Keep runtime behavior compatible across local development, Docker, and Fly
- Avoid introducing macOS-only production dependencies

### Permissions

- Respect existing collection/document access rules
- Derived features like graph access, exports, or analytics affordances should
  inherit those permission boundaries

### UI Consistency

- Shared behavior belongs in shared JS files
- Avoid inline scripts, inline handlers, and repeated template families
- Follow the UI standards doc for EJS/CSS/page structure

## Common Checks

Run the checks that match your change:

```bash
node --check path/to/file.js
npm test -- --runInBand
```

The repository hygiene check allows the committed top-level guidance docs used
by contributors and agents, including `Claude.md`. Treat unexpected extra
top-level files and directories as hygiene failures unless the repo documents
them intentionally.

For template-heavy changes, also sanity-check template compilation and the
relevant pages locally.

For curator-facing UI/UX changes, prefer the fast rendered-page contract suite:

```bash
npm run test:curator-ui
```

Use simulated browser tests only for behavior that needs a real browser:

```bash
npm run test:ux
```

For Python analytics changes, ensure the local runtime is set up:

```bash
npm run setup:python
```

## Deployment-Sensitive Areas

Be especially careful when editing:

- `database/db.js` migrations and data access helpers
- worker/job orchestration in `utils/worker.js`
- storage logic in `utils/storage/`
- Fly/Docker runtime paths
- import, analytics, and knowledge extraction workflows

If you change those areas, think through:

- restart safety
- migration safety
- Docker/Fly portability
- permission implications

## Documentation Rule

If a feature introduces a new convention, subsystem, or workflow that future
contributors would need to understand, add or update the corresponding doc in
`docs/` as part of the same change.
