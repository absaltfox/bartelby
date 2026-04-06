# Transcriber

Bartelby is a document transcription and archival workflow app for importing,
transcribing, organizing, and exploring historical materials.

## Key Docs

- Local setup and Python analytics runtime:
  [docs/local-development.md](./docs/local-development.md)
- UI, EJS, and CSS conventions for all presentation-layer changes:
  [docs/ui-template-standards.md](./docs/ui-template-standards.md)
- Deployment notes for Docker and Fly:
  [DEPLOY.md](./DEPLOY.md)

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

