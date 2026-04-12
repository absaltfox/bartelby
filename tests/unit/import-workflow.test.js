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
        { label: ' Document A ', source: 'manual', pages: [' page-1 ', 'page-2'] },
        { label: 'Short', source: 'ai', pages: ['single-page'] }
      ]
    });

    expect(parsed).toEqual({
      collectionIds: [5, 5],
      groups: [
        {
          label: 'Document A',
          source: 'manual',
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
      { pageIndices: [0, 1, 2, 3], label: 'Document (pages 1, 2, 3, 4)' },
      { pageIndices: [4, 5], label: 'Document (pages 5, 6)' }
    ]);
  });
});
