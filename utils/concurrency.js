'use strict';

/**
 * Bounded-concurrency helpers.
 *
 * There was no concurrency limiter for database work anywhere in the
 * codebase, in contrast to `S3_MAX_SOCKETS` for storage traffic. That matters
 * on remote Turso, where every query is an HTTP request: an unbounded
 * `Promise.all` over a result page can put a hundred simultaneous libsql
 * calls in flight from a single inbound request, and `fly.toml` admits up to
 * `soft_limit` concurrent requests per machine on top of that.
 *
 * `processWithConcurrency` was lifted here from utils/pdf-worker.js, where it
 * already served the same purpose for image work.
 *
 * The preferred fix for a database fan-out is still to collapse it into
 * grouped SQL. Use these helpers for the fan-outs that genuinely cannot be
 * collapsed — not as a licence to replace serial loops with `Promise.all`.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding N3).
 */

// Ceiling for database fan-out from a single inbound request. Deliberately
// well below `S3_MAX_SOCKETS` (64): storage work is a handful of large
// transfers, whereas query fan-out multiplies by the number of concurrent
// requests the machine is already serving.
const DB_FANOUT_CONCURRENCY = 8;

/**
 * Runs `iteratee` over `items` with at most `concurrency` in flight, and
 * returns the results in input order.
 */
async function processWithConcurrency(items, concurrency, iteratee) {
  const list = Array.isArray(items) ? items : Array.from(items || []);
  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (index < list.length) {
      const currentIndex = index++;
      results[currentIndex] = await iteratee(list[currentIndex], currentIndex);
    }
  }

  const workers = [];
  const limit = Math.max(1, Math.min(concurrency, list.length || 1));
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * `processWithConcurrency` pre-bound to the database fan-out ceiling, so call
 * sites do not each pick their own number.
 */
async function mapWithDbConcurrency(items, iteratee) {
  return await processWithConcurrency(items, DB_FANOUT_CONCURRENCY, iteratee);
}

module.exports = {
  DB_FANOUT_CONCURRENCY,
  processWithConcurrency,
  mapWithDbConcurrency
};
