'use strict';

// curator-access predicate family.
//
// Answers "can this user mutate this knowledge-graph row?" — the write-side
// parallel to documentsAsync.buildAccessConditions (which answers "can this
// user see this row?"). Non-admin curators ("collection managers") need to
// act on rows in collections they manage; admins can act on anything.
//
// Subsequent tasks in PR 1 will add the per-row predicates (entity,
// citation, relationship, date-expression, authority-suggestion). This
// scaffold only handles the admin short-circuit so the factory wiring and
// test harness can land first.

function curatorAccessFactory({
  documentCollectionsAsync,
  collectionsAsync,
  entitiesAsync,
  citationsAsync,
  relationshipsAsync,
  dateExpressionsAsync,
  authoritySuggestionsAsync
}) {
  function adminShortCircuit(user) {
    if (user && user.role === 'admin') {
      return { allowed: true, collectionIds: null };
    }
    return null;
  }

  async function userCanCurateEntity(user, entityId) {
    const admin = adminShortCircuit(user);
    if (admin) return admin;
    return { allowed: false };
  }

  return {
    userCanCurateEntity
    // additional predicates added in subsequent tasks
  };
}

module.exports = { curatorAccessFactory };
