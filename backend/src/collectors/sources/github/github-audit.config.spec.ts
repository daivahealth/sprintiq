import {
  auditCronExpression,
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
  it('builds a seconds-precision cron for each sweep interval', () => {
    expect(fullSweepCronExpression(30)).toBe('0 */30 * * * *');
    expect(fullSweepCronExpression(60)).toBe('0 0 * * * *');
    expect(fullSweepCronExpression(120)).toBe('0 0 */2 * * *');
    expect(fullSweepCronExpression(240)).toBe('0 0 */4 * * *');
  });

  it('still returns a valid (hourly) expression for 0 — the tick itself is gated off', () => {
    expect(fullSweepCronExpression(0)).toBe('0 0 * * * *');
  });
});

describe('auditCronExpression', () => {
  it('builds a seconds-precision cron for each interval', () => {
    expect(auditCronExpression(5)).toBe('0 */5 * * * *');
    expect(auditCronExpression(30)).toBe('0 */30 * * * *');
    expect(auditCronExpression(60)).toBe('0 0 * * * *');
  });
});
