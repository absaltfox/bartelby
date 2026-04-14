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

const rateLimit = require('express-rate-limit');
const { userOrIpRateLimitKey } = require('./rate-limit');

/**
 * Dedicated limiter for AI transcription job queueing.
 *
 * Editors with a hijacked account or an errant script could otherwise queue an
 * unbounded number of provider API calls.  10 requests per 15 minutes is
 * generous for legitimate use (one job per document) but tight enough to cap
 * blast radius to a manageable number of LLM calls.
 */
const aiTranscriptionLimiter = rateLimit({
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

module.exports = {
  aiTranscriptionLimiter
};
