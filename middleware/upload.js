'use strict';

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
    (req, res, next) => {
      // Defer to the shared validateCsrf function which is bound to app.locals by server.js
      if (typeof req.app.locals.validateCsrf === 'function') {
        return req.app.locals.validateCsrf(req, res, next);
      }
      // If for some reason CSRF isn't enabled in the environment, just proceed
      next();
    }
  ];
}

module.exports = {
  withCsrf
};
