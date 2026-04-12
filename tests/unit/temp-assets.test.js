'use strict';

describe('temp asset helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('reads temp assets via async storage helpers when present', async () => {
    const readTempFileAsync = jest.fn(async () => Buffer.from('async-temp'));

    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
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

    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
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

    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      copyTempAssetToUpload
    }));

    const tempAssets = require('../../utils/temp-assets');
    const result = await tempAssets.copyTempAssetToUpload('page.png', 'page.png', '.png');

    expect(copyTempAssetToUpload).toHaveBeenCalledWith('page.png', 'page.png', '.png');
    expect(result.url).toBe('/uploads/page.png');
  });

  it('treats queued temp asset promotion as a no-op in local storage mode', async () => {
    const tempFileExistsAsync = jest.fn(async () => true);

    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      tempFileExistsAsync,
      tempFileExists: jest.fn(() => true),
      putTempObject: jest.fn()
    }));

    const tempAssets = require('../../utils/temp-assets');
    const files = await tempAssets.promoteQueuedTempAssets(['page1.png', 'page2.png']);

    expect(files).toEqual(['page1.png', 'page2.png']);
  });

  it('uploads queued temp assets to shared temp storage in s3 mode when only local copies exist', async () => {
    const putTempObject = jest.fn(async () => {});
    const readTempFileAsync = jest.fn(async () => Buffer.from('pdf-bytes'));

    jest.doMock('../../config', () => ({
      storage: { driver: 's3' }
    }));
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      tempFileExistsAsync: jest.fn(async () => true),
      tempFileExists: jest.fn(() => true),
      readTempFileAsync,
      putTempObject
    }));

    const tempAssets = require('../../utils/temp-assets');
    const files = await tempAssets.promoteQueuedTempAssets(['queue.pdf']);

    expect(files).toEqual(['queue.pdf']);
    expect(readTempFileAsync).toHaveBeenCalledWith('queue.pdf');
    expect(putTempObject).toHaveBeenCalledWith('queue.pdf', expect.any(Buffer));
  });

  it('fails queued temp asset promotion when a temp asset is missing', async () => {
    jest.doMock('../../config', () => ({
      storage: { driver: 'local' }
    }));
    jest.doMock('../../utils/storage', () => ({
      sanitizeTempName: jest.fn((name) => name),
      tempFileExistsAsync: jest.fn(async () => false),
      tempFileExists: jest.fn(() => false)
    }));

    const tempAssets = require('../../utils/temp-assets');

    await expect(tempAssets.promoteQueuedTempAssets(['missing.png'])).rejects.toMatchObject({
      statusCode: 400,
      message: 'Temporary file not found. Please upload again.'
    });
  });
});
