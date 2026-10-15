import { forEachBounded } from './concurrency';

describe('forEachBounded', () => {
  it('never runs more than `limit` at once and visits every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('drains every item before rethrowing the first error', async () => {
    const seen: number[] = [];
    await expect(
      forEachBounded([1, 2, 3], 1, async (n) => {
        seen.push(n);
        if (n === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2, 3]);
  });
});
