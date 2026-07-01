'use strict';

// requireCurate / requireCurateAll — Express middleware factory wrappers
// around the curator-access predicate family.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// (§ "Express middleware"), routes opt in with one line:
//
//   router.post(
//     '/admin/knowledge/entities/:id/edit',
//     requireCurate('entity', 'id'),
//     asyncHandler(handler)
//   );
//
// The wrapper resolves the param (or body field, for phrase-target), calls
// the matching predicate from database/models/curator-access.js, and either
// calls next() or returns 404. No business logic lives here. The bulk
// variant (requireCurateAll) handles the bulk endpoint case per
// § "Bulk endpoints".
//
// Both wrappers share a per-request predicate cache on
// req.curatorPermissionCache (a Map) so repeated predicate calls within a
// single request — common in bulk endpoints resolving up to 200 ids —
// resolve through the cache rather than re-walking the entity →
// citations → collections chain.

const { asyncHandler } = require('../utils/async-handler');
const { curatorAccessAsync } = require('../database/db');

// Maximum number of ids accepted by a single requireCurateAll call. Aligns
// with the BULK_CAP enforced in the existing handlers; checked here BEFORE
// the per-id predicate loop so a malformed payload cannot force unbounded
// DB work against the worker.
const BULK_CAP = 200;

const KIND_TO_PREDICATE = {
  entity:               'userCanCurateEntity',
  citation:             'userCanCurateCitation',
  relationship:         'userCanCurateRelationship',
  dateExpression:       'userCanCurateDateExpression',
  authoritySuggestion:  'userCanCurateAuthoritySuggestion',
  phraseTarget:         'userCanCuratePhraseTarget'
};

// Match positive integers only. Rejects '5abc' (parseInt would coerce to 5),
// '-1', '0', '1.5', '1e3', and other near-numeric strings cleanly. Keeps
// audit-log evidence consistent: the same string the route param carries
// is also the integer the predicate ran against.
const POSITIVE_INT_RE = /^[1-9]\d*$/;

function requireCurate(kind, paramName) {
  const methodName = KIND_TO_PREDICATE[kind];
  if (!methodName) throw new Error(`requireCurate: unknown kind "${kind}"`);

  return asyncHandler(async (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    req.curatorPermissionCache = req.curatorPermissionCache || new Map();

    let id;
    if (paramName) {
      const raw = req.params[paramName];
      if (typeof raw !== 'string' || !POSITIVE_INT_RE.test(raw)) {
        return res.status(404).end();
      }
      id = parseInt(raw, 10);
    } else {
      // phrase-target case: pull normalizedPhrase from body
      id = req.body && req.body.normalizedPhrase;
      if (!id) return res.status(404).end();
    }

    const predicate = curatorAccessAsync[methodName];
    const result = await predicate(req.user, id, { cache: req.curatorPermissionCache });
    if (!result.allowed) return res.status(404).end();

    req.curatorAllowedCollectionIds = result.collectionIds;
    return next();
  });
}

// Bulk variant. Per spec § "Bulk endpoints", bulk approve/reject/delete on
// citations and authority suggestions take up to 200 ids each. The middleware
// resolves all ids by walking the predicate (which itself uses the
// req.curatorPermissionCache to avoid re-querying the same entity twice when
// many citations share an entity) and admits only if every id is permitted.
// A mixed batch with any unpermitted id is rejected wholesale:
//
//   403 { error: 'partial_unauthorized', unauthorizedIds: [...] }
//
// The handler does NOT partial-apply; the client surfaces a toast listing
// the rejected ids.
function requireCurateAll(kind, bodyField) {
  const methodName = KIND_TO_PREDICATE[kind];
  if (!methodName) throw new Error(`requireCurateAll: unknown kind "${kind}"`);

  return asyncHandler(async (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    req.curatorPermissionCache = req.curatorPermissionCache || new Map();

    const rawIds = Array.isArray(req.body && req.body[bodyField]) ? req.body[bodyField] : [];
    const ids = rawIds
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ error: `Missing or empty ${bodyField}.` });

    // Cap BEFORE issuing predicate work so a malformed payload cannot force
    // unbounded DB lookups against the worker.
    if (ids.length > BULK_CAP) {
      return res.status(400).json({ error: 'too_many_ids', max: BULK_CAP });
    }

    const predicate = curatorAccessAsync[methodName];
    // Parallelize per-id checks. The shared req.curatorPermissionCache still
    // de-dupes repeated ids and ids that resolve to the same entity, so this
    // is strictly faster than the sequential loop without changing semantics.
    const results = await Promise.all(
      ids.map(id => predicate(req.user, id, { cache: req.curatorPermissionCache }))
    );
    const unauthorized = ids.filter((_, idx) => !results[idx].allowed);
    if (unauthorized.length) {
      return res.status(403).json({ error: 'partial_unauthorized', unauthorizedIds: unauthorized });
    }
    return next();
  });
}

module.exports = { requireCurate, requireCurateAll, BULK_CAP };
