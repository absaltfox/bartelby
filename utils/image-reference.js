'use strict';

const storage = require('./storage');
const config = require('../config');
const { mimeTypeFromFilename } = require('./mime-types');
const { fetchWithTimeout } = require('./http-client');

// Resolve an image reference to `{ buffer, mimeType }`, tolerant of both local
// uploads and remote (IIIF) URLs:
//   - `/uploads/...`  → delegate to the storage adapter (preserving its
//                       invalid/missing-upload validation); mime from filename.
//   - `http(s)://...` → fetch transiently and NEVER persist. This is how a pure
//                       IIIF reference feeds the transcription worker without
//                       duplicating the source institution's images.
// A bug here breaks transcription for ALL documents, so both branches are
// tested (tests/unit/image-reference.test.js).
async function resolveImageBuffer(ref, opts = {}) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('resolveImageBuffer: empty image reference');
  }
  if (/^https?:\/\//i.test(ref)) {
    return fetchRemoteImage(ref, opts);
  }
  const buffer = await storage.readUploadByUrl(ref);
  return { buffer, mimeType: mimeTypeFromFilename(ref, 'image/png') };
}

async function fetchRemoteImage(url, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : config.iiif.requestTimeoutMs;
  const maxBytes = opts.maxBytes != null ? opts.maxBytes : config.iiif.maxImageBytes;
  const headers = { ...(opts.headers || {}) };
  // Generic IIIF Auth bearer (UBC image requests are open; its api_key is only
  // for the Search API, not the Image API).
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let response;
  try {
    response = await fetchWithTimeout(url, { timeoutMs, redirect: 'follow', headers });
  } catch (err) {
    // Preserve the transient token (ETIMEDOUT/econnreset/etc.) in the message.
    throw new Error(`IIIF_FETCH_FAILED: ${err.message}`);
  }
  if (!response.ok) {
    // Include the numeric status so isTransientError can classify 5xx/429.
    throw new Error(`IIIF_FETCH_FAILED: ${response.status} fetching ${url}`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`IIIF_FETCH_FAILED: ${url} exceeds max ${maxBytes} bytes (content-length ${declared})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`IIIF_FETCH_FAILED: ${url} exceeds max ${maxBytes} bytes (${buffer.byteLength})`);
  }
  return { buffer, mimeType: mimeFromResponseOrRef(response.headers.get('content-type'), url) };
}

// IIIF Image API URLs usually end in `default.jpg` but may have no extension;
// prefer the response Content-Type, falling back to the ref's extension.
function mimeFromResponseOrRef(contentType, ref, fallback = 'image/jpeg') {
  if (contentType && /^image\//i.test(contentType)) {
    return contentType.split(';')[0].trim();
  }
  return mimeTypeFromFilename(ref, fallback);
}

module.exports = { resolveImageBuffer, mimeFromResponseOrRef };
