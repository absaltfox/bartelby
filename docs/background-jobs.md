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
| Collection analytics | `worker_leases` + module-level flag in `utils/analytics.js` | `utils/worker.js` scheduled interval |

> **Note:** Analytics do not use a DB-backed job record for the outer sweep;
> `collection_analytics` rows serve as the durable output. The BERTopic sub-step
> is dispatched as either an ephemeral Fly Machine or a detached local process.

---

## Worker Loop Architecture (`utils/worker.js`)

`startWorker()` registers a set of `setInterval` ticks on startup (when
`START_WORKER=true` in config):

| Tick | Interval | Concurrency guard |
|------|----------|-------------------|
| `tick` (transcription) | 5 s | `busy` boolean |
| `tickImportSubmissionJobs` | 5 s | `importBusy` boolean |
| `tickImportRenderJobs` | 5 s | `importRenderBusy` boolean |
| `tickGroupingJobs` | 5 s | `groupingBusy` boolean |
| `tickExtractionJobs` | 5 s | `extractionBusy` boolean |
| `pollRunningBatches` (transcription) | `BATCH_POLL_MS` | `batchPollBusy` boolean |
| `pollRunningGroupingBatches` | `BATCH_POLL_MS` | `groupingBatchPollBusy` boolean |
| `pollRunningExtractionBatchesTick` | `BATCH_POLL_MS` | `extractionBatchPollBusy` boolean |
| `checkStaleImportJobs` | 60 s | — (read-only) |
| Analytics sweep | 15 min | `_analyticsRunning` in `utils/analytics.js` |
| MFA token cleanup | 60 min | — |

Each tick is guarded by a module-level `busy` flag so overlapping invocations of
the same tick do not stack up. Ticks that encounter no work return immediately.

For batch finalization, the in-memory poller flags are not enough on their own
because Fly can briefly run overlapping app processes during deployments or
machine handoff. Completed transcription and extraction batches are therefore
claimed durably in their job tables using
`batch_finalization_claimed_at` / `batch_finalization_claimed_by` before any
documents are materialized. Only the process that wins that claim may finalize
the batch.

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
- **`import_jobs` (submit, `running`)** → re-queued to `queued`
- **`transcription_jobs` (`running`, not a batch)** → marked `failed`
- **`transcription_jobs` (`running`, batch finalization claimed)** → claim cleared so finalization can resume
- **`extraction_jobs` (`running`, batch finalization claimed)** → claim cleared so finalization can resume
- **`extraction_jobs` (`running`, not a batch)** → marked `failed`
- **Fly Machine import jobs** with expired heartbeats → re-queued

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
     catch (err) { /* log */ }
     finally { myDomainBusy = false; }
   }, 5000);
   ```

5. **Add stale-job recovery** in `initializeSchema()` in `database/db.js` so
   jobs interrupted by a restart are not stuck in `running` forever.

6. **Update this document** with the new job family.
