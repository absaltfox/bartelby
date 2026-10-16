'use strict';

const http = require('http');
const https = require('https');
const { createClient } = require('@libsql/client');
const crossFetch = require('cross-fetch');
const config = require('../../config');
const { summarizeStatement } = require('../../utils/error-detail');

// Record which statement a failed request was running, so logs can name the
// query a dropped connection interrupted (see utils/error-detail.js). SQL text
// only; bound values are never attached. The innermost statement wins.
async function tagged(statement, request) {
  try {
    return await request();
  } catch (err) {
    if (err && typeof err === 'object' && !err.dbStatement) {
      try { err.dbStatement = summarizeStatement(statement); } catch (_) { /* frozen error */ }
    }
    throw err;
  }
}

// A fetch for the libsql client that opens a new connection per request
// instead of reusing idle ones from Node's global agent (keep-alive is on by
// default since Node 19). The client builds a cross-fetch (node-fetch v2)
// Request; passing `agent` here overrides the Request's own agent.
function createNoReuseFetch() {
  const agents = {
    'http:': new http.Agent({ keepAlive: false }),
    'https:': new https.Agent({ keepAlive: false })
  };
  const agent = parsedUrl => agents[parsedUrl.protocol] || agents['https:'];
  return request => crossFetch.fetch(request, { agent });
}

async function createDriver() {
  const url = config.database.turso.url;
  const authToken = config.database.turso.authToken;

  if (!url) {
    throw new Error('TURSO_DATABASE_URL is required when DATABASE_DRIVER=turso');
  }

  // Wrap client creation so auth token is never exposed in error messages
  // (libsql can include the full URL with embedded token in stack traces).
  let client;
  try {
    client = createClient({
      url,
      authToken: authToken || undefined,
      ...(config.database.turso.keepAlive === false ? { fetch: createNoReuseFetch() } : {})
    });
  } catch (err) {
    const safeMsg = err.message
      ? err.message.replace(authToken || '__no_token__', '[REDACTED]')
      : 'Failed to create Turso client';
    throw new Error(`Turso client initialization failed: ${safeMsg}`);
  }

  // Enable foreign keys
  await client.execute('PRAGMA foreign_keys = ON');

  // Turso's hosted service blocks PRAGMA user_version writes, so we
  // track the schema version in a dedicated table instead.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Ensure the single row exists
  await client.execute(
    'INSERT OR IGNORE INTO _schema_version (id, version) VALUES (1, 0)'
  );

  return {
    kind: 'turso',
    persistent: false,

    async transaction(fn) {
      const tx = await tagged('BEGIN (write transaction)', () => client.transaction('write'));
      const adapter = {
        async run(sql, params = []) {
          const result = await tagged(sql, () => tx.execute({ sql, args: params }));
          return {
            lastInsertRowid: Number(result.lastInsertRowid),
            changes: result.rowsAffected
          };
        },
        async all(sql, params = []) {
          const result = await tagged(sql, () => tx.execute({ sql, args: params }));
          return result.rows.map(row => {
            const obj = {};
            for (const col of result.columns) {
              obj[col] = row[col];
            }
            return obj;
          });
        },
        async get(sql, params = []) {
          const rows = await this.all(sql, params);
          return rows[0] || null;
        }
      };

      try {
        const result = await fn(adapter);
        await tagged('COMMIT', () => tx.commit());
        return result;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
    },

    async exec(sql) {
      // exec() is used for multi-statement DDL during migrations.
      // libsql client's executeMultiple handles semicolon-separated SQL,
      // but db.js already splits migrations into individual statements
      // and calls run() on each one. exec() is only used by
      // getSchemaVersion/getLastInsertRowid which are single statements.
      const result = await tagged(sql, () => client.execute(sql));
      // Return in a format compatible with sql.js exec() output:
      // [{ columns: [...], values: [[...], ...] }]
      if (result.rows.length === 0) return [];
      const columns = result.columns;
      const values = result.rows.map(row => columns.map((_, i) => row[i]));
      return [{ columns, values }];
    },

    async run(sql, params = []) {
      const result = await tagged(sql, () => client.execute({ sql, args: params }));
      return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.rowsAffected
      };
    },

    async all(sql, params = []) {
      const result = await tagged(sql, () => client.execute({ sql, args: params }));
      // Convert libsql rows to plain objects
      return result.rows.map(row => {
        const obj = {};
        for (const col of result.columns) {
          obj[col] = row[col];
        }
        return obj;
      });
    },

    async get(sql, params = []) {
      const rows = await this.all(sql, params);
      return rows[0] || null;
    },

    async getLastInsertRowid() {
      const result = await this.exec('SELECT last_insert_rowid()');
      return result[0]?.values[0]?.[0];
    },

    async getSchemaVersion() {
      const result = await client.execute(
        'SELECT version FROM _schema_version WHERE id = 1'
      );
      return result.rows[0]?.version ?? 0;
    },

    async setSchemaVersion(version) {
      const safeVersion = Number.parseInt(version, 10) || 0;
      await client.execute({
        sql: 'UPDATE _schema_version SET version = ? WHERE id = 1',
        args: [safeVersion]
      });
    },

    async persist() {
      // No-op — Turso persists automatically on every write.
    }
  };
}

module.exports = {
  createDriver,
  createNoReuseFetch
};
