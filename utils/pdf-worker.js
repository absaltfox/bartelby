// Child process worker for rendering PDF pages to PNG images.
// Runs in a separate process so it doesn't block the main server event loop.

const fs = require('fs');
const storage = require('./storage');

process.on('message', async (msg) => {
  const { pdfTempFile, dbJobId, originalName } = msg;

  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const { createCanvas } = require('canvas');

    const pdfBuffer = storage.readTempFile(pdfTempFile);
    try { storage.deleteTempFile(pdfTempFile); } catch (e) {}

    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer)
    }).promise;

    // Report page count
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

      // Report progress every 10 pages to avoid IPC/DB thrashing
      if (i % 10 === 0 || i === pdf.numPages) {
        process.send({ type: 'progress', dbJobId, pageCount: pdf.numPages, pagesRendered: i });
      }
    }

    pdf.destroy();

    // Wait for the done message to be sent before exiting
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
