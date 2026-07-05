'use strict';

// D8 (2026-07-04 review): the sentiment prompt must carry the document's
// date (and author where known) or the S2 temporal contract is
// uncomputable — the LLM cannot resolve "this past spring" without the
// letter date. buildDocumentMetadata is pure; no DB required.

const { buildDocumentMetadata } = require('../../utils/worker-sentiment');

describe('buildDocumentMetadata (D8)', () => {
  it('includes title, date, and author when all are present', () => {
    const out = buildDocumentMetadata({
      title: 'Letter from Cache Creek',
      date_created: '1875-04-15',
      metadata: JSON.stringify({ author: 'James Leighton' })
    });
    expect(out).toBe('Title: Letter from Cache Creek\nDate: 1875-04-15\nAuthor: James Leighton');
  });

  it('accepts already-parsed metadata objects', () => {
    const out = buildDocumentMetadata({
      title: 'T',
      date_created: '1880',
      metadata: { author: 'Alice' }
    });
    expect(out).toContain('Date: 1880');
    expect(out).toContain('Author: Alice');
  });

  it('omits date and author lines when absent', () => {
    expect(buildDocumentMetadata({ title: 'Undated letter' })).toBe('Title: Undated letter');
  });

  it('tolerates malformed metadata JSON (title/date still emitted)', () => {
    const out = buildDocumentMetadata({
      title: 'T', date_created: '1875-04-15', metadata: '{not json'
    });
    expect(out).toBe('Title: T\nDate: 1875-04-15');
  });

  it('returns empty string for a missing document', () => {
    expect(buildDocumentMetadata(null)).toBe('');
  });
});
