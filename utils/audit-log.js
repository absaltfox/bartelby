'use strict';

/**
 * Minimal structured audit logger for security-sensitive operations.
 * Writes JSON lines to stdout/stderr so they are captured by any log
 * aggregator attached to the process (Fly.io, Docker, systemd, etc.).
 *
 * Format: [AUDIT] <ISO timestamp> <action> — JSON payload
 */

function log(action, payload = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    ...payload
  });
  process.stdout.write(`[AUDIT] ${entry}\n`);
}

// ── Convenience helpers ────────────────────────────────────────────────────

/** Extract a concise request context from an Express req object. */
function reqContext(req) {
  return {
    actorId: req.user?.id ?? null,
    actorName: req.user?.username ?? null,
    ip: req.ip ?? null
  };
}

module.exports = { log, reqContext };
