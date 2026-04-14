'use strict';

const fs = require('fs');
const path = require('path');

describe('analytics module', () => {
  it('loads without throwing ReferenceError for path or fs', () => {
    expect(() => require('../../utils/analytics')).not.toThrow();
  });

  it('has path and fs imported at the top of the file', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../utils/analytics.js'),
      'utf8'
    );
    // Both imports must appear before the first function definition
    const firstFnIndex = src.search(/^function |^const \w+ = /m);
    const pathIndex = src.indexOf("require('path')");
    const fsIndex = src.indexOf("require('fs')");
    expect(pathIndex).toBeGreaterThan(-1);
    expect(fsIndex).toBeGreaterThan(-1);
    // They should appear near the top (before line 20)
    const lines = src.split('\n');
    const pathLine = lines.findIndex(l => l.includes("require('path')"));
    const fsLine = lines.findIndex(l => l.includes("require('fs')"));
    expect(pathLine).toBeLessThan(20);
    expect(fsLine).toBeLessThan(20);
  });
});
