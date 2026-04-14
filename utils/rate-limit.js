'use strict';

const { ipKeyGenerator } = require('express-rate-limit');

const DEFAULT_IPV6_SUBNET = 56;

function ipRateLimitKey(req, options = {}) {
  const ipv6Subnet = options.ipv6Subnet === undefined
    ? DEFAULT_IPV6_SUBNET
    : options.ipv6Subnet;
  const prefix = options.prefix || 'ip';
  return `${prefix}:${ipKeyGenerator(req.ip || '', ipv6Subnet)}`;
}

function userOrIpRateLimitKey(req, options = {}) {
  const userPrefix = options.userPrefix || 'user';
  if (req.user?.id != null) {
    return `${userPrefix}:${req.user.id}`;
  }

  return ipRateLimitKey(req, {
    prefix: options.ipPrefix || 'ip',
    ipv6Subnet: options.ipv6Subnet
  });
}

module.exports = {
  DEFAULT_IPV6_SUBNET,
  ipRateLimitKey,
  userOrIpRateLimitKey
};
