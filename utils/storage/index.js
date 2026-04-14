'use strict';

const config = require('../../config');
const localStorage = require('./local');
const { validateStorageAdapter } = require('./contract');

function getStorage() {
  switch (config.storage.driver) {
    case 's3':
      return require('./s3');
    case 'local':
    default:
      return localStorage;
  }
}

const storage = getStorage();

module.exports = validateStorageAdapter(storage, config.storage.driver || 'local');
