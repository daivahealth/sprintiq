import type { CopilotCoverage, DeveloperCopilot } from '../useInsights';

/**
 * Text for the Overview roster's Copilot column (ADR-0012), kept out of the
 * component so every wording the column can print is pinned by a test.
 *
 * The column exists only once a report has been collected. Before that there
 * is nothing true to say per person, and "—" on every row would read as
 * "nobody uses Copilot".
 */
export function showCopilotColumn(
  coverage: CopilotCoverage | undefined,
): boolean {
  return coverage?.collected === true;
}

export function copilotCellText(cell: DeveloperCopilot | null | undefined): {
  primary: string;
  secondary?: string;
} {
  if (!cell) {
    return { primary: '—' };
  }
  switch (cell.status) {
    case 'active':
      return {
        primary: `${cell.activeDays} ${cell.activeDays === 1 ? 'day' : 'days'}`,
        secondary: `${cell.linesAdded.toLocaleString()} lines`,
      };
    case 'seat_unused':
      return { primary: 'Seat, not used' };
    case 'no_seat':
      return { primary: 'No seat' };
    default:
      // Seats unknown and nothing reported: "none reported" is all we know.
      return { primary: 'None reported' };
  }
}

/** The rule the column is computed from, shown with it (ADR-0012). */
export function copilotCaption(coverage: CopilotCoverage): string {
  const through = coverage.coveredThrough
    ? ` Reported by GitHub about two days late — data through ${coverage.coveredThrough} (UTC).`
    : '';
  return (
    'Copilot: days GitHub reported any Copilot activity for the person (UTC days), and the lines Copilot added. ' +
    'Context, never a ranking or a productivity score — the column cannot be sorted on.' +
    through +
    " GitHub doesn't count Copilot on github.com or mobile, or IDEs with telemetry off, so no data doesn't mean not using AI."
  );
}
