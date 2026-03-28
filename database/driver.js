'use strict';

const config = require('../config');
const sqljsDriver = require('./drivers/sqljs');

async function initDriver() {
  switch (config.database.driver) {
    case 'turso':
      return require('./drivers/turso').createDriver();
    case 'sqljs':
    default:
      return sqljsDriver.createDriver();
  }
}

module.exports = {
  initDriver
};
