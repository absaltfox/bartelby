'use strict';

const config = require('../../config');
const localStorage = require('./local');

function getStorage() {
  switch (config.storage.driver) {
    case 's3':
      return require('./s3');
    case 'local':
    default:
      return localStorage;
  }
}

module.exports = getStorage();
