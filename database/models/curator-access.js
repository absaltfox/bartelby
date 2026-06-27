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
// Subsequent tasks in PR 1 will add the remaining per-row predicates
// (citation, relationship, date-expression, authority-suggestion,
// phrase-target). This task covers the entity predicate only.

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

  return {
    userCanCurateEntity
    // additional predicates added in subsequent tasks
  };
}

module.exports = { curatorAccessFactory };
