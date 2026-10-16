'use strict';

const { REQUIRED_STORAGE_METHODS, validateStorageAdapter } = require('../../utils/storage/contract');

describe('storage adapter contract', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('requires every documented storage adapter method', () => {
    const brokenAdapter = {
      init() {},
      readUploadByUrl() {}
    };

    expect(() => validateStorageAdapter(brokenAdapter, 'broken')).toThrow(
      'Storage driver "broken" is missing required methods: sanitizeTempName, getTempFilePath, tempFileExists, tempFileExistsAsync, readTempFile, readTempFileAsync, writeTempFile, copyLocalFileToTemp, deleteTempFile, deleteTempFiles, deleteTempAssets, copyTempFileToUpload, copyTempAssetToUpload, copyLocalFileToUpload, getTempPreviewUrl, deleteUploadByUrl, streamUploadByUrl, getUploadSizeByUrl, toUploadsUrl, resolveStoredUrl'
    );
  });

  it.each([
    ['local', '../../utils/storage/local'],
    ['s3', '../../utils/storage/s3']
  ])('%s adapter satisfies the contract', (driverName, modulePath) => {
    const adapter = require(modulePath);

    expect(() => validateStorageAdapter(adapter, driverName)).not.toThrow();
    expect(REQUIRED_STORAGE_METHODS.every((methodName) => typeof adapter[methodName] === 'function')).toBe(true);
  });

  it.each([
    ['local', '../../utils/storage/local'],
    ['s3', '../../utils/storage/s3']
  ])('%s adapter rejects temp names that resolve to a directory', (driverName, modulePath) => {
    const { sanitizeTempName } = require(modulePath);

    expect(sanitizeTempName('.')).toBe('');
    expect(sanitizeTempName('..')).toBe('');
    expect(sanitizeTempName('../..')).toBe('');
    expect(sanitizeTempName('a/b/../..')).toBe('');
    expect(sanitizeTempName('../page-1.jpg')).toBe('page-1.jpg');
    expect(sanitizeTempName('..hidden.png')).toBe('..hidden.png');
  });

  it('fails fast when the configured driver is incomplete', () => {
    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
    jest.doMock('../../utils/storage/local', () => ({
      init: jest.fn()
    }));

    expect(() => require('../../utils/storage')).toThrow(
      'Storage driver "local" is missing required methods: sanitizeTempName, getTempFilePath, tempFileExists, tempFileExistsAsync, readTempFile, readTempFileAsync, writeTempFile, copyLocalFileToTemp, deleteTempFile, deleteTempFiles, deleteTempAssets, copyTempFileToUpload, copyTempAssetToUpload, copyLocalFileToUpload, getTempPreviewUrl, deleteUploadByUrl, readUploadByUrl, streamUploadByUrl, getUploadSizeByUrl, toUploadsUrl, resolveStoredUrl'
    );
  });
});
