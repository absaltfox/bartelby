'use strict';

const {
  parseArgs,
  isEligibleExactSuggestion,
  backfillExactAuthoritySuggestions
} = require('../../scripts/backfill-exact-authority-suggestions');

describe('backfill exact authority suggestions script', () => {
  test('parseArgs defaults to dry-run embedding threshold backfill', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      threshold: 0.75,
      limit: null,
      matchMethod: 'embedding',
      maxApprove: null,
      delayMs: 0,
      retries: 3
    });
  });

  test('isEligibleExactSuggestion accepts normalized exact person/place names only', () => {
    const notGeneric = () => false;

    expect(isEligibleExactSuggestion({
      entity_type: 'person',
      entity_name: ' Alice  Reed ',
      authority_name: 'alice reed'
    }, notGeneric)).toEqual({ eligible: true, reason: null });

    expect(isEligibleExactSuggestion({
      entity_type: 'place',
      entity_name: 'Victoria, British Columbia',
      authority_name: 'Victoria British Columbia'
    }, notGeneric)).toEqual({ eligible: true, reason: null });

    expect(isEligibleExactSuggestion({
      entity_type: 'organization',
      entity_name: 'High School',
      authority_name: 'High School'
    }, notGeneric)).toEqual({ eligible: false, reason: 'type' });

    expect(isEligibleExactSuggestion({
      entity_type: 'person',
      entity_name: 'Alice Reed',
      authority_name: 'A. Reed'
    }, notGeneric)).toEqual({ eligible: false, reason: 'name' });
  });

  test('isEligibleExactSuggestion skips active generic terms', () => {
    const generic = (name) => String(name).toLowerCase() === 'victoria';
    expect(isEligibleExactSuggestion({
      entity_type: 'place',
      entity_name: 'Victoria',
      authority_name: 'Victoria'
    }, generic)).toEqual({ eligible: false, reason: 'generic' });
  });

  test('dry-run reports eligible rows without approving', async () => {
    const approve = jest.fn();
    const db = makeMockDb([
      makeRow({ id: 1, entity_type: 'person', entity_name: 'Alice Reed', authority_name: 'Alice Reed' }),
      makeRow({ id: 2, entity_type: 'person', entity_name: 'Alice Reed', authority_name: 'A. Reed' }),
      makeRow({ id: 3, entity_type: 'place', entity_name: 'Victoria', authority_name: 'Victoria' })
    ], { activeTerms: [{ term: 'Victoria', normalized_term: 'victoria', entity_type: 'place' }], approve });

    const summary = await backfillExactAuthoritySuggestions(db, { apply: false });

    expect(summary.scanned).toBe(3);
    expect(summary.eligible).toBe(1);
    expect(summary.approved).toBe(0);
    expect(summary.skipped.name).toBe(1);
    expect(summary.skipped.generic).toBe(1);
    expect(approve).not.toHaveBeenCalled();
  });

  test('apply approves through the model and ignores rows reviewed mid-run', async () => {
    const approve = jest.fn(async () => {});
    const db = makeMockDb([
      makeRow({ id: 11, entity_type: 'person', entity_name: 'Alice Reed', authority_name: 'Alice Reed' }),
      makeRow({ id: 12, entity_type: 'place', entity_name: 'Victoria', authority_name: 'Victoria' })
    ], {
      approve,
      getById: jest.fn(async (id) => ({ id, status: id === 12 ? 'rejected' : 'pending' }))
    });

    const summary = await backfillExactAuthoritySuggestions(db, { apply: true });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(11, null);
    expect(summary.eligible).toBe(2);
    expect(summary.approved).toBe(1);
    expect(summary.skipped.alreadyReviewed).toBe(1);
  });

  test('apply respects maxApprove', async () => {
    const approve = jest.fn(async () => {});
    const db = makeMockDb([
      makeRow({ id: 21, entity_name: 'Alice Reed', authority_name: 'Alice Reed' }),
      makeRow({ id: 22, entity_name: 'Bob Grant', authority_name: 'Bob Grant' })
    ], { approve });

    const summary = await backfillExactAuthoritySuggestions(db, { apply: true, maxApprove: 1 });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(21, null);
    expect(summary.eligible).toBe(2);
    expect(summary.approved).toBe(1);
    expect(summary.skipped.maxApprove).toBe(1);
  });
});

function makeRow(overrides = {}) {
  return {
    id: 1,
    entity_id: 10,
    suggested_authority_id: 20,
    confidence: 0.82,
    match_method: 'embedding',
    status: 'pending',
    entity_type: 'person',
    entity_name: 'Alice Reed',
    current_authority_id: null,
    authority_name: 'Alice Reed',
    ...overrides
  };
}

function makeMockDb(rows, { activeTerms = [], approve = jest.fn(), getById = null } = {}) {
  return {
    allAsync: jest.fn(async () => rows),
    runAsync: jest.fn(async () => ({})),
    authorityGenericTermsAsync: {
      listActive: jest.fn(async () => activeTerms)
    },
    authorityLinkSuggestionsAsync: {
      getById: getById || jest.fn(async (id) => ({ id, status: 'pending' })),
      approve
    }
  };
}
