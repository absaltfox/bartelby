'use strict';

const { Readable } = require('stream');

function createStorageMock(overrides = {}) {
  const local = jest.requireActual('../../utils/storage/local');

  return {
    ...local,
    readUploadByUrl: jest.fn(async (url) => Buffer.from(`mock:${url}`)),
    streamUploadByUrl: jest.fn(async (url) => Readable.from([Buffer.from(`mock:${url}`)])),
    getUploadSizeByUrl: jest.fn(async () => 17),
    getPresignedUploadUrl: jest.fn(async (url) => `https://signed.example.test${url}?sig=test`),
    ...overrides
  };
}

module.exports = {
  createStorageMock
};
