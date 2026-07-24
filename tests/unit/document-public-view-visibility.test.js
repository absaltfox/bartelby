'use strict';

// Regression test for the unauthenticated public Document view leaking internal
// fields and mis-gating tabs (backlog issue #59). On a world-public document
// viewed while logged out, four things must hold:
//
//   1. Graph tab IS visible to the public (knowledge tab button renders).
//   2. History tab is HIDDEN from the public (button + #tab-history content).
//   3. Transcriber name is HIDDEN from the public (info line + version dropdown).
//   4. Transcription Run Details cost, credentials, and the initiator are HIDDEN
//      from the public.
//
// The fix gates each of these on `currentUser` in the templates. This test
// renders the real views/document.ejs (which pulls in the document header and
// transcript panel partials) once logged out and once logged in, and asserts
// the difference. Per docs/ui-template-standards.md (auth-conditional template
// rendering).

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');

// A transcript populated with every field the public must NOT see (transcriber,
// initiated_by, cost_usd, provider_key_scope) plus fields that stay visible
// (provider/model) so the Run Details panel still renders for everyone.
const selectedTranscript = {
  id: 10,
  version: 2,
  is_best: true,
  transcriber: 'Jane Curator',
  notes: '',
  provider: 'openai',
  model: 'gpt-4o',
  initiated_by: 'Ada Initiator',
  temperature: 0,
  run_duration_ms: 5000,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: 0.0123,
  confidence: 90,
  content: 'Hello world',
  prompt: '',
  provider_key_scope: 'system',
  created_at: '2026-01-01T00:00:00Z'
};

// A second version so the transcript version dropdown renders (it only appears
// when transcripts.length > 1), exercising the "by <transcriber>" leak.
const transcripts = [
  selectedTranscript,
  { id: 11, version: 1, is_best: false, transcriber: 'Bob Second' }
];

function renderDocument(currentUser) {
  const data = {
    document: { id: 1, title: 'Test Doc', date_created: '', metadata: {} },
    transcripts,
    selectedTranscript,
    editableTranscriptContent: 'Hello world',
    annotations: [],
    docCollections: [],
    pendingJob: null,
    jobsHref: null,
    jobStatusUrl: null,
    backHref: '/',
    canEdit: false,
    canManage: false,
    allowExport: false,
    exportEnabledCollections: [],
    comparisonPages: [],
    pendingRelationshipCount: 0,
    approvedRelationshipCount: 0,
    sentimentSummary: [],
    hasSentiment: false,
    isAdmin: false,
    csrfToken: 'tok',
    currentUser
  };
  const file = path.join(ROOT, 'views/document.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), data, { filename: file });
}

describe('Unauthenticated public Document view visibility (issue #59)', () => {
  let anon;
  let auth;

  beforeAll(() => {
    anon = renderDocument(null);
    auth = renderDocument({ username: 'admin' });
  });

  describe('logged out (public viewer)', () => {
    test('Graph (knowledge) tab remains visible', () => {
      expect(anon).toMatch(/data-tab="knowledge"/);
    });

    test('History tab button and content are hidden', () => {
      expect(anon).not.toMatch(/data-tab="history"/);
      expect(anon).not.toContain('id="tab-history"');
    });

    test('transcriber name is hidden (info line and version dropdown)', () => {
      expect(anon).not.toContain('Jane Curator');
      expect(anon).not.toContain('Bob Second');
    });

    test('run-details cost, credentials, and initiator are hidden', () => {
      expect(anon).not.toContain('Est. cost');
      expect(anon).not.toContain('Credentials');
      expect(anon).not.toContain('System API key');
      expect(anon).not.toContain('Ada Initiator');
    });

    test('non-sensitive transcript content still renders', () => {
      // The transcript body and provider are not gated — only creator/cost/
      // credentials are. Guards against over-hiding.
      expect(anon).toContain('Hello world');
      expect(anon).toContain('openai');
    });
  });

  describe('logged in (authenticated viewer)', () => {
    test('History tab button and content are present', () => {
      expect(auth).toMatch(/data-tab="history"/);
      expect(auth).toContain('id="tab-history"');
    });

    test('transcriber, initiator, cost, and credentials are shown', () => {
      expect(auth).toContain('Jane Curator');
      expect(auth).toContain('Bob Second');
      expect(auth).toContain('Ada Initiator');
      expect(auth).toContain('Est. cost');
      expect(auth).toContain('Credentials');
      expect(auth).toContain('System API key');
    });

    test('Graph tab is also visible to authenticated viewers', () => {
      expect(auth).toMatch(/data-tab="knowledge"/);
    });
  });
});
