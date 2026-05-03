'use strict';

const crypto = require('crypto');

const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
});

const LEVEL_NAMES = Object.keys(LEVELS);
const DEFAULT_CONFIG = Object.freeze({
  logLevel: 'info',
  persistEnabled: true,
  persistMinLevel: 'warn',
  slowRequestMs: 1000,
  eventLoopMonitorEnabled: false,
  eventLoopLagWarnMs: 250,
  retentionDays: 14
});
const TEST_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  persistEnabled: false,
  eventLoopMonitorEnabled: false
});

const SENSITIVE_KEY_PATTERN = /(secret|password|token|cookie|authorization|api[_-]?key|session|csrf|prompt|transcript|content)/i;
const MAX_STRING_LENGTH = 500;
const MAX_OBJECT_DEPTH = 4;
const CONFIG_CACHE_MS = 5000;
const CONFIG_SETTING_KEYS = [
  'log_level',
  'log_persist_enabled',
  'log_persist_min_level',
  'log_slow_request_ms',
  'log_event_loop_monitor_enabled',
  'log_event_loop_lag_warn_ms',
  'log_retention_days'
];
let cachedConfig = { expiresAt: 0, value: DEFAULT_CONFIG };
let eventLoopMonitorStarted = false;
let logMaintenanceStarted = false;
let eventLoopMonitorHandle = null;
let logMaintenanceHandle = null;

function isTestEnv() {
  return process.env.NODE_ENV === 'test';
}

function normalizeLevel(level, fallback = DEFAULT_CONFIG.logLevel) {
  const name = String(level || '').trim().toLowerCase();
  return LEVELS[name] ? name : fallback;
}

function levelValue(level) {
  return LEVELS[normalizeLevel(level)];
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeString(value) {
  const raw = String(value);
  if (raw.length <= MAX_STRING_LENGTH) return raw;
  return `${raw.slice(0, MAX_STRING_LENGTH)}…`;
}

function redactValue(key, value, depth = 0) {
  if (value == null) return value;
  if (SENSITIVE_KEY_PATTERN.test(String(key || ''))) return '[redacted]';
  if (depth >= MAX_OBJECT_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [childKey, childValue]) => {
      acc[childKey] = redactValue(childKey, childValue, depth + 1);
      return acc;
    }, {});
  }

  if (typeof value === 'string') return sanitizeString(value);
  return value;
}

function sanitizeContext(context = {}) {
  return redactValue('', context, 0) || {};
}

function formatLine(level, category, message, context) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    category,
    message
  };
  if (context && Object.keys(context).length > 0) payload.context = context;
  return JSON.stringify(payload);
}

async function loadConfig() {
  const now = Date.now();
  if (cachedConfig.expiresAt > now) return cachedConfig.value;
  if (isTestEnv()) {
    cachedConfig = {
      value: TEST_CONFIG,
      expiresAt: now + CONFIG_CACHE_MS
    };
    return TEST_CONFIG;
  }

  const next = { ...DEFAULT_CONFIG };
  try {
    const { settingsAsync } = require('../database/db');
    const cfg = await settingsAsync.getMany(CONFIG_SETTING_KEYS);
    next.logLevel = normalizeLevel(cfg.log_level, DEFAULT_CONFIG.logLevel);
    next.persistEnabled = parseBoolean(cfg.log_persist_enabled, DEFAULT_CONFIG.persistEnabled);
    next.persistMinLevel = normalizeLevel(cfg.log_persist_min_level, DEFAULT_CONFIG.persistMinLevel);
    next.slowRequestMs = parsePositiveInt(cfg.log_slow_request_ms, DEFAULT_CONFIG.slowRequestMs);
    next.eventLoopMonitorEnabled = parseBoolean(cfg.log_event_loop_monitor_enabled, DEFAULT_CONFIG.eventLoopMonitorEnabled);
    next.eventLoopLagWarnMs = parsePositiveInt(cfg.log_event_loop_lag_warn_ms, DEFAULT_CONFIG.eventLoopLagWarnMs);
    next.retentionDays = parsePositiveInt(cfg.log_retention_days, DEFAULT_CONFIG.retentionDays);
  } catch (err) {
    // Fall back to defaults until the database is ready.
  }

  cachedConfig = {
    value: next,
    expiresAt: now + CONFIG_CACHE_MS
  };
  return next;
}

function invalidateConfigCache() {
  cachedConfig = { expiresAt: 0, value: DEFAULT_CONFIG };
}

async function persistLog(level, category, message, context) {
  try {
    const config = await loadConfig();
    if (!config.persistEnabled || levelValue(level) < levelValue(config.persistMinLevel)) return;
    const { appLogsAsync } = require('../database/db');
    if (!appLogsAsync || typeof appLogsAsync.create !== 'function') return;
    await appLogsAsync.create({
      level,
      category,
      message,
      context,
      requestId: context.requestId || null,
      userId: context.userId || null,
      documentId: context.documentId || null,
      collectionId: context.collectionId || null,
      jobType: context.jobType || null,
      jobId: context.jobId || null
    });
  } catch (err) {
    // Never let operational logging break the app.
  }
}

async function emit(level, category, message, context = {}, options = {}) {
  const normalizedLevel = normalizeLevel(level);
  const safeContext = sanitizeContext(context);
  const config = await loadConfig();
  const line = formatLine(normalizedLevel, category, message, safeContext);
  const shouldWriteConsole = options.console !== false;

  if (shouldWriteConsole && levelValue(normalizedLevel) >= levelValue(config.logLevel)) {
    if (levelValue(normalizedLevel) >= LEVELS.error) {
      console.error(line);
    } else if (levelValue(normalizedLevel) >= LEVELS.warn) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  void persistLog(normalizedLevel, category, message, safeContext);
}

function bind(level) {
  return (category, message, context, options) => emit(level, category, message, context, options);
}

function createRequestId() {
  return crypto.randomUUID();
}

function requestLoggingMiddleware() {
  return function logRequests(req, res, next) {
    const startedAt = process.hrtime.bigint();
    const requestId = req.headers['x-request-id'] || createRequestId();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', async () => {
      try {
        const config = await loadConfig();
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const baseContext = {
          requestId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          statusCode: res.statusCode,
          durationMs: Math.round(elapsedMs),
          userId: req.user ? req.user.id : null
        };

        if (res.statusCode >= 500) {
          await emit('error', 'http', 'Request failed with server error.', baseContext);
          return;
        }

        if (elapsedMs >= config.slowRequestMs) {
          await emit('warn', 'http', 'Slow request detected.', baseContext);
        }
      } catch (err) {
        // Ignore logging failures.
      }
    });

    next();
  };
}

function startEventLoopMonitor() {
  if (eventLoopMonitorStarted) return;
  eventLoopMonitorStarted = true;

  let last = Date.now();
  async function checkEventLoopLag() {
    try {
      const now = Date.now();
      const delta = now - last;
      last = now;

      const config = await loadConfig();
      if (!config.eventLoopMonitorEnabled) return;

      const lagMs = delta - 10000;
      if (lagMs >= config.eventLoopLagWarnMs) {
        await emit('warn', 'event-loop', 'Event loop lag spike detected.', {
          lagMs: Math.round(lagMs)
        });
      }
    } catch (err) {
      // Ignore monitoring failures.
    }
  }

  eventLoopMonitorHandle = setInterval(() => {
    void checkEventLoopLag();
  }, 10000);
  eventLoopMonitorHandle.unref();
}

function startLogMaintenance() {
  if (logMaintenanceStarted) return;
  logMaintenanceStarted = true;

  async function prune() {
    try {
      const config = await loadConfig();
      const { appLogsAsync } = require('../database/db');
      if (appLogsAsync && typeof appLogsAsync.deleteOlderThanDays === 'function') {
        await appLogsAsync.deleteOlderThanDays(config.retentionDays);
      }
    } catch (err) {
      // Ignore maintenance failures.
    }
  }

  void prune();
  logMaintenanceHandle = setInterval(() => {
    void prune();
  }, 6 * 60 * 60 * 1000);
  logMaintenanceHandle.unref();
}

function stopBackgroundTasks() {
  if (eventLoopMonitorHandle) {
    clearInterval(eventLoopMonitorHandle);
    eventLoopMonitorHandle = null;
  }
  if (logMaintenanceHandle) {
    clearInterval(logMaintenanceHandle);
    logMaintenanceHandle = null;
  }
  eventLoopMonitorStarted = false;
  logMaintenanceStarted = false;
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  DEFAULT_CONFIG,
  normalizeLevel,
  levelValue,
  loadConfig,
  invalidateConfigCache,
  sanitizeContext,
  requestLoggingMiddleware,
  startEventLoopMonitor,
  startLogMaintenance,
  stopBackgroundTasks,
  trace: bind('trace'),
  debug: bind('debug'),
  info: bind('info'),
  warn: bind('warn'),
  error: bind('error'),
  fatal: bind('fatal')
};
