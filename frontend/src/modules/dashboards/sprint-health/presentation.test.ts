import { describe, expect, it } from 'vitest';
import { checkInBucket, formatDateRange, initials, priorityBand } from './presentation';

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Rahul Kumar Sharma')).toBe('RS');
  });
  it('handles a single name and blank input', () => {
    expect(initials('rahul')).toBe('R');
    expect(initials('   ')).toBe('?');
  });
});

describe('checkInBucket', () => {
  it('never weights a zero', () => {
    expect(checkInBucket(0, 5)).toBe('zero');
    expect(checkInBucket(0, 0)).toBe('zero');
  });
  it('weights relative to the page maximum', () => {
    expect(checkInBucket(5, 5)).toBe('high');
    expect(checkInBucket(3, 5)).toBe('mid');
    expect(checkInBucket(1, 5)).toBe('low');
  });
});

describe('priorityBand', () => {
  it('maps the common Jira schemes', () => {
    expect(priorityBand('Highest')).toBe('p1');
    expect(priorityBand('Blocker')).toBe('p1');
    expect(priorityBand('High')).toBe('p2');
    expect(priorityBand('Medium')).toBe('p3');
    expect(priorityBand('Low')).toBe('p4');
  });
  it('drops an unknown name to the quietest band', () => {
    expect(priorityBand('Whenever')).toBe('p4');
  });
});

describe('formatDateRange', () => {
  it('formats a same-year range once with the year', () => {
    expect(formatDateRange('2026-08-24', '2026-08-30')).toBe('Aug 24 – Aug 30, 2026');
  });
  it('keeps both years across a year boundary', () => {
    expect(formatDateRange('2026-12-29', '2027-01-04')).toBe(
      'Dec 29, 2026 – Jan 4, 2027',
    );
  });
  it('renders a single day once', () => {
    expect(formatDateRange('2026-08-24', '2026-08-24')).toBe('Aug 24, 2026');
  });
});
