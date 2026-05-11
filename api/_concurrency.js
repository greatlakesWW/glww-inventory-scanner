// ═══════════════════════════════════════════════════════════
// Bounded parallelism for SuiteQL fan-outs.
//
// NetSuite's account-wide SuiteQL concurrency ceiling is ~5,
// shared across every device, tab, and background job. Endpoints
// that fan out one SuiteQL-bearing task per input (e.g. validating
// N SOs in a wave) must cap their parallelism — otherwise even a
// small wave saturates the ceiling and the loser of the race comes
// back as a 429 CONCURRENCY_LIMIT_EXCEEDED. `runSuiteQL` retries on
// that error, but with N callers all retrying on the same backoff
// schedule they collide again; capping at the source is the proper
// fix.
// ═══════════════════════════════════════════════════════════

/**
 * Map `fn` over `items` with at most `concurrency` in-flight at once.
 * Preserves input order in the returned array.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
