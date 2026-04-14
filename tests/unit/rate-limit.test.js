'use strict';

const { ipRateLimitKey, userOrIpRateLimitKey, DEFAULT_IPV6_SUBNET } = require('../../utils/rate-limit');

describe('rate limit key helpers', () => {
  it('uses the authenticated user id when available', () => {
    const key = userOrIpRateLimitKey({
      ip: '203.0.113.42',
      user: { id: 17 }
    }, {
      userPrefix: 'auth-api-user',
      ipPrefix: 'auth-api-ip'
    });

    expect(key).toBe('auth-api-user:17');
  });

  it('normalizes ipv4 addresses with a stable prefix', () => {
    const key = ipRateLimitKey({
      ip: '203.0.113.42'
    }, {
      prefix: 'auth-api-ip'
    });

    expect(key).toBe('auth-api-ip:203.0.113.42');
  });

  it('collapses ipv6 addresses into a subnet key instead of using the raw address', () => {
    const key = userOrIpRateLimitKey({
      ip: '2001:db8:abcd:1234:1111:2222:3333:4444'
    }, {
      userPrefix: 'auth-api-user',
      ipPrefix: 'auth-api-ip'
    });

    expect(key).toMatch(/^auth-api-ip:/);
    expect(key).toContain(`/${DEFAULT_IPV6_SUBNET}`);
    expect(key).not.toContain('3333:4444');
  });
});
