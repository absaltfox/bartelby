'use strict';

/**
 * Guards the shared bounded-concurrency helper lifted out of
 * utils/pdf-worker.js so database fan-out has a ceiling.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding N3).
 */

const {
  DB_FANOUT_CONCURRENCY,
  processWithConcurrency,
  mapWithDbConcurrency
} = require('../../utils/concurrency');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('processWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const items = [40, 10, 30, 20, 0];
    const results = await processWithConcurrency(items, 3, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });
    expect(results).toEqual([80, 20, 60, 40, 0]);
  });

  it('never runs more than `concurrency` iteratees at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await processWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(25);
  });

  it('really is bounded — the 5th task cannot start until one of the first 4 settles', async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    const started = [];
    const run = processWithConcurrency([0, 1, 2, 3, 4, 5], 4, async (index) => {
      started.push(index);
      await gates[index].promise;
      return index;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]);

    gates[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates.forEach((gate) => gate.resolve());
    await expect(run).resolves.toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles empty and single-item inputs', async () => {
    await expect(processWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
    await expect(processWithConcurrency([7], 4, async (v) => v)).resolves.toEqual([7]);
  });

  it('mapWithDbConcurrency applies the shared database ceiling', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithDbConcurrency(Array.from({ length: 50 }, (_, i) => i), async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(DB_FANOUT_CONCURRENCY);
    expect(DB_FANOUT_CONCURRENCY).toBeLessThan(64); // stays under S3_MAX_SOCKETS
  });
});
