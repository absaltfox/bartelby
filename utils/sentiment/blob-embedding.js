'use strict';

// Decode a stored embedding BLOB into a Float32Array, tolerant of how each
// SQLite driver hands a BLOB column back:
//   - better-sqlite3 / sql.js  → Node Buffer / Uint8Array (an ArrayBuffer view)
//   - @libsql/client (Turso)   → a raw ArrayBuffer
//
// Embeddings are written as `Buffer.from(new Float32Array(vec).buffer)`
// (database/models/sentiment.js), i.e. raw little-endian float32 bytes.
//
// The clustering read path previously did
// `new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)`, which
// assumes a Buffer. On Turso the value is an ArrayBuffer whose `.buffer` /
// `.byteOffset` are `undefined`, so the decode collapsed to length 0 for every
// row and UMAP threw `shape=(N, 0)`. See docs/background-jobs.md and
// docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md.
function blobToFloat32Array(blob) {
  if (blob == null) return new Float32Array(0);

  let bytes;
  if (ArrayBuffer.isView(blob)) {
    // Node Buffer or any typed-array view — honor its byteOffset/byteLength.
    // `ArrayBuffer.isView` checks an internal slot, so it is realm-agnostic.
    bytes = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  } else if (typeof blob.byteLength === 'number') {
    // Raw ArrayBuffer — including a cross-realm one (e.g. the ArrayBuffer that
    // @libsql/client hands back for Turso BLOBs). Avoid `instanceof ArrayBuffer`,
    // which is realm-fragile; `new Uint8Array(ab)` accepts any-realm ArrayBuffer.
    bytes = new Uint8Array(blob);
  } else {
    return new Float32Array(0);
  }

  // Copy into a fresh, 4-byte-aligned buffer so the Float32Array view is valid
  // regardless of the source byteOffset alignment, and drop any trailing bytes
  // that do not complete a float.
  const floatCount = Math.floor(bytes.byteLength / 4);
  const aligned = new Uint8Array(floatCount * 4);
  aligned.set(bytes.subarray(0, floatCount * 4));
  return new Float32Array(aligned.buffer);
}

module.exports = { blobToFloat32Array };
