# Bartelby

Bartelby is a document transcription and archival workflow app for importing, transcribing, organizing, and exploring historical materials. 

It supports historians engaged in research by making the data and connections contained in primary sources apparent and discoverable.

## Key Docs

- Agent quick-start guide:
  [AGENTS.md](./AGENTS.md)
- Claude-oriented repo guidance:
  [CLAUDE.md](./CLAUDE.md)
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

## License

Copyright (C) 2026 Michael LeBlanc.

Bartelby is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License, version 3, as published by the
Free Software Foundation. It is distributed in the hope that it will be useful,
but without any warranty; see [LICENSE](./LICENSE) for the full text and
[COPYRIGHT](./COPYRIGHT) for the copyright notice.

Because this is the Affero licence, running a modified copy as a network
service means offering its users the source of that modified copy.
