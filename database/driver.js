'use strict';

const config = require('../config');

function hasBetterSqlite3() {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch (_) {
    return false;
  }
}

async function initDriver() {
  switch (config.database.driver) {
    case 'turso':
      return require('./drivers/turso').createDriver();
    case 'sqljs':
      return require('./drivers/sqljs').createDriver();
    case 'better-sqlite3':
      return require('./drivers/better-sqlite3').createDriver();
    default:
      // Auto-select: prefer better-sqlite3 (has FTS5) over sql.js
      if (hasBetterSqlite3()) {
        return require('./drivers/better-sqlite3').createDriver();
      }
      return require('./drivers/sqljs').createDriver();
  }
}

module.exports = {
  initDriver
};
