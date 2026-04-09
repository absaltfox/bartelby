# Bartelby Architecture

## Purpose

Bartelby is a document transcription and archival workflow app for importing,
transcribing, organizing, reviewing, and exploring historical materials.

The product is centered on scanned documents, derived transcripts, and the
metadata and graph relationships that are built from them over time.

## Major Subsystems

### Web App

- Node.js + Express application in `server.js`
- EJS server-side rendering in `views/`
- Shared client-side behavior in `public/js/`
- Shared styling in `public/css/style.css`

### Authentication and Access Control

- Session-based login with Passport
- Role-aware access for admin, manager, editor, viewer, and access-all users
- Collection-scoped access controls for documents, transcripts, and graph data
- CSRF protection on state-changing requests

### Document Workflow

- Document upload and import
- Page rendering and grouping
- Transcript generation
- Transcript editing and annotation
- Export to PDF and TEI

### Knowledge and Analytics

- BERTopic-powered collection analytics
- Knowledge graph extraction from transcripts
- Entity review, merge, and graph exploration
- Background job queues for transcription, import submission, analytics, and graph extraction

## Runtime Model

### Local Development

- Runs as a single Node process
- Uses local SQLite / SQL.js storage by default
- Can use a local Python virtualenv for BERTopic
- Can also use local storage for uploads

### Production

- Designed for Docker and Fly.io
- Uses Turso as the database backend
- Uses Cloudflare R2 or another S3-compatible store for uploads
- Can launch ephemeral Fly Machines for large PDF processing and BERTopic

## Data Flow

### Import

1. A user uploads a document.
2. The import pipeline renders or extracts page images.
3. The user reviews or groups pages.
4. A transcription job is queued or submitted as a provider batch job.
5. The resulting transcript is stored as the best transcript for the document.

### Transcription

1. The worker claims a queued transcription job.
2. The selected provider generates text for the page images.
3. The transcript is persisted with provenance metadata.
4. If enabled, a knowledge graph extraction job is queued for that transcript.

### Knowledge Graph Extraction

1. The extraction worker claims a queued extraction job.
2. The transcript content is sent to the configured LLM prompt.
3. Entities, aliases, dates, relationships, and citations are written to the
   database.
4. Review and merge workflows can refine the extracted graph afterward.

### Analytics

1. A collection analytics job computes summary metrics.
2. BERTopic generates topics, hierarchy, and evolution data.
3. Results are saved back to the database and rendered in the collection UI.

## Async Job Model

Bartelby uses database-backed queues rather than in-memory task state.

Current job families:

- transcription jobs
- import submission jobs
- extraction jobs
- collection analytics jobs

Workers claim jobs atomically, mark them running, and persist logs and status
as they progress. This makes the app safer under restarts and compatible with
multi-instance deployment.

Important behavior:

- provider batch transcription is asynchronous
- large PDF import submission can be offloaded to Fly Machines
- knowledge graph reruns can reset existing transcript-scoped graph artifacts
- analytics can run locally or on an ephemeral Fly worker, depending on config

## Storage and Database

### Database

- SQLite-compatible schema with migrations in `database/db.js`
- Local development can use a local database file or SQL.js
- Production can use Turso

### Upload Storage

- Local filesystem storage for development
- S3-compatible storage in production
- Upload URLs are treated as application data and are served through the app
  with access control when needed

### Python Runtime

- BERTopic uses a project-local Python virtualenv when available
- The app can also use a configured Python interpreter path

## Extension Points

When adding new features, the main extension points are:

- `routes/` for HTTP endpoints and page composition
- `utils/` for reusable workflow logic, provider adapters, and background
  workers
- `database/db.js` for schema migrations and data access helpers
- `views/` and `public/js/` for UI and client-side behavior
- `public/css/style.css` for presentation rules

## Design Principles

- Prefer durable jobs over in-process background work
- Keep shared behavior in shared modules
- Keep page templates focused on structure and view data
- Make production behavior work the same way in Docker and Fly as it does
  locally whenever possible
- Preserve archival quality in stored source assets, and generate lighter
  derivatives for preview and UI use
