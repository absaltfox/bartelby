'use strict';

// Load csrf middleware in isolation — no app boot needed.
const { validateCsrf } = require('../../middleware/csrf');

function makeReq({ method, body, session, headers = {}, path = '/settings' }) {
  return {
    method,
    body: body || {},
    session: session || { csrfToken: 'valid-token-abc' },
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    path,
    get: (name) => headers[name.toLowerCase()] || null
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

describe('validateCsrf', () => {
  it('redirects to "/" on invalid token, ignoring Referer', () => {
    const req = makeReq({
      method: 'POST',
      body: { _csrf: 'wrong-token' },
      headers: { referer: 'http://evil.example.com/phish' }
    });
    const res = makeRes();
    const next = jest.fn();

    validateCsrf(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not redirect to Referer even when Referer is a same-origin path', () => {
    const req = makeReq({
      method: 'POST',
      body: { _csrf: 'bad' },
      headers: { referer: '/settings' }
    });
    const res = makeRes();
    validateCsrf(req, res, jest.fn());

    // Redirect target must be exactly '/'
    expect(res.redirect).toHaveBeenCalledWith('/');
  });
});
