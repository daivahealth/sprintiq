import {
  isValidTriStateFlagValue,
  parseTriStateFlag,
} from '../../../config/env-flags';

/**
 * Deployment knobs for the Copilot usage-metrics sync (ADR-0012), parsed in
 * one place so the boot-time validator (`config/env.validation.ts`) and the
 * scheduler can never disagree about what a value means.
 */
export interface GithubCopilotConfig {
  /** `GITHUB_COPILOT_USAGE_SYNC` — off unless explicitly turned on. */
  syncEnabled: boolean;
  /** `GITHUB_COPILOT_BACKFILL_DAYS` — how far back the first run reaches. */
  backfillDays: number;
}

export const DEFAULT_COPILOT_BACKFILL_DAYS = 28;
/** GitHub keeps one year of usage-metrics history. */
export const MAX_COPILOT_BACKFILL_DAYS = 365;

export function readGithubCopilotConfig(
  env: Record<string, unknown> = process.env,
): GithubCopilotConfig {
  const rawSync = env.GITHUB_COPILOT_USAGE_SYNC;
  if (
    rawSync !== undefined &&
    (typeof rawSync !== 'string' ||
      (rawSync.trim() !== '' && !isValidTriStateFlagValue(rawSync)))
  ) {
    throw new Error(
      `Invalid GITHUB_COPILOT_USAGE_SYNC "${String(rawSync)}". Expected one of: on | off | true | false | 1 | 0, or unset (off).`,
    );
  }
  // Unset is off: this sync spends a token with org-wide read access, and a
  // deployment that has never heard of it must not start doing that on upgrade.
  const syncEnabled =
    parseTriStateFlag(
      'GITHUB_COPILOT_USAGE_SYNC',
      rawSync as string | undefined,
    ) ?? false;

  const rawDays = env.GITHUB_COPILOT_BACKFILL_DAYS;
  let backfillDays = DEFAULT_COPILOT_BACKFILL_DAYS;
  if (rawDays !== undefined && String(rawDays).trim() !== '') {
    const parsed = Number(rawDays);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_COPILOT_BACKFILL_DAYS
    ) {
      throw new Error(
        `Invalid GITHUB_COPILOT_BACKFILL_DAYS "${String(rawDays)}". Expected an integer from 1 to ${MAX_COPILOT_BACKFILL_DAYS}.`,
      );
    }
    backfillDays = parsed;
  }

  return { syncEnabled, backfillDays };
}
