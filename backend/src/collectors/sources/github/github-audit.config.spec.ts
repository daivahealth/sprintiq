import {
  ALLOWED_AUDIT_INTERVALS,
  ALLOWED_FULL_SWEEP_INTERVALS,
  auditCronExpression,
  effectiveLagWarnMinutes,
  fullSweepCronExpression,
  readGithubAuditConfig,
} from './github-audit.config';

describe('readGithubAuditConfig', () => {
  it('defaults to off, every 5 minutes, 100 per page', () => {
    expect(readGithubAuditConfig({})).toEqual({
      mode: 'off',
      intervalMinutes: 5,
      pageSize: 100,
      overlapMinutes: 15,
      compareConcurrency: 2,
      maxRangeAttempts: 5,
      maxPages: 200,
      lagWarnMinutes: 30,
      fullSweepMinutes: 60,
      newRepoMaxBranches: 50,
    });
  });

  it.each([5, 10, 15, 20, 30, 60])('accepts a %i-minute interval', (n) => {
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: String(n) })
        .intervalMinutes,
    ).toBe(n);
  });

  it('rejects an interval outside the allowed set', () => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '7' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_INTERVAL_MINUTES/);
  });

  it('rejects an unknown mode and accepts shadow/ingest case-insensitively', () => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'on' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_MODE/);
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'Shadow' }).mode,
    ).toBe('shadow');
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' }).mode,
    ).toBe('ingest');
  });

  it('bounds page size to 1..100', () => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '101' }),
    ).toThrow();
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '50' }).pageSize,
    ).toBe(50);
  });

  it('treats empty strings as unset', () => {
    expect(readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '' }).pageSize).toBe(
      100,
    );
  });

  it('bounds the lag warning threshold to 5..1440 minutes, default 30', () => {
    expect(readGithubAuditConfig({}).lagWarnMinutes).toBe(30);
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_LAG_WARN_MINUTES: '60' })
        .lagWarnMinutes,
    ).toBe(60);
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_LAG_WARN_MINUTES: '4' }),
    ).toThrow(/GITHUB_AUDIT_LAG_WARN_MINUTES/);
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_LAG_WARN_MINUTES: '1441' }),
    ).toThrow(/GITHUB_AUDIT_LAG_WARN_MINUTES/);
  });
});

describe('effectiveLagWarnMinutes', () => {
  it.each([
    [30, 5, 30],
    [30, 15, 30],
    [30, 20, 40],
    [30, 60, 120],
    [180, 60, 180],
  ])(
    'threshold %i with a %i-minute interval → %i',
    (lagWarnMinutes, intervalMinutes, expected) => {
      expect(
        effectiveLagWarnMinutes({ lagWarnMinutes, intervalMinutes }),
      ).toBe(expected);
    },
  );
});

describe('GITHUB_AUDIT_FULL_SWEEP_MINUTES', () => {
  it.each([0, 30, 60, 120, 240])('accepts %i', (n) => {
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_FULL_SWEEP_MINUTES: String(n) })
        .fullSweepMinutes,
    ).toBe(n);
  });

  it('defaults to 60 and treats an empty value as unset', () => {
    expect(readGithubAuditConfig({}).fullSweepMinutes).toBe(60);
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_FULL_SWEEP_MINUTES: '' })
        .fullSweepMinutes,
    ).toBe(60);
  });

  it.each(['15', '90', '480', '-30', 'hourly'])('rejects %s', (raw) => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_FULL_SWEEP_MINUTES: raw }),
    ).toThrow(/GITHUB_AUDIT_FULL_SWEEP_MINUTES/);
  });
});

describe('fullSweepCronExpression', () => {
  it('builds a seconds-precision cron for each sweep interval, offset 2 minutes', () => {
    expect(fullSweepCronExpression(30)).toBe('0 2,32 * * * *');
    expect(fullSweepCronExpression(60)).toBe('0 2 * * * *');
    expect(fullSweepCronExpression(120)).toBe('0 2 */2 * * *');
    expect(fullSweepCronExpression(240)).toBe('0 2 */4 * * *');
  });

  it('still returns a valid (hourly, offset) expression for 0 — the tick itself is gated off', () => {
    expect(fullSweepCronExpression(0)).toBe('0 2 * * * *');
  });

  /** Minute values (0–59) a six-field cron's minute field fires on. */
  function minutesOf(expr: string): Set<number> {
    const field = expr.split(' ')[1];
    const out = new Set<number>();
    for (const part of field.split(',')) {
      const step = /^\*\/(\d+)$/.exec(part);
      if (step) {
        for (let m = 0; m < 60; m += Number(step[1])) out.add(m);
      } else if (part === '*') {
        for (let m = 0; m < 60; m++) out.add(m);
      } else if (/^\d+$/.test(part)) {
        out.add(Number(part));
      } else {
        throw new Error(`unparsed minute field part "${part}" in "${expr}"`);
      }
    }
    return out;
  }

  it.each(
    ALLOWED_AUDIT_INTERVALS.flatMap((a) =>
      ALLOWED_FULL_SWEEP_INTERVALS.map((s) => [a, s] as [number, number]),
    ),
  )(
    'audit every %i min and sweep every %i min never fire in the same minute',
    (audit, sweep) => {
      const auditMinutes = minutesOf(auditCronExpression(audit));
      const sweepMinutes = minutesOf(fullSweepCronExpression(sweep));
      expect(auditMinutes.size).toBeGreaterThan(0);
      expect(sweepMinutes.size).toBeGreaterThan(0);
      const shared = [...sweepMinutes].filter((m) => auditMinutes.has(m));
      expect(shared).toEqual([]);
    },
  );
});

describe('auditCronExpression', () => {
  it('builds a seconds-precision cron for each interval', () => {
    expect(auditCronExpression(5)).toBe('0 */5 * * * *');
    expect(auditCronExpression(30)).toBe('0 */30 * * * *');
    expect(auditCronExpression(60)).toBe('0 0 * * * *');
  });
});

describe('GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES', () => {
  it('defaults to 50 and treats an empty value as unset', () => {
    expect(readGithubAuditConfig({}).newRepoMaxBranches).toBe(50);
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: '' })
        .newRepoMaxBranches,
    ).toBe(50);
  });

  it.each([0, 1, 500])('accepts %i', (n) => {
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: String(n) })
        .newRepoMaxBranches,
    ).toBe(n);
  });

  it.each(['-1', '501', '2.5', 'many'])('rejects %s', (v) => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: v }),
    ).toThrow(/GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES/);
  });
});
