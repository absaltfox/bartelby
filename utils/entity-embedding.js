'use strict';

const MAX_CITATION_LENGTH = 120;

/**
 * Build a structured text representation of an entity for embedding.
 * @param {object} entity - { entity_type, canonical_name }
 * @param {string[]} aliases - alternate name forms (canonical name is deduplicated out)
 * @param {string|null} citation - first citation passage text, or null
 * @returns {string}
 */
function buildEntityText(entity, aliases, citation) {
  const canonicalLower = (entity.canonical_name || '').toLowerCase().trim();
  const dedupedAliases = (aliases || []).filter(
    (a) => a && a.toLowerCase().trim() !== canonicalLower
  );

  let text = `${entity.entity_type}: ${entity.canonical_name}.`;

  if (dedupedAliases.length > 0) {
    text += ` Also known as: ${dedupedAliases.join(', ')}.`;
  }

  if (citation) {
    const truncated = String(citation).slice(0, MAX_CITATION_LENGTH);
    text += `\nEvidence: "${truncated}"`;
  }

  return text;
}

module.exports = { buildEntityText };
