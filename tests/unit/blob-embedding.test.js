'use strict';

// Regression guard for the Turso BLOB-decode bug: the clustering worker read
// embedding BLOBs assuming a Node Buffer, but @libsql/client (Turso) returns a
// raw ArrayBuffer whose `.buffer`/`.byteOffset` are undefined — so every vector
// decoded to length 0 (UMAP then threw shape=(N, 0)). See docs/background-jobs.md
// and docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md.

const { blobToFloat32Array } = require('../../utils/sentiment/blob-embedding');

// The exact storage format used by database/models/sentiment.js
// (`Buffer.from(new Float32Array(embedding).buffer)`).
const VEC = [0.1, 0.25, -0.5, 0.75, 1.0, -1.0];
const storedBuffer = Buffer.from(new Float32Array(VEC).buffer);

function approxEqual(actual, expected) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
}

describe('blobToFloat32Array', () => {
  it('decodes a Node Buffer (better-sqlite3 / sql.js path)', () => {
    const out = blobToFloat32Array(storedBuffer);
    expect(out).toBeInstanceOf(Float32Array);
    approxEqual(Array.from(out), VEC);
  });

  it('decodes a raw ArrayBuffer (Turso / @libsql/client path) — the regression', () => {
    // How Turso hands the same BLOB back: a raw ArrayBuffer.
    const ab = storedBuffer.buffer.slice(
      storedBuffer.byteOffset,
      storedBuffer.byteOffset + storedBuffer.byteLength
    );
    // (Intentionally no `instanceof ArrayBuffer` check: under the jsdom test
    // realm a Node-Buffer-derived ArrayBuffer fails instanceof — the same
    // realm fragility the helper is hardened against.)
    const out = blobToFloat32Array(ab);
    expect(out.length).toBe(VEC.length); // was 0 before the fix
    approxEqual(Array.from(out), VEC);
  });

  it('decodes a Uint8Array view with a non-zero byteOffset', () => {
    // Simulate a pooled/offset view: embed the bytes inside a larger buffer.
    const backing = new Uint8Array(storedBuffer.byteLength + 8);
    backing.set(storedBuffer, 8);
    const view = new Uint8Array(backing.buffer, 8, storedBuffer.byteLength);
    approxEqual(Array.from(blobToFloat32Array(view)), VEC);
  });

  it('returns an empty Float32Array for null / undefined', () => {
    expect(blobToFloat32Array(null).length).toBe(0);
    expect(blobToFloat32Array(undefined).length).toBe(0);
  });

  it('drops trailing bytes that do not complete a float', () => {
    const trailing = Buffer.concat([storedBuffer, Buffer.from([0x01, 0x02])]);
    expect(blobToFloat32Array(trailing).length).toBe(VEC.length);
  });
});
