'use strict';

// Regression test for #88.
//
// Every limiter used express-rate-limit's default in-process MemoryStore, which
// is per-machine and resets on deploy — while DEPLOY.md's recommended baseline
// is two web machines behind Fly's non-sticky load balancer. So the documented
// production deployment got `max × machine count`, and a deploy reset every
// counter. Limiters now share a Redis-backed store when one is configured.
//
// The structural constraint worth protecting: limiters are constructed at
// module load, but the Redis client only exists after initApp() builds the
// session store. `createLimiter` therefore defers store resolution to the first
// request. A limiter that resolved its store eagerly would silently keep
// MemoryStore forever.

process.env.NODE_ENV = 'test';

// Stand-in for node-redis that honours the Lua script's semantics rather than
// returning a canned value.
//
// A stub that always replies `[1, ttl]` cannot express what #88 is about: no
// test would ever see a counter increment, a decreasing remaining count, or a
// 429, and a RedisStore replacement that returned a constant would pass. This
// keeps a Map so two limiter instances pointed at the same prefix genuinely
// accumulate — which is the two-machine case the fix exists for.
function fakeRedis() {
  const sent = [];
  const counts = new Map();
  return {
    sent,
    counts,
    sendCommand: async (args) => {
      sent.push(args);
      const command = String(args[0] || '').toUpperCase();
      if (command === 'SCRIPT') return 'a'.repeat(40);
      if (command === 'EVALSHA' || command === 'EVAL') {
        // Verified against the real store: EVALSHA <sha> 1 <key> <resetOnChange>
        // <windowMs>. Whether it increments is decided by which of the two
        // loaded scripts the sha names, not by an argument — and the request
        // path only ever runs the incrementing one.
        const key = args[3];
        const windowMs = Number(args[5]) || 60_000;
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        return [next, windowMs];
      }
      return 'OK';
    }
  };
}

function appWith(...middlewares) {
  const express = require('express');
  const app = express();
  for (const mw of middlewares) app.use(mw);
  app.get('/', (req, res) => res.send('ok'));
  return app;
}

describe('rate limiters share a store when Redis is configured (#88)', () => {
  let store;

  beforeEach(() => {
    jest.resetModules();
    store = require('../../utils/rate-limit-store');
  });

  afterEach(() => {
    store.setRateLimitRedisClient(null);
  });

  it('falls back to MemoryStore when no client is registered', () => {
    expect(store.hasSharedStore()).toBe(false);
    // undefined lets express-rate-limit apply its MemoryStore default.
    expect(store.buildStore('auth')).toBeUndefined();
  });

  it('builds a Redis-backed store once a client is registered', () => {
    store.setRateLimitRedisClient(fakeRedis());
    expect(store.hasSharedStore()).toBe(true);
    expect(store.buildStore('auth')).toBeDefined();
  });

  it('namespaces each limiter so two cannot share a counter', () => {
    store.setRateLimitRedisClient(fakeRedis());

    const a = store.buildStore('auth');
    const b = store.buildStore('mfa-ip');
    expect(a.prefix).toBe('bartelby:rl:auth:');
    expect(b.prefix).toBe('bartelby:rl:mfa-ip:');
    expect(a.prefix).not.toBe(b.prefix);
  });

  it('resolves the store on first request, not at construction', async () => {
    // The load-bearing behaviour. server.js builds its limiters at module load;
    // the Redis client is only registered later, inside initApp. A limiter that
    // resolved its store eagerly would capture `undefined` — MemoryStore — and
    // keep it forever, which is the bug this whole change exists to prevent.
    //
    // Asserting on hasSharedStore() would NOT catch that: it is true either
    // way. The discriminating signal is whether the client receives traffic, so
    // the limiter must actually count (no `skip`).
    const limiter = store.createLimiter({
      prefix: 'deferred', windowMs: 60_000, max: 100
    });

    // Client arrives AFTER the limiter was created.
    const redis = fakeRedis();
    store.setRateLimitRedisClient(redis);

    const request = require('supertest');
    const res = await request(appWith(limiter)).get('/');
    expect(res.status).toBe(200);

    // Eager binding leaves this empty, because MemoryStore never talks to Redis.
    const evals = redis.sent.filter((args) => String(args[0]).toUpperCase().startsWith('EVAL'));
    expect(evals.length).toBeGreaterThan(0);

    // And the key that reached Redis must carry this limiter's prefix. Without
    // this the wiring between createLimiter's prefix and buildStore is untested
    // — hardcoding buildStore('rl') would put all nine limiters in one bucket
    // and every other assertion here would still pass.
    expect(evals[0][3]).toMatch(/^bartelby:rl:deferred:/);
  });

  it('shares one counter across limiter instances with the same prefix', async () => {
    // The actual thesis of #88: two web machines are two processes, each with
    // its own limiter object. Under the old per-process MemoryStore they each
    // got a full budget. Sharing a prefix must mean sharing a count.
    store.setRateLimitRedisClient(fakeRedis());
    const request = require('supertest');

    const opts = { prefix: 'shared', windowMs: 60_000, max: 2, legacyHeaders: false };
    const machineA = store.createLimiter({ ...opts });
    const machineB = store.createLimiter({ ...opts });

    expect((await request(appWith(machineA)).get('/')).status).toBe(200);
    expect((await request(appWith(machineB)).get('/')).status).toBe(200);
    // Third request is over the shared cap regardless of which "machine" serves it.
    expect((await request(appWith(machineA)).get('/')).status).toBe(429);
  });

  it('keeps separate counters for different prefixes', async () => {
    store.setRateLimitRedisClient(fakeRedis());
    const request = require('supertest');

    const opts = { windowMs: 60_000, max: 1, legacyHeaders: false };
    const login = store.createLimiter({ ...opts, prefix: 'auth-x' });
    const browse = store.createLimiter({ ...opts, prefix: 'general-x' });

    expect((await request(appWith(login)).get('/')).status).toBe(200);
    // Browsing must not consume the login budget.
    expect((await request(appWith(browse)).get('/')).status).toBe(200);
    expect((await request(appWith(login)).get('/')).status).toBe(429);
  });

  it('builds the limiter once, so counts accumulate across requests', async () => {
    // Rebuilding per request would hand each one a fresh store. With Redis that
    // is merely wasteful; with the MemoryStore fallback every count is 1 and
    // rate limiting is silently off entirely.
    store.setRateLimitRedisClient(null);
    const request = require('supertest');

    const limiter = store.createLimiter({
      prefix: 'cached', windowMs: 60_000, max: 2, legacyHeaders: false
    });
    const app = appWith(limiter);

    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(429);
  });

  it('requires a prefix so a limiter cannot land in the global keyspace', () => {
    expect(() => store.createLimiter({ windowMs: 1000, max: 1 })).toThrow(/prefix/);
  });
});

describe('every limiter in the app is namespaced (#88)', () => {
  const FILES = ['server.js', 'utils/rate-limiters.js'];

  function read(rel) {
    return require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', ...rel.split('/')), 'utf8'
    );
  }

  it.each(FILES)('%s does not construct limiters directly', (rel) => {
    // Importing the library at all bypasses createLimiter, and with it the
    // shared store. Asserting on the import rather than a call shape catches
    // `rateLimit(opts)`, a reformatted call, and inline require() alike.
    expect(read(rel)).not.toMatch(/require\(['"]express-rate-limit['"]\)/);
  });

  it('gives every limiter across both files a distinct prefix', () => {
    // Checked as a union, not per file: utils/rate-limiters.js reusing
    // 'auth' would put AI transcription jobs in the login bucket, and a
    // per-file uniqueness check would pass.
    const prefixes = FILES.flatMap((rel) =>
      [...read(rel).matchAll(/^\s*prefix: '([^']+)',$/gm)].map((m) => m[1])
    );

    expect(prefixes.length).toBeGreaterThanOrEqual(9);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
