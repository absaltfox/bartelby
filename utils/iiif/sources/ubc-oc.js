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

const IIIF_HOST = 'https://iiif.library.ubc.ca';
const IIIF_PRESENTATION_BASE = `${IIIF_HOST}/presentation`;
const DEFAULT_PAGE_SIZE = 100;

function itemIdToManifestUrl(collection, itemId, presentationBase = IIIF_PRESENTATION_BASE) {
  const dashed = String(itemId).replace(/\./g, '-');
  return `${String(presentationBase).replace(/\/+$/, '')}/cdm.${collection}.${dashed}.0000/manifest`;
}

// Build a working IIIF Image API URL for a given page of a UBC item.
//
// UBC's manifests DECLARE per-canvas image services with an extra `.0000`
// segment (e.g. cdm.royalfisk.1-0040134.0000.0000) that 404s. The service that
// actually resolves is cdm.{coll}.{itemDashed}.{canvasIndex:04d}, verified live
// against royalfisk (pages .0000/.0001/.0002 all return valid info.json). So we
// DERIVE the image id from the item id + canvas order rather than trusting the
// manifest's declared service['@id'] (which utils/iiif/parser.js buildImageUrl
// uses for generic, spec-compliant sources).
function buildItemImageUrl(collection, itemId, canvasIndex, size = 'full', imageBase = IIIF_HOST) {
  const dashed = String(itemId).replace(/\./g, '-');
  const page = String(canvasIndex).padStart(4, '0');
  return `${String(imageBase).replace(/\/+$/, '')}/image/cdm.${collection}.${dashed}.${page}/full/${size}/0/default.jpg`;
}

// UBC FullText is lightly marked-up HTML (<br>, <sup>, [sic], entities).
// Normalize to plain text suitable for a transcript body.
function cleanFullText(html) {
  if (html == null) return null;
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');            // strip remaining tags (keeps <sup> contents)
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s || null;
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

module.exports = {
  enumerateManifestRefs, itemIdToManifestUrl, buildItemImageUrl, cleanFullText, parseItemsPage, firstText
};
