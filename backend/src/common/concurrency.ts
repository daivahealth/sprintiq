/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * `allSettled` semantics without `allSettled`: every worker drains the queue
 * even after a failure, then the first error is rethrown, so a caller's
 * `finally` never runs while work is still in flight. Errors are caught per
 * ITEM so one bad item costs one item, not the rest of the queue.
 */
export async function forEachBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  // Safe without a lock: the read-and-increment is synchronous.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      try {
        await fn(items[next++]);
      } catch (err) {
        firstError ??= err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
}
