// Child process worker for rendering PDF pages to PNG images.
// Runs in a separate process so it doesn't block the main server event loop.
// Uses pdftoppm (poppler-utils) when available, falls back to pdfjs-dist + canvas.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const storage = require('./storage');

function hasPdftoppm() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function renderWithPdftoppm(pdfBuffer, dbJobId) {
  // Write PDF to a temp file for pdftoppm
  const pdfTmpName = `pdftoppm_${Date.now()}.pdf`;
  storage.writeTempFile(pdfTmpName, pdfBuffer);
  const pdfPath = storage.getTempFilePath(pdfTmpName);

  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outDir = path.dirname(pdfPath);
  const outPrefix = path.join(outDir, prefix);

  try {
    // Render all pages at 200 DPI as PNG
    execFileSync('pdftoppm', ['-png', '-r', '200', pdfPath, outPrefix], {
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024
    });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }

  // Collect output files (pdftoppm names them prefix-01.png, prefix-02.png, etc.)
  const outputFiles = fs.readdirSync(outDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort();

  const pageCount = outputFiles.length;
  process.send({ type: 'progress', dbJobId, pageCount, pagesRendered: 0 });

  const pages = [];
  for (let i = 0; i < outputFiles.length; i++) {
    const srcPath = path.join(outDir, outputFiles[i]);
    const filename = `${prefix}_page${i + 1}.png`;
    const pngBuffer = fs.readFileSync(srcPath);
    fs.unlinkSync(srcPath);

    storage.writeTempFile(filename, pngBuffer);
    pages.push({
      pageNumber: i + 1,
      filename,
      previewUrl: storage.getTempPreviewUrl(filename)
    });

    if ((i + 1) % 10 === 0 || i + 1 === pageCount) {
      process.send({ type: 'progress', dbJobId, pageCount, pagesRendered: i + 1 });
    }
  }

  return pages;
}

async function renderWithPdfjs(pdfBuffer, dbJobId) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('canvas');

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer)
  }).promise;

  process.send({ type: 'progress', dbJobId, pageCount: pdf.numPages, pagesRendered: 0 });

  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();

    const filename = `${prefix}_page${i}.png`;
    storage.writeTempFile(filename, canvas.toBuffer('image/png'));
    pages.push({
      pageNumber: i,
      filename,
      previewUrl: storage.getTempPreviewUrl(filename)
    });

    if (i % 10 === 0 || i === pdf.numPages) {
      process.send({ type: 'progress', dbJobId, pageCount: pdf.numPages, pagesRendered: i });
    }
  }

  pdf.destroy();
  return pages;
}

process.on('message', async (msg) => {
  const { pdfTempFile, dbJobId, originalName } = msg;

  try {
    const pdfBuffer = storage.readTempFile(pdfTempFile);
    try { storage.deleteTempFile(pdfTempFile); } catch (e) {}

    const usePdftoppm = hasPdftoppm();
    console.log(`PDF worker: using ${usePdftoppm ? 'pdftoppm' : 'pdfjs-dist'} renderer`);

    const pages = usePdftoppm
      ? await renderWithPdftoppm(pdfBuffer, dbJobId)
      : await renderWithPdfjs(pdfBuffer, dbJobId);

    process.send({ type: 'done', dbJobId, pages, originalName }, () => {
      process.exit(0);
    });
  } catch (err) {
    console.error('PDF worker error:', err);
    process.send({ type: 'failed', dbJobId, error: err.message }, () => {
      try { storage.deleteTempFile(pdfTempFile); } catch (e) {}
      process.exit(1);
    });
  }
});
