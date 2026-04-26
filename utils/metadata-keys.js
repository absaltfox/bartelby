'use strict';

// Keys reserved for system use. Any value the client supplies under these
// keys is silently dropped before being persisted, because they feed into
// authorization or filesystem logic (see database/models/documents.js
// getIdsByUploadUrl and server.js /uploads/:filename access check).
const METADATA_RESERVED_KEYS = new Set([
  'additional_pages',
  '_upload_filename'
]);

function stripReservedMetadataKeys(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (METADATA_RESERVED_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

module.exports = {
  METADATA_RESERVED_KEYS,
  stripReservedMetadataKeys
};
