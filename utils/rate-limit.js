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

/**
 * Key for the MFA verification step, where the caller is not yet logged in so
 * `req.user` is unset — the account under attack is named by the pending-login
 * record instead. Falls back to IP when there is no pending login.
 *
 * Keying by account is safe here specifically because a pendingLogin is only
 * minted after the password check succeeds (routes/auth.js), so an attacker
 * cannot use this to lock an account whose password they do not hold. The same
 * would NOT be true of a per-username limiter on /login itself.
 */
function pendingLoginOrIpRateLimitKey(req, options = {}) {
  const pendingUserId = req.session && req.session.pendingLogin
    ? req.session.pendingLogin.userId
    : null;
  if (pendingUserId != null) {
    return `${options.userPrefix || 'mfa-user'}:${pendingUserId}`;
  }
  return ipRateLimitKey(req, {
    prefix: options.ipPrefix || 'mfa-ip',
    ipv6Subnet: options.ipv6Subnet
  });
}

module.exports = {
  DEFAULT_IPV6_SUBNET,
  ipRateLimitKey,
  userOrIpRateLimitKey,
  pendingLoginOrIpRateLimitKey
};
