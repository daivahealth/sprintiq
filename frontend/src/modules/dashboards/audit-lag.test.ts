import { describe, expect, it } from 'vitest';
import { auditLagWarning, formatLag } from './audit-lag';

const behind = {
  applies: true,
  lagMinutes: 4053,
  behind: true,
  checkpointAt: '2026-10-16T13:41:00.000Z',
};

describe('auditLagWarning', () => {
  it('warns when the route is part of collection and behind', () => {
    expect(auditLagWarning(behind)).toBe(
      'branch-only commits may be missing — the audit-log route is 2d 19h behind',
    );
  });

  it('says nothing when the route is on time, not in use, or unknown', () => {
    expect(auditLagWarning({ ...behind, behind: false })).toBeNull();
    expect(auditLagWarning({ ...behind, applies: false })).toBeNull();
    expect(auditLagWarning({ ...behind, lagMinutes: null })).toBeNull();
    expect(auditLagWarning(null)).toBeNull();
    expect(auditLagWarning(undefined)).toBeNull();
  });

  it('says nothing for a range that ended before the route stopped reading', () => {
    expect(auditLagWarning(behind, '2026-10-15T18:29:59.999Z')).toBeNull();
    expect(auditLagWarning(behind, '2026-10-19T18:29:59.999Z')).not.toBeNull();
  });
});

describe('formatLag', () => {
  it('reads in minutes, hours or days', () => {
    expect(formatLag(45)).toBe('45m');
    expect(formatLag(120)).toBe('2h');
    expect(formatLag(200)).toBe('3h 20m');
    expect(formatLag(2880)).toBe('2d');
    expect(formatLag(3000)).toBe('2d 2h');
  });
});
