const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { loadEnv } = require('./utils/secrets');
const { initializeSchema } = require('./database/db');
const { passport, locals } = require('./middleware/auth');

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // EJS inline scripts
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

// ── Rate limiting ───────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again later.'
});
app.use('/login', authLimiter);
app.use('/register', authLimiter);

// ── Core middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ───────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set — using a random secret. Sessions will not persist across restarts. Set SESSION_SECRET in .env for production.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 'bartelby.sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

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

  const token = req.body?._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
}

// Apply CSRF validation to all state-changing requests
app.use(validateCsrf);

// ── Passport ───────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(locals); // makes currentUser / isAdmin available in all templates

// ── View engine ────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Routes ─────────────────────────────────────────────────────────────────
const { requireAdmin, requireAuthApi } = require('./middleware/auth');

// Auth routes get CSRF protection on POST
app.use('/', require('./routes/auth'));
app.use('/account', require('./routes/account'));
app.use('/', require('./routes/documents'));
app.use('/transcripts', require('./routes/transcripts'));
app.use('/api/annotations', requireAuthApi, require('./routes/annotations'));
app.use('/search', require('./routes/search'));
app.use('/admin', requireAdmin, require('./routes/admin'));
app.use('/admin/documents', require('./routes/admin-documents')); // has its own requireAdmin
app.use('/admin/users', require('./routes/admin-users')); // has its own requireAdmin
app.use('/admin/collections', require('./routes/admin-collections')); // has its own requireAdmin
app.use('/admin/jobs', require('./routes/admin-jobs')); // has its own requireAdmin

// Export CSRF validator for routes that need it
app.locals.validateCsrf = validateCsrf;

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

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initializeSchema();
    console.log('Database initialized');

    const { startWorker } = require('./utils/worker');
    startWorker();

    app.listen(PORT, () => {
      console.log(`Bartelby running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
module.exports = app;
