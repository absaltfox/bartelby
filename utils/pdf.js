'use strict';

const { createCanvas, Image } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
const storage = require('./storage');
const { NodeCanvasFactory } = require('./pdf-canvas-factory');

const RENDER_SCALE = 2.0; // 2x for decent quality page images

/**
 * Convert a PDF buffer into an array of PNG page images.
 * Returns: [{ pageNumber, buffer (PNG), width, height }]
 */
async function pdfToImages(pdfBuffer, opts = {}) {
  const scale = opts.scale || RENDER_SCALE;

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    canvasFactory: new NodeCanvasFactory()
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const pages = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx,
      viewport
    }).promise;

    const pngBuffer = canvas.toBuffer('image/png');
    pages.push({
      pageNumber: i,
      buffer: pngBuffer,
      width: viewport.width,
      height: viewport.height
    });

    page.cleanup();
  }

  pdf.destroy();
  return pages;
}

/**
 * Save page images to a temp directory.
 * Returns: [{ pageNumber, filename, path }]
 */
async function savePdfPages(pdfBuffer, tempDir) {
  const pages = await pdfToImages(pdfBuffer);
  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const saved = [];

  for (const page of pages) {
    const filename = `${prefix}_page${page.pageNumber}.png`;
    storage.writeTempFile(filename, page.buffer);
    saved.push({
      pageNumber: page.pageNumber,
      filename,
      previewUrl: storage.getTempPreviewUrl(filename)
    });
  }

  return saved;
}

module.exports = { pdfToImages, savePdfPages };
