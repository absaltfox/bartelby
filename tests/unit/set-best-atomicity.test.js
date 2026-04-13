'use strict';

// Verify that setBest uses a single SQL UPDATE, not two sequential statements.
// We do this by inspecting the source rather than mocking, because the bug
// is a structural one (two-statement gap) that doesn't show up in happy-path tests.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(
  path.join(__dirname, '../../database/models/documents.js'),
  'utf8'
);

describe('setBest', () => {
  it('uses a single UPDATE statement, not two sequential statements', () => {
    // Extract the setBest function body
    const match = src.match(/async setBest\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/);
    expect(match).not.toBeNull();
    const body = match[1];

    // Must contain exactly one runAsync/UPDATE call
    const updateCount = (body.match(/await runAsync/g) || []).length;
    expect(updateCount).toBe(1);

    // Must NOT clear all is_best flags separately (old two-statement pattern)
    expect(body).not.toMatch(/is_best = 0/);
  });
});
