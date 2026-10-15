'use strict';

/**
 * Shared rate-limiter definitions for Bartelby.
 *
 * Centralizing limiters here avoids scattering express-rate-limit config across
 * server.js and individual route files, and prevents circular-require issues when
 * route modules need a more specific limit than the general authenticated API cap.
 *
 * All limiters are no-ops outside production (skip returns true) so local
 * development is not throttled.
 */

const { userOrIpRateLimitKey } = require('./rate-limit');
const { createLimiter } = require('./rate-limit-store');

/**
 * Dedicated limiter for AI transcription job queueing.
 *
 * Editors with a hijacked account or an errant script could otherwise queue an
 * unbounded number of provider API calls.  10 requests per 15 minutes is
 * generous for legitimate use (one job per document) but tight enough to cap
 * blast radius to a manageable number of LLM calls.
 */
const aiTranscriptionLimiter = createLimiter({
  prefix: 'ai-transcription',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => userOrIpRateLimitKey(req, {
    userPrefix: 'ai-transcription-user',
    ipPrefix: 'ai-transcription-ip'
  }),
  skip: () => process.env.NODE_ENV !== 'production',
  message: { error: 'Too many transcription requests. Please wait before queuing more jobs.' }
});

/**
 * Limiter for account changes that re-check the current password (email, MFA,
 * password change).
 *
 * Those routes turn a signed-in session into a password oracle: without a cap,
 * whoever holds the session can guess the password at request speed. Keyed by
 * account so the budget follows the user rather than the source address.
 */
const accountStepUpLimiter = createLimiter({
  prefix: 'account-step-up',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => userOrIpRateLimitKey(req, {
    userPrefix: 'account-step-up-user',
    ipPrefix: 'account-step-up-ip'
  }),
  skip: () => process.env.NODE_ENV !== 'production',
  message: 'Too many attempts. Please wait before trying again.'
});

module.exports = {
  aiTranscriptionLimiter,
  accountStepUpLimiter
};
