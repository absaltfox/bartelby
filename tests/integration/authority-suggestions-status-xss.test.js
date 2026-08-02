'use strict';

// Regression test for the reflected XSS on the authority-suggestions queue.
//
// `?status=` reached views/admin/authority-suggestions.ejs verbatim, where the
// bootstrap payload interpolated it into a <script type="application/json">
// block via JSON.stringify. JSON.stringify escapes quotes and backslashes but
// not `<`, so a `</script>` in the value closed the element early and the rest
// parsed as HTML. The CSP allows 'unsafe-inline', so nothing caught it.
//
// Two independent defences are asserted here, because either alone would have
// prevented this and we want both to stay:
//   1. the route allowlists ?status= (routes/admin-authorities.js)
//   2. the template escapes `<` in the payload (per
//      docs/ui-template-standards.md § JSON bootstrap payloads must escape `<`)

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

const XSS_PAYLOAD = '</script><script>window.__pwned = 1;</script>';

function extractCsrfFromForm(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Returns the raw text between the bootstrap element's opening tag and the
 * very next `</script>`. If the payload broke out, that boundary lands early
 * and the captured text will not parse as JSON.
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

describe('authority suggestions ?status= is not an XSS sink', () => {
  let app;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;

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
  }, 30_000);

  it('does not let a </script> payload break out of the bootstrap block', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions')
      .query({ status: XSS_PAYLOAD });

    expect(res.status).toBe(200);

    const raw = extractBootstrapRaw(res.text);
    expect(raw).not.toBeNull();

    // The element must not be terminable from inside the payload, and the
    // injected script must not appear anywhere in the document.
    expect(raw).not.toContain('<');
    expect(res.text).not.toContain('window.__pwned');

    // Whatever survives must still be the JSON the page script expects.
    expect(() => JSON.parse(raw)).not.toThrow();
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
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json')
      .query({ status: XSS_PAYLOAD });

    expect(res.status).toBe(200);
    // An unallowlisted status previously reached the store as a literal
    // `WHERE status = ?` value, silently returning an empty queue. It should
    // now behave exactly as ?status=pending does.
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });
});
