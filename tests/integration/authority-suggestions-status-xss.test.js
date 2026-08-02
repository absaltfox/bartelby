'use strict';

// Regression tests for the reflected XSS on the authority-suggestions queue.
//
// `?status=` reached views/admin/authority-suggestions.ejs verbatim, where the
// bootstrap payload interpolated it into a <script type="application/json">
// block via JSON.stringify. JSON.stringify escapes quotes and backslashes but
// not `<`, so a `</script>` in the value closed the element early and the rest
// parsed as HTML. The CSP allows 'unsafe-inline', so nothing caught it.
//
// Two independent defences exist and each needs its own suite, because a route
// test cannot reach the template escape while the allowlist is working — with
// `status` constrained to four literals the payload contains no `<` at all and
// `.replace(/</g, ...)` is a provable no-op:
//
//   * "template escape" renders each bootstrap block straight out of its .ejs
//     file with hostile values the routes could never produce.
//   * "route allowlist" drives the real HTTP route.
//
// Reverting either defence must fail at least one test here. Verified by
// reverting each independently.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const ejs = require('ejs');
const request = require('supertest');

// Marker looked for in the parsed DOM. Kept separate from the payloads so
// editing a payload cannot quietly decouple it from the assertion.
const MARKER = '__pwned';

// Several shapes, because asserting on one hardcoded byte sequence is how the
// previous version of this test came to false-pass: `<script >` (extra space),
// a typed script, and a non-script execution vector all evade a substring
// check for the literal `<script>window.__pwned`.
const XSS_PAYLOADS = [
  `</script><script>window.${MARKER} = 1;</script>`,
  `</script><script >window.${MARKER} = 1;</script>`,
  `</script><script type="text/javascript">window.${MARKER} = 1;</script>`,
  `</script><svg onload="window.${MARKER} = 1">`,
  // Types a naive `type === 'text/javascript'` check calls inert but browsers
  // execute. These are why markerLeaks() is closed-world rather than a list
  // of known-executable types.
  `</script><script type="text/javascript; charset=utf-8">window.${MARKER} = 1;</script>`,
  `</script><script type="application/x-javascript">window.${MARKER} = 1;</script>`,
  // Non-script vectors entirely.
  `</script><iframe srcdoc="&lt;script&gt;window.${MARKER}=1&lt;/script&gt;">`,
  `</script><a href="javascript:window.${MARKER}=1">x</a>`
];

// [template path, bootstrap element id]
const BOOTSTRAP_TEMPLATES = [
  ['views/admin/authority-suggestions.ejs', 'suggestions-bootstrap'],
  ['views/manage/collections/knowledge/authority-suggestions.ejs', 'suggestions-bootstrap'],
  ['views/admin/sentiment-review.ejs', 'sentiment-bootstrap']
];

const EJS_INTERNALS = new Set(['escapeFn', 'include', 'rethrow']);

/**
 * Locals that hand back a hostile string for ANY name the template asks for.
 *
 * The point is that adding a key to a bootstrap payload cannot silently escape
 * coverage. Passing a fixed locals object instead would either throw
 * ReferenceError on the new key, or — with this repo's
 * `typeof x !== 'undefined' ? x : null` idiom — render it as null and stop
 * testing it.
 *
 * `has` deliberately declines `__`-prefixed names, EJS internals, and anything
 * resolvable as a global: EJS compiles to `with (locals) { ... }`, so claiming
 * those would shadow `__append` and `JSON` and break the render.
 */
function hostileLocals(sentinel) {
  return new Proxy({}, {
    has(_target, prop) {
      if (typeof prop !== 'string') return false;
      if (prop.startsWith('__') || EJS_INTERNALS.has(prop)) return false;
      return !(prop in globalThis);
    },
    get() { return sentinel; }
  });
}

/**
 * Pulls a bootstrap block's EJS source out of a template file so it can be
 * rendered in isolation, without standing up every partial the page includes.
 * Reading the real file is the point: drop the escape and this fragment
 * changes and the test fails.
 *
 * Matching is tolerant of attribute order and quote style — both idioms are in
 * use across the repo (`type=... id=...` and `id=... type=...`), and neither
 * has any bearing on whether the payload is escaped.
 */
function readBootstrapFragment(relPath, elementId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
  const block = new RegExp(
    `<script\\b[^>]*\\bid\\s*=\\s*['"]${elementId}['"][^>]*>([\\s\\S]*?)</script\\s*>`,
    'i'
  );
  const m = src.match(block);
  return m ? m[1] : null;
}

/**
 * Returns the text of the named bootstrap element, or null. Parses the DOM
 * rather than slicing on `</script>`: a substring walk stops at whichever
 * `</script>` comes first, which is exactly the boundary an injected payload
 * moves.
 */
function bootstrapText($, elementId) {
  const el = $(`script#${elementId}`);
  if (el.length !== 1) return null;
  return el.html();
}

/**
 * Every place the marker leaks out of the one element that is allowed to
 * contain it.
 *
 * This is deliberately a closed-world check rather than a list of execution
 * vectors. An earlier version enumerated "executable" script types and `on*`
 * attributes, and quietly failed to flag `type="text/javascript; charset=utf-8"`
 * and `type="application/x-javascript"` — both of which browsers run — as well
 * as `srcdoc` and `javascript:` URLs. Enumerating sinks means the test is only
 * ever as good as the last person's threat model.
 *
 * The invariant that actually holds is narrower and checkable: the marker may
 * appear **only** as text inside the bootstrap element. Anywhere else — another
 * script body, any attribute, any other text node — is a leak, whether or not
 * this file can name why it would execute.
 *
 * Returns human-readable locations so a failure names the vector.
 */
function markerLeaks($, elementId, marker) {
  const leaks = [];

  $('script').each((_i, el) => {
    if ($(el).attr('id') === elementId) return;
    if (($(el).html() || '').includes(marker)) {
      leaks.push(`<script type="${$(el).attr('type') || '(none)'}"> body`);
    }
  });

  $('*').each((_i, el) => {
    for (const [name, value] of Object.entries((el && el.attribs) || {})) {
      if (String(value).includes(marker)) leaks.push(`<${el.name} ${name}=...>`);
    }
  });

  // Any text node outside the bootstrap element. Catches markup that parsed
  // into a position this file did not anticipate.
  const outside = $.root().clone();
  outside.find(`script#${elementId}`).empty();
  outside.find('script, style').each((_i, el) => {
    if (($.html(el) || '').includes(marker)) leaks.push(`<${el.name}> (outside bootstrap)`);
  });
  if (outside.text().includes(marker)) leaks.push('text node outside bootstrap');

  return [...new Set(leaks)];
}

describe('bootstrap payloads: template escape', () => {
  it.each(BOOTSTRAP_TEMPLATES)('%s escapes `<` in every payload value', (relPath, elementId) => {
    const fragment = readBootstrapFragment(relPath, elementId);
    expect(fragment).not.toBeNull();

    const payload = XSS_PAYLOADS[0];
    const rendered = ejs.render(fragment, hostileLocals(payload));

    // Nothing that could close the enclosing <script> element may survive.
    expect(rendered).not.toContain('<');

    // The escape must be lossless — the client JSON.parses this back — and
    // must have been applied to every string the template interpolated, not
    // just the one we happened to name.
    const parsed = JSON.parse(rendered);
    const strings = Object.values(parsed).filter((v) => typeof v === 'string');
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) expect(value).toBe(payload);
  });
});

describe('authority suggestions: route allowlist', () => {
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
        _csrf: cheerio.load(setupPage.text)('input[name="_csrf"]').first().attr('value')
      });

    agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent
      .post('/login')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        _csrf: cheerio.load(page.text)('input[name="_csrf"]').first().attr('value')
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

  it.each(XSS_PAYLOADS)('leaves no executable payload in the page for %s', async (payload) => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status: payload });

    expect(res.status).toBe(200);

    const $ = cheerio.load(res.text);

    // The bootstrap element must still be intact and still be one element —
    // a breakout splits it, so `length !== 1` is itself the symptom.
    const raw = bootstrapText($, 'suggestions-bootstrap');
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw)).not.toThrow();

    // The real assertion. Substring checks on the raw HTML cannot express
    // this: a correctly escaped page still contains the text `__pwned`,
    // inert, and an executable payload need not match any fixed byte string.
    expect(markerLeaks($, 'suggestions-bootstrap', MARKER)).toEqual([]);
  });

  it('falls back to pending for an unrecognised status', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status: XSS_PAYLOADS[0] });

    const raw = bootstrapText(cheerio.load(res.text), 'suggestions-bootstrap');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw).status).toBe('pending');
  });

  it('applies the same allowlist to the JSON endpoint', async () => {
    const [rejected, unknown, pending] = await Promise.all([
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: 'rejected' }),
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: XSS_PAYLOADS[0] }),
      agent.get('/admin/knowledge/authorities/suggestions.json').query({ status: 'pending' })
    ]);

    // The seeded row is pending. Without the allowlist the unknown status
    // reaches `WHERE als.status = ?` and comes back empty like `rejected`
    // rather than matching `pending`; `rejected` is the control.
    expect(rejected.body.suggestions).toHaveLength(0);
    expect(pending.body.suggestions).toHaveLength(1);
    expect(unknown.body.suggestions).toHaveLength(1);
    expect(unknown.body.suggestions[0].entity_id).toBe(pending.body.suggestions[0].entity_id);
  });
});

// Functional, not security: this passes with or without either defence. It
// guards the opposite failure — an allowlist tightened so far it drops a
// status the filter tabs still link to.
describe('authority suggestions: allowlist is not over-tight', () => {
  let agent;

  beforeAll(async () => {
    const { app } = require('../../server');
    agent = request.agent(app);
    const page = await agent.get('/login');
    await agent
      .post('/login')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        _csrf: cheerio.load(page.text)('input[name="_csrf"]').first().attr('value')
      });
  }, 30_000);

  it.each(['pending', 'approved', 'rejected', 'all'])('round-trips status=%s', async (status) => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status });

    expect(res.status).toBe(200);
    const raw = bootstrapText(cheerio.load(res.text), 'suggestions-bootstrap');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw).status).toBe(status);
  });
});
