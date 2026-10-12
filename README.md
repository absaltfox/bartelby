# Transcriber

Bartelby is a document transcription and archival workflow app for importing, transcribing, organizing, and exploring historical materials. 

It supports historians engaged in research by making the data and connections contained in primary sources apparent and discoverable.

## Key Docs

- Agent quick-start guide:
  [AGENTS.md](./AGENTS.md)
- Claude-oriented repo guidance:
  [Claude.md](./Claude.md)
- Architecture and subsystem overview:
  [docs/architecture.md](./docs/architecture.md)
- Development principles and decision rules:
  [docs/development-principles.md](./docs/development-principles.md)
- Local setup and Python analytics runtime:
  [docs/local-development.md](./docs/local-development.md)
- Knowledge graph model and admin workflows:
  [docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md)
- UI, EJS, and CSS conventions for all presentation-layer changes:
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
- Schema migrations, drift risk, and repair patterns:
  [docs/db-migrations.md](./docs/db-migrations.md)
- Contribution workflow:
  [CONTRIBUTING.md](./CONTRIBUTING.md)
- Reporting a security problem:
  [SECURITY.md](./SECURITY.md)
- Deployment notes for Docker and Fly:
  [DEPLOY.md](./DEPLOY.md)
- Curator UI/UX testing:
  [docs/curator-ux-testing.md](./docs/curator-ux-testing.md)

## UI Changes

If you are changing:

- EJS templates in `views/`
- shared partials in `views/partials/`
- page JS loaded from templates
- `public/css/style.css`

follow the standards in
[docs/ui-template-standards.md](./docs/ui-template-standards.md) before making
changes. That document is the project baseline for:

- layout and partial structure
- CSS organization
- component naming
- navigation hierarchy
- forms, tables, tabs, and modals
- accessibility and usability expectations
