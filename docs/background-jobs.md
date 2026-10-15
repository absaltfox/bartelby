# Background Jobs

This document explains how Bartelby's background job queue works, how the worker
loop is structured, and where to wire up new worker tasks.

---

## Why Durable Jobs?

Bartelby uses **database-backed job queues** rather than in-process task queues or
message brokers. This matches the project's core principle of favouring durable
workflows over in-memory state:

- Jobs survive server restarts (Fly.io deploy, crash, scale-down).
- Job state, logs, and errors are visible in the admin Jobs UI.
- Multiple app instances (Fly horizontal scaling) can claim jobs atomically without
  a separate queue service.

On startup, `database/db.js::initializeSchema()` automatically detects and
recovers stale jobs (those left in `running`/`processing` state from an unclean
shutdown) by marking them `failed` or re-queuing them as appropriate.

---

## Job Families

| Family | Table | Claimed by |
|--------|-------|-----------|
| Transcription | `transcription_jobs` | `utils/worker-transcription.js` |
| Import – render (PDF → images) | `import_jobs` (kind `render`) | `utils/worker.js::tickImportRenderJobs` |
| Import – submit (batch provider) | `import_jobs` (kind `submit`) | `utils/worker.js::tickImportSubmissionJobs` |
| Import – auto-grouping (LLM) | `import_jobs` (kind `grouping`) | `utils/worker.js::tickGroupingJobs` (submit) + `pollRunningGroupingBatches` (finalize) |
| Knowledge graph extraction | `extraction_jobs` | `utils/worker-extraction.js` |
| Authority resolution backfill | `authority_resolution_jobs` | `utils/worker-authority-resolution.js` |
| Authority suggestion (cluster pipeline) | `authority_suggestion_jobs` | `utils/worker-authority-suggestion.js` |
| Title & summary backfill | `title_backfill_jobs` | `utils/worker-title-backfill.js` |
| Sentiment extraction | `sentiment_extraction_jobs` | `utils/worker-sentiment.js` |
| IIIF ingestion (remote-reference crawl) | `iiif_sources` | `utils/worker-iiif.js` |
| Collection analytics | `worker_leases` + module-level flag in `utils/analytics.js` | `utils/worker.js` scheduled interval |

> **Note:** Analytics do not use a DB-backed job record for the outer sweep;
> `collection_analytics` rows serve as the durable output. The BERTopic sub-step
> is dispatched as either an ephemeral Fly Machine or a detached local process.

> **Note:** `sentiment_extraction_jobs` are auto-queued from
> `utils/worker-extraction.js` via `autoQueueSentimentForTranscript` after a
> graph-extraction job finalizes. Enqueue is gated on the document belonging
> to at least one collection with `collections.sentiment_enabled = 1`, and is
> de-duped via `hasQueuedOrRunningForTranscript` so a transcript never has
> overlapping sentiment jobs.

---

## Worker Loop Architecture (`utils/worker.js`)

`startWorker()` registers a set of `setInterval` ticks on startup when the app
is running with background work enabled. In practice that means
`DISABLE_BACKGROUND_WORKER` is not set to a truthy value, so
`config.runtime.startWorker` remains `true`.

| Tick | Interval | Concurrency guard |
|------|----------|-------------------|
| `tick` (transcription) | 5 s | `busy` boolean |
| `tickImportSubmissionJobs` | 5 s | `importBusy` boolean |
| `tickImportRenderJobs` | 5 s | `importRenderBusy` boolean |
| `tickGroupingJobs` | 5 s | `groupingBusy` boolean |
| `tickExtractionJobs` | 5 s | `extractionBusy` boolean |
| `tickAuthorityResolutionJobs` | 5 s | `authorityResolutionBusy` boolean |
| `tickAuthoritySuggestionJobs` | `BATCH_POLL_MS` | `authoritySuggestionBusy` boolean |
| `tickTitleBackfillJobs` | 5 s | `titleBackfillBusy` boolean |
| `tickSentimentExtractionJobs` | 5 s | `sentimentExtractionBusy` boolean |
| `tickIiifSyncJobs` | 5 s | `iiifSyncBusy` boolean |
| `pollRunningBatches` (transcription) | `BATCH_POLL_MS` | `batchPollBusy` boolean |
| `pollRunningGroupingBatches` | `BATCH_POLL_MS` | `groupingBatchPollBusy` boolean |
| `pollRunningExtractionBatchesTick` | `BATCH_POLL_MS` | `extractionBatchPollBusy` boolean |
| `pollRunningSentimentBatchesTick` | `BATCH_POLL_MS` | `sentimentBatchPollBusy` boolean |
| `checkStaleImportJobs` | 60 s | — (read-only) |
| Analytics sweep | 15 min | `_analyticsRunning` in `utils/analytics.js` |
| MFA token cleanup | 60 min | — |

Each tick is guarded by a module-level `busy` flag so overlapping invocations of
the same tick do not stack up. Ticks that encounter no work return immediately.

## Deployment Topology

Bartelby supports two runtime shapes:

- **Single-process app role** — one `node server.js` process serves HTTP and
  runs the worker loop. This is the simplest option for local development and
  small installs.
- **Split web/worker roles** — web instances run with
  `DISABLE_BACKGROUND_WORKER=1`, while worker instances run the same image
  without that flag. This is the preferred production topology when background
  work can affect page responsiveness.

Because job state is stored durably in the database, split roles work across
Fly, Docker Compose, and other container schedulers without introducing a
separate queue service.

Worker images must have `pdftoppm` (poppler-utils) installed; the PDF render job throws at boot in production if it is absent (see `DEPLOY.md` § Worker runtime requirements).

Fly Machine PDF render jobs send heartbeat updates from the standalone worker
and treat render progress as liveness. During the long `pdftoppm` rasterization
step, the worker polls the generated PNG files in its temp directory and updates
`import_jobs.pages_rendered` so the admin Jobs UI can show that image rendering
is still moving before the final page assets are uploaded. The same nonblocking
progress polling is required for the extraction-first `pdfimages` path, because
large embedded-image PDFs can otherwise spend several minutes inside Poppler
without yielding back to the worker heartbeat interval.

For batch finalization, the in-memory poller flags are not enough on their own
because Fly can briefly run overlapping app processes during deployments or
machine handoff. Completed transcription and extraction batches are therefore
claimed durably in their job tables using
`batch_finalization_claimed_at` / `batch_finalization_claimed_by` before any
documents are materialized. The claim owner must be unique per app instance,
not just per PID, because containerized web and worker roles often both run as
PID 1. Only the process that wins that claim may finalize the batch, and
startup recovery only clears claims that are older than the configured stale
window.

---

## Analytics Scheduler

The analytics sweep runs on a 15-minute polling interval in `utils/worker.js`.
Whether a collection _actually_ runs is determined by `shouldRunAnalytics()` in
`utils/analytics.js`, which checks:

1. `analytics_enabled` setting is `'1'`.
2. The collection has at least one document.
3. Either: document count has grown by more than the configured threshold
   (default 10%) since the last run, **or** the scheduled calendar boundary has
   elapsed (daily / weekly / monthly).

### Concurrency Lock

Analytics use a two-layer lock:

1. `_analyticsRunning`, a **module-level boolean** in `utils/analytics.js`, to
   prevent duplicate sweeps inside one process.
2. A durable lease in `worker_leases` so only one app instance can own the
   global sweep, and only one app instance can run analytics for a given
   collection at a time.

Both of these call sites share that logic:

- The `setInterval` timer in `utils/worker.js`
- The admin "Run All" route (`POST /admin/analytics-settings/run-all`)

This prevents a double-click, concurrent admin session, or second container from
triggering overlapping sweeps that could cause `SQLITE_BUSY` locking or spawn
multiple BERTopic dispatches for the same collection.

### Two-Phase Run

Each `runAnalyticsForCollection(collectionId)` call is two-phased:

1. **Stats snapshot** — `computeCollectionStats()` runs SQL queries to aggregate
   document counts, transcribed counts, storage bytes, confidence averages, etc.
   The result is immediately written to `collection_analytics` via
   `collectionAnalyticsAsync.upsert()`.

2. **BERTopic dispatch** — if `transcribed_count >= 5`, BERTopic is dispatched via
   `dispatchBertopicAnalysis()`. The dispatch path chosen depends on config:

   | Condition | Path |
   |-----------|------|
   | `FLY_MACHINES_ENABLED=true` AND `STORAGE_DRIVER=s3` | Ephemeral Fly Machine (high-RAM VM) |
   | Otherwise | Detached local Node child (`utils/bertopic-worker.js`) |

   The Fly Machine path uses the `runEphemeralBertopicWorker()` helper in
   `utils/fly-machines.js`. The local path spawns a detached child that exchanges
   data with the parent via a pair of temp JSON files in `os.tmpdir()`.

### Embedding Reuse

Existing document embeddings are loaded from `document_embeddings` and passed to
the Python BERTopic script as `existing_embeddings`. The script only recomputes
embeddings for documents missing from this map, significantly reducing API/compute
costs on incremental runs.

---

## Graceful Shutdown and Stale Job Recovery

When the app receives `SIGTERM` (Fly.io deploy, scale-down), `server.close()`
drains in-flight HTTP requests and then calls `flushDatabase()` in
`database/db.js`. Unlike the normal `saveDatabase()` debounced write,
`flushDatabase()` bypasses the 300 ms timer and calls `db.persist()` immediately.

On the next startup, `initializeSchema()` identifies stale jobs:

- **`import_jobs` (render, `processing`, no `machine_id`)** → marked `failed`
- **`import_jobs` (submit, `running`)** → marked `failed`
- **`import_jobs` (grouping, `processing`, no `batch_remote_id`)** → marked `failed`
- **`transcription_jobs` (`running`, not a batch)** → marked `failed`
- **`transcription_jobs` (`running`, batch finalization claimed)** → claim cleared so finalization can resume
- **`extraction_jobs` (`running`, batch finalization claimed)** → claim cleared so finalization can resume
- **`extraction_jobs` (`running`, not a batch)** → marked `failed`
- **`authority_resolution_jobs` (`running`)** → marked `failed`
- **`authority_suggestion_jobs` (`running`)** → marked `failed`
- **`title_backfill_jobs` (`running`)** → marked `failed`
- **`sentiment_extraction_jobs` (singleton, `running`)** → marked `failed` with `error = 'Server restarted during processing'`
- **`sentiment_extraction_jobs` (batch, `batch_submitted`, finalization claim stale)** → claim cleared. The
  claim itself is re-claimable by the same owner, or by any worker after
  `SENTIMENT_BATCH_FINALIZATION_STALE_SECONDS`, and is released immediately when a
  result fetch fails — so a transient provider error can no longer wedge a batch
  until the next restart.
- **`sentiment_extraction_jobs` (batch, `running`, finalization claimed)** → marked `failed`, claim columns nulled, `error = 'Server restarted during batch finalization'`. Note: `batch_submitted` rows are intentionally untouched — provider still owns them; `pollRunningSentimentBatchesTick` resumes them on next tick.
- **`sentiment_extraction_jobs` (batch, `running`, `batch_remote_id LIKE 'pending-%'`)** → marked `failed` with the correlation id logged in the error message. Indicates a crash during batch submission; the provider may have an orphaned batch. The Phase 1.6a reconciliation tick (see below) recovers these inside the grace window before this backstop fires.
- **`sentiment_extraction_jobs` (batch, `running`, `batch_remote_id IS NULL`)** → marked `failed`. Indicates a crash before the pre-stage write; no provider call was made.
- **`transcription_jobs` / `extraction_jobs` (batch, `running`, `batch_remote_id LIKE 'pending%'`, older than the stale window)** → marked `failed` with the submission sentinel in the error message. Indicates a crash during batch submission; the provider may hold an orphaned batch — recover manually from the provider console. Fresh `pending%` rows are left alone (a live worker may be mid-submission). Batch submission errors are never auto-requeued; retry is admin-triggered from `/admin/jobs`.
- **Fly Machine import jobs** with expired heartbeats → re-queued
- **`iiif_sources` (`running`, `machine_id IS NULL`)** → **re-queued** (not
  failed): the `iiif_imported_manifests` ledger makes the re-crawl idempotent,
  so resuming from `cursor` is safe and preferable to a manual admin retry. A
  future Fly-machine crawl (`machine_id` set) is instead recovered by the
  heartbeat sweeper (`iiifSourcesAsync.requeueStaleJobs`).

`initializeSchema(options)` accepts `{ runStaleJobRecovery: false }` to skip
the recovery sweeps above and only run migrations + FTS5 setup. Ephemeral
single-purpose processes (e.g. the standalone PDF render worker in
`utils/pdf-worker.js`) MUST opt out, because their startup window can race a
main worker that has just claimed an unrelated job. Without the opt-out,
the grouping recovery sweep marks any in-flight grouping submission
(`processing`, no `batch_remote_id`) as failed, even when a live worker is
still uploading its inputs.

### Sentiment provider batch reconciliation (Phase 1.6a)

The `pending-<uuid>` correlation placeholder is written to
`sentiment_extraction_jobs.batch_remote_id` by `markBatchPending` before
the provider call lands. The orphan window — where the worker crashes
between placeholder-write and the real `batch_remote_id` flip — is:

- `status = 'running'` AND `kind = 'batch'`
- `batch_remote_id LIKE 'pending-%'`

Two layers cover this scenario:

1. **`tickSentimentReconciliation`** (every 10 min by default, env
   `SENTIMENT_RECONCILIATION_INTERVAL_MS`): lists provider-side batches
   inside a windowed range (env `SENTIMENT_RECONCILIATION_LIST_WINDOW_HOURS`,
   default 24h), matches by per-provider correlation token, and atomically
   flips matched rows to the real `batch_remote_id` (and `status =
   'batch_submitted'`). The existing `pollRunningSentimentBatches` then
   finalizes via `fetchSentimentBatchResults`. The admin button at
   `/admin/jobs` runs the same cycle on demand.
2. **Stale-claim recovery in `initializeSchema()`** (backstop, runs
   once per server startup): after
   `SENTIMENT_BATCH_FINALIZATION_STALE_SECONDS` (default 30 min),
   pending rows are marked `failed` with the correlation id surfaced
   in the error message for manual operator recovery.

Running **batch** transcription/extraction jobs can be manually failed from
`/admin/jobs` ("Mark failed") as the operator escape hatch for wedged batches;
the action is audit-logged as `admin.job_force_failed`.

`markBatchPending` sets `provider` on the row at placeholder-write time
so the reconciliation tick can route to the correct provider API
without needing to guess.

---

## Authority suggestion failure visibility & retry (added 2026-06-05 per A1)

`authority_suggestion_jobs` now appear as a first-class type in
`/admin/jobs`. Failed rows render the full provider/runtime error
inline (not truncated), with a Retry button. Retry semantics differ
from other job types: it creates a *new* queued row mirroring the
failed job's scope and thresholds; the failed row is preserved as the
audit trail. Retry is idempotent — if a queued/running job already
covers the same scope, the API returns `{success:true, alreadyQueued:true}`
without enqueuing a duplicate.

Backfill is triggered per-collection from `/admin/knowledge/authorities/backfill`,
which orders collections by `sentiment_enabled DESC, name ASC` and shows
an entity-count preview before the operator clicks. The per-row submit
reuses the existing idempotent `POST /admin/knowledge/authorities/suggestion-jobs/collection/:id`
endpoint, preserving "One Canonical Backend Path per Workflow"
([docs/development-principles.md](./development-principles.md)).

Per the standing project rule, no automatic retries are scheduled —
all retries are admin-triggered.

## Title & summary backfill (added 2026-07-11)

Triggered per-collection from the admin collection card ("Backfill
titles", next to "Backfill sentiment"). One `title_backfill_jobs` row per
run; the worker iterates the collection's best transcripts and calls the
shared `regenerateDocumentMetadata` helper in
`utils/transcription-pipeline.js` — the same logic transcription
finalization uses, so a title is regenerated only when the current one is
generic and a summary only when `description` is empty. Re-runs are
therefore idempotent and skip already-fixed documents without LLM calls.
Provider comes from the `default_provider` setting; the job fails fast
with the setting name when it is unset. Per-document failures are counted
and summarized in `error` (the per-document detail is in the job log);
retry creates a new queued row, preserving the failed row as the audit
trail. See docs/superpowers/specs/2026-07-11-title-backfill-design.md.

---

## Adding a New Worker Task

1. **Create the job table** — add a migration in `database/db.js` with status
   columns: `queued | running | done | failed`, plus `created_at`, `started_at`,
   `completed_at`, `error`.

2. **Add model helpers** in the appropriate `database/models/*.js` file:
   `claimNext()`, `markRunning()`, `markDone()`, `markFailed()`.

3. **Write the worker cycle** — create `utils/worker-<domain>.js` with a
   `runWorkerCycle()` function following the existing pattern:
   claim one job, process it, mark done/failed, return.

4. **Register the interval** in `utils/worker.js`:
   ```js
   let myDomainBusy = false;
   setInterval(async () => {
     if (myDomainBusy) return;
     myDomainBusy = true;
     try { await runMyDomainWorkerCycle(); }
     catch (err) { console.error('[worker] my domain cycle failed:', describeError(err)); }
     finally { myDomainBusy = false; }
   }, 5000);
   ```
   Log worker failures with `describeError(err)` from `utils/error-detail.js`,
   not `err.message`. For a database error it adds the statement that failed
   (SQL text only, never bound values; the Turso driver attaches it as
   `err.dbStatement`) and the underlying network cause, such as `ECONNRESET`.
   Without them a dropped request logs only `socket hang up`, with nothing to
   say which query or connection failed. Keep `err.message` for the text
   stored with a job (`markFailed`, job logs), which the admin Jobs UI shows.

5. **Add stale-job recovery** in `initializeSchema()` in `database/db.js` so
   jobs interrupted by a restart are not stuck in `running` forever.

6. **Update this document** with the new job family.
