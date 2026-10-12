'use strict';

// Regression test for the public Collection Analytics page leaking the
// aggregate transcription cost to unauthenticated viewers (issue #66). A
// world-public collection's analytics page renders for logged-out visitors, so
// the "Total Transcription Cost" stat card must be gated on `currentUser`, the
// same predicate that hides the per-document Est. cost (issue #59). The other
// stat cards are methodology paradata and stay public. Per
// docs/ui-template-standards.md (auth-conditional template rendering).

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');

function renderAnalytics(currentUser) {
  const data = {
    pageTitle: 'Letters — Analytics',
    collection: { id: 2, name: 'Letters', description: '' },
    collectionId: 2,
    analytics: {
      document_count: 12,
      storage_bytes: 2048,
      transcribed_count: 10,
      untranscribed_count: 2,
      total_cost_usd: 4.3219,
      avg_confidence: 87,
      topics_computed: false
    },
    latestAnalytics: null,
    topics: [],
    assignments: [],
    hierarchyData: [],
    hierarchyPlot: null,
    evolution: [],
    sentimentSummary: [],
    sentimentList: [],
    sentimentHasMore: false,
    csrfToken: 'tok',
    currentUser
  };
  const file = path.join(ROOT, 'views/collection-analytics.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), data, { filename: file });
}

describe('Public Collection Analytics cost visibility (issue #66)', () => {
  test('logged-out viewers do not see the total transcription cost', () => {
    const anon = renderAnalytics(null);
    expect(anon).not.toContain('Total Transcription Cost');
    expect(anon).not.toContain('4.3219');
  });

  test('logged-out viewers still see the public methodology stats', () => {
    const anon = renderAnalytics(null);
    expect(anon).toContain('Avg. Confidence');
    expect(anon).toContain('Transcribed');
  });

  test('signed-in viewers see the total transcription cost', () => {
    const auth = renderAnalytics({ username: 'reader', role: 'user' });
    expect(auth).toContain('Total Transcription Cost');
    expect(auth).toContain('$4.3219');
  });
});
