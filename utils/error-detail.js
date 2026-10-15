'use strict';

// One-line error descriptions for operator logs. `err.message` alone hides the
// two things needed to diagnose a dropped database request: which statement
// it interrupted (set as `err.dbStatement` by database/drivers/turso.js) and
// the network error underneath (`err.cause`, e.g. ECONNRESET). SQL text is
// included; bound parameters never are, because they can hold user data.
//
// For console logs only. Job errors shown in the admin UI keep `err.message`.

const MAX_STATEMENT_LENGTH = 200;
const MAX_CAUSE_DEPTH = 3;

function summarizeStatement(statement) {
  const sql = typeof statement === 'string' ? statement : statement && statement.sql;
  const text = String(sql || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_STATEMENT_LENGTH ? `${text.slice(0, MAX_STATEMENT_LENGTH)}…` : text;
}

function messageOf(err) {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

function withCode(err) {
  const code = err && typeof err === 'object' && err.code ? `${err.code} ` : '';
  return `${code}${messageOf(err)}`;
}

function describeError(err) {
  const parts = [messageOf(err)];
  if (!err || typeof err !== 'object') return parts[0];

  if (err.dbStatement) parts.push(`[statement: ${err.dbStatement}]`);

  let cause = err.cause;
  for (let depth = 0; cause != null && depth < MAX_CAUSE_DEPTH; depth++) {
    parts.push(`[cause: ${withCode(cause)}]`);
    cause = typeof cause === 'object' ? cause.cause : null;
  }

  if (err.code && err.cause == null) parts.push(`[code: ${err.code}]`);
  return parts.join(' ');
}

module.exports = { describeError, summarizeStatement };
