import { GithubRateLimit } from './github.client';

/**
 * Quota the bulk reconcilers refuse to spend, leaving it for the scheduled
 * sync. Backfill is never the thing a user is waiting on; the poller is. A
 * reconciler that drains the token to zero starves real collection for the
 * rest of the hour — which is precisely what happened on a real tenant, where
 * a manual backfill run exhausted the limit and every subsequent sync tick
 * returned `rateLimited` until the reset.
 *
 * Env-tunable because the right reserve depends on how many connections a
 * deployment polls (an org sync registers one per repo).
 */
export const DEFAULT_RATE_RESERVE = 1000;

export function rateReserve(): number {
  const raw = Number(process.env.GITHUB_BACKFILL_RATE_RESERVE);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_RATE_RESERVE;
}

export interface BudgetState {
  /** Stop this run: either a hard rate limit, or the reserve was reached. */
  exhausted: boolean;
  /** When it is worth trying again. */
  resumeAt?: Date;
  /** True when we stopped voluntarily rather than being cut off. */
  reserved: boolean;
}

/**
 * Decides whether a bulk run should stop, given what the last response said.
 *
 * Two distinct stops, deliberately not merged:
 *  - `rateLimitedUntil` — GitHub already refused us. Nothing to do but wait.
 *  - remaining below the reserve — we are still allowed to call, and choose
 *    not to. This is the one that keeps the poller alive.
 */
export function evaluateBudget(
  result: { rateLimitedUntil?: Date; rateLimit?: GithubRateLimit },
  reserve = rateReserve(),
): BudgetState {
  if (result.rateLimitedUntil) {
    return {
      exhausted: true,
      resumeAt: result.rateLimitedUntil,
      reserved: false,
    };
  }
  if (result.rateLimit && result.rateLimit.remaining <= reserve) {
    return {
      exhausted: true,
      resumeAt: result.rateLimit.resetAt,
      reserved: true,
    };
  }
  return { exhausted: false, reserved: false };
}
