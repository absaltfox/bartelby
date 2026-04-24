'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAdminImportScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../public/js/admin-import.js'),
    'utf8'
  );
  const context = {
    document: {
      addEventListener: () => {},
      querySelector: () => null,
      getElementById: () => null,
      querySelectorAll: () => []
    },
    window: {},
    console: { log: () => {}, error: () => {}, warn: () => {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    FormData: class {},
    URL: class { constructor(u) { this.href = u || ''; } },
    URLSearchParams: class { constructor() {} get() { return null; } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    history: { replaceState: () => {} },
    location: { search: '' },
    alert: () => {}
  };
  vm.runInNewContext(source, context, { filename: 'public/js/admin-import.js' });
  return context;
}

describe('admin-import.js preview grouping helpers', () => {
  let ctx;

  beforeAll(() => {
    ctx = loadAdminImportScript();
  });

  it('builds a session summary for the preview surface', () => {
    expect(typeof ctx.buildPageSessionSummary).toBe('function');
    expect(ctx.buildPageSessionSummary({
      currentPageNumber: 4,
      totalPages: 12,
      isSelected: true,
      currentGroupLabel: 'Document (pages 4, 5)',
      activeGroupLabel: 'Document (pages 4, 5)'
    })).toBe(
      'Current page: 4 of 12 (selected, in Document (pages 4, 5)). Active group: Document (pages 4, 5).'
    );
  });

  it('falls back cleanly when the page is ungrouped and no active group exists', () => {
    expect(ctx.buildPageSessionSummary({
      currentPageNumber: 0,
      totalPages: 0,
      isSelected: false,
      currentGroupLabel: '',
      activeGroupLabel: ''
    })).toBe(
      'Current page: 0 of 0 (not selected, ungrouped). Active group: none.'
    );
  });

  it('returns cue descriptors for selected, grouped, and active states', () => {
    expect(typeof ctx.buildPageSessionCues).toBe('function');
    expect(ctx.buildPageSessionCues({
      isSelected: true,
      currentGroupLabel: 'Document (pages 8, 9)',
      activeGroupLabel: 'Document (pages 8, 9)'
    })).toEqual([
      { tone: 'selected', text: 'Selected in grid' },
      { tone: 'group', text: 'In Document (pages 8, 9)' },
      { tone: 'active', text: 'Active group: Document (pages 8, 9)' }
    ]);
  });

  it('omits the active-group cue when there is no active group', () => {
    expect(ctx.buildPageSessionCues({
      isSelected: false,
      currentGroupLabel: '',
      activeGroupLabel: ''
    })).toEqual([
      { tone: 'neutral', text: 'Not selected' },
      { tone: 'neutral', text: 'Ungrouped' }
    ]);
  });
});
