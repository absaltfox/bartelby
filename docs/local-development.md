# Local Development

For project-wide architecture, principles, and contribution workflow, also see:

- [`docs/architecture.md`](./architecture.md)
- [`docs/development-principles.md`](./development-principles.md)
- [`docs/knowledge-graph-design.md`](./knowledge-graph-design.md)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)

For UI- and template-layer changes, follow
[`docs/ui-template-standards.md`](./ui-template-standards.md). That document is
the project baseline for EJS, shared partials, CSS organization, and
presentation-layer accessibility/usability conventions.

## Python dependencies for analytics

Collection topic analysis uses the Python BERTopic stack. Install it into a
project-local virtualenv with:

```bash
npm run setup:python
```

This creates `.venv/` and installs the packages from `requirements.txt`.

The analytics runtime will automatically use `.venv/bin/python3` when that
virtualenv exists. If you need to point the app at a different interpreter,
set:

```bash
PYTHON_BIN=/absolute/path/to/python3
```

## Typical startup

```bash
npm install
npm run setup:python
npm start
```

## Vertex batch configuration

Realtime Vertex requests in Bartelby still use Vertex AI Express Mode with an
API key. Batch transcription and batch extraction now use the native Vertex
batch prediction API instead, which has different requirements:

- Google Cloud bearer-token auth available to the app, typically through
  Application Default Credentials or a service-account JSON credential
- a Google Cloud project ID
- a Vertex batch location
- a Cloud Storage bucket for staged inputs and outputs

You can configure those in Admin > LLM Settings, or via environment variables:

| Variable | Purpose |
|----------|---------|
| `VERTEX_BATCH_PROJECT_ID` | Google Cloud project for Vertex batch jobs |
| `VERTEX_BATCH_LOCATION` | Vertex batch location such as `global` or `us-central1` |
| `VERTEX_BATCH_BUCKET` | Cloud Storage bucket used for staged inputs and outputs |
| `VERTEX_BATCH_CREDENTIALS_JSON` | Optional service-account JSON for batch auth when ambient ADC is not available |
| `VERTEX_BATCH_INPUT_PREFIX` | Optional object prefix for request JSONL and uploaded page assets |
| `VERTEX_BATCH_OUTPUT_PREFIX` | Optional object prefix for Vertex batch result files |

`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are also respected as
fallbacks for project and location. `GOOGLE_APPLICATION_CREDENTIALS_JSON` is
also supported as a JSON-credential fallback.

In the admin UI, the optional Vertex batch credentials JSON is stored encrypted
in the database using the same `DATA_ENCRYPTION_KEY` mechanism as provider API
keys. This is the recommended way to configure Vertex batch auth on Fly when
ambient Google credentials are not available.

## Production environment requirements

Bartelby production now assumes the app is running behind a trusted reverse
proxy or TLS-terminating ingress. If you run with `NODE_ENV=production`, the
app will refuse to start unless the proxy-related environment is configured to
match that topology.

Two environment variables are required (not just recommended) when running with
`NODE_ENV=production`. The app will refuse to start if either is missing or
misconfigured:

| Variable | Requirement | Notes |
|----------|-------------|-------|
| `PUBLIC_APP_URL` | Must be set to the canonical app URL | Used in email links and CSRF validation |
| `TRUST_PROXY` | Must be set to a non-zero value such as `1` | Required in production because secure session cookies depend on trusted proxy headers when TLS is terminated upstream |

### Worker heartbeat

Import workers write a heartbeat timestamp every 30 seconds. The main app requeues jobs whose heartbeat has gone stale (i.e. the worker died mid-job):

| Variable | Default | Notes |
|----------|---------|-------|
| `WORKER_HEARTBEAT_TIMEOUT_MS` | `300000` (5 min) | Jobs processing longer than this without a heartbeat are requeued automatically |

## Local storage defaults

- Local uploads are stored under `data/uploads/`.
- The app still reads legacy files from `public/uploads/` when needed, but new
  local uploads should not be written there.
- Any custom storage adapter or storage test double must implement the full
  documented `utils/storage/` contract, including `streamUploadByUrl()`. The
  app now validates the configured adapter at startup instead of failing later
  on the first protected upload request.
- `docker-compose.yml` runs the app with `NODE_ENV=production`, so it sets
  `ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION=1` and
  `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=1` explicitly for that single-node Docker
  workflow.
- `TRUST_PROXY=0` is still appropriate for direct local listeners in
  non-production development. It is not a supported production setting for this
  app.
