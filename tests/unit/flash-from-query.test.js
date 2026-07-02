'use strict';

const { flashesFromQuery, FLAG_MESSAGES } = require('../../utils/flash-from-query');

describe('flashesFromQuery', () => {
  it('returns flashes only for allowed flags present in query', () => {
    const flashes = flashesFromQuery({ merged: '1', approved: '1' }, ['merged']);
    expect(flashes).toEqual([{ type: 'success', message: 'Entity merge completed.' }]);
  });

  it('ignores flags not in allowedFlags', () => {
    const flashes = flashesFromQuery({ merged: '1', approved: '1' }, ['approved']);
    expect(flashes).toEqual([{ type: 'success', message: 'Citation approved.' }]);
  });

  it('ignores unknown flags (not in FLAG_MESSAGES)', () => {
    const flashes = flashesFromQuery({ nope: '1' }, ['nope']);
    expect(flashes).toEqual([]);
  });

  it('returns empty array when no flags match', () => {
    expect(flashesFromQuery({}, ['merged'])).toEqual([]);
  });

  it('returns empty array when query is empty', () => {
    expect(flashesFromQuery({}, ['merged', 'approved', 'deleted'])).toEqual([]);
  });

  it('returns multiple flashes when multiple allowed flags are present', () => {
    const flashes = flashesFromQuery(
      { merged: '1', approved: '1', deleted: '1' },
      ['merged', 'approved', 'deleted']
    );
    expect(flashes).toHaveLength(3);
    expect(flashes[0]).toEqual({ type: 'success', message: 'Entity merge completed.' });
    expect(flashes[1]).toEqual({ type: 'success', message: 'Citation approved.' });
    expect(flashes[2]).toEqual({ type: 'success', message: 'Citation deleted.' });
  });

  it('appends error flash when query.error is a string', () => {
    const flashes = flashesFromQuery({ error: 'Something went wrong.' }, ['merged']);
    expect(flashes).toEqual([{ type: 'error', message: 'Something went wrong.' }]);
  });

  it('appends error flash alongside success flashes', () => {
    const flashes = flashesFromQuery({ merged: '1', error: 'Oops.' }, ['merged']);
    expect(flashes).toHaveLength(2);
    expect(flashes[1]).toEqual({ type: 'error', message: 'Oops.' });
  });

  it('ignores error flag when query.error is not a string', () => {
    const flashes = flashesFromQuery({ error: ['a', 'b'] }, ['merged']);
    expect(flashes).toEqual([]);
  });

  it('exports FLAG_MESSAGES with all expected keys', () => {
    const expectedKeys = [
      'merged', 'approved', 'rejected', 'deleted',
      'authorityUpdated', 'entityUpdated', 'splitCreated',
      'authorityMerged', 'unlinked', 'reassigned', 'confirmed'
    ];
    for (const key of expectedKeys) {
      expect(FLAG_MESSAGES).toHaveProperty(key);
    }
  });
});
