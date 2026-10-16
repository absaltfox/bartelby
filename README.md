# Bartelby

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)

Transcribe, organize and explore historical documents, with an evidence-linked knowledge graph.

Bartelby is a self-hosted web application for people who work with primary sources. The process works like this:

1) You can upload scans of letters, ledgers, diaries and other documents.
2) A vision-capable language model drafts a transcript
3) You or another curator corrects it, annotates it, and approves the people, places, dates and relationships extracted from it.

Every entity and relationship stays linked to the passage it came from, so a researcher can always get from a claim back to the page. Note that entity extraction is under active development, and its efficacy can vary from document to document

Bartelby is built for historians, archivists and small research teams who need to share and work from a common set of transcribed historical documents. Importantly, Bartelby offers flexibility and transparency and aims to be model-agnostic. In addition to native API support for Claude, ChatGPT, and Gemini, it supports access to local models hosted in Ollama and LM Studio. 

The intention is to provide users of the tool with maximum control over, to the extent possible, over an AI-assisted transcription process. 


## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
  - [Dependencies](#dependencies)
  - [Run with Docker](#run-with-docker)
  - [Run from source](#run-from-source)
  - [Updating](#updating)
- [Usage](#usage)
  - [First run](#first-run)
  - [A typical workflow](#a-typical-workflow)
  - [Roles](#roles)
  - [CLI](#cli)
- [Configuration](#configuration)
  - [Required settings](#required-settings)
  - [Database](#database)
  - [Upload storage](#upload-storage)
  - [Sessions and proxies](#sessions-and-proxies)
  - [Model providers](#model-providers)
  - [Email](#email)
- [Operation](#operation)
  - [Background jobs](#background-jobs)
  - [Health, logs and backups](#health-logs-and-backups)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Documentation](#documentation)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

Report vulnerabilities privately, as described in [SECURITY.md](./SECURITY.md),
not in a public issue.

Things to know before you put an instance on a network:

- **Documents and transcripts are sent to the model provider you configure.**
  Use a local provider (Ollama, LM Studio) if your material cannot leave your
  machine.
- **`docker-compose.yml` is for one machine, not for the internet.** It serves
  plain http, keeps sessions in memory and sets
  `ALLOW_INSECURE_HTTP_IN_PRODUCTION=1`, which stops marking cookies `Secure`.
  For anything reachable by others, follow [DEPLOY.md](./DEPLOY.md): TLS in
  front, `TRUST_PROXY=1`, an `https` `PUBLIC_APP_URL`, Redis sessions.
- **Production fails closed.** With `NODE_ENV=production` the app refuses to
  start on in-memory sessions, local upload storage, a missing
  `PUBLIC_APP_URL` or an untrusted proxy unless you set the matching explicit
  override.
- **Keep `DATA_ENCRYPTION_KEY` safe and stable.** Provider API keys saved in the
  admin UI are encrypted with it; if it changes, they can no longer be read.
- **Remove `BOOTSTRAP_ADMIN_TOKEN` after creating the first administrator.**

Accounts support email or authenticator-app MFA, sign-in throttling, and
collection-scoped access control. State-changing requests are CSRF-protected.

## Background

Large collections of historical documents can be difficult to use when the information they contain is locked in page images. Transcription makes the text searchable, but the research value can be in the connections: places, names, artifacts, and institutions named in a document. Sentiment can offer another facet for discovery, by indicating polarity between two items in a document (negative, positive, neutral). 

Bartelby treats that as a curation problem with machine assistance:

- **Transcription** by a vision-capable model, one document or a provider batch
  at a time, with the provider, model and prompt recorded as provenance.
- **Knowledge graph extraction** of entities, aliases, dates and relationships,
  each with a citation into the transcript. Nothing is authoritative until a
  curator approves it, and curators can author, correct, merge and split
  entities themselves.
- **Authority records** that reconcile name variants ("Wm. Smith", "William
  Smith") onto one identity.
- **Sentiment annotation** of how people and things are written about, also
  citation-backed and reviewable.
- **Export** to PDF and TEI.

It is a Node.js and Express application with server-rendered EJS pages, a
SQLite-compatible database (a local file, or [Turso](https://turso.tech)), and
local or S3-compatible upload storage. Topic modelling runs in Python. Long
work runs as database-backed jobs, as do scheduled jobs.
[docs/architecture.md](./docs/architecture.md) describes the subsystems, and
[docs/development-principles.md](./docs/development-principles.md) the rules
the project holds itself to.

## Install

### Dependencies

For Docker: Docker with Compose v2.

From source:

- [Node.js](https://nodejs.org) 25.9 (`>=25.9.0 <26`; the repo has an `.nvmrc`)
- Python 3 with `venv`, only for collection topic analysis
- [Poppler](https://poppler.freedesktop.org) (`pdftoppm`) for fast PDF page
  rendering; without it the app falls back to a slower built-in renderer
- A C/C++ toolchain plus Cairo, Pango, libjpeg, giflib, librsvg and pixman if
  `npm install` has to compile `canvas` for your platform

You also need access to at least one model provider to transcribe anything; see
[Model providers](#model-providers).

### Run with Docker

The quickest way to try Bartelby on your own machine.

```bash
git clone https://github.com/absaltfox/bartelby.git
cd bartelby

cat > .env <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
BOOTSTRAP_ADMIN_TOKEN=$(openssl rand -hex 16)
EOF

docker compose up -d --build
```

The first build takes several minutes because it installs the Python analytics
stack. Then open <http://localhost:3000/setup> and continue with
[First run](#first-run).

This starts one container that serves the site and runs background work, with
the database and uploads on Docker volumes. Read [Security](#security) before
exposing it to anyone else.

### Run from source

```bash
git clone https://github.com/absaltfox/bartelby.git
cd bartelby
nvm use                 # or install Node 25.9 another way
npm install
cp .env.example .env    # then set the three values below
npm run setup:python    # optional: topic analysis
npm start
```

In `.env`, replace the placeholders for `SESSION_SECRET`,
`DATA_ENCRYPTION_KEY` (at least 32 characters) and `BOOTSTRAP_ADMIN_TOKEN`;
`openssl rand -hex 32` generates a suitable value. The app listens on
<http://localhost:3000> and keeps its data in `data/`.

### Updating

Schema migrations run automatically at startup. Back up first (see
[Health, logs and backups](#health-logs-and-backups)).

```bash
git pull
docker compose up -d --build     # Docker
npm ci && npm start              # from source
```

## Usage

### First run

1. Open `/setup`, enter the value of `BOOTSTRAP_ADMIN_TOKEN`, and create the
   administrator account.
2. Sign in, then go to **Admin → LLM Settings** and add an API key or local
   endpoint for the provider you want to use.
3. Remove `BOOTSTRAP_ADMIN_TOKEN` from the environment and restart.

### A typical workflow

1. **Create a collection** under **Manage** and decide who can see it.
2. **Import** page images or a PDF. For a PDF, group pages into documents,
   with optional AI-suggested grouping.
3. **Transcribe.** Jobs are queued and run in the background; **Admin → Jobs**
   shows progress and failures. Failed jobs are retried by you, not
   automatically.
4. **Correct and annotate** the transcript on the document page.
5. **Review extractions** under **Admin → Knowledge**: approve, edit or reject
   entities and relationships, link them to authority records, merge
   duplicates.
6. **Explore**: search, the graph explorer at `/graph`, entity pages, the
   sentiment workbench at `/sentiment`, and each collection's analytics.
7. **Export** a document to PDF or TEI.

### Roles

Viewer, editor and manager are granted per collection; administrator is a
property of the account.

| Role | Can |
|------|-----|
| Viewer | Read the collection |
| Editor | Also edit metadata and transcripts, and request AI transcription |
| Manager | Also manage the collection and import into it |
| Admin | Everything, including users, providers, jobs and the knowledge graph |

Collections can also be made public, in which case signed-out visitors can read
them. New registrations wait for an administrator's approval; administrators
can also send invitations.

### CLI

Most work happens in the browser. A few tasks have scripts:

```bash
# Transcribe a folder of images straight into the database
node utils/import.js ./scans --provider openai --dry-run

# Replace the database contents with a few sample documents.
# Destructive: deletes all existing documents, transcripts and annotations.
npm run seed

# Move a local install to hosted infrastructure (see DEPLOY.md)
npm run migrate:turso
npm run migrate:s3
```

## Configuration

Configuration is by environment variable, read from the process environment
and from `.env`. [.env.example](./.env.example) lists them with comments.
Provider keys and most application settings can also be set in the admin UI.

### Required settings

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Signs session cookies. Required in production. |
| `DATA_ENCRYPTION_KEY` | Encrypts secrets stored in the database. At least 32 characters. |
| `BOOTSTRAP_ADMIN_TOKEN` | One-time token for `/setup`. Remove it afterwards. |
| `PUBLIC_APP_URL` | Canonical URL, used in emailed links. Required in production. |
| `TRUST_PROXY` | Must be non-zero in production behind a TLS proxy. |

### Database

| Variable | Notes |
|----------|-------|
| `DATABASE_DRIVER` | `better-sqlite3` (default when installed), `sqljs`, or `turso` |
| `SQLJS_FILE_PATH` | Path of the local database file. Default `data/transcriber.db`. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Required for `turso` |

Use `better-sqlite3` for a single machine and `turso` when more than one
machine shares the database. `sqljs` keeps the whole database in memory and
rewrites the file on each save; it exists mainly for tests.

### Upload storage

| Variable | Notes |
|----------|-------|
| `STORAGE_DRIVER` | `local` (default) or `s3` |
| `UPLOADS_DIR` | Local upload directory. Default `data/uploads`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Any S3-compatible store |
| `S3_FORCE_PATH_STYLE` | `true` for stores that need path-style URLs (most self-hosted ones) |
| `S3_PRESIGNED_GET_TTL_SECONDS` | Serve authorized thumbnails by short-lived signed URL |

Uploads are served through the app so collection permissions apply; the bucket
does not need to be public.

### Sessions and proxies

| Variable | Notes |
|----------|-------|
| `SESSION_STORE` | `memory` (default) or `redis` |
| `REDIS_URL` | Required for `redis`; also shares rate-limit counters |
| `PUBLIC_ALLOWED_HOSTS` | Extra hostnames accepted without redirecting to `PUBLIC_APP_URL` |
| `DISABLE_BACKGROUND_WORKER` | `1` on web-only instances when workers run separately |
| `ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION`, `ALLOW_LOCAL_STORAGE_IN_PRODUCTION`, `ALLOW_INSECURE_HTTP_IN_PRODUCTION` | Explicit single-machine overrides of the production checks |

### Model providers

Bartelby talks to OpenAI, Anthropic, Google Gemini, Google Vertex AI, Ollama
and LM Studio. Set keys in **Admin → LLM Settings**, or with
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`OLLAMA_BASE_URL` or `LMSTUDIO_BASE_URL`. Transcription needs a model that
accepts images.

OpenAI, Anthropic, Gemini and Vertex also support batch jobs, which are slower
but cheaper for large imports. Vertex batch needs a Google Cloud project and
bucket; see [docs/local-development.md](./docs/local-development.md).

### Email

Invitations, password resets and email MFA need SMTP: `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and optionally
`SMTP_SECURE` and `SMTP_REQUIRE_TLS`. Without SMTP, an administrator can still
create invite and reset links and pass them on by hand.

## Operation

### Background jobs

Transcription, import, graph extraction, sentiment and analytics all run as
jobs stored in the database. A worker loop claims them, records progress and
logs, and can be restarted at any point. By default the worker runs inside the
web process; larger installs run separate web and worker processes from the
same image. [docs/background-jobs.md](./docs/background-jobs.md) has the model.

Jobs that fail stay failed until an administrator retries them from
**Admin → Jobs**. That is deliberate: a failure is something a curator should
see.

### Health, logs and backups

- `GET /healthz` returns `200 ok` when the process is serving.
- Logs go to standard output as JSON lines; **Admin → Logging** shows recent
  entries and sets the level.
- Back up the database and the uploads together. For a local install that is
  the `data/` directory; for Docker, the `app-data` and `app-uploads` volumes;
  for a hosted install, the Turso database and the bucket.

## Deployment

[DEPLOY.md](./DEPLOY.md) is a complete walkthrough for the reference topology:
[Fly.io](https://fly.io) for the containers, Turso for the database, and
Cloudflare R2 (or any S3-compatible store) for uploads, with Redis for
sessions. It covers single-process and split web/worker layouts, scaling,
pre-deploy checks, rollback and known dependency advisories.

Nothing is specific to Fly except optional offloading of large PDF imports and
topic models to short-lived machines. Any host that can run the `Dockerfile`
behind a TLS-terminating proxy will work, provided it sets:

```bash
NODE_ENV=production
PUBLIC_APP_URL=https://bartelby.example.org
TRUST_PROXY=1
SESSION_STORE=redis
REDIS_URL=redis://...
DATABASE_DRIVER=turso
STORAGE_DRIVER=s3
```

## Troubleshooting

**The app exits at startup in production.** The last log line names the
setting. The usual ones are a missing `PUBLIC_APP_URL`, `TRUST_PROXY` unset or
`0`, `SESSION_STORE=memory`, or `STORAGE_DRIVER=local`. Fix the setting, or for
a deliberate single-machine install set the matching `ALLOW_…_IN_PRODUCTION`
override.

**Signing in succeeds but you are sent back to the sign-in page.** The session
cookie is marked `Secure` and you are on plain http. Put TLS in front, or for a
local-only install set `ALLOW_INSECURE_HTTP_IN_PRODUCTION=1` (the compose file
already does).

**`/setup` says setup is locked.** `BOOTSTRAP_ADMIN_TOKEN` is not set. Set it
and restart. If `/setup` redirects to sign-in, an administrator already exists.

**"DATA_ENCRYPTION_KEY is too short" or stored keys cannot be decrypted.** The
key must be at least 32 characters, and must be the same one the keys were
saved under.

**Jobs stay queued.** No worker is running. Check that
`DISABLE_BACKGROUND_WORKER` is not set on your only instance, and look at
**Admin → Jobs** and the logs for worker errors.

**A transcription job failed.** Open it in **Admin → Jobs** for the provider's
error; a missing or invalid API key and a model without image input are the
common causes. Retry it from the same page.

**Topic analysis fails.** Run `npm run setup:python`, or point `PYTHON_BIN` at
an interpreter that has the packages in `requirements.txt`. The first run
downloads an embedding model.

**`npm install` fails building `canvas`.** Install the libraries listed under
[Dependencies](#dependencies), and check `node --version` is 25.9.

**"TURSO_DATABASE_URL is required."** `DATABASE_DRIVER=turso` is set without
its URL and token.

**Images do not load with S3 storage.** Check every `S3_*` value, and
`S3_FORCE_PATH_STYLE=true` if your store needs path-style URLs.

More hosted-deployment cases are in [DEPLOY.md](./DEPLOY.md#troubleshooting).

## Testing

```bash
npm test                  # hygiene check, lint, unit and integration tests
npm run test:unit
npm run test:integration
npm run test:curator-ui   # rendered-page contracts for curator screens
npm run test:ux           # Playwright browser tests
```

Tests use an in-memory database and need no provider keys.

## Documentation

- [docs/architecture.md](./docs/architecture.md): subsystems and data flow
- [docs/development-principles.md](./docs/development-principles.md): product
  and engineering decision rules
- [docs/local-development.md](./docs/local-development.md): local setup, the
  Python runtime, production environment requirements
- [docs/knowledge-graph-design.md](./docs/knowledge-graph-design.md): extraction,
  review, entities, authorities and the graph explorer
- [docs/sentiment-design.md](./docs/sentiment-design.md): sentiment annotation
- [docs/background-jobs.md](./docs/background-jobs.md): queues and workers
- [docs/db-migrations.md](./docs/db-migrations.md): schema migrations
- [docs/ui-template-standards.md](./docs/ui-template-standards.md): EJS, CSS
  and page JavaScript conventions, required reading for any UI change
- [docs/curator-ux-testing.md](./docs/curator-ux-testing.md): curator UI testing
- [DEPLOY.md](./DEPLOY.md): hosted deployment and operations
- [AGENTS.md](./AGENTS.md) and [CLAUDE.md](./CLAUDE.md): guidance for AI coding
  agents working in this repository

## Maintainers

[Michael LeBlanc (@absaltfox)](https://github.com/absaltfox)

## Contributing

Questions, bug reports and ideas are welcome as
[GitHub issues](https://github.com/absaltfox/bartelby/issues). Security
problems go through [SECURITY.md](./SECURITY.md) instead.

Pull requests are accepted. Before you start, read
[CONTRIBUTING.md](./CONTRIBUTING.md), and note two requirements:

- `npm test` must pass, and a change that alters documented behaviour updates
  the matching document in the same pull request.
- Copyright in the project is held by a single owner. Contributions are
  accepted only on the basis that you assign your copyright in them to Michael
  LeBlanc. If you cannot agree to that, open an issue describing the change
  instead of sending code.

## License

[AGPL-3.0-only](./LICENSE) © 2026 Michael LeBlanc. See
[COPYRIGHT](./COPYRIGHT) for the full notice.

Bartelby is free software, distributed without any warranty. Because this is
the Affero licence, running a modified copy as a network service means offering
its users the source of that modified copy.
