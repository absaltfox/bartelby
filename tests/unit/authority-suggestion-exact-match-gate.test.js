'use strict';

const { decideAuthorityLinkAction } = require('../../utils/authority-suggestion-pipeline');

describe('decideAuthorityLinkAction exact-match gate uses normalizeForMatching (A3.1)', () => {
  function pair(nameA, nameB, entityType = 'person') {
    return {
      entityA: { entity_type: entityType, canonical_name: nameA },
      entityB: { entity_type: entityType, canonical_name: nameB }
    };
  }

  const thresholds = { pending_threshold: 0.75, auto_approve_threshold: 0.92 };

  it('auto-approves "Wm. Jessop" ↔ "William Jessop" via abbreviation expansion', () => {
    const decision = decideAuthorityLinkAction(pair('Wm. Jessop', 'William Jessop'), 0.85, thresholds);
    expect(decision.action).toBe('auto_approve_exact');
    expect(decision.exactNameMatch).toBe(true);
  });

  it('auto-approves "Jno. Smith" ↔ "John Smith" via abbreviation expansion', () => {
    const decision = decideAuthorityLinkAction(pair('Jno. Smith', 'John Smith'), 0.85, thresholds);
    expect(decision.action).toBe('auto_approve_exact');
  });

  it('auto-approves "Mr. Jessop" ↔ "Jessop" via honorific strip', () => {
    const decision = decideAuthorityLinkAction(pair('Mr. Jessop', 'Jessop'), 0.85, thresholds);
    expect(decision.action).toBe('auto_approve_exact');
  });

  it('does NOT auto-approve "Mr. Jessop" ↔ "Mr. Smith" (different surnames after honorific strip)', () => {
    const decision = decideAuthorityLinkAction(pair('Mr. Jessop', 'Mr. Smith'), 0.85, thresholds);
    expect(decision.action).not.toBe('auto_approve_exact');
  });

  it('exact-match gate still excludes role/organization/etc. types from auto-approve (E1.4 pinning preserved)', () => {
    const decision = decideAuthorityLinkAction(pair('Wm. Jessop', 'William Jessop', 'role'), 0.85, thresholds);
    expect(decision.action).not.toBe('auto_approve_exact');
    expect(decision.action).toBe('suggest');
  });

  it('exact-match gate still respects pending threshold (low confidence → discard, not auto-approve)', () => {
    const decision = decideAuthorityLinkAction(pair('Wm. Jessop', 'William Jessop'), 0.5, thresholds);
    expect(decision.action).toBe('discard');
  });

  it('exact-match gate applies to "place" type (e.g., "Victoria" ↔ "Victoria")', () => {
    const decision = decideAuthorityLinkAction(pair('Victoria', 'Victoria', 'place'), 0.85, thresholds);
    expect(decision.action).toBe('auto_approve_exact');
  });

  // Final-review on commit dc36950 caught: Jr/Sr/II/III/IV were in HONORIFICS
  // and got stripped by normalizeForMatching, so father-and-son same-name
  // pairs would silently auto-approve into one authority. Fix removed them
  // from HONORIFICS; these specs pin the corrected behavior.
  it('does NOT auto-approve "John Smith Jr" ↔ "John Smith Sr" (generational suffixes distinguish people)', () => {
    const decision = decideAuthorityLinkAction(pair('John Smith Jr', 'John Smith Sr'), 0.85, thresholds);
    expect(decision.action).not.toBe('auto_approve_exact');
  });

  it('does NOT auto-approve "John Smith II" ↔ "John Smith III" (Roman-numeral suffixes distinguish people)', () => {
    const decision = decideAuthorityLinkAction(pair('John Smith II', 'John Smith III'), 0.85, thresholds);
    expect(decision.action).not.toBe('auto_approve_exact');
  });

  it('does NOT auto-approve "John Smith" ↔ "John Smith Jr" (the suffix marks a specific generation)', () => {
    const decision = decideAuthorityLinkAction(pair('John Smith', 'John Smith Jr'), 0.85, thresholds);
    expect(decision.action).not.toBe('auto_approve_exact');
  });
});
