'use strict';

const config = require('../config');
const sqljsDriver = require('./drivers/sqljs');
const tursoDriver = require('./drivers/turso');

async function initDriver() {
  switch (config.database.driver) {
    case 'turso':
      return tursoDriver.createDriver();
    case 'sqljs':
    default:
      return sqljsDriver.createDriver();
  }
}

module.exports = {
  initDriver
};
