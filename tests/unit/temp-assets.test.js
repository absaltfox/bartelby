'use strict';

describe('temp asset helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('reads temp assets via async storage helpers when present', async () => {
    const readTempFileAsync = jest.fn(async () => Buffer.from('async-temp'));

    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      readTempFileAsync,
      tempFileExistsAsync: jest.fn(async () => true)
    }));

    const tempAssets = require('../../utils/temp-assets');
    const buffer = await tempAssets.readTempAsset('page.png');

    expect(readTempFileAsync).toHaveBeenCalledWith('page.png');
    expect(buffer.toString()).toBe('async-temp');
  });

  it('falls back to temp object reads when sync temp files are unavailable', async () => {
    const getTempObject = jest.fn(async () => Buffer.from('s3-temp'));

    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      tempFileExists: jest.fn(() => false),
      readTempFile: jest.fn(),
      getTempObject
    }));

    const tempAssets = require('../../utils/temp-assets');
    const buffer = await tempAssets.readTempAsset('page.png');

    expect(getTempObject).toHaveBeenCalledWith('page.png');
    expect(buffer.toString()).toBe('s3-temp');
  });

  it('delegates upload copies through the unified async helper', async () => {
    const copyTempAssetToUpload = jest.fn(async () => ({ url: '/uploads/page.png' }));

    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      copyTempAssetToUpload
    }));

    const tempAssets = require('../../utils/temp-assets');
    const result = await tempAssets.copyTempAssetToUpload('page.png', 'page.png', '.png');

    expect(copyTempAssetToUpload).toHaveBeenCalledWith('page.png', 'page.png', '.png');
    expect(result.url).toBe('/uploads/page.png');
  });
});
