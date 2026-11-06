import { describe, expect, it } from 'vitest';
import type { DataGapFinding, DataGapKind } from '../useInsights';
import { GAP_COPY } from './gap-copy';

const finding = (
  kind: DataGapKind,
  count: number,
  commits: number | null = null,
): DataGapFinding => ({ kind, severity: 'action', count, commits, sample: [] });

describe('GAP_COPY', () => {
  it('reads correctly for one ticket and for many', () => {
    const copy = GAP_COPY['jira-not-updated'];

    expect(copy.statement(finding('jira-not-updated', 1), 'NHC')).toBe(
      '1 ticket has every linked PR merged, but Jira still shows a development status.',
    );
    expect(copy.statement(finding('jira-not-updated', 3), 'NHC')).toMatch(
      /^3 tickets have every/,
    );
  });

  it('names the project and the commits behind a sprint-wide finding', () => {
    expect(
      GAP_COPY['ticket-not-in-sprint'].statement(
        finding('ticket-not-in-sprint', 24, 112),
        'NHC',
      ),
    ).toBe(
      '112 commits in this sprint name 24 NHC tickets that are in no sprint (the backlog).',
    );
    expect(GAP_COPY['commits-not-tagged'].fix('ACT')).toContain('ACT-123');
  });
});
