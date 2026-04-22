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

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Setting `min_machines_running = 1` keeps the app always on (required for the background transcription worker). The free allowance covers one always-on machine.

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
│   Browser    │────▶│   Fly.io (Docker) │────▶│  Turso (libsql)  │
│              │◀────│   Express + EJS   │◀────│  SQLite on edge  │
└─────────────┘     │   + BG Worker     │     └──────────────────┘
                    │                    │
                    │                    │────▶┌──────────────────┐
                    │                    │◀────│  Cloudflare R2   │
                    └──────────────────┘     │  S3-compatible   │
                                              └──────────────────┘
```

- **Fly.io** runs the single `node server.js` process which includes both the Express web server and the background transcription worker polling loop
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
Ensure `min_machines_running = 1` in `fly.toml`. If `auto_stop_machines` stops the machine, the worker stops too. With `min_machines_running = 1`, at least one machine stays alive.

**Machine keeps stopping**
Fly's auto-stop only stops machines with no active HTTP connections. The background worker doesn't count as an HTTP connection. Set `auto_stop_machines = "off"` if the worker must run continuously regardless of traffic.
