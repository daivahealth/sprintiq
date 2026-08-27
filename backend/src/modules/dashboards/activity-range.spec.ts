import { BadRequestException } from '@nestjs/common';
import { istWindowFloor } from '../../common/time';
import { resolveActivityRange } from './activity-range';

const NOW = new Date('2026-08-25T09:00:00.000Z');

describe('resolveActivityRange', () => {
  describe('presets', () => {
    it('resolves a known preset exactly as the boards always have', () => {
      const range = resolveActivityRange('week', undefined, undefined, NOW);

      expect(range.windowDays).toBe(7);
      expect(range.from.toISOString()).toBe(
        istWindowFloor(7, NOW).toISOString(),
      );
      expect(range.to).toBe(NOW);
    });

    it('falls back to 30 days for a window it does not know', () => {
      // Deliberate tolerance, not sloppiness: it lets a frontend ship ahead of
      // this backend and name a range it has not learned yet. The 30 is
      // echoed as `windowDays`, so the board labels what was measured.
      const range = resolveActivityRange(
        'fortnight',
        undefined,
        undefined,
        NOW,
      );
      expect(range.windowDays).toBe(30);
    });

    it('ignores from/to when the window is a preset', () => {
      const range = resolveActivityRange('day', '2026-01-01', '2026-01-31', NOW);
      expect(range.windowDays).toBe(1);
    });
  });

  describe('custom', () => {
    it('covers both endpoint days in full', () => {
      const range = resolveActivityRange(
        'custom',
        '2026-04-01',
        '2026-06-30',
        NOW,
      );

      expect(range.from.toISOString()).toBe('2026-03-31T18:30:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-30T18:29:59.999Z');
      expect(range.windowDays).toBe(91);
    });

    it('accepts a single day', () => {
      const range = resolveActivityRange(
        'custom',
        '2026-06-30',
        '2026-06-30',
        NOW,
      );
      expect(range.windowDays).toBe(1);
    });

    it('clamps an end in the future to now rather than rejecting it', () => {
      // "Through today" is a well-defined request. What it must never do is
      // claim data for hours that have not happened.
      const range = resolveActivityRange(
        'custom',
        '2026-08-01',
        '2026-12-31',
        NOW,
      );
      expect(range.to).toBe(NOW);
    });

    it('rejects a missing endpoint', () => {
      expect(() =>
        resolveActivityRange('custom', '2026-04-01', undefined, NOW),
      ).toThrow(BadRequestException);
      expect(() =>
        resolveActivityRange('custom', undefined, '2026-06-30', NOW),
      ).toThrow(BadRequestException);
    });

    it('rejects a malformed date', () => {
      // 400 rather than the preset fallback: a broken range is not a newer
      // vocabulary, and answering it with a silent 30 days is exactly the
      // mislabelling the fallback exists to prevent.
      expect(() =>
        resolveActivityRange('custom', '01/04/2026', '2026-06-30', NOW),
      ).toThrow(BadRequestException);
      expect(() =>
        resolveActivityRange('custom', '2026-13-45', '2026-06-30', NOW),
      ).toThrow(BadRequestException);
    });

    it('rejects a range that runs backwards', () => {
      expect(() =>
        resolveActivityRange('custom', '2026-06-30', '2026-04-01', NOW),
      ).toThrow(BadRequestException);
    });
  });
});
