'use strict';

// curator-access predicate family.
//
// Answers "can this user mutate this knowledge-graph row?" — the write-side
// parallel to documentsAsync.buildAccessConditions (which answers "can this
// user see this row?"). Non-admin curators ("collection managers") need to
// act on rows in collections they manage; admins can act on anything.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// (§ "Permission predicate"), each predicate returns
// { allowed: boolean, collectionIds?: number[] } — admins get
// { allowed: true, collectionIds: null } so callers can detect the
// short-circuit and skip the per-collection scoping work that follows.
//
// This module currently exposes entity, citation, relationship, and
// date-expression predicates. The remaining authority-suggestion and
// phrase-target predicates are added by subsequent tasks in PR 1.

function curatorAccessFactory({
  documentCollectionsAsync,
  collectionsAsync,
  userCollectionAccessAsync,
  entitiesAsync,
  citationsAsync,
  relationshipsAsync,
  dateExpressionsAsync,
  authoritySuggestionsAsync,
  roleAtLeast
}) {
  function adminShortCircuit(user) {
    if (user && user.role === 'admin') {
      return { allowed: true, collectionIds: null };
    }
    return null;
  }

  // Entities don't have a direct document_id column (see
  // database/migrations.js v44 — entities are linked to documents through
  // citations). We resolve the entity's containing collections via the
  // citation → document → document_collections chain. If the entity has
  // no citations or its citations' documents aren't in any collection a
  // user manages, the predicate denies.
  async function userCanCurateEntity(user, entityId) {
    const admin = adminShortCircuit(user);
    if (admin) return admin;
    if (!user || !user.id) return { allowed: false };

    const entity = await entitiesAsync.getById(entityId);
    if (!entity) return { allowed: false };

    const collectionIds = await documentCollectionsAsync.listCollectionIdsForEntity(entityId);
    if (!collectionIds.length) return { allowed: false };

    for (const collectionId of collectionIds) {
      const role = await userCollectionAccessAsync.getRoleForUser(user.id, collectionId);
      if (role && roleAtLeast(role, 'manager')) {
        return { allowed: true, collectionIds: [collectionId] };
      }
    }
    return { allowed: false };
  }

  // Citations attach to either an entity, a date_expression, or a
  // relationship. In all three cases the citation's containing collection
  // resolves through an entity, so we forward to userCanCurateEntity once
  // we know which entity to ask about. Per
  // docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
  // § "Permission predicate", citations inherit their collection scope from
  // the entity they support.
  async function userCanCurateCitation(user, citationId) {
    const admin = adminShortCircuit(user);
    if (admin) return admin;
    if (!user || !user.id) return { allowed: false };

    const citation = await citationsAsync.getById(citationId);
    if (!citation) return { allowed: false };

    let entityId = citation.entity_id;
    if (!entityId && citation.relationship_id) {
      const rel = await relationshipsAsync.getById(citation.relationship_id);
      entityId = rel && rel.source_entity_id;
    }
    if (!entityId && citation.date_expression_id) {
      const de = await dateExpressionsAsync.getById(citation.date_expression_id);
      entityId = de && de.entity_id;
    }
    if (!entityId) return { allowed: false };

    return userCanCurateEntity(user, entityId);
  }

  // Relationships connect two entities. Both endpoints are valid handles
  // into the collection-containment chain; we resolve through the source
  // entity. (If a relationship's source and target sit in disjoint
  // collections, the manager only needs rights to one of them — by
  // convention we ask about source. Future task may broaden to union.)
  async function userCanCurateRelationship(user, relationshipId) {
    const admin = adminShortCircuit(user);
    if (admin) return admin;
    if (!user || !user.id) return { allowed: false };

    const rel = await relationshipsAsync.getById(relationshipId);
    if (!rel) return { allowed: false };
    return userCanCurateEntity(user, rel.source_entity_id);
  }

  // Date expressions hang directly off an entity (entity_id FK on the
  // date_expressions table — see migrations.js). Forward to the entity
  // predicate to inherit the citation-resolved collection scope.
  async function userCanCurateDateExpression(user, dateExpressionId) {
    const admin = adminShortCircuit(user);
    if (admin) return admin;
    if (!user || !user.id) return { allowed: false };

    const de = await dateExpressionsAsync.getById(dateExpressionId);
    if (!de) return { allowed: false };
    return userCanCurateEntity(user, de.entity_id);
  }

  return {
    userCanCurateEntity,
    userCanCurateCitation,
    userCanCurateRelationship,
    userCanCurateDateExpression
    // userCanCurateAuthoritySuggestion added in Task 1.4
  };
}

module.exports = { curatorAccessFactory };
