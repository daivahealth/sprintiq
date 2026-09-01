import { useOutletContext } from 'react-router-dom';
import type { ActivityRange } from '../activity-range';

/**
 * The section's window, plus a re-export of the range vocabulary it shares
 * with Project Activity.
 *
 * The vocabulary itself lives one level up (`../activity-window`) because both
 * activity surfaces select from the same five ranges against the same backend
 * mapping. Two copies is how they drift apart, and a section whose subject is
 * ranges that mean exactly what they say cannot afford that.
 */
export * from '../activity-window';
export * from '../activity-range';

/** What the shell hands every subpage. */
export interface SectionContext {
  range: ActivityRange;
  setRange: (r: ActivityRange) => void;
}

export function useSectionRange(): SectionContext {
  return useOutletContext<SectionContext>();
}
