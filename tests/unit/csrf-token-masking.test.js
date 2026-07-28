'use strict';

// The CSRF token is masked per response so that a *stable* secret never
// appears in a compressed HTML body. Compression (server.js) plus the `?q=`
// reflection in the page shell would otherwise form the BREACH precondition:
// an attacker observing encrypted response sizes across many induced requests
// could recover a constant token from compression-ratio differences.
//
// These tests pin the two properties that make the scheme work — the emitted
// value varies per render, and it still round-trips to the session secret —
// plus the rejection cases.

const crypto = require('crypto');
const { maskCsrfToken, unmaskCsrfToken, ensureCsrfToken, validateCsrf } = require('../../middleware/csrf');

const SECRET = crypto.randomBytes(32).toString('hex');

function runMiddleware(middleware, req, res) {
  return new Promise((resolve) => middleware(req, res, () => resolve('next')));
}

function makeReq(overrides = {}) {
  return { method: 'POST', headers: {}, session: {}, path: '/', body: {}, ...overrides };
}

describe('CSRF token masking', () => {
  it('emits a different token every time for the same secret', () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i += 1) tokens.add(maskCsrfToken(SECRET));
    expect(tokens.size).toBe(50);
  });

  it('never emits the bare secret', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = maskCsrfToken(SECRET);
      expect(token).not.toContain(SECRET);
      // Neither half is the secret either.
      const [mask, masked] = token.split('.');
      expect(mask).not.toBe(SECRET);
      expect(masked).not.toBe(SECRET);
    }
  });

  it('round-trips back to the secret', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(unmaskCsrfToken(maskCsrfToken(SECRET))).toBe(SECRET);
    }
  });

  it('rejects malformed tokens instead of throwing', () => {
    const bad = [
      '', 'nonsense', 'abc.def', 'zz.zz', `${'a'.repeat(64)}`,
      `${'a'.repeat(64)}.${'b'.repeat(62)}`, 'a.b.c', '.', `${'a'.repeat(64)}.`
    ];
    for (const token of bad) {
      expect(unmaskCsrfToken(token)).not.toBe(SECRET);
    }
  });

  it('ensureCsrfToken keeps the secret in the session and masks res.locals', async () => {
    const req = makeReq({ method: 'GET' });
    const res = { locals: {} };
    await runMiddleware(ensureCsrfToken, req, res);

    expect(req.session.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.locals.csrfToken).not.toBe(req.session.csrfToken);
    expect(unmaskCsrfToken(res.locals.csrfToken)).toBe(req.session.csrfToken);

    // A second render of the same session emits a different value.
    const res2 = { locals: {} };
    await runMiddleware(ensureCsrfToken, req, res2);
    expect(res2.locals.csrfToken).not.toBe(res.locals.csrfToken);
    expect(unmaskCsrfToken(res2.locals.csrfToken)).toBe(req.session.csrfToken);
  });

  it('accepts a masked token from a different render of the same session', async () => {
    const req = makeReq({ session: { csrfToken: SECRET }, body: { _csrf: maskCsrfToken(SECRET) } });
    const res = {};
    await expect(runMiddleware(validateCsrf, req, res)).resolves.toBe('next');
    expect(req._csrfValidated).toBe(true);
  });

  it('accepts the bare secret, so forms rendered before a deploy still submit', async () => {
    const req = makeReq({ session: { csrfToken: SECRET }, body: { _csrf: SECRET } });
    await expect(runMiddleware(validateCsrf, req, {})).resolves.toBe('next');
  });

  it('accepts a masked token supplied via the X-CSRF-Token header', async () => {
    const req = makeReq({
      session: { csrfToken: SECRET },
      headers: { 'x-csrf-token': maskCsrfToken(SECRET) }
    });
    await expect(runMiddleware(validateCsrf, req, {})).resolves.toBe('next');
  });

  it('rejects a token masked from a different secret', async () => {
    const otherSecret = crypto.randomBytes(32).toString('hex');
    const req = makeReq({
      session: { csrfToken: SECRET },
      body: { _csrf: maskCsrfToken(otherSecret) },
      path: '/api/thing'
    });
    let status = null;
    const res = { status: (code) => { status = code; return { json: () => {} }; } };

    let calledNext = false;
    validateCsrf(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(false);
    expect(status).toBe(403);
  });

  it('rejects a tampered mask half', async () => {
    const token = maskCsrfToken(SECRET);
    const [mask, masked] = token.split('.');
    const flipped = (mask[0] === 'a' ? 'b' : 'a') + mask.slice(1);

    const req = makeReq({
      session: { csrfToken: SECRET },
      body: { _csrf: `${flipped}.${masked}` },
      path: '/api/thing'
    });
    let status = null;
    const res = { status: (code) => { status = code; return { json: () => {} }; } };

    let calledNext = false;
    validateCsrf(req, res, () => { calledNext = true; });

    expect(calledNext).toBe(false);
    expect(status).toBe(403);
  });
});
