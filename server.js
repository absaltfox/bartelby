const express = require('express');
const path = require('path');
const { finished } = require('stream/promises');
const { Transform } = require('stream');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { loadEnv } = require('./utils/secrets');
const { initializeSchema, settingsAsync, documentsAsync } = require('./database/db');
const { passport, locals } = require('./middleware/auth');
const { ensureCsrfToken, validateCsrf } = require('./middleware/csrf');
const { resolveApplicationSettings } = require('./utils/application-settings');
const { parseProxyTrust } = require('./utils/proxy-trust');
const { ipRateLimitKey, userOrIpRateLimitKey } = require('./utils/rate-limit');
const logger = require('./utils/logger');

loadEnv();

const app = express();
const PORT = config.runtime.port;
const isProduction = config.runtime.nodeEnv === 'production';
const bootStartedAt = Date.now();
const startupDebugEnabled = /^(1|true|yes|on)$/i.test(String(process.env.STARTUP_DEBUG || ''));
const routeLoadMetrics = [];
const deferredRouteLoaders = [];

function readEnvFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function formatBootElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function logBoot(message) {
  const elapsedMs = Date.now() - bootStartedAt;
  const rendered = `[boot +${formatBootElapsed(elapsedMs)}] ${message}`;
  console.log(rendered);
  void logger.info('boot', message, { elapsedMs }, { console: false });
}

function logBootDebug(message) {
  if (!startupDebugEnabled) return;
  logBoot(message);
}

function logBootWarn(message) {
  const elapsedMs = Date.now() - bootStartedAt;
  const rendered = `[boot +${formatBootElapsed(elapsedMs)}] ${message}`;
  console.warn(rendered);
  void logger.warn('boot', message, { elapsedMs }, { console: false });
}

function normalizeRequestCharsetAlias(req, res, next) {
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string' && /;\s*charset\s*=\s*"?utf8"?/i.test(contentType)) {
    req.headers['content-type'] = contentType.replace(
      /(\;\s*charset\s*=\s*"?)(utf8)("?)/i,
      '$1utf-8$3'
    );
  }
  next();
}

function isMissingUploadError(err) {
  return err?.code === 'UPLOAD_NOT_FOUND' || err?.code === 'INVALID_UPLOAD_URL';
}

async function streamUploadToResponse(stream, res) {
  let started = false;
  const marker = new Transform({
    transform(chunk, encoding, callback) {
      started = true;
      callback(null, chunk);
    }
  });

  const streamError = new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.off('error', onError);
      marker.off('error', onError);
    };
    stream.once('error', onError);
    marker.once('error', onError);
  });

  stream.pipe(marker).pipe(res);

  try {
    await Promise.race([finished(res), streamError]);
  } catch (err) {
    if ((started || res.headersSent) && !res.destroyed) {
      res.destroy(err);
    }
    throw err;
  }
}

function loadRouteModule(routePath, label, options = {}) {
  const tier = options.tier || 'core';
  const trigger = options.trigger || 'boot';
  const startedAt = Date.now();
  logBootDebug(`Loading ${tier} route (${trigger}): ${label}`);
  const route = require(routePath);
  const durationMs = Date.now() - startedAt;
  routeLoadMetrics.push({
    routePath,
    label,
    tier,
    trigger,
    durationMs
  });
  logBoot(`Loaded ${tier} route (${trigger}): ${label} in ${formatBootElapsed(durationMs)}`);
  return route;
}

function logRouteLoadSummary(trigger = null, tierFilter = null) {
  const relevantMetrics = routeLoadMetrics.filter((metric) => {
    if (trigger && metric.trigger !== trigger) return false;
    if (tierFilter && metric.tier !== tierFilter) return false;
    return true;
  });

  const byTier = relevantMetrics.reduce((acc, metric) => {
    if (!acc[metric.tier]) {
      acc[metric.tier] = {
        count: 0,
        totalMs: 0,
        slowest: metric
      };
    }
    acc[metric.tier].count += 1;
    acc[metric.tier].totalMs += metric.durationMs;
    if (metric.durationMs > acc[metric.tier].slowest.durationMs) {
      acc[metric.tier].slowest = metric;
    }
    return acc;
  }, {});

  ['core', 'management', 'admin'].forEach((tier) => {
    const summary = byTier[tier];
    if (!summary) return;
    logBoot(
      `Route load summary (${tier}${trigger ? `, ${trigger}` : ''}): `
      + `${summary.count} route${summary.count === 1 ? '' : 's'}, `
      + `${formatBootElapsed(summary.totalMs)} total, slowest ${summary.slowest.label} `
      + `at ${formatBootElapsed(summary.slowest.durationMs)}`
    );
  });
}

function loadRoute(routePath, label, options = {}) {
  return loadRouteModule(routePath, label, { ...options, trigger: 'boot' });
}

function createDeferredRouteLoader(routePath, label, options = {}) {
  let route = null;
  let loadingPromise = null;

  async function ensureLoaded(trigger) {
    if (route) return route;
    if (!loadingPromise) {
      loadingPromise = Promise.resolve().then(() => {
        route = loadRouteModule(routePath, label, { ...options, trigger });
        return route;
      }).finally(() => {
        loadingPromise = null;
      });
    }
    return loadingPromise;
  }

  const middleware = (req, res, next) => {
    ensureLoaded('request')
      .then((loadedRoute) => loadedRoute(req, res, next))
      .catch(next);
  };

  middleware.prewarm = () => ensureLoaded('prewarm');
  middleware.routeLabel = label;
  middleware.routeTier = options.tier || 'core';
  return middleware;
}

function registerDeferredRoute(routePath, label, options = {}) {
  const loader = createDeferredRouteLoader(routePath, label, options);
  deferredRouteLoaders.push(loader);
  return loader;
}

async function prewarmDeferredRoutes(tier, options = {}) {
  const matchingLoaders = deferredRouteLoaders.filter((loader) => loader.routeTier === tier);
  if (matchingLoaders.length === 0) return;

  logBoot(`Deferred route prewarm start (${tier})`);
  for (const loader of matchingLoaders) {
    // Yield between prewarms so first interactive requests are not blocked
    // by a long burst of synchronous module loading.
    await new Promise((resolve) => setImmediate(resolve));
    await loader.prewarm();
  }
  logRouteLoadSummary('prewarm', tier);
  logBoot(`Deferred route prewarm complete (${tier})`);
  const delayMs = Number(options.nextDelayMs || 0);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

logBoot(`Starting Bartelby (pid ${process.pid}, env ${config.runtime.nodeEnv}, port ${PORT})`);

// ── Security headers ────────────────────────────────────────────────────
const imgSrcDirectives = ["'self'", "data:"];
if (config.storage.driver === 's3') {
  try {
    const endpointStr = config.storage.s3.endpoint || `https://s3.${config.storage.s3.region || 'us-east-1'}.amazonaws.com`;
    const endpointUrl = new URL(endpointStr);
    imgSrcDirectives.push(endpointUrl.origin);
    if (config.storage.s3.bucket && !config.storage.s3.forcePathStyle) {
      imgSrcDirectives.push(`${endpointUrl.protocol}//${config.storage.s3.bucket}.${endpointUrl.hostname}${endpointUrl.port ? ':' + endpointUrl.port : ''}`);
    }
  } catch (err) {}
}

app.use(helmet({
  hsts: isProduction ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // EJS inline scripts
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: imgSrcDirectives,
      connectSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));

// Trust reverse proxy (Fly.io, nginx, etc.) so secure cookies and rate
// limiting work correctly behind TLS termination. Must be set before
// rate limiters, which validate X-Forwarded-For against this setting.
// The parser now defaults to 0 so direct listeners do not trust spoofed
// forwarded headers unless the deployment opts in explicitly.
const proxyTrust = parseProxyTrust(process.env.TRUST_PROXY, {
  onWarning: (message) => logBootWarn(message)
});
app.set('trust proxy', proxyTrust);

// ── Rate limiting (auth endpoints only — general limiter applied after Passport) ─
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again later.'
});

const mfaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many verification attempts. Please try again later.'
});

app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/setup', authLimiter);
app.use('/reset-password', authLimiter);
app.use('/login/mfa', mfaLimiter);

// ── Core middleware ────────────────────────────────────────────────────────
app.use(normalizeRequestCharsetAlias);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// When using S3 storage, serve /uploads/* by proxying from S3.
// Auth is deferred until after Passport is initialized (see below).

const publicStaticMiddleware = express.static(path.join(__dirname, 'public'));
app.use((req, res, next) => {
  if (req.path === '/uploads' || req.path.startsWith('/uploads/')) {
    return next();
  }
  return publicStaticMiddleware(req, res, next);
});
app.use(logger.requestLoggingMiddleware());
logBoot('Core middleware configured');

// ── Sessions ───────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  if (isProduction) {
    logger.fatal('security', 'SESSION_SECRET must be set in production.')
      .finally(() => process.exit(1));
  }
  void logger.warn('security', 'SESSION_SECRET is not set. Using a random secret; sessions will not persist across restarts.');
}
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

let redisClient = null;
let sessionMiddleware = null;

function getSessionOptions(store) {
  return {
    store,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'bartelby.sid',
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction
    }
  };
}

function validateProductionConfiguration() {
  if (!isProduction) return;

  const sessionStore = String(config.session.store || 'memory').toLowerCase();
  const storageDriver = String(config.storage.driver || 'local').toLowerCase();
  const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').trim();
  const allowMemorySessionStore = readEnvFlag('ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION');
  const allowLocalStorage = readEnvFlag('ALLOW_LOCAL_STORAGE_IN_PRODUCTION');

  if (sessionStore === 'memory') {
    if (!allowMemorySessionStore) {
      throw new Error(
        'SESSION_STORE=memory is not allowed in production. Set SESSION_STORE=redis or ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION=1.'
      );
    }
    void logger.warn('boot', 'Production override enabled: using in-memory session store.', {
      sessionStore,
      overrideEnv: 'ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION'
    });
  }

  if (storageDriver === 'local') {
    if (!allowLocalStorage) {
      throw new Error(
        'STORAGE_DRIVER=local is not allowed in production. Configure S3 storage or set ALLOW_LOCAL_STORAGE_IN_PRODUCTION=1.'
      );
    }
    void logger.warn('boot', 'Production override enabled: using local upload storage.', {
      storageDriver,
      overrideEnv: 'ALLOW_LOCAL_STORAGE_IN_PRODUCTION'
    });
  }

  if (!publicAppUrl) {
    throw new Error(
      'PUBLIC_APP_URL must be configured in production so invite and password-reset links resolve correctly.'
    );
  }

  const trustProxy = String(process.env.TRUST_PROXY || '').trim();
  if (!trustProxy || trustProxy === '0') {
    throw new Error(
      'TRUST_PROXY must be set to a non-zero value in production. ' +
      'Set TRUST_PROXY=1 when running behind Fly.io, nginx, or another TLS-terminating proxy.'
    );
  }
}

async function createSessionMiddleware() {
  const sessionStore = String(config.session.store || 'memory').toLowerCase();

  if (sessionStore === 'redis') {
    if (!config.session.redisUrl) {
      throw new Error('SESSION_STORE=redis requires REDIS_URL to be configured.');
    }

    const redis = require('redis');
    const connectRedis = require('connect-redis');
    const RedisStore = connectRedis.RedisStore || connectRedis.default;
    if (!RedisStore) {
      throw new Error('Could not initialize connect-redis.');
    }

    redisClient = redis.createClient({
      url: config.session.redisUrl
    });

    redisClient.on('error', (err) => {
      void logger.error('redis', 'Session store error.', { error: err.message });
    });

    await redisClient.connect();

    return session(getSessionOptions(new RedisStore({
      client: redisClient,
      prefix: 'bartelby:sess:'
    })));
  }

  if (sessionStore !== 'memory') {
    throw new Error(`Unsupported SESSION_STORE "${config.session.store}". Use "memory" or "redis".`);
  }

  return session(getSessionOptions(undefined));
}

app.use((req, res, next) => {
  if (!sessionMiddleware) {
    return next(new Error('Session middleware is not initialized.'));
  }
  return sessionMiddleware(req, res, next);
});

app.use(cookieParser(sessionSecret));

// ── CSRF protection ─────────────────────────────────────────────────────
// Simple double-submit token approach for all state-changing requests.
// Generate a CSRF token per session and validate on POST/PUT/DELETE.
app.use(ensureCsrfToken);

// Apply CSRF validation to all state-changing requests
app.use(validateCsrf);

// ── Passport ───────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(locals); // makes currentUser / isAdmin available in all templates

// ── General rate limiting (after Passport so req.isAuthenticated works) ───
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== 'production' || (req.isAuthenticated && req.isAuthenticated())
});
app.use(generalLimiter);

const authenticatedApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => userOrIpRateLimitKey(req, {
    userPrefix: 'auth-api-user',
    ipPrefix: 'auth-api-ip'
  }),
  skip: (req) => process.env.NODE_ENV !== 'production',
  message: { error: 'Too many requests. Please try again later.' }
});

function isAuthenticatedRequest(req) {
  return !!(req.isAuthenticated && req.isAuthenticated());
}

function isCollectionBrowsePath(req) {
  return req.method === 'GET'
    && (req.path === '/' || req.path === '/collections' || req.path.startsWith('/collections/'));
}

function isUploadProxyPath(req) {
  return req.method === 'GET'
    && req.path.startsWith('/uploads/');
}

function isScannerPath(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return false;
  return /(?:^|\/)(?:\.env|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|phpMyAdmin|server-status|\.git)(?:\/|$|\?)/i
    .test(req.path);
}

const anonymousCollectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipRateLimitKey(req, { prefix: 'anon-collections-ip' }),
  skip: (req) => process.env.NODE_ENV !== 'production' || isAuthenticatedRequest(req) || !isCollectionBrowsePath(req),
  message: 'Too many collection requests. Please try again shortly.'
});

const anonymousUploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipRateLimitKey(req, { prefix: 'anon-uploads-ip' }),
  skip: (req) => process.env.NODE_ENV !== 'production' || isAuthenticatedRequest(req) || !isUploadProxyPath(req),
  message: 'Too many upload requests. Please try again shortly.'
});

const scannerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipRateLimitKey(req, { prefix: 'scanner-ip' }),
  skip: (req) => process.env.NODE_ENV !== 'production' || isAuthenticatedRequest(req) || !isScannerPath(req),
  message: 'Too many requests.'
});

app.use(scannerLimiter);
app.use(anonymousCollectionLimiter);
app.use(anonymousUploadLimiter);

app.use(async (req, res, next) => {
  try {
    const cfg = await settingsAsync.getAllPublic();
    Object.assign(res.locals, resolveApplicationSettings(cfg));
  } catch (err) {
    Object.assign(res.locals, resolveApplicationSettings({}));
  }
  next();
});

// ── View engine ────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function getUploadContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// ── Authenticated upload proxy ──────────────────────────────────────────────
const { requireAuth, requireAdmin, requireAuthApi } = require('./middleware/auth');
logBootDebug('Authentication middleware loaded');

const storage = require('./utils/storage');
app.get('/uploads/:filename', async (req, res) => {
  try {
    const safeFilename = path.basename(String(req.params.filename || ''));
    if (!safeFilename) {
      return res.status(404).end();
    }

    const uploadUrl = `/uploads/${safeFilename}`;
    const userId = req.user ? req.user.id : null;
    const isAdmin = req.user ? req.user.role === 'admin' : false;
    const accessAll = req.user ? !!req.user.access_all : false;
    const matchingDocIds = await documentsAsync.getIdsByUploadUrl(uploadUrl);

    if (matchingDocIds.length === 0) {
      return res.status(404).end();
    }

    let canRead = false;
    for (const docId of matchingDocIds) {
      if (await documentsAsync.canAccess(docId, userId, isAdmin, accessAll)) {
        canRead = true;
        break;
      }
    }

    if (!canRead) {
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
      }
      return res.status(403).end();
    }

    const stream = await storage.streamUploadByUrl(uploadUrl);
    res.set('Content-Type', getUploadContentType(safeFilename));
    res.set('Cache-Control', 'private, max-age=86400');
    await streamUploadToResponse(stream, res);
    return;
  } catch (err) {
    void logger.error('uploads', 'Protected upload streaming failed.', {
      path: req.originalUrl,
      userId: req.user ? req.user.id : null,
      error: err?.stack || err?.message || String(err)
    });
    if (res.headersSent) {
      return;
    }
    if (isMissingUploadError(err)) {
      return res.status(404).end();
    }
    return res.status(500).end();
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────

// Auth routes get CSRF protection on POST
app.use('/', loadRoute('./routes/auth', 'auth routes', { tier: 'core' }));
app.use('/account', loadRoute('./routes/account', 'account routes', { tier: 'core' }));
app.use('/', loadRoute('./routes/documents', 'document routes', { tier: 'core' }));
app.use('/transcripts', authenticatedApiLimiter, loadRoute('./routes/transcripts', 'transcript routes', { tier: 'core' }));
app.use('/api/annotations', authenticatedApiLimiter, requireAuthApi, loadRoute('./routes/annotations', 'annotation routes', { tier: 'core' }));
app.use('/export', loadRoute('./routes/export', 'export routes', { tier: 'core' }));
app.use('/search', loadRoute('./routes/search', 'search routes', { tier: 'core' }));
app.use('/graph', authenticatedApiLimiter, loadRoute('./routes/graph', 'graph routes', { tier: 'core' }));
app.use('/manage', registerDeferredRoute('./routes/manage', 'manage routes', { tier: 'management' })); // has its own requireAdminOrManager
app.use('/admin', requireAdmin, registerDeferredRoute('./routes/admin', 'admin routes', { tier: 'admin' }));
app.use('/admin/documents', registerDeferredRoute('./routes/admin-documents', 'admin document routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/users', registerDeferredRoute('./routes/admin-users', 'admin user routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/collections', registerDeferredRoute('./routes/admin-collections', 'admin collection routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/jobs', registerDeferredRoute('./routes/admin-jobs', 'admin job routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/logging', registerDeferredRoute('./routes/admin-logging', 'admin logging routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge', registerDeferredRoute('./routes/admin-knowledge', 'admin knowledge routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge/extraction-jobs', registerDeferredRoute('./routes/admin-extraction', 'admin knowledge extraction routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge/authorities', registerDeferredRoute('./routes/admin-authorities', 'admin knowledge authority routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge/entities', registerDeferredRoute('./routes/admin-entities', 'admin knowledge entity routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge/sentiment', registerDeferredRoute('./routes/admin-sentiment', 'admin knowledge sentiment routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/knowledge', registerDeferredRoute('./routes/admin-review', 'admin knowledge review routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/extraction-jobs', registerDeferredRoute('./routes/admin-extraction', 'admin extraction routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/authorities', registerDeferredRoute('./routes/admin-authorities', 'admin authority routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin/entities', registerDeferredRoute('./routes/admin-entities', 'admin entity routes', { tier: 'admin' })); // has its own requireAdmin
app.use('/admin', registerDeferredRoute('./routes/admin-review', 'admin review routes', { tier: 'admin' })); // has its own requireAdmin
logRouteLoadSummary('boot');
logBoot('Routes mounted');

// ── Health check (used by fly.io and Docker) ─────────────────────────────
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ── Error handling ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const statusCode = Number.isInteger(err?.statusCode)
    ? err.statusCode
    : Number.isInteger(err?.status)
      ? err.status
      : 500;
  const message = statusCode === 500
    ? 'Something went wrong!'
    : (err.message || 'Request failed.');
  void logger.error('http', 'Unhandled Express error.', {
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    contentType: req.headers['content-type'] || null,
    userId: req.user ? req.user.id : null,
    error: err.stack || err.message
  });
  if ((req.originalUrl || '').includes('/api/')) {
    return res.status(statusCode).json({
      error: message
    });
  }
  res.status(statusCode).render('error', {
    message,
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found', error: {} });
});

// ── Global error guards ─────────────────────────────────────────────────────
// Without these, Node.js 15+ exits the process on any unhandled promise
// rejection, causing Fly.io to restart the machine repeatedly.
process.on('unhandledRejection', (reason) => {
  logger.fatal('crash', 'Unhandled promise rejection.', {
    error: reason instanceof Error ? reason.stack || reason.message : String(reason)
  }).finally(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  logger.fatal('crash', 'Uncaught exception.', {
    error: err.stack || err.message
  }).finally(() => process.exit(1));
});

// ── Initialization (shared by start() and tests) ───────────────────────────
// Prepares the DB schema and session middleware without binding a port.
// Tests call this directly; start() calls it then listens.
async function initApp() {
  validateProductionConfiguration();
  logBoot('Schema initialization start');
  await initializeSchema();
  logBoot('Schema initialization complete');

  logBoot('Session middleware initialization start');
  sessionMiddleware = await createSessionMiddleware();
  logBoot('Session middleware initialization complete');
  if (process.env.NODE_ENV !== 'test') {
    logger.startEventLoopMonitor();
    logger.startLogMaintenance();
  }
  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  let startupPhase = 'schema initialization';
  try {
    await initApp();
    void logger.info('boot', 'Database initialized.');
    startupPhase = 'session middleware initialization';
    if (config.runtime.startWorker) {
      startupPhase = 'background worker startup';
      logBoot('Background worker startup requested');
      const { startWorker } = require('./utils/worker');
      startWorker();
      logBoot('Background worker startup complete');
    } else {
      logBoot('Background worker startup disabled by configuration');
      void logger.info('boot', 'Background worker startup disabled by configuration.');
    }

    startupPhase = 'http listen';
    logBoot(`Binding HTTP listener on 0.0.0.0:${PORT}`);
    const server = app.listen(PORT, '0.0.0.0', () => {
      logBoot(`HTTP listener ready on port ${PORT}`);
      void logger.info('boot', `Bartelby running on port ${PORT}.`);
      void (async () => {
        try {
          await prewarmDeferredRoutes('management', { nextDelayMs: 150 });
          await prewarmDeferredRoutes('admin');
        } catch (err) {
          void logger.warn('boot', 'Deferred route prewarm failed.', {
            error: err.stack || err.message
          });
        }
      })();
    });

    // ── Graceful shutdown (fly.io sends SIGTERM on deploy) ──────────────
    const { saveDatabase, flushDatabase } = require('./database/db');

    async function shutdown(signal) {
      void logger.warn('shutdown', `${signal} received — shutting down gracefully.`);
      logger.stopBackgroundTasks();
      server.close(async () => {
        try {
          if (redisClient) await redisClient.quit().catch(() => {});
          // Use flushDatabase() (not saveDatabase()) so the persist is immediate
          // and bypasses the 300 ms debounce.  Any writes still in-flight when
          // server.close() fires are already committed to the DB driver; this
          // call ensures they reach disk before process.exit(0).
          await flushDatabase();
        } catch (err) {
          void logger.error('shutdown', 'Shutdown cleanup error.', { error: err.message });
        }
        process.exit(0);
      });

      // Force exit after 10s if graceful shutdown stalls
      setTimeout(() => {
        logger.fatal('shutdown', 'Graceful shutdown timed out — forcing exit.')
          .finally(() => process.exit(1));
      }, 10_000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    await logger.fatal('boot', `Failed during ${startupPhase}.`, {
      error: err.stack || err.message
    });
    process.exit(1);
  }
}

// Only bind a port when run directly (not when required by tests)
if (require.main === module) {
  start();
}

module.exports = { app, initApp, validateProductionConfiguration };
