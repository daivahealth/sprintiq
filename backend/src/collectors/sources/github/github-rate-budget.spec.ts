import { evaluateBudget } from './github-rate-budget';

describe('evaluateBudget', () => {
  const resetAt = new Date(Date.now() + 600_000);

  it('keeps going while there is quota above the reserve', () => {
    expect(
      evaluateBudget({ rateLimit: { remaining: 4000, resetAt } }, 1000),
    ).toEqual({ exhausted: false, reserved: false });
  });

  it('stops VOLUNTARILY at the reserve, so the poller keeps its quota', () => {
    // The point of the reserve: backfill is never what a user is waiting on,
    // but the scheduled sync is. Draining the token starves it for the hour.
    const b = evaluateBudget({ rateLimit: { remaining: 900, resetAt } }, 1000);

    expect(b.exhausted).toBe(true);
    expect(b.reserved).toBe(true);
    expect(b.resumeAt).toBe(resetAt);
  });

  it('distinguishes being cut off by GitHub from stopping by choice', () => {
    const hard = evaluateBudget({ rateLimitedUntil: resetAt }, 1000);

    expect(hard.exhausted).toBe(true);
    // Not `reserved` — this one we did not choose, and it means the poller has
    // already been starved.
    expect(hard.reserved).toBe(false);
    expect(hard.resumeAt).toBe(resetAt);
  });

  it('continues when GitHub sent no rate-limit headers at all', () => {
    expect(evaluateBudget({}, 1000)).toEqual({
      exhausted: false,
      reserved: false,
    });
  });
});
