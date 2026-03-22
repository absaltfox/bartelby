'use strict';

const { createCanvas, Image } = require('canvas');

/**
 * Custom CanvasFactory for pdfjs-dist v4+ running in Node.js with node-canvas.
 * pdfjs-dist v4 requires an explicit canvas factory when not running in a browser.
 */
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

module.exports = { NodeCanvasFactory };
