'use strict';

// Minimal fetch wrapper adding a request timeout via AbortController. Extends
// the bare `fetch` usage in utils/batch-core.js; used by the image-reference
// resolver and the IIIF client. Kept intentionally small.
async function fetchWithTimeout(url, { timeoutMs = 30000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Normalize an abort/timeout into a message isTransientError classifies as
    // retryable (utils/worker-runtime.js keys on the ETIMEDOUT token).
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      const e = new Error(`ETIMEDOUT: request to ${url} timed out after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
