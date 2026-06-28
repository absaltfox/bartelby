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
// This module exposes entity, citation, relationship, date-expression,
// authority-suggestion, and phrase-target predicates.

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

  // Per spec § "Predicate caching" — within one request, predicates may be
  // called repeatedly (e.g. a bulk endpoint resolving 200 ids). The middleware
  // passes a Map on `opts.cache` keyed by `${kind}:${id}`; we memoize the
  // in-flight promise so concurrent callers share a single resolution rather
  // than re-running the entity → citations → collections chain.
  //
  // The phrase-target predicate uses the normalized phrase string as `id`;
  // string keys work fine in JS Maps so a single helper covers both shapes.
  function withCache(kind, id, opts, compute) {
    if (!opts || !opts.cache) return compute();
    const key = `${kind}:${id}`;
    if (opts.cache.has(key)) return opts.cache.get(key);
    // A rejected predicate promise must NOT stay in the cache; otherwise a
    // single transient DB error propagates to every dependent permission
    // check in the request (e.g. a bulk endpoint resolving 200 ids would
    // see the same rejection 200 times). Delete the key on rejection so
    // future callers can retry cleanly.
    const promise = compute().catch(err => {
      opts.cache.delete(key);
      throw err;
    });
    opts.cache.set(key, promise);
    return promise;
  }

  // Entities don't have a direct document_id column (see
  // database/migrations.js v44 — entities are linked to documents through
  // citations). We resolve the entity's containing collections via the
  // citation → document → document_collections chain. If the entity has
  // no citations or its citations' documents aren't in any collection a
  // user manages, the predicate denies.
  async function userCanCurateEntity(user, entityId, opts) {
    return withCache('entity', entityId, opts, async () => {
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
    });
  }

  // Citations attach to either an entity, a date_expression, or a
  // relationship. In all three cases the citation's containing collection
  // resolves through an entity, so we forward to userCanCurateEntity once
  // we know which entity to ask about. Per
  // docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
  // § "Permission predicate", citations inherit their collection scope from
  // the entity they support.
  async function userCanCurateCitation(user, citationId, opts) {
    return withCache('citation', citationId, opts, async () => {
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

      return userCanCurateEntity(user, entityId, opts);
    });
  }

  // Relationships connect two entities. Both endpoints are valid handles
  // into the collection-containment chain; we resolve through the source
  // entity. (If a relationship's source and target sit in disjoint
  // collections, the manager only needs rights to one of them — by
  // convention we ask about source. Future task may broaden to union.)
  async function userCanCurateRelationship(user, relationshipId, opts) {
    return withCache('relationship', relationshipId, opts, async () => {
      const admin = adminShortCircuit(user);
      if (admin) return admin;
      if (!user || !user.id) return { allowed: false };

      const rel = await relationshipsAsync.getById(relationshipId);
      if (!rel) return { allowed: false };
      return userCanCurateEntity(user, rel.source_entity_id, opts);
    });
  }

  // Date expressions hang directly off an entity (entity_id FK on the
  // date_expressions table — see migrations.js). Forward to the entity
  // predicate to inherit the citation-resolved collection scope.
  async function userCanCurateDateExpression(user, dateExpressionId, opts) {
    return withCache('dateExpression', dateExpressionId, opts, async () => {
      const admin = adminShortCircuit(user);
      if (admin) return admin;
      if (!user || !user.id) return { allowed: false };

      const de = await dateExpressionsAsync.getById(dateExpressionId);
      if (!de) return { allowed: false };
      return userCanCurateEntity(user, de.entity_id, opts);
    });
  }

  // Authority link suggestions hang off an entity via suggestion.entity_id.
  // The suggestion's containing collections are the entity's containing
  // collections, so we forward to the entity predicate once we've resolved
  // the row. Per
  // docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
  // § "Permission predicate", curator-side authority-link actions
  // (approve/reject the suggestion) are entity-side: they decide whether to
  // attach a curator-owned entity to an authority. The authority-side
  // actions (merge, rename, delete the authority itself) stay admin-only
  // and live outside this predicate.
  async function userCanCurateAuthoritySuggestion(user, suggestionId, opts) {
    return withCache('authoritySuggestion', suggestionId, opts, async () => {
      const admin = adminShortCircuit(user);
      if (admin) return admin;
      if (!user || !user.id) return { allowed: false };

      const suggestion = await authoritySuggestionsAsync.getById(suggestionId);
      if (!suggestion) return { allowed: false };
      return userCanCurateEntity(user, suggestion.entity_id, opts);
    });
  }

  // Phrase-targets have a DIFFERENT shape from the row-id predicates above:
  // the input is a normalized phrase string, not a row id. A single phrase
  // can appear across many documents in many collections, so the predicate
  // returns the INTERSECTION of
  //   - collections that contain at least one sentiment_annotations row
  //     with target_kind='phrase' and a matching normalized target_phrase
  //   - collections where the user holds manager-or-higher
  // The phrase-target promote/suppress handler in PR 4 uses the returned
  // collectionIds to scope the corpus-wide UPDATE down to authorized
  // collections only.
  //
  // SECURITY-CRITICAL — see
  // docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
  // § "Phrase-target scope" and § "Phrase-target promotion blast radius".
  // If this list ever included a collection the user does not manage, the
  // PR 4 handler would silently retarget annotations across collection
  // boundaries. The corpus-wide candidate set comes from
  // documentCollectionsAsync.listCollectionsWithPhraseAnnotation, which
  // applies the same LOWER + RTRIM trailing-punctuation normalization the
  // existing admin handler uses (routes/admin-sentiment-phrase-targets.js).
  // Callers should pass the phrase already normalized via
  // db.normalizeSentimentPhrase so JS-side and SQL-side normalizations
  // agree.
  async function userCanCuratePhraseTarget(user, normalizedPhrase, opts) {
    return withCache('phraseTarget', normalizedPhrase, opts, async () => {
      const admin = adminShortCircuit(user);
      if (admin) return admin;
      if (!user || !user.id) return { allowed: false };
      if (!normalizedPhrase) return { allowed: false };

      const candidateCollectionIds = await documentCollectionsAsync.listCollectionsWithPhraseAnnotation(normalizedPhrase);
      if (!candidateCollectionIds.length) return { allowed: false };

      const permitted = [];
      for (const cid of candidateCollectionIds) {
        const role = await userCollectionAccessAsync.getRoleForUser(user.id, cid);
        if (role && roleAtLeast(role, 'manager')) {
          permitted.push(cid);
        }
      }
      if (!permitted.length) return { allowed: false };
      return { allowed: true, collectionIds: permitted };
    });
  }

  return {
    userCanCurateEntity,
    userCanCurateCitation,
    userCanCurateRelationship,
    userCanCurateDateExpression,
    userCanCurateAuthoritySuggestion,
    userCanCuratePhraseTarget
  };
}

module.exports = { curatorAccessFactory };
