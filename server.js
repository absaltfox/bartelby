const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { loadEnv } = require('./utils/secrets');
const { initializeSchema, settingsAsync, documentsAsync } = require('./database/db');
const { passport, locals } = require('./middleware/auth');
const { resolveApplicationSettings } = require('./utils/application-settings');

loadEnv();

const app = express();
const PORT = config.runtime.port;
const isProduction = config.runtime.nodeEnv === 'production';
const bootStartedAt = Date.now();
const startupDebugEnabled = /^(1|true|yes|on)$/i.test(String(process.env.STARTUP_DEBUG || ''));

function formatBootElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function logBoot(message) {
  console.log(`[boot +${formatBootElapsed(Date.now() - bootStartedAt)}] ${message}`);
}

function logBootDebug(message) {
  if (!startupDebugEnabled) return;
  logBoot(message);
}

function loadRoute(routePath, label) {
  logBootDebug(`Loading ${label}`);
  const route = require(routePath);
  logBootDebug(`Loaded ${label}`);
  return route;
}

logBoot(`Starting Bartelby (pid ${process.pid}, env ${config.runtime.nodeEnv}, port ${PORT})`);

// ── Security headers ────────────────────────────────────────────────────
app.use(helmet({
  hsts: isProduction ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // EJS inline scripts
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));

// Trust reverse proxy (Fly.io, nginx, etc.) so secure cookies and rate
// limiting work correctly behind TLS termination. Must be set before
// rate limiters, which validate X-Forwarded-For against this setting.
app.set('trust proxy', 1);

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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// When using S3 storage, serve /uploads/* by proxying from S3.
// Auth is deferred until after Passport is initialized (see below).

app.use(express.static(path.join(__dirname, 'public')));
logBoot('Core middleware configured');

// ── Sessions ───────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  if (isProduction) {
    console.error('[security] SESSION_SECRET must be set in production. Exiting.');
    process.exit(1);
  }
  console.warn('[security] SESSION_SECRET is not set — using a random secret. Sessions will not persist across restarts. Set SESSION_SECRET in .env for production.');
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
      secure: process.env.NODE_ENV === 'production'
    }
  };
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
      console.error('[redis] session store error:', err);
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
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

function validateCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Skip for multipart/form-data — body hasn't been parsed yet.
  // These routes must call validateCsrf manually after multer runs.
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return next();

  const token = req.body?._csrf || req.headers['x-csrf-token'];
  const valid = token && req.session.csrfToken &&
    (() => {
      const tokenBuf = Buffer.from(String(token));
      const expectedBuf = Buffer.from(req.session.csrfToken);
      return tokenBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(tokenBuf, expectedBuf);
    })();

  if (!valid) {
    // API requests get JSON error
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
    // Form submissions: redirect back so the user gets a fresh token
    req.session.authError = 'Your session expired. Please try again.';
    return res.redirect(req.get('Referrer') || '/login');
  }
  next();
}

// Apply CSRF validation to all state-changing requests
app.use(validateCsrf);

// ── Passport ───────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(locals); // makes currentUser / isAdmin available in all templates
app.use(async (req, res, next) => {
  try {
    const cfg = await settingsAsync.getAll();
    Object.assign(res.locals, resolveApplicationSettings(cfg));
  } catch (err) {
    Object.assign(res.locals, resolveApplicationSettings({}));
  }
  next();
});

// ── General rate limiting (after Passport so req.isAuthenticated works) ───
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== 'production' || (req.isAuthenticated && req.isAuthenticated())
});
app.use(generalLimiter);

// ── View engine ────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Authenticated upload proxy ──────────────────────────────────────────────
const { requireAuth, requireAdmin, requireAuthApi } = require('./middleware/auth');
logBootDebug('Authentication middleware loaded');

if (config.storage.driver === 's3') {
  const storage = require('./utils/storage');
  app.get('/uploads/:filename', async (req, res) => {
    try {
      const safeFilename = path.basename(String(req.params.filename || ''));
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

      const buffer = await storage.readUploadByUrl(uploadUrl);
      const ext = path.extname(req.params.filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.pdf': 'application/pdf'
      };
      res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(buffer);
    } catch (err) {
      res.status(404).end();
    }
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Auth routes get CSRF protection on POST
app.use('/', loadRoute('./routes/auth', 'auth routes'));
app.use('/account', loadRoute('./routes/account', 'account routes'));
app.use('/', loadRoute('./routes/documents', 'document routes'));
app.use('/transcripts', loadRoute('./routes/transcripts', 'transcript routes'));
app.use('/api/annotations', requireAuthApi, loadRoute('./routes/annotations', 'annotation routes'));
app.use('/export', loadRoute('./routes/export', 'export routes'));
app.use('/search', loadRoute('./routes/search', 'search routes'));
app.use('/admin', requireAdmin, loadRoute('./routes/admin', 'admin routes'));
app.use('/admin/documents', loadRoute('./routes/admin-documents', 'admin document routes')); // has its own requireAdmin
app.use('/admin/users', loadRoute('./routes/admin-users', 'admin user routes')); // has its own requireAdmin
app.use('/admin/collections', loadRoute('./routes/admin-collections', 'admin collection routes')); // has its own requireAdmin
app.use('/admin/jobs', loadRoute('./routes/admin-jobs', 'admin job routes')); // has its own requireAdmin
app.use('/admin/extraction-jobs', loadRoute('./routes/admin-extraction', 'admin extraction routes')); // has its own requireAdmin
app.use('/admin/entities', loadRoute('./routes/admin-entities', 'admin entity routes')); // has its own requireAdmin
app.use('/admin', loadRoute('./routes/admin-review', 'admin review routes')); // has its own requireAdmin
app.use('/graph', loadRoute('./routes/graph', 'graph routes'));
app.use('/manage', loadRoute('./routes/manage', 'manage routes')); // has its own requireAdminOrManager
logBoot('Routes mounted');

// Export CSRF validator for routes that need it
app.locals.validateCsrf = validateCsrf;

// ── Health check (used by fly.io and Docker) ─────────────────────────────
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ── Error handling ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', {
    message: 'Something went wrong!',
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
  console.error('[crash] Unhandled promise rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[crash] Uncaught exception:', err);
  process.exit(1);
});

// ── Initialization (shared by start() and tests) ───────────────────────────
// Prepares the DB schema and session middleware without binding a port.
// Tests call this directly; start() calls it then listens.
async function initApp() {
  logBoot('Schema initialization start');
  await initializeSchema();
  logBoot('Schema initialization complete');

  logBoot('Session middleware initialization start');
  sessionMiddleware = await createSessionMiddleware();
  logBoot('Session middleware initialization complete');
  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  let startupPhase = 'schema initialization';
  try {
    await initApp();
    console.log('Database initialized');
    startupPhase = 'session middleware initialization';
    if (config.runtime.startWorker) {
      startupPhase = 'background worker startup';
      logBoot('Background worker startup requested');
      const { startWorker } = require('./utils/worker');
      startWorker();
      logBoot('Background worker startup complete');
    } else {
      logBoot('Background worker startup disabled by configuration');
      console.log('Background worker startup disabled by configuration');
    }

    startupPhase = 'http listen';
    logBoot(`Binding HTTP listener on 0.0.0.0:${PORT}`);
    const server = app.listen(PORT, '0.0.0.0', () => {
      logBoot(`HTTP listener ready on port ${PORT}`);
      console.log(`Bartelby running on port ${PORT}`);
    });

    // ── Graceful shutdown (fly.io sends SIGTERM on deploy) ──────────────
    const { saveDatabase } = require('./database/db');

    async function shutdown(signal) {
      console.log(`${signal} received — shutting down gracefully…`);
      server.close(async () => {
        try {
          if (redisClient) await redisClient.quit().catch(() => {});
          await saveDatabase();
        } catch (err) {
          console.error('Shutdown cleanup error:', err);
        }
        process.exit(0);
      });

      // Force exit after 10s if graceful shutdown stalls
      setTimeout(() => {
        console.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
      }, 10_000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(`[boot] Failed during ${startupPhase}`);
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only bind a port when run directly (not when required by tests)
if (require.main === module) {
  start();
}

module.exports = { app, initApp };
