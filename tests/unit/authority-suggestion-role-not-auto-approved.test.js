'use strict';

const { decideAuthorityLinkAction } = require('../../utils/authority-suggestion-pipeline');

describe('authority-suggestion auto-approve gate excludes role (E1.4)', () => {
  function pair(entityType) {
    return {
      entityA: { entity_type: entityType, canonical_name: 'Superintendent of Education' },
      entityB: { entity_type: entityType, canonical_name: 'Superintendent of Education' }
    };
  }

  it('auto-approves exact-name match for person', () => {
    const decision = decideAuthorityLinkAction(pair('person'), 0.85, { pending_threshold: 0.75, auto_approve_threshold: 0.92 });
    expect(decision.action).toBe('auto_approve_exact');
  });

  it('auto-approves exact-name match for place', () => {
    const decision = decideAuthorityLinkAction(pair('place'), 0.85, { pending_threshold: 0.75, auto_approve_threshold: 0.92 });
    expect(decision.action).toBe('auto_approve_exact');
  });

  it('does NOT auto-approve exact-name match for role (E1.4)', () => {
    const decision = decideAuthorityLinkAction(pair('role'), 0.85, { pending_threshold: 0.75, auto_approve_threshold: 0.92 });
    expect(decision.action).toBe('suggest');
  });

  it('still pending-threshold-discards role pairs below threshold', () => {
    const decision = decideAuthorityLinkAction(pair('role'), 0.5, { pending_threshold: 0.75, auto_approve_threshold: 0.92 });
    expect(decision.action).toBe('discard');
  });
});
