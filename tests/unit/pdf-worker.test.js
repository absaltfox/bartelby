'use strict';

describe('pdf worker ipc mode', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PDF_WORKER_MODE;
  });

  it('reads queued pdf input through shared temp helpers when the local file is absent', async () => {
    const readTempAsset = jest.fn(async () => Buffer.from('shared-temp-pdf'));
    const deleteTempAssets = jest.fn(async () => {});
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process);

    jest.doMock('../../utils/temp-assets', () => ({
      readTempAsset,
      deleteTempAssets
    }));
    jest.doMock('../../utils/storage', () => ({
      readTempFile: jest.fn(() => {
        throw new Error('local temp file missing');
      })
    }));

    const pdfWorker = require('../../utils/pdf-worker');
    const reportDoneImpl = jest.fn(async () => {});
    const reportFailedImpl = jest.fn(async () => {});
    const renderPdfImpl = jest.fn(async (buffer) => {
      expect(buffer.toString()).toBe('shared-temp-pdf');
      return [{ filename: 'page1.png' }];
    });

    const result = await pdfWorker.__testables.processIpcJob(
      {
        pdfTempFile: 'queue.pdf',
        dbJobId: 42,
        originalName: 'queue.pdf'
      },
      {
        renderPdfImpl,
        reportDoneImpl,
        reportFailedImpl,
        deleteTempAssetsImpl: deleteTempAssets
      }
    );

    expect(result.ok).toBe(true);
    expect(readTempAsset).toHaveBeenCalledWith('queue.pdf');
    expect(reportDoneImpl).toHaveBeenCalledWith(42, [{ filename: 'page1.png' }], 'queue.pdf');
    expect(reportFailedImpl).not.toHaveBeenCalled();
    expect(deleteTempAssets).toHaveBeenCalledWith(['queue.pdf']);

    processOnSpy.mockRestore();
  });
});
