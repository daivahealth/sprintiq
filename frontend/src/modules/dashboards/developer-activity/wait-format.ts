/**
 * "4d 2h" — a wait is read in days once it passes one.
 *
 * Rounds to whole hours BEFORE splitting into days. Splitting first and
 * rounding the remainder rendered 47.6h as "1d 24h".
 */
export function formatWait(hours: number): string {
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const total = Math.round(hours);
  const days = Math.floor(total / 24);
  const rest = total - days * 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}
