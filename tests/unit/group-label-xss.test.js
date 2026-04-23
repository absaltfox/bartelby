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

describe('admin-import.js escapeHtml', () => {
  let ctx;

  beforeAll(() => {
    ctx = loadAdminImportScript();
  });

  it('defines a top-level escapeHtml function', () => {
    expect(typeof ctx.escapeHtml).toBe('function');
  });

  it('escapes & < > " and single-quote', () => {
    expect(ctx.escapeHtml('&')).toBe('&amp;');
    expect(ctx.escapeHtml('<')).toBe('&lt;');
    expect(ctx.escapeHtml('>')).toBe('&gt;');
    expect(ctx.escapeHtml('"')).toBe('&quot;');
    expect(ctx.escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a crafted XSS payload that would have broken renderGroups', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const escaped = ctx.escapeHtml(payload);
    // The literal < > must be escaped so the browser cannot parse this as a tag
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
    expect(escaped).toContain('&gt;');
    // The full escaped string must not contain an unescaped opening bracket
    expect(escaped).not.toMatch(/<[a-z]/i);
  });

  it('returns an empty string for null or undefined', () => {
    expect(ctx.escapeHtml(null)).toBe('');
    expect(ctx.escapeHtml(undefined)).toBe('');
  });

  it('leaves safe label text unchanged', () => {
    expect(ctx.escapeHtml('Document (pages 1, 2)')).toBe('Document (pages 1, 2)');
  });
});
