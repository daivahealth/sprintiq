import { describe, expect, it } from 'vitest';
import { istDayKeyOffset, istTodayKey } from '../../../lib/utils';
import {
  clampVerifyRange,
  defaultVerifyRange,
  formatDelta,
  groupItems,
  isActionable,
  scopeLabel,
  verificationHeadline,
  verifyRangeProblem,
  type ActivityVerificationReport,
  type DiscrepancyItem,
} from './activity-verification';

function item(over: Partial<DiscrepancyItem>): DiscrepancyItem {
  return {
    kind: 'commit',
    category: 'missing_in_db',
    code: 'not_collected',
    reason: '',
    repoFullName: 'acme/api',
    ref: 'abc1234',
    title: 't',
    url: 'https://github.com/acme/api/commit/abc1234',
    diffs: [],
    ...over,
  };
}

function report(over: Partial<ActivityVerificationReport>): ActivityVerificationReport {
  return {
    developer: 'dev',
    identity: { logins: ['dev'], emails: [] },
    range: { from: '', to: '' },
    scope: 'active',
    status: 'match',
    summary: [],
    counts: {
      commits: { matched: 0, missingInDb: 0, mismatched: 0, onlyInDb: 0, unverifiable: 0 },
      pullRequests: { matched: 0, missingInDb: 0, mismatched: 0, onlyInDb: 0, unverifiable: 0 },
      reviews: { matched: 0, missingInDb: 0, mismatched: 0, onlyInDb: 0, unverifiable: 0 },
    },
    items: [],
    unverified: [],
    coverage: {} as ActivityVerificationReport['coverage'],
    rules: [],
    generatedAt: '',
    ...over,
  };
}

describe('verify range', () => {
  it('starts on the page’s own range', () => {
    expect(defaultVerifyRange({ kind: 'custom', from: '2026-10-01', to: '2026-10-07' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-07',
    });
    const today = istTodayKey();
    expect(defaultVerifyRange({ kind: 'preset', window: 'week' })).toEqual({
      from: istDayKeyOffset(today, -6),
      to: today,
    });
  });

  it('cuts a longer range to the most recent 31 days', () => {
    expect(clampVerifyRange('2026-01-01', '2026-03-31')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('explains why a range cannot run', () => {
    expect(verifyRangeProblem('2026-10-01', '2026-10-07')).toBeNull();
    expect(verifyRangeProblem('2026-10-08', '2026-10-07')).toMatch(/after/);
    expect(verifyRangeProblem('2026-08-01', '2026-10-07')).toMatch(/31 days/);
    expect(verifyRangeProblem('', '2026-10-07')).toMatch(/both/);
  });
});

describe('headline', () => {
  it('never lets an incomplete run read as a match', () => {
    expect(verificationHeadline(report({ status: 'match' }))).toMatch(/matches GitHub/);
    const incomplete = verificationHeadline(
      report({ status: 'incomplete', items: [item({ category: 'unverifiable' })] }),
    );
    expect(incomplete).toMatch(/1 stored record\(s\) could not be verified/);
    expect(verificationHeadline(report({ status: 'incomplete' }))).toMatch(
      /part of GitHub could not be read/,
    );
  });

  it('never counts records awaiting the next sync as discrepancies', () => {
    const text = verificationHeadline(
      report({ status: 'match', items: [item({ category: 'pending_sync' })] }),
    );
    expect(text).toMatch(/^Every stored commit/);
    expect(text).toMatch(/1 newer record\(s\) on GitHub are not synced yet/);
    expect(isActionable({ category: 'pending_sync' })).toBe(false);
    expect(isActionable({ category: 'missing_in_db' })).toBe(true);
  });

  it('counts only actionable discrepancies, by category', () => {
    const text = verificationHeadline(
      report({
        status: 'discrepancies',
        items: [
          item({}),
          item({ category: 'mismatched' }),
          item({ category: 'mismatched' }),
          item({ category: 'unverifiable' }),
        ],
      }),
    );
    expect(text).toBe('3 discrepancies: 1 on github, missing in sprintiq; 2 in both, details differ.');
  });
});

describe('helpers', () => {
  it('groups one category by kind in a fixed order', () => {
    const groups = groupItems(
      [item({ kind: 'review' }), item({ kind: 'commit' }), item({ kind: 'review', category: 'mismatched' })],
      'missing_in_db',
    );
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
      ['commit', 1],
      ['review', 1],
    ]);
  });

  it('formats deltas with a true minus sign', () => {
    expect(formatDelta(3)).toBe('+3');
    expect(formatDelta(-2)).toBe('−2');
    expect(formatDelta(0)).toBe('0');
  });

  it('labels where an unverified scope sits', () => {
    expect(scopeLabel({ kind: 'commits', repoFullName: 'acme/api', branch: 'main', reason: 'x', detail: '' })).toBe(
      'Commits · acme/api · main',
    );
    expect(scopeLabel({ kind: 'pull_requests', reason: 'x', detail: '' })).toBe('PR search');
  });
});
