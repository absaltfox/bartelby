'use strict';

const {
  normalizeComparable,
  normalizeForMatching,
  similarityScore
} = require('./entity-resolution');

const AUTO_LINK_THRESHOLD = 0.92;
const SUGGESTION_THRESHOLD = 0.78;

async function resolveAuthorityCandidate(mention, normalized, entityType, opts = {}) {
  const { authorities, entityAliases, entities } = require('../database/db');
  const candidate = normalizeComparable(normalized || mention);
  if (!candidate || !entityType) return null;

  const authorityRows = await authorities.search(normalized || mention, 25, {
    authorityType: entityType
  });

  let best = null;
  for (const authority of authorityRows) {
    const members = await authorities.getMembers(authority.id, 50);
    const aliases = await entityAliases.getByEntityIds(members.map((member) => member.id));
    const names = [
      authority.canonical_name,
      ...members.map((member) => member.canonical_name),
      ...aliases.map((alias) => alias.alias)
    ].filter(Boolean);

    for (const value of names) {
      const normalizedValue = normalizeComparable(value);
      if (!normalizedValue) continue;

      if (normalizedValue === candidate) {
        return {
          authorityId: authority.id,
          confidence: 1,
          matchMethod: value === authority.canonical_name ? 'canonical_exact' : 'member_exact',
          autoLink: true
        };
      }

      const expandedCandidate = normalizeForMatching(normalized || mention);
      const expandedValue = normalizeForMatching(value);
      if (expandedCandidate && expandedValue === expandedCandidate) {
        return {
          authorityId: authority.id,
          confidence: 0.97,
          matchMethod: value === authority.canonical_name ? 'canonical_fuzzy' : 'member_fuzzy',
          autoLink: true
        };
      }

      const score = similarityScore(expandedValue, expandedCandidate);
      if (!best || score > best.confidence) {
        best = {
          authorityId: authority.id,
          confidence: score,
          matchMethod: value === authority.canonical_name ? 'similarity_canonical' : 'similarity_member',
          autoLink: score >= AUTO_LINK_THRESHOLD
        };
      }
    }
  }

  if (best && best.confidence >= SUGGESTION_THRESHOLD) {
    return best;
  }

  if (opts.entityId) {
    const entity = await entities.getById(opts.entityId);
    if (entity && Number.isInteger(entity.authority_id)) {
      return {
        authorityId: entity.authority_id,
        confidence: 1,
        matchMethod: 'existing_entity_authority',
        autoLink: true
      };
    }
  }

  return null;
}

async function ensureEntityAuthority(entityInput, opts = {}) {
  const {
    authorities,
    entities,
    authorityLinkSuggestions
  } = require('../database/db');

  const entity = typeof entityInput === 'object' && entityInput
    ? entityInput
    : await entities.getById(Number(entityInput));
  if (!entity) {
    throw new Error('Entity not found.');
  }

  if (Number.isInteger(entity.authority_id)) {
    return {
      authority: await authorities.getById(entity.authority_id),
      created: false,
      linked: false,
      suggested: false,
      matchMethod: 'existing'
    };
  }

  const mention = String(opts.mention || entity.canonical_name || '').trim();
  const normalized = String(opts.normalized || entity.canonical_name || '').trim();
  const entityType = String(opts.entityType || entity.entity_type || '').trim();

  const candidate = await resolveAuthorityCandidate(mention, normalized, entityType, {
    entityId: entity.id
  });

  if (candidate && candidate.autoLink) {
    await entities.assignAuthority(entity.id, candidate.authorityId);
    return {
      authority: await authorities.getById(candidate.authorityId),
      created: false,
      linked: true,
      suggested: false,
      matchMethod: candidate.matchMethod,
      confidence: candidate.confidence
    };
  }

  const authorityId = await authorities.create({
    authority_type: entityType || 'topic',
    canonical_name: normalized || mention || entity.canonical_name,
    description: entity.description || null,
    properties: {}
  });
  await entities.assignAuthority(entity.id, authorityId);

  if (candidate && candidate.authorityId && candidate.confidence >= SUGGESTION_THRESHOLD) {
    await authorityLinkSuggestions.createIfMissing({
      entity_id: entity.id,
      suggested_authority_id: candidate.authorityId,
      confidence: candidate.confidence,
      match_method: candidate.matchMethod,
      status: 'pending'
    });
  }

  return {
    authority: await authorities.getById(authorityId),
    created: true,
    linked: true,
    suggested: !!candidate,
    matchMethod: candidate ? candidate.matchMethod : 'new_authority',
    confidence: candidate ? candidate.confidence : 1
  };
}

module.exports = {
  AUTO_LINK_THRESHOLD,
  SUGGESTION_THRESHOLD,
  resolveAuthorityCandidate,
  ensureEntityAuthority
};
