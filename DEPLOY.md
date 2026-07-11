# Deploying Bartelby to Fly.io + Turso + Cloudflare R2

This guide walks through deploying the full production stack:

- **Fly.io** — runs the Docker container (app + background worker)
- **Turso** — managed SQLite database (libsql)
- **Cloudflare R2** — S3-compatible object storage for document images

Estimated monthly cost for light usage: **$0–5** (all three services have generous free tiers).

---

## Prerequisites

- Node.js 25.9.0 installed locally (or another `25.x` runtime that satisfies
  the repo's engine check)
- A working local Bartelby instance with data in `data/transcriber.db` and files in `data/uploads/`

Install the CLIs:

```bash
# Fly.io
curl -L https://fly.io/install.sh | sh
fly auth login

# Turso
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
```

You'll also need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free).

---

## Step 1: Create the Turso Database

```bash
# Create a database (pick a region close to your Fly.io app)
turso db create bartelby --group default

# Get the connection URL
turso db show bartelby --url
# → libsql://bartelby-<your-org>.turso.io

# Create an auth token
turso db tokens create bartelby
# → Save this token — you'll need it for Fly.io secrets
```

### Migrate your local data to Turso

```bash
cd /path/to/transcriber

TURSO_DATABASE_URL=libsql://bartelby-<your-org>.turso.io \
TURSO_AUTH_TOKEN=<your-token> \
node scripts/migrate-to-turso.js
```

Run with `--dry-run` first to preview what will be migrated. The script:
1. Reads your local `data/transcriber.db`
2. Applies all schema migrations to the Turso database
3. Copies every row from every table

### Verify the migration

```bash
turso db shell bartelby
> SELECT COUNT(*) FROM documents;
> SELECT COUNT(*) FROM users;
> .quit
```

---

## Step 2: Create the Cloudflare R2 Bucket

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **R2 Object Storage**
2. Click **Create bucket**, name it `bartelby`
3. Go to **R2** → **Manage R2 API Tokens** → **Create API Token**
   - Permissions: **Object Read & Write**
   - Scope: **Apply to specific bucket** → `bartelby`
4. Save the **Access Key ID** and **Secret Access Key**
5. Note your **Account ID** from the R2 dashboard URL (or the R2 settings page)

Your S3 endpoint will be: `https://<account-id>.r2.cloudflarestorage.com`

### Migrate your local uploads to R2

```bash
S3_BUCKET=bartelby \
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
S3_ACCESS_KEY_ID=<your-r2-access-key> \
S3_SECRET_ACCESS_KEY=<your-r2-secret-key> \
S3_REGION=auto \
node scripts/migrate-uploads-to-s3.js
```

Run with `--dry-run` first to see what will be uploaded. Use `--verbose` for per-file output.

The script uploads files from `data/uploads/` and also falls back to legacy `public/uploads/` if present. It writes to the `uploads/` prefix in R2 and skips files that already exist, so it's safe to re-run.

---

## Step 3: Deploy to Fly.io

### Create the Fly.io app

```bash
cd /path/to/transcriber

# Launch — this creates fly.toml but does NOT deploy yet
fly launch --no-deploy
```

When prompted:
- Choose a name (e.g. `bartelby`) or accept the default
- Pick a region close to your Turso database
- Say **No** to Postgres and Redis — we use Turso and R2

### Configure fly.toml

Replace the generated `fly.toml` with:

```toml
app = "bartelby"  # ← your app name from fly launch
primary_region = "iad"  # ← your chosen region

[build]

[env]
  NODE_ENV = "production"
  PORT = "3000"
  DATABASE_DRIVER = "turso"
  STORAGE_DRIVER = "s3"
  S3_REGION = "auto"
  S3_FORCE_PATH_STYLE = "false"
  S3_MAX_SOCKETS = "64"
  # Optional: bypass the app's /uploads proxy for already-authorized image
  # thumbnails by rendering short-lived S3-compatible signed URLs.
  # S3_PRESIGNED_GET_TTL_SECONDS = "300"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    hard_limit = 64
    soft_limit = 48

[[vm]]
  memory = "2gb"
  cpu_kind = "shared"
  cpus = 2
  processes = ['web']

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
  processes = ['worker']
```

Setting `min_machines_running = 1` keeps the app always on (required for the background transcription worker). The free allowance covers one always-on machine.

`S3_MAX_SOCKETS` controls the AWS SDK HTTP connection pool used for R2/S3
traffic. Keep the web role's request concurrency near that value so upload
proxying and background storage operations do not build a large queue inside
`@smithy/node-http-handler`. If Fly logs show socket-capacity warnings, first
lower the web concurrency or scale out, then raise `S3_MAX_SOCKETS` only if the
VM has enough CPU and memory headroom.

`S3_PRESIGNED_GET_TTL_SECONDS` is disabled by default. Set it to a short value
such as `300` to render already-authorized collection thumbnails and document
preview images as short-lived S3-compatible signed URLs. This keeps the
permission decision in Bartelby while reducing Fly and S3 proxy work during
image-heavy collection browsing. Non-image uploads and fallback paths continue
through `/uploads/:filename`.

### Set secrets

```bash
# Generate random secrets
SESSION_SECRET=$(openssl rand -base64 32)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)

fly secrets set \
  SESSION_SECRET="$SESSION_SECRET" \
  DATA_ENCRYPTION_KEY="$DATA_ENCRYPTION_KEY" \
  FLY_API_TOKEN="$(fly tokens create deploy -x 999999h)" \
  TURSO_DATABASE_URL="libsql://bartelby-<your-org>.turso.io" \
  TURSO_AUTH_TOKEN="<your-turso-token>" \
  S3_BUCKET="bartelby" \
  S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY_ID="<your-r2-access-key>" \
  S3_SECRET_ACCESS_KEY="<your-r2-secret-key>"
```

> **Important:** If you already have LLM provider keys configured in Bartelby's admin settings (stored encrypted in the database), those will carry over from the Turso migration. You don't need to set `OPENAI_API_KEY` etc. as Fly secrets unless you want fallback env-level keys.
>
> **Important:** `FLY_API_TOKEN` is required for the app to launch ephemeral Fly Machines for large PDF imports and BERTopic jobs. `FLY_APP_NAME` and `FLY_IMAGE_REF` are provided by Fly at runtime.
>
> **Important:** Production now fails closed for non-durable local defaults. `SESSION_STORE=memory` and `STORAGE_DRIVER=local` are rejected unless you set `ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION=1` or `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=1`. Those overrides are intended only for deliberate single-node deployments.
>
> **Important:** Set `PUBLIC_APP_URL` in production. Invite links, password-reset links, and other absolute URLs now fail fast at boot if this value is missing.
> Bartelby also uses `PUBLIC_APP_URL` as the canonical production host. Requests
> for other hosts, including the default `*.fly.dev` hostname, are redirected to
> this URL before sessions, database reads, or upload proxy work. If you need to
> accept another hostname temporarily, set `PUBLIC_ALLOWED_HOSTS` to a
> comma-separated list such as `www.bartelby.ca`.
>
> **Important:** Production now assumes Bartelby is running behind a trusted
> proxy or TLS-terminating ingress. Set `TRUST_PROXY=1` on Fly (or a more
> specific non-zero proxy-addr value if your topology requires it). `0` is a
> local direct-listener setting, not a supported production value.

### Deploy

```bash
fly deploy
```

This builds the Docker image on Fly's builders and deploys it. First deploy takes 2–3 minutes.

### Verify

```bash
# Check app status
fly status

# View logs
fly logs

# Open in browser
fly open
```

---

## Step 4: Custom Domain (Optional)

```bash
# Add your domain
fly certs add transcriber.yourdomain.com

# It will show you DNS records to add. Create a CNAME:
# transcriber.yourdomain.com → bartelby.fly.dev
```

After DNS propagates (usually minutes), Fly auto-provisions a TLS certificate.

If using Cloudflare DNS for your domain, set the proxy status to **DNS only** (grey cloud) so Fly handles TLS.

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Browser    │────▶│  Web Role        │────▶│  Turso (libsql)  │
│              │◀────│  Express + EJS   │◀────│  SQLite on edge  │
└─────────────┘     └──────────────────┘     └──────────────────┘
                             ▲
                             │
                    ┌──────────────────┐     ┌──────────────────┐
                    │  Worker Role     │────▶│  Cloudflare R2   │
                    │  BG polling loop │◀────│  S3-compatible   │
                    └──────────────────┘     └──────────────────┘
```

- Bartelby can run as a single `node server.js` process, but the preferred
  production topology is to use separate web and worker roles from the same
  image.
- Web roles should run with `DISABLE_BACKGROUND_WORKER=1`.
- Worker roles should run the same image without that flag so `startWorker()`
  is enabled.
- **Turso** stores all application data (documents, transcripts, users, settings, jobs)
- **R2** stores uploaded document images, served back through the app's `/uploads/:filename` proxy route

---

## Cost Breakdown

| Service | Free Tier | What You Use | Likely Cost |
|---------|-----------|-------------|-------------|
| **Fly.io** | 3 shared-cpu VMs, 256MB each | 1 shared-cpu VM, 512MB | $0 (within free) or ~$3.19/mo |
| **Turso** | 9GB storage, 500 databases | 1 database, <100MB | $0 |
| **Cloudflare R2** | 10GB storage, 10M reads/mo | ~1GB storage, light reads | $0 |

Fly.io has a **hard spending limit** you can set in the dashboard under Billing → set to $5 or $10 to prevent any surprise charges.

---

## Operations

### Production topologies

#### Simple single-process deployment

- Run one `node server.js` container.
- Keep `DISABLE_BACKGROUND_WORKER` unset.
- This is fine for smaller installs and the easiest way to get started.

#### Split web/worker deployment

- Run at least one **web** container with `DISABLE_BACKGROUND_WORKER=1`.
- Run at least one **worker** container from the same image with
  `DISABLE_BACKGROUND_WORKER` unset.
- Route public HTTP traffic only to the web role.
- This is the preferred production topology when extraction, import, or
  analytics work can affect page responsiveness.

On Fly specifically, this maps naturally to separate process groups. On Docker
Compose or other schedulers, it maps to separate services using the same image.
The checked-in [fly.toml](/Users/mleblanc/Documents/code/transcriber/fly.toml)
defines `web` and `worker` process groups, routes `http_service` traffic only
to `web`, and relies on `FLY_PROCESS_GROUP=web` to keep the web role from
starting the in-process worker loop.

To ensure Fly is actually running one machine for each role:

```bash
fly scale count web=1 worker=1
```

For image-heavy or bursty production traffic, the current recommended baseline
is two web machines and two worker machines in the primary region:

```bash
fly scale count web=2 worker=2
fly scale vm shared-cpu-2x --group web
fly scale memory 2048 --group web
```

Worker sizing can remain at `shared-cpu-1x` / `1024MB` unless import,
extraction, or analytics logs show sustained worker pressure.

### Cloudflare front door

For public deployments, put the custom domain behind Cloudflare's proxy
("orange cloud") rather than exposing all automated traffic directly to Fly.
Use Full (strict) TLS, keep the Fly ownership TXT record in DNS, and configure:

- Cloudflare managed WAF rules
- bot/security level rules for anonymous traffic
- rate limits for `GET /`, `GET /collections*`, and `GET /uploads/*`
- stronger challenges or blocks for scanner paths such as `.env`, `wp-login.php`,
  `xmlrpc.php`, `.git`, and `phpmyadmin`

Bartelby's Express rate limits are a second line of defense. Cloudflare should
absorb the obvious automated traffic before it can consume Fly CPU, Turso query
round trips, or S3-compatible object reads.

Set the canonical host once Cloudflare and Fly certificates are working:

```bash
fly secrets set PUBLIC_APP_URL="https://bartelby.ca" --app bartelby
```

Leave `PUBLIC_ALLOWED_HOSTS` unset unless another hostname should reach the app
without being redirected to the canonical URL.

### Viewing logs

```bash
fly logs                    # Live tail
fly logs --app bartelby     # If you have multiple apps
```

### SSH into the container

```bash
fly ssh console
```

### Scaling

```bash
# Increase memory if processing large PDFs
fly scale memory 1024

# Add more CPU
fly scale vm shared-cpu-2x
```

### Pre-deploy checks

- Run `npm test` (which invokes `npm run test:hygiene` first) and confirm a
  clean pass before promoting a build.
- Run `npm audit --omit=dev` and triage any new high/critical advisory
  before release. A production-only audit gate inside `test:hygiene` is
  planned but blocked on the pdfjs-dist upgrade, which clears the
  residual `tar` chain. See "Known open advisories" below for current
  baseline and mitigations.

### Known open advisories

`npm audit --omit=dev` currently reports **4 high, 0 critical** (plus
3 low). None of them are practically exploitable in the current
production configuration; each has a documented mitigation. Reviewers
checking the audit output before a release should expect this baseline
and not treat it as a release blocker.

- **`nodemailer` (high, GHSA-p6gq-j5cr-w38f — `raw` option bypasses
  disableFileAccess/disableUrlAccess).** Reachable only when the
  message-level `raw` option is passed to `sendMail`. The only call
  site, [`utils/email.js`](./utils/email.js), sends a fixed
  `{from, to, subject, text}` shape with no caller-controlled message
  options, so the vulnerable path never runs. The fix is a breaking
  major (9.x); upgrade tracked as a follow-up.

- **`pdfjs-dist` (high, GHSA-wgrm-67xf-hhpq — malicious-PDF JS exec).**
  Reachable only through the dev-only `renderWithPdfjs` fallback in
  [`utils/pdf-worker.js`](./utils/pdf-worker.js). Production workers
  fail at module load if `pdftoppm` is absent (see "Worker runtime
  requirements" below), so the fallback path never runs in production.
  The fallback also passes `isEvalSupported: false`,
  `disableFontFace: true`, and `useSystemFonts: false` to neutralise
  the documented exploitation path even when it does run in dev.
  Upgrading past `pdfjs-dist@3.11.174` requires investigating a prior
  4.x rendering regression and is tracked as a follow-up.

- **`tar` (high, six advisories) via `@mapbox/node-pre-gyp`.**
  Reached only at `npm install` time through the `canvas` →
  `@mapbox/node-pre-gyp` → `tar` chain. The vulnerable code paths
  involve extracting attacker-controlled tarballs, which the
  application never does at runtime; only npm itself extracts the
  pinned, integrity-checked dependency tarballs at install. This
  chain clears automatically once `pdfjs-dist` (which pulls in
  `canvas`) is upgraded.

Pre-merge work on this baseline:

- Closed `protobufjs <7.5.5` (critical, GHSA-xq3m-2v4x-88gg, four
  advisories) by migrating from `@xenova/transformers` 2.x to
  `@huggingface/transformers` 3.8.1, whose `onnxruntime-web` no
  longer pulls `onnx-proto`/`protobufjs`. See
  [`utils/worker-authority-suggestion.js`](./utils/worker-authority-suggestion.js).
- Closed `fast-xml-parser` (moderate) via non-breaking
  `npm audit fix`.
- Closed `fast-xml-builder` (high) through the AWS SDK XML builder chain and
  `ip-address` (moderate) through `express-rate-limit` via non-breaking
  `npm audit fix`.
- Removed the unused legacy `utils/pdf.js` helper so the only remaining
  `pdfjs-dist` rendering fallback is the hardened, development-only path in
  `utils/pdf-worker.js`.

### Worker runtime requirements

- `pdftoppm` (from `poppler-utils`) MUST be present on every worker image.
  The PDF rendering job aborts at boot in production if it is missing,
  because the pdfjs-dist fallback is vulnerable to malicious-PDF JS
  execution (GHSA-wgrm-67xf-hhpq). The provided `Dockerfile` installs
  `poppler-utils`; verify this if you maintain a fork of the image.

### Updating

```bash
# Pull latest code, then:
fly deploy
```

### Restarting

```bash
fly apps restart bartelby
```

### Database shell

```bash
turso db shell bartelby
```

### Foreign keys on Turso

The schema relies on SQLite foreign-key ACTIONS (`ON DELETE SET NULL` on
sentiment-annotation entity references; `ON DELETE CASCADE` on several job
tables). Local drivers enable `PRAGMA foreign_keys` per connection, but
Turso's HTTP protocol is stateless per statement, so enforcement on the
hosted service must be verified, not assumed:

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/verify-turso-fk.js
```

Run this once per Turso database (and after libsql client upgrades). If it
prints `FAIL`, entity deletions will leave dangling references in
production that local development never exhibits — treat that as a blocker
and open an issue to make the affected cleanup explicit at the app layer.
Record the result (PASS/FAIL + date) here when run.

**Result: PASS — 2026-07-09.** Run on a production worker machine via
`fly ssh console` (probe staged to `/tmp`, `NODE_PATH=/app/node_modules`);
`ON DELETE SET NULL` fired and the probe exited 0.

---

## Rollback

If something goes wrong after deploy:

```bash
# List recent deployments
fly releases

# Roll back to a previous release
fly deploy --image registry.fly.io/bartelby:deployment-<id>
```

---

## Troubleshooting

**App won't start / crashes immediately**
```bash
fly logs  # Check for missing env vars or connection errors
fly secrets list  # Verify all secrets are set
```

**"TURSO_DATABASE_URL is required"**
The `DATABASE_DRIVER=turso` env var is set but the URL secret is missing. Run `fly secrets set TURSO_DATABASE_URL=...`.

**Uploads not loading**
Check that `STORAGE_DRIVER=s3` is set and all S3 secrets are configured. The app proxies S3 files through its own `/uploads/` route, so R2 doesn't need to be publicly accessible.

**Background worker not running**
If you are using the single-process topology, ensure the app machine stays up.
If you are using split web/worker roles, verify the worker role is running and
that `DISABLE_BACKGROUND_WORKER` is only set on the web role.

**Machine keeps stopping**
Fly's auto-stop only stops machines with no active HTTP connections. A separate
worker role does not receive HTTP traffic, so do not rely on the web service's
request-based keepalive semantics for it. Keep at least one worker alive if
jobs must continue processing continuously.
