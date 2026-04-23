'use strict';

const fs = require('fs');
const path = require('path');

const { cropPageStrip } = require('../../utils/grouping-llm');
const { buildGroupsFromAnnotations } = require('../../utils/import-workflow');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'grouping');

describe('grouping pipeline integration', () => {
  const fixtureFiles = [];

  beforeAll(() => {
    const files = fs.readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.png') && f.startsWith('page-'))
      .sort();
    files.forEach((f) => fixtureFiles.push(f));
  });

  it('cropPageStrip produces valid strips for all fixture pages', async () => {
    for (const file of fixtureFiles) {
      const buffer = fs.readFileSync(path.join(FIXTURE_DIR, file));
      const strip = await cropPageStrip(buffer, { region: 'top' });
      expect(Buffer.isBuffer(strip)).toBe(true);
      expect(strip.length).toBeGreaterThan(0);
    }
  });

  it('cropPageStrip bottom region works on fixture pages', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURE_DIR, fixtureFiles[0]));
    const strip = await cropPageStrip(buffer, { region: 'bottom' });
    expect(Buffer.isBuffer(strip)).toBe(true);
  });

  it('cropPageStrip both region returns two strips', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURE_DIR, fixtureFiles[0]));
    const strips = await cropPageStrip(buffer, { region: 'both' });
    expect(Array.isArray(strips)).toBe(true);
    expect(strips).toHaveLength(2);
  });

  it('buildGroupsFromAnnotations finds two documents in fixture annotations', () => {
    // Simulate what the LLM would return for our 6 fixture pages:
    // Pages 1-3 are doc 1 (numbered 1,2,3), pages 4-5 are doc 2 (numbered 1,2), page 6 is unnumbered
    const annotations = [
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: 3 },
      { page: 4, number: 1 },
      { page: 5, number: 2 },
      { page: 6, number: null }
    ];

    const groups = buildGroupsFromAnnotations(annotations, fixtureFiles);

    expect(groups).toHaveLength(2);
    expect(groups[0].pageIndices).toEqual([0, 1, 2]);
    expect(groups[1].pageIndices).toEqual([3, 4]);
  });

  it('buildGroupsFromAnnotations handles single-page documents (ungrouped)', () => {
    // A batch where page 4 starts at "1" but has no continuation
    const annotations = [
      { page: 1, number: 1 },
      { page: 2, number: 2 },
      { page: 3, number: 3 },
      { page: 4, number: 1 },
      { page: 5, number: null },
      { page: 6, number: null }
    ];

    const groups = buildGroupsFromAnnotations(annotations, fixtureFiles);

    // Page 4 starts at 1 but has no page 2 following — should not form a group
    // (current behavior: groups < 2 explicit matches are discarded)
    expect(groups).toHaveLength(1);
    expect(groups[0].pageIndices).toEqual([0, 1, 2]);
  });
});
