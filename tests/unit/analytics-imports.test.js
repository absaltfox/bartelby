'use strict';

describe('analytics module', () => {
  it('loads without throwing ReferenceError for path or fs', () => {
    expect(() => require('../../utils/analytics')).not.toThrow();
  });

  it('queueLocalBertopicWorker does not throw ReferenceError when called', () => {
    const analytics = require('../../utils/analytics');
    // The function uses path and fs at call time. Calling it will fail for
    // other reasons (no Python, no row) but must NOT throw ReferenceError.
    expect(() => {
      try {
        analytics.queueLocalBertopicWorker(1, 1);
      } catch (err) {
        if (err instanceof ReferenceError) throw err;
        // Other errors (e.g. ENOENT) are acceptable here.
      }
    }).not.toThrow();
  });
});
