'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

describe('pdf worker ipc mode', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PDF_WORKER_MODE;
  });

  it('reads queued pdf input through shared temp helpers when the local file is absent', async () => {
    const readTempAsset = jest.fn(async () => Buffer.from('shared-temp-pdf'));
    const deleteTempAssets = jest.fn(async () => {});
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
  });

  it('sorts generated poppler page files numerically', () => {
    const pdfWorker = require('../../utils/pdf-worker');

    const files = [
      'prefix-10.png',
      'prefix-2.png',
      'prefix-1.png',
      'prefix-11.png',
      'prefix-3.png'
    ].sort(pdfWorker.__testables.compareNumericFilename);

    expect(files).toEqual([
      'prefix-1.png',
      'prefix-2.png',
      'prefix-3.png',
      'prefix-10.png',
      'prefix-11.png'
    ]);
  });

  it('polls pdfimages extraction progress without waiting for process exit', async () => {
    jest.useFakeTimers();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimages-progress-'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();

    const spawn = jest.fn(() => child);

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => Buffer.from('ok')),
      spawn,
      execSync: jest.fn()
    }));

    const pdfWorker = require('../../utils/pdf-worker');
    const reportProgressImpl = jest.fn(async () => {});
    const promise = pdfWorker.__testables.runPdfimagesWithProgress({
      pdfPath: path.join(tmpDir, 'source.pdf'),
      tempPrefix: path.join(tmpDir, 'embedded'),
      outDir: tmpDir,
      tempPrefixBase: 'embedded',
      dbJobId: 42,
      pageCount: 3,
      timeoutMs: 60 * 1000,
      reportProgressImpl
    });

    fs.writeFileSync(path.join(tmpDir, 'embedded-000.png'), Buffer.from('png'));
    await jest.advanceTimersByTimeAsync(5000);

    expect(reportProgressImpl).toHaveBeenCalledWith(42, 3, 1);
    expect(spawn).toHaveBeenCalledWith('pdfimages', [
      '-png',
      '-p',
      path.join(tmpDir, 'source.pdf'),
      path.join(tmpDir, 'embedded')
    ], expect.any(Object));

    fs.writeFileSync(path.join(tmpDir, 'embedded-001.png'), Buffer.from('png'));
    child.emit('close', 0, null);
    await promise;

    expect(reportProgressImpl).toHaveBeenCalledWith(42, 3, 2);

    jest.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
