'use strict';

// Pure IIIF Presentation parsing — NO I/O, so it is unit-testable against
// captured fixtures. Targets Presentation API 2.0 (the version UBC Open
// Collections serves); v3 branches are present but v3 is only exercised as a
// Phase 2 concern. Defensive throughout: a single malformed canvas is skipped,
// never fatal (IIIF-in-the-wild is inconsistent).

function detectVersion(doc) {
  const ctx = Array.isArray(doc && doc['@context'])
    ? doc['@context'].join(' ')
    : String((doc && doc['@context']) || '');
  if (/presentation\/3/.test(ctx)) return 3;
  if (doc && doc.type && !doc['@type']) return 3; // v3 uses `type`, v2 uses `@type`
  return 2;
}

// Normalize a label/value that may be a plain string, an array, a v2
// `{ '@value': ... }` object, or a v3 language map `{ en: ['...'] }`.
function firstString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) { const s = firstString(v); if (s) return s; }
    return null;
  }
  if (typeof value === 'object') {
    if (value['@value'] != null) return String(value['@value']);
    for (const v of Object.values(value)) { const s = firstString(v); if (s) return s; }
  }
  return null;
}

// v2/v3 metadata[] → plain { label: value } map.
function parseMetadata(metadataArr) {
  const out = {};
  if (!Array.isArray(metadataArr)) return out;
  for (const entry of metadataArr) {
    if (!entry) continue;
    const label = firstString(entry.label);
    const value = firstString(entry.value);
    if (label && value != null) out[label] = value;
  }
  return out;
}

function parseCanvas(canvas, version) {
  if (!canvas) return null;
  const canvasId = canvas['@id'] || canvas.id || null;
  const label = firstString(canvas.label);
  let serviceBase = null;
  let directImageUrl = null;

  if (version === 3) {
    const annoPage = (Array.isArray(canvas.items) ? canvas.items : [])[0];
    const anno = annoPage && (Array.isArray(annoPage.items) ? annoPage.items : [])[0];
    const body = anno && anno.body;
    if (body) {
      const svc = Array.isArray(body.service) ? body.service[0] : body.service;
      serviceBase = (svc && (svc.id || svc['@id'])) || null;
      if (!serviceBase) directImageUrl = body.id || body['@id'] || null;
    }
  } else {
    const resource = ((Array.isArray(canvas.images) ? canvas.images : [])[0] || {}).resource;
    if (resource) {
      const svc = resource.service;
      const svcNode = Array.isArray(svc) ? svc[0] : svc;
      serviceBase = (svcNode && (svcNode['@id'] || svcNode.id)) || null;
      if (!serviceBase) directImageUrl = resource['@id'] || resource.id || null;
    }
  }

  if (!serviceBase && !directImageUrl) return null;
  return { canvasId, label, serviceBase, directImageUrl };
}

function extractCanvases(doc, version) {
  let raw = [];
  if (version === 3) {
    raw = Array.isArray(doc.items) ? doc.items : [];
  } else {
    const seq = (Array.isArray(doc.sequences) ? doc.sequences : [])[0];
    raw = seq && Array.isArray(seq.canvases) ? seq.canvases : [];
  }
  const out = [];
  for (const canvas of raw) {
    let parsed = null;
    try { parsed = parseCanvas(canvas, version); } catch (_) { parsed = null; }
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseManifest(doc) {
  const version = detectVersion(doc);
  return {
    id: (doc && (doc['@id'] || doc.id)) || null,
    version,
    label: firstString(doc && doc.label),
    description: firstString(doc && doc.description),
    metadata: parseMetadata(doc && doc.metadata),
    rights: (doc && (doc.license || doc.rights)) || null,               // v2 license / v3 rights
    attribution: firstString(doc && doc.attribution)                    // v2
      || firstString(doc && doc.requiredStatement && doc.requiredStatement.value), // v3
    canvases: extractCanvases(doc, version)
  };
}

// Build a renderable Image API 2.0 URL for a parsed canvas: prefer the Image
// API service (`{base}/full/{size}/0/default.jpg`), else the direct image URL.
// `size` is IIIF Image API size syntax, e.g. 'full' or '2000,'.
function buildImageUrl(canvas, size = 'full') {
  if (!canvas) return null;
  if (canvas.serviceBase) {
    return `${String(canvas.serviceBase).replace(/\/+$/, '')}/full/${size}/0/default.jpg`;
  }
  return canvas.directImageUrl || null;
}

module.exports = {
  detectVersion,
  firstString,
  parseMetadata,
  parseCanvas,
  parseManifest,
  buildImageUrl
};
