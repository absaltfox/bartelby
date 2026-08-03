'use strict';

/**
 * Shared backing store for every rate limiter in the app.
 *
 * express-rate-limit defaults to an in-process MemoryStore. That is per-machine
 * and resets on deploy, while DEPLOY.md's recommended baseline is two web
 * machines behind Fly's non-sticky load balancer — so every documented
 * production deployment was getting `max × machine count`, and a deploy reset
 * every counter. For the auth limiters that is the difference between "20 login
 * attempts per 15 minutes" and "40, or fewer if you redeploy".
 *
 * Two structural facts shape this module:
 *
 *   1. Limiters are constructed at module load, but the Redis client is only
 *      created during initApp() when the session store is built. A limiter
 *      cannot be handed a store it does not yet have, so `createLimiter` defers
 *      construction to the first request — which always happens after initApp.
 *   2. Redis is optional. Without it (local dev, single-machine installs,
 *      SESSION_STORE=memory) limiters fall back to MemoryStore, which is
 *      correct for one process.
 */

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

let sharedClient = null;

/**
 * Registers the connected Redis client for limiters to share. Called from
 * server.js once the session store has connected; before that, and when Redis
 * is not configured, limiters use MemoryStore.
 */
function setRateLimitRedisClient(client) {
  sharedClient = client || null;
}

function hasSharedStore() {
  return !!sharedClient;
}

function buildStore(prefix) {
  if (!sharedClient) return undefined; // express-rate-limit defaults to MemoryStore
  return new RedisStore({
    // node-redis v4 exposes sendCommand; rate-limit-redis expects exactly this shape.
    sendCommand: (...args) => sharedClient.sendCommand(args),
    prefix: `bartelby:rl:${prefix}:`
  });
}

/**
 * Builds a limiter whose store is resolved on first use rather than at
 * construction. `prefix` namespaces the keyspace so limiters cannot collide in
 * a shared Redis — two limiters keyed by the same IP must not share a counter,
 * and express-rate-limit's own double-count guard collapses every RedisStore to
 * the same identity, so the prefix is what keeps them apart.
 *
 * The limiter is built exactly once and cached. Rebuilding per request would
 * hand each request a fresh MemoryStore in the no-Redis path, making every
 * count 1 and silently disabling rate limiting altogether.
 */
function createLimiter({ prefix, ...options }) {
  if (!prefix) throw new Error('createLimiter requires a prefix');
  let limiter = null;

  const middleware = (req, res, next) => {
    if (!limiter) {
      limiter = rateLimit({
        // A rate limiter is defence in depth; a store blip should not take the
        // site down. express-rate-limit defaults this to false, which turns any
        // Redis hiccup into a 500 on every path — including anonymous browsing,
        // which needs Redis for nothing else. Auth is not weakened by this:
        // sessions hard-depend on the same client, so a Redis outage has
        // already broken login regardless of what the limiter does.
        passOnStoreError: true,
        // Deferring construction to the first request is deliberate (see
        // above), but the library flags building a limiter inside a handler and
        // logs a stack trace per limiter on first use — in production too, not
        // just dev. Silence that one check rather than the whole set.
        validate: { creationStack: false },
        ...options,
        store: buildStore(prefix)
      });
      // express-rate-limit hangs these off the middleware it returns; forward
      // them so callers (an admin "unlock this IP" action, say) do not hit an
      // undefined with nothing pointing back here.
      middleware.resetKey = limiter.resetKey;
      middleware.getKey = limiter.getKey;
    }
    return limiter(req, res, next);
  };

  middleware.limiterPrefix = prefix;
  return middleware;
}

module.exports = {
  setRateLimitRedisClient,
  hasSharedStore,
  buildStore,
  createLimiter
};
