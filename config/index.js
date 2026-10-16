'use strict';

const path = require('path');
require('../utils/secrets').loadEnv();

const rootDir = path.join(__dirname, '..');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flyProcessGroup() {
  return String(process.env.FLY_PROCESS_GROUP || '').trim().toLowerCase();
}

const startWorker = !boolEnv('DISABLE_BACKGROUND_WORKER', false) && flyProcessGroup() !== 'web';

const config = {
  app: {
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    uploadsDir: process.env.UPLOADS_DIR || path.join(rootDir, 'data', 'uploads'),
    legacyUploadsDir: path.join(rootDir, 'public', 'uploads'),
    tempDir: path.join(rootDir, 'temp'),
    publicBaseUrl: process.env.PUBLIC_APP_URL || ''
  },
  runtime: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    startWorker
  },
  session: {
    store: process.env.SESSION_STORE || 'memory',
    redisUrl: process.env.REDIS_URL || ''
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || '',
      endpoint: process.env.S3_ENDPOINT || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: boolEnv('S3_FORCE_PATH_STYLE', false),
      maxSockets: intEnv('S3_MAX_SOCKETS', 64),
      connectionTimeoutMs: intEnv('S3_CONNECTION_TIMEOUT_MS', 5000),
      socketTimeoutMs: intEnv('S3_SOCKET_TIMEOUT_MS', 120000),
      presignedGetTtlSeconds: intEnv('S3_PRESIGNED_GET_TTL_SECONDS', 0)
    }
  },
  flyMachines: {
    enabled: boolEnv('FLY_MACHINES_ENABLED', false),
    apiToken: process.env.FLY_API_TOKEN || '',
    appName: process.env.FLY_APP_NAME || '',
    imageRef: process.env.FLY_IMAGE_REF || '',
    region: process.env.FLY_REGION || process.env.PRIMARY_REGION || 'iad',
    workerCpus: parseInt(process.env.PDF_WORKER_CPUS || '4', 10),
    workerMemoryMb: parseInt(process.env.PDF_WORKER_MEMORY_MB || '2048', 10),
    analyticsWorkerMemoryMb: parseInt(process.env.ANALYTICS_WORKER_MEMORY_MB || '4096', 10)
  },
  database: {
    driver: process.env.DATABASE_DRIVER || 'auto',
    dataDir: path.join(rootDir, 'data'),
    sqljs: {
      filePath: process.env.SQLJS_FILE_PATH || (process.env.NODE_ENV === 'test'
        ? ':memory:'
        : path.join(rootDir, 'data', 'transcriber.db'))
    },
    turso: {
      url: process.env.TURSO_DATABASE_URL || '',
      authToken: process.env.TURSO_AUTH_TOKEN || '',
      // Reuse HTTPS connections between Turso requests. Off by default in
      // processes that run the background worker, whose bursts of small
      // queries were failing with ECONNRESET, most likely on reused connections; on by
      // default for web-only processes, where a new TLS handshake per query
      // would slow page loads. See DEPLOY.md (Turso connection reuse).
      keepAlive: boolEnv('TURSO_HTTP_KEEP_ALIVE', !startWorker)
    },
    // Lifetime of the in-process cache of public application settings, read
    // by the page-shell middleware on every HTML request and every /uploads
    // thumbnail. Writes through `settingsAsync.set` invalidate it
    // immediately, so this only bounds staleness when a *second* web machine
    // performs the write. Set to 0 to disable the cache entirely.
    settingsCacheTtlMs: intEnv('SETTINGS_CACHE_TTL_MS', 30000)
  },
  iiif: {
    // Size parameter for IIIF Image API derivatives fetched for transcription
    // and rendered in the viewer (IIIF Image API 2.0 size syntax, e.g. '2000,').
    transcriptionImageSize: process.env.IIIF_IMAGE_SIZE || '2000,',
    requestTimeoutMs: intEnv('IIIF_TIMEOUT_MS', 30000),
    maxImageBytes: intEnv('IIIF_MAX_IMAGE_BYTES', 25 * 1024 * 1024),
    crawlDelayMs: intEnv('IIIF_CRAWL_DELAY_MS', 250),
    maxManifestsPerSync: intEnv('IIIF_MAX_MANIFESTS', 0), // 0 = unlimited
    // UBC Open Collections enumeration (Research/Search API). The api key is a
    // secret passed as a `?api_key=` query param; may also be set per-source.
    ubcSearchBase: process.env.UBC_OC_SEARCH_BASE || 'https://oc-index.library.ubc.ca',
    // IIIF presentation + image host. NOTE: UBC manifests declare per-canvas
    // image services with a spurious extra `.0000` segment that 404s; the
    // working Image API id is derived as cdm.{coll}.{itemDashed}.{page:04d}
    // (see utils/iiif/sources/ubc-oc.js buildItemImageUrl).
    ubcImageBase: process.env.UBC_OC_IMAGE_BASE || 'https://iiif.library.ubc.ca',
    ubcApiKey: process.env.UBC_OC_API_KEY || ''
  }
};

module.exports = config;
