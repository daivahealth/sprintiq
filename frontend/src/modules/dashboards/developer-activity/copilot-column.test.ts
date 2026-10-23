import { describe, expect, it } from 'vitest';
import {
  copilotCaption,
  copilotCellText,
  showCopilotColumn,
} from './copilot-column';

describe('showCopilotColumn', () => {
  it('hides the column until a report has been collected', () => {
    // An older API (undefined) and a tenant that never collected (false)
    // must both hide it — "—" on every row would read as "nobody uses it".
    expect(showCopilotColumn(undefined)).toBe(false);
    expect(
      showCopilotColumn({
        collected: false,
        coveredThrough: null,
        reportDaysInWindow: 0,
      }),
    ).toBe(false);
    expect(
      showCopilotColumn({
        collected: true,
        coveredThrough: '2026-10-12',
        reportDaysInWindow: 5,
      }),
    ).toBe(true);
  });
});

describe('copilotCellText', () => {
  it('prints days and lines for an active developer', () => {
    expect(
      copilotCellText({ status: 'active', activeDays: 6, linesAdded: 1240 }),
    ).toEqual({ primary: '6 days', secondary: '1,240 lines' });
    expect(
      copilotCellText({ status: 'active', activeDays: 1, linesAdded: 0 }),
    ).toEqual({ primary: '1 day', secondary: '0 lines' });
  });

  it('separates seat-but-unused, no seat, and unknown', () => {
    const empty = { activeDays: 0, linesAdded: 0 };
    expect(copilotCellText({ status: 'seat_unused', ...empty }).primary).toBe(
      'Seat, not used',
    );
    expect(copilotCellText({ status: 'no_seat', ...empty }).primary).toBe(
      'No seat',
    );
    expect(copilotCellText({ status: 'no_activity', ...empty }).primary).toBe(
      'None reported',
    );
    expect(copilotCellText(null).primary).toBe('—');
    expect(copilotCellText(undefined).primary).toBe('—');
  });
});

describe('copilotCaption', () => {
  it('states the rule, the freshness, and what GitHub cannot see', () => {
    const caption = copilotCaption({
      collected: true,
      coveredThrough: '2026-10-12',
      reportDaysInWindow: 5,
    });
    expect(caption).toContain('data through 2026-10-12');
    expect(caption).toContain('never a ranking');
    expect(caption).toContain("no data doesn't mean not using AI");
  });
});
