/**
 * Pure presentation helpers shared by the Sprint Health panels. No data is
 * computed here — only how an already-computed number is shown.
 */

/** "Rahul Sharma" -> "RS", "rahul" -> "R", "" -> "?". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export type CheckInBucket = 'zero' | 'low' | 'mid' | 'high';

/**
 * Weight of one check-in cell, relative to the busiest cell on the current
 * page. Relative rather than absolute because teams move tickets at very
 * different rates; the count itself is always printed, so the weight is a
 * scanning aid, never the figure.
 */
export function checkInBucket(count: number, max: number): CheckInBucket {
  if (count <= 0 || max <= 0) return 'zero';
  const ratio = count / max;
  if (ratio >= 0.75) return 'high';
  if (ratio >= 0.4) return 'mid';
  return 'low';
}

/** Severity band for a Jira priority name — p1 most severe. */
export type PriorityBand = 'p1' | 'p2' | 'p3' | 'p4';

/**
 * Jira priority names vary by scheme (Highest/High/Medium/Low,
 * Blocker/Critical/Major/Minor, P1..P4). Unknown names fall to the quietest
 * band rather than being guessed upward.
 */
export function priorityBand(priority: string): PriorityBand {
  const p = priority.trim().toLowerCase();
  if (['highest', 'blocker', 'critical', 'p1', 'p0'].includes(p)) return 'p1';
  if (['high', 'major', 'p2'].includes(p)) return 'p2';
  if (['medium', 'normal', 'p3'].includes(p)) return 'p3';
  return 'p4';
}

/** Text colour per severity band — Highest red through Low recessive. */
export const PRIORITY_TEXT: Record<PriorityBand, string> = {
  p1: 'text-danger-fg',
  p2: 'text-chart-1',
  p3: 'text-warning-fg',
  p4: 'text-fg-subtle',
};

/** Fill colour per severity band, for bars and dots. */
export const PRIORITY_FILL: Record<PriorityBand, string> = {
  p1: 'bg-danger',
  p2: 'bg-chart-1',
  p3: 'bg-warning',
  p4: 'bg-fg-faint',
};

const MONTH_DAY: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
};

/**
 * Two IST date keys ("2026-08-24") -> "Aug 24 – Aug 30, 2026". The keys are
 * already IST calendar days, so they are anchored at UTC midnight and
 * formatted in UTC — no timezone conversion happens on the client.
 */
export function formatDateRange(fromKey: string, toKey: string): string {
  const from = new Date(`${fromKey}T00:00:00.000Z`);
  const to = new Date(`${toKey}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';
  const fromYear = from.getUTCFullYear();
  const toYear = to.getUTCFullYear();
  const fromText = from.toLocaleDateString('en-US', MONTH_DAY);
  const toText = to.toLocaleDateString('en-US', MONTH_DAY);
  if (fromKey === toKey) return `${fromText}, ${fromYear}`;
  return fromYear === toYear
    ? `${fromText} – ${toText}, ${toYear}`
    : `${fromText}, ${fromYear} – ${toText}, ${toYear}`;
}
