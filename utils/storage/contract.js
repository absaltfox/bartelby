'use strict';

const REQUIRED_STORAGE_METHODS = [
  'init',
  'sanitizeTempName',
  'getTempFilePath',
  'tempFileExists',
  'tempFileExistsAsync',
  'readTempFile',
  'readTempFileAsync',
  'writeTempFile',
  'copyLocalFileToTemp',
  'deleteTempFile',
  'deleteTempFiles',
  'deleteTempAssets',
  'copyTempFileToUpload',
  'copyTempAssetToUpload',
  'copyLocalFileToUpload',
  'getTempPreviewUrl',
  'deleteUploadByUrl',
  'readUploadByUrl',
  'streamUploadByUrl',
  'getUploadSizeByUrl',
  'toUploadsUrl',
  'resolveStoredUrl'
];

function validateStorageAdapter(adapter, driverName = 'unknown') {
  const missing = REQUIRED_STORAGE_METHODS.filter((methodName) => typeof adapter?.[methodName] !== 'function');
  if (missing.length === 0) return adapter;

  throw new Error(
    `Storage driver "${driverName}" is missing required method${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
  );
}

module.exports = {
  REQUIRED_STORAGE_METHODS,
  validateStorageAdapter
};
