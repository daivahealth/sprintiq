import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RunDigestDto } from './digest-admin.controller';

function errorsFor(day: unknown) {
  const dto = plainToInstance(RunDigestDto, { day });
  return validateSync(dto);
}

describe('RunDigestDto.day validation', () => {
  it('accepts a real calendar date', () => {
    expect(errorsFor('2026-09-17')).toHaveLength(0);
  });

  it('accepts a real leap-day date', () => {
    expect(errorsFor('2028-02-29')).toHaveLength(0);
  });

  it('accepts an absent day (defaults to the previous working day)', () => {
    expect(errorsFor(undefined)).toHaveLength(0);
  });

  it('rejects a date that silently rolls forward — 2026-02-30 is really 2 March', () => {
    // Shape-only validation (`\d{4}-\d{2}-\d{2}`) lets this through, and
    // `new Date('2026-02-30')` rolls to 2 March — the window queried would
    // then disagree with the `reportedDay` recorded on the run row.
    const errors = errorsFor('2026-02-30');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual(
      expect.objectContaining({
        isRealCalendarDateKey: expect.stringContaining('real calendar date'),
      }),
    );
  });

  it('rejects a value that yields an Invalid Date — the freshness gate fails open otherwise', () => {
    // '9999-99-99' matches the shape regex but produces an Invalid Date.
    // `no-commit-detection.service.ts`'s freshness gate
    // (`!collectedThroughAt || collectedThroughAt < to`) is false on BOTH
    // sides against an Invalid Date `to`, so unguarded, the gate does not
    // withhold and execution continues on garbage input.
    const errors = errorsFor('9999-99-99');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual(
      expect.objectContaining({
        isRealCalendarDateKey: expect.stringContaining('real calendar date'),
      }),
    );
  });

  it('still rejects a value with the wrong shape via the existing regex', () => {
    const errors = errorsFor('17-09-2026');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual(
      expect.objectContaining({
        matches: expect.stringContaining('IST date key'),
      }),
    );
  });
});
