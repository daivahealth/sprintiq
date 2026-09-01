import { BadRequestException } from '@nestjs/common';
import {
  istDayEnd,
  istDaySpan,
  istDayStart,
  istWindowFloor,
} from '../../common/time';

/**
 * Selectable ranges for the activity boards, in **IST calendar days including
 * today** (`istWindowFloor`), not rolling hours.
 *
 * The 30-day ceiling these had was a floor on what the boards could show, not a
 * cost control: a repository whose whole history predates it is unreachable at
 * any setting. `athmahealth/nh-website` is the case that surfaced it — 12
 * commits between 20 Jun and 21 Jul, dormant since, so every developer on it
 * read as "0 commits" on every available window. Reviewers then proposed
 * removing those developers as inactive, which is the failure mode a missing
 * range turns into: absence of a window presenting as absence of work.
 *
 * Widening the presets made that repository reachable; it did not make it
 * readable in isolation, since every range containing its active June also
 * contains the dormant months that dilute it. That is what `custom` is for.
 */
export const ACTIVITY_WINDOWS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

/** The window key that means "read from/to instead of a preset length". */
export const CUSTOM_WINDOW = 'custom';

export interface ResolvedRange {
  from: Date;
  /** Inclusive upper bound: the last instant of the To day, or now. */
  to: Date;
  /** Days actually measured, inclusive of both ends — echoed to the client. */
  windowDays: number;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one place a request's range is decided, for every activity endpoint.
 *
 * Note the deliberate asymmetry in how the two failure modes are treated. An
 * **unknown preset** falls back to 30 days, because that tolerance is what lets
 * a frontend deploy ahead of this backend and name a range it has not learned
 * yet — the client labels its board from the echoed `windowDays`, so it states
 * what was measured. A **broken custom range** is rejected, because it is not a
 * newer vocabulary; it is a malformed request, and answering it with a silent
 * 30 days would be the exact mislabelling the fallback exists to prevent.
 */
export function resolveActivityRange(
  window: string,
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedRange {
  if (window !== CUSTOM_WINDOW) {
    const days = ACTIVITY_WINDOWS[window] ?? 30;
    return { from: istWindowFloor(days, now), to: now, windowDays: days };
  }

  const fromKey = requireDateKey(from, 'from');
  const toKey = requireDateKey(to, 'to');
  if (fromKey > toKey) {
    throw new BadRequestException(
      'Query param "from" must not be later than "to".',
    );
  }

  const end = istDayEnd(toKey);
  return {
    from: istDayStart(fromKey),
    // A range reaching today or beyond means "through now". Clamped rather
    // than rejected — it is a well-defined request — but never left in the
    // future, which would claim data for hours that have not happened.
    to: end > now ? now : end,
    windowDays: istDaySpan(fromKey, toKey),
  };
}

function requireDateKey(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestException(
      `Query param "${name}" is required when window=${CUSTOM_WINDOW}.`,
    );
  }
  if (!DATE_KEY.test(value) || Number.isNaN(istDayStart(value).getTime())) {
    throw new BadRequestException(
      `Query param "${name}" must be an IST calendar date (YYYY-MM-DD).`,
    );
  }
  return value;
}
