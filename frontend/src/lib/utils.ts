/** Tiny className combiner (avoids a dep). */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
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

/** Hours → compact "Xh"/"Yd Zh" label. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h ? `${d}d ${h}h` : `${d}d`;
}
