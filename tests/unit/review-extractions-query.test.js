'use strict';

describe('citations.list review query', () => {
  it('computes support citation distance inside a derived subquery', async () => {
    const knowledgeGraphFactory = require('../../database/models/knowledge-graph');
    const allAsync = jest.fn(async () => []);

    const models = knowledgeGraphFactory(
      null,
      jest.fn(),
      jest.fn(),
      allAsync,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      () => false
    );

    await models.citations.list('all', 25, 0, { reviewKind: 'all' });

    expect(allAsync).toHaveBeenCalledTimes(1);
    const [sql, params] = allAsync.mock.calls[0];

    expect(sql).toContain('SELECT ranked.id');
    expect(sql).toContain('AS distance_from_primary');
    expect(sql).toContain('ORDER BY distance_from_primary ASC');
    expect(sql).not.toContain('ORDER BY ABS(COALESCE(c2.passage_start, 0) - COALESCE(c.passage_start, 0))');
    expect(sql).not.toContain('ORDER BY ABS(COALESCE(c3.passage_start, 0) - COALESCE(c.passage_start, 0))');
    expect(sql).not.toContain('ORDER BY ABS(COALESCE(c4.passage_start, 0) - COALESCE(c.passage_start, 0))');
    expect(params.slice(-2)).toEqual([25, 0]);
  });
});
