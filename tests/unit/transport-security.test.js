'use strict';

const { allowsInsecureHttp, requiresSecureTransport } = require('../../utils/transport-security');

describe('transport security', () => {
  it('requires secure transport in production by default', () => {
    const env = { NODE_ENV: 'production' };
    expect(requiresSecureTransport(env)).toBe(true);
    expect(allowsInsecureHttp(env)).toBe(false);
  });

  it('does not require secure transport in production when the override is set', () => {
    const env = { NODE_ENV: 'production', ALLOW_INSECURE_HTTP_IN_PRODUCTION: '1' };
    expect(requiresSecureTransport(env)).toBe(false);
    expect(allowsInsecureHttp(env)).toBe(true);
  });

  it('never requires secure transport outside production, and the override means nothing there', () => {
    const env = { NODE_ENV: 'development', ALLOW_INSECURE_HTTP_IN_PRODUCTION: '1' };
    expect(requiresSecureTransport(env)).toBe(false);
    expect(allowsInsecureHttp(env)).toBe(false);
  });

  it('treats anything but an affirmative value as unset', () => {
    for (const value of ['', '0', 'false', 'no']) {
      expect(requiresSecureTransport({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP_IN_PRODUCTION: value })).toBe(true);
    }
  });
});
