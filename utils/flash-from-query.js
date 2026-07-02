'use strict';

const FLAG_MESSAGES = {
  merged: { type: 'success', message: 'Entity merge completed.' },
  approved: { type: 'success', message: 'Citation approved.' },
  rejected: { type: 'success', message: 'Citation rejected.' },
  deleted: { type: 'success', message: 'Citation deleted.' },
  authorityUpdated: { type: 'success', message: 'Authority assignment updated.' },
  entityUpdated: { type: 'success', message: 'Entity updated.' },
  splitCreated: { type: 'success', message: 'Entity split created.' },
  // authority-detail flags
  authorityMerged: { type: 'success', message: 'Authority merge completed.' },
  unlinked: { type: 'success', message: 'Entity unlinked from this authority.' },
  reassigned: { type: 'success', message: 'Entity moved to another authority.' },
  // review-extractions uses 'confirmed' for citation approval
  confirmed: { type: 'success', message: 'Citation approved.' }
};

/**
 * Maps known query-string flags to flash message objects.
 *
 * Only flags listed in `allowedFlags` are considered — this prevents
 * surprise messages from URL manipulation. The special `error` key is
 * handled separately: if present and a string, it is pushed as an
 * error-type flash regardless of `allowedFlags`.
 *
 * @param {object} query  - req.query object
 * @param {string[]} allowedFlags - whitelist of flag names to check
 * @returns {{ type: string, message: string }[]}
 */
function flashesFromQuery(query, allowedFlags) {
  const out = [];
  for (const flag of allowedFlags) {
    if (query[flag] && FLAG_MESSAGES[flag]) {
      out.push(FLAG_MESSAGES[flag]);
    }
  }
  if (query.error && typeof query.error === 'string') {
    out.push({ type: 'error', message: query.error });
  }
  return out;
}

module.exports = { flashesFromQuery, FLAG_MESSAGES };
