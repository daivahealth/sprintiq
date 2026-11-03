/** IST has no DST, so a fixed +5:30 gives the right calendar date. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** An instant as its IST calendar date, the app's day convention. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** An instant as IST date and time, for freshness. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const ist = new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 16)} IST`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
