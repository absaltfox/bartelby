'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../../config');

const dbPath = config.database.sqljs.filePath;
const isInMemory = dbPath === ':memory:';
const dataDir = isInMemory ? null : path.dirname(dbPath);

function ensureDataDir() {
  if (isInMemory) return;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

async function createDriver() {
  ensureDataDir();

  const SQL = await initSqlJs();
  let db;

  if (!isInMemory && fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  // sql.js `export()` ends any open transaction and discards its writes, and
  // persist() is called from a debounce timer that can land between BEGIN and
  // COMMIT. So the driver tracks transaction boundaries itself (sql.js does not
  // expose SQLite's autocommit flag) and holds a persist requested mid-
  // transaction until the transaction ends.
  let inTransaction = false;
  let persistDeferred = false;

  function writeFile() {
    ensureDataDir();
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  function trackTransaction(sql) {
    const head = String(sql).trimStart().slice(0, 16).toUpperCase();
    if (/^BEGIN\b/.test(head)) {
      // A multi-statement script that opens a transaction is expected to close
      // it as well; only a lone BEGIN leaves one open across calls.
      inTransaction = !/;\s*\S/.test(String(sql));
      return;
    }
    const ends = /^(COMMIT|END)\b/.test(head) ||
      (/^ROLLBACK\b/.test(head) && !/^ROLLBACK\s+(TRANSACTION\s+)?TO\b/.test(String(sql).trimStart().toUpperCase()));
    if (!ends) return;
    inTransaction = false;
    if (persistDeferred) {
      persistDeferred = false;
      writeFile();
    }
  }

  return {
    kind: 'sqljs',
    persistent: !isInMemory,
    exec(sql) {
      const result = db.exec(sql);
      trackTransaction(sql);
      return result;
    },
    run(sql, params = []) {
      db.run(sql, params);
      trackTransaction(sql);
      return {
        lastInsertRowid: this.getLastInsertRowid(),
        changes: db.getRowsModified()
      };
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    },
    get(sql, params = []) {
      const results = this.all(sql, params);
      return results[0] || null;
    },
    getLastInsertRowid() {
      return this.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    },
    getSchemaVersion() {
      return this.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0;
    },
    setSchemaVersion(version) {
      db.run(`PRAGMA user_version = ${Number.parseInt(version, 10) || 0}`);
    },
    persist() {
      if (isInMemory) return;
      if (inTransaction) {
        persistDeferred = true;
        return;
      }
      writeFile();
    }
  };
}

module.exports = {
  createDriver
};
