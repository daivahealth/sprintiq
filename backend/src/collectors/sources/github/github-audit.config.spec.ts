import {
  auditCronExpression,
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
});

describe('auditCronExpression', () => {
  it('builds a seconds-precision cron for each interval', () => {
    expect(auditCronExpression(5)).toBe('0 */5 * * * *');
    expect(auditCronExpression(30)).toBe('0 */30 * * * *');
    expect(auditCronExpression(60)).toBe('0 0 * * * *');
  });
});
