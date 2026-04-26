'use strict';

describe('pdf-worker pdfjs-dist hardening', () => {
  let getDocumentMock;

  beforeEach(() => {
    jest.resetModules();

    getDocumentMock = jest.fn(() => ({
      promise: Promise.resolve({
        numPages: 0,
        getPage: jest.fn(),
        destroy: jest.fn(),
        cleanup: jest.fn()
      })
    }));

    jest.doMock('pdfjs-dist/legacy/build/pdf.js', () => ({
      getDocument: getDocumentMock
    }));

    jest.doMock('canvas', () => ({
      createCanvas: jest.fn(() => ({
        getContext: jest.fn(() => ({})),
        toBuffer: jest.fn(() => Buffer.alloc(0))
      }))
    }));
  });

  it('passes hardening flags to pdfjsLib.getDocument', async () => {
    const pdfWorker = require('../../utils/pdf-worker');
    await pdfWorker.__testables.renderWithPdfjs(Buffer.from('%PDF-1.4'), null);

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const arg = getDocumentMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false
    });
  });
});
