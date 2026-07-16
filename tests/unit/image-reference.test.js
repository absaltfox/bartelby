'use strict';

jest.mock('../../utils/storage', () => ({ readUploadByUrl: jest.fn() }));
const storage = require('../../utils/storage');
const { resolveImageBuffer, mimeFromResponseOrRef } = require('../../utils/image-reference');

function mockResponse({ ok = true, status = 200, contentType = 'image/jpeg', contentLength = null, bytes = Buffer.from([1, 2, 3, 4]) }) {
  const headers = new Map();
  if (contentType != null) headers.set('content-type', contentType);
  if (contentLength != null) headers.set('content-length', String(contentLength));
  return {
    ok,
    status,
    headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

describe('resolveImageBuffer', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

  it('delegates a /uploads/ ref to storage and derives mime from filename', async () => {
    storage.readUploadByUrl.mockResolvedValue(Buffer.from('png-bytes'));
    const { buffer, mimeType } = await resolveImageBuffer('/uploads/letter.png');
    expect(storage.readUploadByUrl).toHaveBeenCalledWith('/uploads/letter.png');
    expect(buffer.toString()).toBe('png-bytes');
    expect(mimeType).toBe('image/png');
  });

  it('fetches a remote IIIF ref transiently, returning buffer + mime from content-type', async () => {
    global.fetch = jest.fn(async () => mockResponse({ contentType: 'image/jpeg', bytes: Buffer.from([9, 9, 9]) }));
    const { buffer, mimeType } = await resolveImageBuffer('https://iiif.example/full/2000,/0/default.jpg');
    expect(storage.readUploadByUrl).not.toHaveBeenCalled();
    expect(Array.from(buffer)).toEqual([9, 9, 9]);
    expect(mimeType).toBe('image/jpeg');
  });

  it('throws a transient-classifiable error on a 5xx', async () => {
    global.fetch = jest.fn(async () => mockResponse({ ok: false, status: 503 }));
    await expect(resolveImageBuffer('https://iiif.example/x.jpg')).rejects.toThrow(/IIIF_FETCH_FAILED: 503/);
  });

  it('rejects an oversize image by content-length', async () => {
    global.fetch = jest.fn(async () => mockResponse({ contentLength: 999999999 }));
    await expect(resolveImageBuffer('https://iiif.example/x.jpg', { maxBytes: 1000 })).rejects.toThrow(/exceeds/);
  });

  it('throws on an empty reference', async () => {
    await expect(resolveImageBuffer('')).rejects.toThrow(/empty image reference/);
  });
});

describe('mimeFromResponseOrRef', () => {
  it('uses an image content-type, stripping parameters', () => {
    expect(mimeFromResponseOrRef('image/png; charset=binary', 'x')).toBe('image/png');
  });
  it('falls back to the ref extension for a non-image content-type', () => {
    expect(mimeFromResponseOrRef('text/html', 'https://iiif/x/default.jpg')).toBe('image/jpeg');
  });
});
