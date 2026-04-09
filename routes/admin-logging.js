const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { appLogsAsync, settingsAsync } = require('../database/db');
const { LEVEL_NAMES, invalidateConfigCache, info } = require('../utils/logger');

router.use(requireAdmin);

const PAGE_SIZE = 100;

function normalizeLevelFilter(value) {
  const candidate = String(value || 'all').toLowerCase();
  return candidate === 'all' || LEVEL_NAMES.includes(candidate) ? candidate : 'all';
}

router.get('/', async (req, res) => {
  const level = normalizeLevelFilter(req.query.level);
  const category = String(req.query.category || 'all').trim() || 'all';
  const query = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [counts, categories, filteredTotal, logs] = await Promise.all([
    appLogsAsync.getCounts(),
    appLogsAsync.getCategories(),
    appLogsAsync.getFilteredCount({ level, category, query }),
    appLogsAsync.list({ level, category, query, limit: PAGE_SIZE, offset })
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));

  res.render('admin/logging', {
    pageTitle: 'Logging',
    counts,
    categories,
    logs,
    level,
    category,
    query,
    page,
    totalPages,
    filteredTotal,
    saved: req.query.saved === '1',
    cleaned: req.query.cleaned === '1',
    error: req.query.error || null,
    levelOptions: LEVEL_NAMES
  });
});

router.get('/settings', async (req, res) => {
  const cfg = await settingsAsync.getAll();

  res.render('admin/logging-settings', {
    pageTitle: 'Logging Settings',
    cfg,
    saved: req.query.saved === '1',
    cleaned: req.query.cleaned === '1',
    error: req.query.error || null,
    levelOptions: LEVEL_NAMES
  });
});

router.post('/settings', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const fields = [
      'log_level',
      'log_persist_min_level',
      'log_slow_request_ms',
      'log_event_loop_lag_warn_ms',
      'log_retention_days'
    ];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        await settingsAsync.set(field, String(req.body[field] || '').trim());
      }
    }

    await settingsAsync.set('log_persist_enabled', req.body.log_persist_enabled === 'on' ? '1' : '0');
    await settingsAsync.set('log_event_loop_monitor_enabled', req.body.log_event_loop_monitor_enabled === 'on' ? '1' : '0');
    invalidateConfigCache();
    void info('admin', 'Updated logging settings.', {
      userId: req.user ? req.user.id : null
    });
    res.redirect('/admin/logging/settings?saved=1');
  } catch (err) {
    res.redirect('/admin/logging/settings?error=' + encodeURIComponent(err.message));
  }
});

router.post('/cleanup', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const retentionDays = parseInt(await settingsAsync.get('log_retention_days'), 10) || 14;
    await appLogsAsync.deleteOlderThanDays(retentionDays);
    invalidateConfigCache();
    void info('admin', 'Pruned persisted application logs.', {
      userId: req.user ? req.user.id : null,
      retentionDays
    });
    res.redirect('/admin/logging/settings?cleaned=1');
  } catch (err) {
    res.redirect('/admin/logging/settings?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
