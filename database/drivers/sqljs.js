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

  return {
    kind: 'sqljs',
    exec(sql) {
      return db.exec(sql);
    },
    run(sql, params = []) {
      db.run(sql, params);
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
      ensureDataDir();
      const data = db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }
  };
}

module.exports = {
  createDriver
};
