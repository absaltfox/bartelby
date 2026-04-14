'use strict';

const { validateCsrf } = require('./csrf');

/**
 * Wraps a Multer upload middleware by chaining it strictly with the application's
 * global CSRF validation function. This ensures that any multipart form endpoints
 * are securely validated after the body has been parsed, closing the fail-open
 * vulnerability where a developer might forget to validate manually.
 *
 * @param {Function} uploadMiddleware - the initialized multer upload function (e.g. upload.single('file'))
 * @returns {Array} - Express middleware array
 */
function withCsrf(uploadMiddleware) {
  return [
    uploadMiddleware,
    validateCsrf
  ];
}

module.exports = {
  withCsrf
};
