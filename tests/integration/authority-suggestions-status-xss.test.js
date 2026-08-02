'use strict';

// Regression tests for the reflected XSS on the authority-suggestions queue.
//
// `?status=` reached views/admin/authority-suggestions.ejs verbatim, where the
// bootstrap payload interpolated it into a <script type="application/json">
// block via JSON.stringify. JSON.stringify escapes quotes and backslashes but
// not `<`, so a `</script>` in the value closed the element early and the rest
// parsed as HTML. The CSP allows 'unsafe-inline', so nothing caught it.
//
// Two independent defences exist and each needs its own test, because a route
// test cannot reach the template escape while the allowlist is working — with
// `status` constrained to four literals the payload contains no `<` at all and
// `.replace(/</g, ...)` is a provable no-op:
//
//   * "route allowlist" below drives the real HTTP route.
//   * "template escape" below renders the bootstrap block straight out of the
//     .ejs file with a hostile value the route could never produce.
//
// Deleting either defence must fail at least one test here.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const request = require('supertest');

const XSS_PAYLOAD = '</script><script>window.__pwned = 1;</script>';

const BOOTSTRAP_TEMPLATES = [
  'views/admin/authority-suggestions.ejs',
  'views/manage/collections/knowledge/authority-suggestions.ejs'
];

function extractCsrfFromForm(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Returns the raw text between the bootstrap element's opening tag and the
 * very next `</script>`. If a payload broke out, that boundary lands early and
 * the captured text will not parse as JSON.
 */
function extractBootstrapRaw(html) {
  const open = '<script type="application/json" id="suggestions-bootstrap">';
  const start = html.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = html.indexOf('</script>', from);
  if (end === -1) return null;
  return html.slice(from, end);
}

/**
 * Pulls the bootstrap block's EJS source out of a template file so it can be
 * rendered in isolation, without standing up every partial the page includes.
 * Reading the real file is the point: drop the escape from the template and
 * this fragment changes and the test fails.
 */
function readBootstrapFragment(relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
  const m = src.match(
    /<script type="application\/json" id="suggestions-bootstrap">([\s\S]*?)<\/script>/
  );
  return m ? m[1] : null;
}

describe('authority suggestions bootstrap: template escape', () => {
  // Drives the templates directly with a value the allowlisted route can never
  // produce, which is the only way to exercise the escape.
  it.each(BOOTSTRAP_TEMPLATES)('%s escapes `<` in the payload', (relPath) => {
    const fragment = readBootstrapFragment(relPath);
    expect(fragment).not.toBeNull();

    const rendered = ejs.render(fragment, {
      status: XSS_PAYLOAD,
      matchMethodFilter: [XSS_PAYLOAD],
      pageSize: 25
    });

    // Nothing that can close the enclosing <script> element may survive.
    expect(rendered).not.toContain('<');

    // The escape must be lossless: the client JSON.parses this back.
    const parsed = JSON.parse(rendered);
    expect(parsed.status).toBe(XSS_PAYLOAD);
    expect(parsed.matchMethodFilter).toEqual([XSS_PAYLOAD]);
  });
});

describe('authority suggestions bootstrap: route allowlist', () => {
  let app;
  let db;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    await setupAgent
      .post('/setup')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: extractCsrfFromForm(setupPage.text)
      });

    agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        _csrf: extractCsrfFromForm(page.text)
      });
    expect(res.status).toBe(302);

    // One pending suggestion, so "unknown status" can be told apart from
    // "no rows" on the JSON endpoint below.
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: 'Ada Lovelace',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'A. Lovelace',
      description: null, properties: {}, authority_id: null
    });
    await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authorityId,
      confidence: 0.85, match_method: 'exact_canonical', status: 'pending'
    });
  }, 30_000);

  it('does not let a </script> payload break out of the bootstrap block', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status: XSS_PAYLOAD });

    expect(res.status).toBe(200);

    const raw = extractBootstrapRaw(res.text);
    expect(raw).not.toBeNull();
    expect(raw.trim()).not.toHaveLength(0);
    expect(raw).not.toContain('<');
    expect(() => JSON.parse(raw)).not.toThrow();

    // Assert on markup, not on the substring: a correctly escaped page still
    // contains the text `window.__pwned`, rendered inert as <script>.
    // What must never appear is the payload as live markup.
    expect(res.text).not.toContain('<script>window.__pwned');
  });

  it('falls back to pending for an unrecognised status', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status: XSS_PAYLOAD });

    const parsed = JSON.parse(extractBootstrapRaw(res.text));
    expect(parsed.status).toBe('pending');
  });

  it('still honours every status the filter tabs offer', async () => {
    for (const status of ['pending', 'approved', 'rejected', 'all']) {
      const res = await agent
        .get('/admin/knowledge/authorities/suggestions')
        .query({ status });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(extractBootstrapRaw(res.text));
      expect(parsed.status).toBe(status);
    }
  });

  it('applies the same allowlist to the JSON endpoint', async () => {
    const [rejected, unknown, pending] = await Promise.all([
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: 'rejected' }),
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: XSS_PAYLOAD }),
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: 'pending' })
    ]);

    // The seeded row is pending, so these three are mutually distinguishing:
    // without the allowlist the unknown status reaches `WHERE als.status = ?`
    // and comes back empty like the rejected queue, instead of like pending.
    expect(rejected.body.suggestions).toHaveLength(0);
    expect(pending.body.suggestions).toHaveLength(1);
    expect(unknown.body.suggestions).toHaveLength(1);
    expect(unknown.body.suggestions[0].entity_id).toBe(pending.body.suggestions[0].entity_id);
  });
});
