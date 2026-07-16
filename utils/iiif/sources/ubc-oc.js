'use strict';

const config = require('../../../config');
const { fetchWithTimeout } = require('../../http-client');

// UBC Open Collections enumeration adapter. UBC exposes no crawlable IIIF
// Collection; you list a collection's items via the Research API and build a
// per-item IIIF manifest URL. Item ids look like "1.0362307"; the IIIF API
// needs the dots replaced with dashes:
//   https://iiif.library.ubc.ca/presentation/cdm.{collection}.1-0362307.0000/manifest
// (the `.0000` compound-object suffix and dot→dash transform are confirmed in
// UBC's own integration demo).
//
// NOTE: the exact response wrapper of `/collections/{id}/items` is not fully
// pinned in UBC's public docs, so `parseItemsPage` is defensive across likely
// shapes; confirm against a live response (needs a registered api_key).

const IIIF_PRESENTATION_BASE = 'https://iiif.library.ubc.ca/presentation';
const DEFAULT_PAGE_SIZE = 100;

function itemIdToManifestUrl(collection, itemId, presentationBase = IIIF_PRESENTATION_BASE) {
  const dashed = String(itemId).replace(/\./g, '-');
  return `${String(presentationBase).replace(/\/+$/, '')}/cdm.${collection}.${dashed}.0000/manifest`;
}

function firstText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return firstText(v[0]);
  if (typeof v === 'object' && v.value != null) return firstText(v.value);
  return null;
}

// Extract item records from a list-response page, tolerant of the wrapper key.
function parseItemsPage(json) {
  const arr = Array.isArray(json)
    ? json
    : (json && (json.data || json.items || json.docs || json.results)) || [];
  const out = [];
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    if (!raw) continue;
    const itemId = raw._id || raw.id || null;
    if (!itemId) continue;
    out.push({
      itemId,
      title: firstText(raw.Title) || firstText(raw.title) || null,
      fullText: firstText(raw.FullText) || firstText(raw.full_text) || null,
      metadata: raw
    });
  }
  return out;
}

async function fetchItemsPage(source, offset, limit) {
  const base = source.search_base_url || config.iiif.ubcSearchBase;
  const apiKey = source.api_key || config.iiif.ubcApiKey;
  const url = new URL(`${String(base).replace(/\/+$/, '')}/collections/${encodeURIComponent(source.collection_identifier)}/items`);
  if (apiKey) url.searchParams.set('api_key', apiKey); // stays on the list call only — never on stored manifest/image URLs
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  const resp = await fetchWithTimeout(url.toString(), {
    timeoutMs: config.iiif.requestTimeoutMs,
    headers: { Accept: 'application/json' }
  });
  if (!resp.ok) {
    // Include the status so isTransientError can classify 5xx/429.
    throw new Error(`UBC_OC_ENUM_FAILED: ${resp.status} for collection ${source.collection_identifier} (offset ${offset})`);
  }
  return resp.json();
}

// Async generator: yields { manifestUrl, itemId, title, fullText, metadata, offset }.
// `deps.fetchPage(source, offset, limit)` is injectable for testing.
async function* enumerateManifestRefs(source, deps = {}) {
  const fetchPage = deps.fetchPage || fetchItemsPage;
  const limit = Number(source.page_size) || DEFAULT_PAGE_SIZE;
  const presentationBase = source.presentation_base || IIIF_PRESENTATION_BASE;
  const cap = config.iiif.maxManifestsPerSync || 0;
  let offset = Number(source.cursor_offset) || 0;
  let emitted = 0;

  for (;;) {
    const page = await fetchPage(source, offset, limit);
    const items = parseItemsPage(page);
    if (items.length === 0) break;
    for (const it of items) {
      yield {
        manifestUrl: itemIdToManifestUrl(source.collection_identifier, it.itemId, presentationBase),
        itemId: it.itemId,
        title: it.title,
        fullText: it.fullText,
        metadata: it.metadata,
        offset
      };
      emitted += 1;
      if (cap && emitted >= cap) return;
    }
    if (items.length < limit) break; // short page → last page
    offset += limit;
  }
}

module.exports = { enumerateManifestRefs, itemIdToManifestUrl, parseItemsPage, firstText };
