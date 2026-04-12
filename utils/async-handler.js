'use strict';

function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}

function runAsync(next, fn) {
  return Promise.resolve()
    .then(fn)
    .catch(next);
}

module.exports = {
  asyncHandler,
  runAsync
};
