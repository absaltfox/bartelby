'use strict';

// The Content-Security-Policy in server.js sets script-src to 'self' only, so
// the browser refuses inline <script> bodies and inline event-handler
// attributes. A template that adds one breaks silently — the page renders and
// the script just never runs — so this scans every view for them.
//
// Data for page scripts goes in a non-executing
// <script type="application/json"> element that the page's own JS file parses;
// see docs/ui-template-standards.md (Inline JSON for page scripts).

const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'views');

function listViews(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listViews(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

const NON_EXECUTING_TYPE = /type="application\/(ld\+)?json"/;
const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=\s*["']/i;

describe('views are compatible with a script-src \'self\' policy', () => {
  const files = listViews(VIEWS);

  test('there are views to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('no view contains an inline executable <script>', () => {
    const offenders = [];
    for (const file of files) {
      const openTags = fs.readFileSync(file, 'utf8').match(/<script\b[^>]*>/gi) || [];
      for (const tag of openTags) {
        if (/\ssrc=/.test(tag) || NON_EXECUTING_TYPE.test(tag)) continue;
        offenders.push(`${path.relative(VIEWS, file)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no view contains an inline event-handler attribute', () => {
    const offenders = [];
    for (const file of files) {
      // Strip EJS code first so JS inside <% %> is not mistaken for markup.
      const markup = fs.readFileSync(file, 'utf8').replace(/<%[\s\S]*?%>/g, '');
      for (const tag of markup.match(/<[a-zA-Z][^>]*>/g) || []) {
        if (EVENT_HANDLER_ATTR.test(tag)) {
          offenders.push(`${path.relative(VIEWS, file)}: ${tag.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('server.js does not allow inline scripts', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const scriptSrc = server.match(/scriptSrc:\s*\[([^\]]*)\]/);
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc[1]).not.toContain('unsafe-inline');
    expect(scriptSrc[1]).not.toContain('unsafe-eval');
  });
});
