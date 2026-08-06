import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** className combiner with Tailwind conflict resolution (last write wins). */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}

/** Human-friendly "time ago" for freshness indicators. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** IST has no DST, so a static +5:30 shift always gives the correct calendar date. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The last `windowDays` IST calendar-date keys (YYYY-MM-DD), ending today,
 * oldest first — for building a contiguous day axis. Must stay in sync with
 * the backend's `dailySeries` bucketing (`insights.service.ts`'s `istDateKey`)
 * or the axis and the data it's zero-filling against will disagree on what
 * "today" means.
 */
export function istDayAxis(windowDays: number): string[] {
  const todayIst = new Date(Date.now() + IST_OFFSET_MS);
  todayIst.setUTCHours(0, 0, 0, 0);
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(
      new Date(todayIst.getTime() - i * 86_400_000).toISOString().slice(0, 10),
    );
  }
  return out;
}

/** Hours → compact "Xh"/"Yd Zh" label. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h ? `${d}d ${h}h` : `${d}d`;
}
