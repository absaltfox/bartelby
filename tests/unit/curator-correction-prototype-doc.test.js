'use strict';

const fs = require('fs');
const path = require('path');

describe('curator correction UX prototype document', () => {
  test('captures static correction prototypes with shared classes and authority warning', () => {
    const doc = fs.readFileSync(
      path.join(__dirname, '../../docs/reviews/2026-06-20-curator-correction-ux-prototypes.md'),
      'utf8'
    );

    expect(doc).toContain('## Entity Edit');
    expect(doc).toContain('## Entity Split');
    expect(doc).toContain('## Phrase Target Reconciliation');
    expect(doc).toContain('## Relationship Authoring');
    expect(doc).toContain('Changing entity type may unlink the current authority');
    expect(doc).toContain('settings-section');
    expect(doc).toContain('workflows-table');
    expect(doc).toContain('phrase-target-action-form');
    expect(doc).not.toMatch(/<script\b/i);
    expect(doc).not.toMatch(/style="/i);
  });
});
