'use strict';

describe('import workflow helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('parses grouping state and sanitizes grouped pages', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => (pages || []).map((page) => String(page).trim()).filter(Boolean)
    }));

    const { parseGroupingState } = require('../../utils/import-workflow');
    const parsed = parseGroupingState({
      collectionIds: ['5', 'bad', '5'],
      groups: [
        { label: ' Document A ', source: 'manual', confidence: 'high', pages: [' page-1 ', 'page-2'] },
        { label: 'Short', source: 'ai', confidence: 'low', pages: ['single-page'] }
      ]
    });

    expect(parsed).toEqual({
      collectionIds: [5, 5],
      groups: [
        {
          label: 'Document A',
          source: 'manual',
          confidence: 'high',
          pages: ['page-1', 'page-2']
        }
      ]
    });
  });

  it('enforces managed collection access for non-admin imports', async () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));
    jest.doMock('../../database/db', () => ({
      userCollectionAccessAsync: {
        getManagerCollectionIds: jest.fn(async () => [2, 3])
      }
    }));

    const { getAuthorizedCollectionIds } = require('../../utils/import-workflow');

    await expect(getAuthorizedCollectionIds({
      user: { id: 99, role: 'user' }
    }, [2, 4])).rejects.toThrow('You do not have permission to import into one or more selected collections.');

    await expect(getAuthorizedCollectionIds({
      user: { id: 99, role: 'user' },
      managedCollectionIds: [2, 3]
    }, [2, 3, 3])).resolves.toEqual([2, 3]);
  });

  it('builds numbered document groups from page annotations', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: 2 },
      { page: 4, number: 3 },
      { page: 5, number: 1 },
      { page: 6, number: 2 }
    ], ['a', 'b', 'c', 'd', 'e', 'f']);

    expect(groups).toEqual([
      { pageIndices: [0, 1, 2, 3], label: 'Document (pages 1, 2, 3, 4)', confidence: 'medium' },
      { pageIndices: [4, 5], label: 'Document (pages 5, 6)', confidence: 'medium' }
    ]);
  });

  it('handles annotations starting after page 1 (partial sequence)', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');

    // Sequence starts at page 3 with number "3" — no "1" anchor, so no group
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 3 },
      { page: 2, number: 4 },
      { page: 3, number: 5 }
    ], ['a', 'b', 'c']);

    expect(groups).toEqual([]);
  });

  it('handles all-null annotations (no detected numbers)', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: null },
      { page: 2, number: null },
      { page: 3, number: null }
    ], ['a', 'b', 'c']);

    expect(groups).toEqual([]);
  });

  it('handles empty annotations array', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    expect(buildGroupsFromAnnotations([], ['a', 'b'])).toEqual([]);
    expect(buildGroupsFromAnnotations(null, ['a', 'b'])).toEqual([]);
  });

  it('tolerates a missing page in the middle of a sequence', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');

    // Pages: 1, 2, null (missing), 4 — should keep the group if anchored
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: null },
      { page: 4, number: 4 }
    ], ['a', 'b', 'c', 'd']);

    // The unreadable page should be included, and the helper should allow a
    // one-step numbering jump on the next page to account for the missed folio.
    expect(groups).toHaveLength(1);
    expect(groups[0].pageIndices).toEqual([0, 1, 2, 3]);
    expect(groups[0].confidence).toBe('low');
  });

  it('does not bridge a numbering jump without an unreadable page', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: 4 }
    ], ['a', 'b', 'c']);

    expect(groups).toHaveLength(1);
    expect(groups[0].pageIndices).toEqual([0, 1]);
    expect(groups[0].confidence).toBe('medium');
  });

  it('does not bridge more than one missing folio number after an unreadable page', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: null },
      { page: 4, number: 5 }
    ], ['a', 'b', 'c', 'd']);

    expect(groups).toHaveLength(1);
    expect(groups[0].pageIndices).toEqual([0, 1]);
    expect(groups[0].confidence).toBe('medium');
  });

  it('marks uninterrupted sequences as high confidence', () => {
    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: (pages) => pages || []
    }));

    const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');
    const groups = buildGroupsFromAnnotations([
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: 3 },
      { page: 4, number: 4 }
    ], ['a', 'b', 'c', 'd']);

    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('high');
  });
});
