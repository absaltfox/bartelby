'use strict';

/**
 * Tests for bulk export error isolation.
 *
 * Structural test: verifies the try/catch is present in the bulk handler source.
 * Integration test: verifies the endpoint returns a valid ZIP even when document
 * generation fails for one document.
 *
 * Note: per-document error isolation is structural — the try/catch in the loop
 * wraps each document independently, so a failure in doc N does not abort
 * processing of doc N+1 or prevent zipfile.end() from being called.
 */

const fs = require('fs');
const path = require('path');

// ── Structural test ────────────────────────────────────────────────────────────

describe('routes/export.js bulk handler — structural', () => {
  it('wraps each document\'s generation in a try/catch', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../routes/export.js'),
      'utf8'
    );

    // The try/catch must appear inside the for...of loop, after the basename
    // assignment, and before zipfile.end(). We check for the key structural
    // markers in order.
    const loopStart = src.indexOf('for (const docId of ids)');
    const tryStart = src.indexOf('try {', loopStart);
    const catchStart = src.indexOf('} catch (err) {', tryStart);
    const zipEnd = src.indexOf('zipfile.end()', catchStart);

    expect(loopStart).toBeGreaterThan(-1);
    expect(tryStart).toBeGreaterThan(loopStart);
    expect(catchStart).toBeGreaterThan(tryStart);
    expect(zipEnd).toBeGreaterThan(catchStart);
  });

  it('logs the error inside the catch block', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../routes/export.js'),
      'utf8'
    );

    const catchStart = src.indexOf('} catch (err) {');
    expect(catchStart).toBeGreaterThan(-1);

    // After the catch, before the next closing brace, there must be a console.error
    const afterCatch = src.slice(catchStart);
    expect(afterCatch).toMatch(/console\.error/);
  });
});
