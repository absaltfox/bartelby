const express = require('express');
const path = require('path');
const session = require('express-session');
const { initializeSchema } = require('./database/db');
const { passport, locals } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Core middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ───────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'bartelby-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// ── Passport ───────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
app.use(locals); // makes currentUser / isAdmin available in all templates

// ── View engine ────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Routes ─────────────────────────────────────────────────────────────────
const { requireAdmin, requireAuthApi } = require('./middleware/auth');

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/documents'));
app.use('/transcripts', require('./routes/transcripts'));
app.use('/api/annotations', requireAuthApi, require('./routes/annotations'));
app.use('/search', require('./routes/search'));
app.use('/admin', requireAdmin, require('./routes/admin'));
app.use('/admin/documents', require('./routes/admin-documents')); // has its own requireAdmin
app.use('/admin/users', require('./routes/admin-users')); // has its own requireAdmin
app.use('/admin/collections', require('./routes/admin-collections')); // has its own requireAdmin
app.use('/admin/jobs', require('./routes/admin-jobs')); // has its own requireAdmin

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
