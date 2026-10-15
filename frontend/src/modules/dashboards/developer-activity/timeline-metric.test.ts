import { describe, expect, it } from 'vitest';
import type { ActivityDay } from '../useInsights';
import { hasDailyLoc, timelineMetric, timelineValue } from './timeline-metric';

function day(date: string, totalCommits: number, locChanged?: number): ActivityDay {
  return {
    date,
    totalCommits,
    ...(locChanged === undefined ? {} : { locChanged }),
    developers: [],
    unattributedCommits: 0,
  };
}

const WITH_LOC = [day('2026-10-13', 9, 40), day('2026-10-14', 1, 4_000)];

describe('timelineMetric', () => {
  it('draws LOC by default when every day carries it', () => {
    expect(timelineMetric(WITH_LOC, 'loc')).toBe('loc');
  });

  it('draws commits when the reader toggles to commits', () => {
    expect(timelineMetric(WITH_LOC, 'commits')).toBe('commits');
  });

  it('falls back to commits when any day lacks LOC (an older API)', () => {
    const mixed = [day('2026-10-13', 9, 40), day('2026-10-14', 1)];
    expect(hasDailyLoc(mixed)).toBe(false);
    expect(timelineMetric(mixed, 'loc')).toBe('commits');
  });

  it('has no LOC to offer for an empty window', () => {
    expect(hasDailyLoc([])).toBe(false);
    expect(timelineMetric([], 'loc')).toBe('commits');
  });
});

describe('timelineValue', () => {
  it('reads lines in LOC mode and commits in commit mode', () => {
    const [many, big] = WITH_LOC;
    expect(timelineValue(big, 'loc')).toBeGreaterThan(timelineValue(many, 'loc'));
    expect(timelineValue(many, 'commits')).toBeGreaterThan(
      timelineValue(big, 'commits'),
    );
  });
});
