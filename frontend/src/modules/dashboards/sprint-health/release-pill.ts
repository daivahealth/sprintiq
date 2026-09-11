export interface ReleaseCandidatePillInput {
  daysLate: number | null;
  released: boolean;
}

export interface ReleaseCandidatePill {
  tone: 'good' | 'bad' | 'neutral';
  text: string;
}

/**
 * The RC date pill, driven strictly by what is known.
 *
 * Three states, and the third (`daysLate === null`) is not a failure to
 * compute — it is the honest answer. Jira overwrites a version's planned
 * date the moment it releases, so without a recorded plan there is nothing
 * to compare against. That null splits two ways: an RC that hasn't shipped
 * yet has nothing to compare BECAUSE it isn't done, while a released one
 * with no recorded plan has nothing to compare because nobody ever stated
 * one — conflating the two into a single "unknown" would silently imply
 * "on time" for a plan that was simply never written down.
 */
export function releaseCandidatePill(
  rc: ReleaseCandidatePillInput,
): ReleaseCandidatePill {
  if (rc.daysLate === null) {
    return rc.released
      ? { tone: 'neutral', text: 'No planned date recorded' }
      : { tone: 'neutral', text: 'Not yet released' };
  }
  return rc.daysLate > 0
    ? { tone: 'bad', text: `${rc.daysLate} days late` }
    : { tone: 'good', text: 'On time' };
}
