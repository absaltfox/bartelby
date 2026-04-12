'use strict';

const { parseProxyTrust } = require('../../utils/proxy-trust');

describe('proxy trust parsing', () => {
  it('defaults to zero trusted proxy hops when unset', () => {
    expect(parseProxyTrust(undefined)).toBe(0);
    expect(parseProxyTrust('')).toBe(0);
  });

  it('parses numeric hop counts', () => {
    expect(parseProxyTrust('1')).toBe(1);
    expect(parseProxyTrust('2')).toBe(2);
    expect(parseProxyTrust('0')).toBe(0);
  });

  it('parses boolean values', () => {
    expect(parseProxyTrust('true')).toBe(true);
    expect(parseProxyTrust('false')).toBe(false);
    expect(parseProxyTrust('yes')).toBe(true);
    expect(parseProxyTrust('off')).toBe(false);
  });

  it('accepts standard proxy-addr trust labels', () => {
    expect(parseProxyTrust('loopback')).toBe('loopback');
  });

  it('falls back safely on invalid values', () => {
    const warnings = [];
    expect(parseProxyTrust('definitely not valid', {
      onWarning: (message) => warnings.push(message)
    })).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Invalid TRUST_PROXY value/);
  });
});
