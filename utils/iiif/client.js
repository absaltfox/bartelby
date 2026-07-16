'use strict';

const config = require('../../config');
const { fetchWithTimeout } = require('../http-client');

// Thin JSON fetch for IIIF Presentation manifests and JSON detail endpoints.
// Kept separate from the pure parser (utils/iiif/parser.js) so parsing stays
// I/O-free and unit-testable. IIIF servers answer to `application/ld+json`;
// UBC's manifest host also accepts plain JSON. The api key (UBC Search API
// secret) is passed as a `?api_key=` query param and must never be logged.
async function fetchIiifJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : config.iiif.requestTimeoutMs;
  const target = new URL(url);
  if (opts.apiKey) target.searchParams.set('api_key', opts.apiKey);

  const headers = {
    Accept: opts.accept || 'application/ld+json, application/json;q=0.9, */*;q=0.5',
    ...(opts.headers || {})
  };

  let resp;
  try {
    resp = await fetchWithTimeout(target.toString(), { timeoutMs, redirect: 'follow', headers });
  } catch (err) {
    // Preserve the transient token (ETIMEDOUT/fetch failed/etc.) for
    // isTransientError classification upstream.
    throw new Error(`IIIF_JSON_FETCH_FAILED: ${err.message}`);
  }
  if (!resp.ok) {
    // Numeric status lets utils/worker-runtime.js isTransientError classify
    // 5xx/429 as retryable and 4xx as permanent.
    throw new Error(`IIIF_JSON_FETCH_FAILED: ${resp.status} fetching ${url}`);
  }
  return await resp.json();
}

module.exports = { fetchIiifJson };
