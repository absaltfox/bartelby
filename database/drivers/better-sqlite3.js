'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
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

function createDriver() {
  ensureDataDir();

  const db = new Database(isInMemory ? ':memory:' : dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  return {
    kind: 'better-sqlite3',
    exec(sql) {
      db.exec(sql);
      return [];
    },
    run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return {
        lastInsertRowid: Number(info.lastInsertRowid),
        changes: info.changes
      };
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },
    getLastInsertRowid() {
      return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    },
    getSchemaVersion() {
      return db.pragma('user_version', { simple: true }) || 0;
    },
    setSchemaVersion(version) {
      db.pragma(`user_version = ${Number.parseInt(version, 10) || 0}`);
    },
    persist() {
      // better-sqlite3 writes to disk automatically (WAL mode),
      // but we checkpoint to ensure durability
      if (!isInMemory) {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
      }
    }
  };
}

module.exports = {
  createDriver
};
