import { istDateKey, istMidnightUtc, istWindowFloor } from './time';

describe('IST time helpers', () => {
  describe('istDateKey', () => {
    it('matches the UTC date for most of the day', () => {
      expect(istDateKey(new Date('2026-06-01T10:00:00.000Z'))).toBe(
        '2026-06-01',
      );
    });

    it('rolls over to the next day for the 18:30-23:59:59 UTC divergence window (00:00-05:29:59 IST)', () => {
      // 19:00 UTC = 00:30 IST the next calendar day
      expect(istDateKey(new Date('2026-06-01T19:00:00.000Z'))).toBe(
        '2026-06-02',
      );
      // right at the boundary
      expect(istDateKey(new Date('2026-06-01T18:30:00.000Z'))).toBe(
        '2026-06-02',
      );
      expect(istDateKey(new Date('2026-06-01T18:29:59.000Z'))).toBe(
        '2026-06-01',
      );
    });
  });

  describe('istMidnightUtc', () => {
    it('returns the UTC instant of IST midnight for a moment late in the IST day', () => {
      // 2026-06-02 20:00 IST = 2026-06-02 14:30 UTC
      const now = new Date('2026-06-02T14:30:00.000Z');
      // IST midnight for 2026-06-02 is 2026-06-01T18:30:00.000Z
      expect(istMidnightUtc(now).toISOString()).toBe(
        '2026-06-01T18:30:00.000Z',
      );
    });

    it('returns the SAME IST midnight for a moment just after it rolls over', () => {
      // 2026-06-02 00:01 IST = 2026-06-01 18:31 UTC — still the 06-02 IST day
      const now = new Date('2026-06-01T18:31:00.000Z');
      expect(istMidnightUtc(now).toISOString()).toBe(
        '2026-06-01T18:30:00.000Z',
      );
    });
  });

  describe('istWindowFloor', () => {
    it('"today" (days=1) is calendar-aligned to IST midnight, not a rolling 24h lookback', () => {
      // 2026-06-02 20:00 IST (14:30 UTC) — 3pm-ish local afternoon
      const now = new Date('2026-06-02T14:30:00.000Z');
      // floor must be IST midnight *today*, not `now - 24h`
      expect(istWindowFloor(1, now).toISOString()).toBe(
        '2026-06-01T18:30:00.000Z',
      );
      expect(istWindowFloor(1, now).getTime()).not.toBe(
        now.getTime() - 86_400_000,
      );
    });

    it('"this week" (days=7) floors to IST midnight 6 days ago, covering 7 calendar days including today', () => {
      const now = new Date('2026-06-10T14:30:00.000Z'); // 2026-06-10 IST afternoon
      const floor = istWindowFloor(7, now);
      // 6 days before 2026-06-09T18:30:00.000Z (today's IST midnight) is 2026-06-03T18:30:00.000Z
      expect(floor.toISOString()).toBe('2026-06-03T18:30:00.000Z');
    });
  });
});
