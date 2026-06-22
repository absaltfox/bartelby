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
- Can run as a single `node server.js` process for smaller installs
- Can also split into separate web and worker roles from the same image by
  setting `DISABLE_BACKGROUND_WORKER=1` on web instances only
- Uses Turso as the database backend
- Uses Cloudflare R2 or another S3-compatible store for uploads
- Can launch ephemeral Fly Machines for large PDF processing and BERTopic

## Data Flow

### Import

1. A user uploads a document.
2. The import pipeline renders or extracts page images.
3. The user reviews or groups pages and can assign collections from the subset
   they are authorized to import into. In the PDF import flow, the thumbnail
   organizer supports persistent multi-page selection while the enhanced page
   preview provides the keyboard-driven manual review flow built around a
   current page and an active group, alongside AI-assisted auto-group
   suggestions.
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
- sentiment extraction jobs

Workers claim jobs atomically, mark them running, and persist logs and status
as they progress. This makes the app safer under restarts and compatible with
multi-instance deployment.

**Sentiment extraction (`sentiment_extraction_jobs`)** runs `utils/worker-sentiment.js` after a graph-extraction job finalizes for a transcript whose document belongs to ≥1 collection with `sentiment_enabled = 1`. The singleton path makes one synchronous LLM call; the batch path (≥2 jobs claimed) submits a provider Messages-Batch via `utils/sentiment-batches.js` (OpenAI, Anthropic, Gemini, Vertex) using a two-phase commit with a `pending-<uuid>` correlation placeholder, then finalizes via durable `batch_finalization_claimed_at`. Annotations are citation-backed (`span_start`/`span_end` + `evidence_excerpt`), voice-tagged (`author` / `speaker` / `described_subject`), aspect-targeted (`entity` / `phrase`), and carry the model's per-annotation reasoning in `notes` plus per-document observations in `extraction_notes`. Reviewable at `/admin/knowledge/sentiment/review`.

**Sentiment research surfaces (Phase 4, reader-facing)** live under two routes both mounted with `optionalAuth`:

- `/sentiment` (`routes/sentiment-research.js`) — the research workbench (HTML at `GET /sentiment`) plus two JSON endpoints: `GET /sentiment/annotations.json` (cursor-paginated list of approved annotations) and `GET /sentiment/rollups.json?shape=summary|timeline|fingerprint|cooccurrence|network` (rollup dispatcher).
- `/entities/:id` (`routes/entities.js`) — reader-facing entity detail page, visible to a user when at least one of the entity's citations lives in a document they can read.

Both surfaces — and the document-detail Sentiment tab, the admin entity / authority knowledge-cards, and the graph-explorer drawer's sentiment subsection — share one filter parser (`parseResearchFilters` in `database/models/sentiment.js`), one access predicate (`documentsAsync.buildAccessConditions(opts)`), and one panel-loader (`loadSentimentEntityPanel` in `database/db.js` — runs an EXISTS-probe short-circuit, fans out summary + recent in parallel, logs and soft-fails so a sentiment-side bug never 500s the parent page). Reader-facing surfaces show only `approval_status='approved'`; admins can opt in to `pending` via the workbench filter. Rejected is never visible. Anonymous viewers see only annotations in `is_world_public` collections.

For lighter deployments, Bartelby can run the web server and worker loop in one
Node process. For production deployments under load, the preferred topology is
to run separate web and worker roles from the same image so background polling
does not compete with interactive page requests.

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

Storage adapters in `utils/storage/` are a documented extension point and must
implement the same interface. The required methods are:

- `init`
- `sanitizeTempName`
- `getTempFilePath`
- `tempFileExists`
- `tempFileExistsAsync`
- `readTempFile`
- `readTempFileAsync`
- `writeTempFile`
- `copyLocalFileToTemp`
- `deleteTempFile`
- `deleteTempFiles`
- `deleteTempAssets`
- `copyTempFileToUpload`
- `copyTempAssetToUpload`
- `copyLocalFileToUpload`
- `getTempPreviewUrl`
- `deleteUploadByUrl`
- `readUploadByUrl`
- `streamUploadByUrl`
- `getUploadSizeByUrl`
- `toUploadsUrl`
- `resolveStoredUrl`

The app validates this contract at startup and fails fast if the configured
driver is incomplete. `streamUploadByUrl` is required for protected upload
delivery so adapters and mocks do not silently fall back to full-buffer reads.
S3-compatible adapters may also implement optional `getPresignedUploadUrl()` so
already-authorized image thumbnails can be delivered through short-lived signed
object URLs instead of the protected `/uploads/:filename` proxy.

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
