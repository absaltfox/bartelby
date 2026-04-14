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
