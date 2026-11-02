import { describe, expect, it } from 'vitest';
import { developerHref } from './developer-href';
import { formatWait } from './wait-format';

describe('formatWait', () => {
  it('reads hours below a day', () => {
    expect(formatWait(5.25)).toBe('5.3h');
  });

  it('never renders a 24-hour remainder', () => {
    expect(formatWait(47.6)).toBe('2d');
    expect(formatWait(71.5)).toBe('3d');
  });

  it('splits days and hours', () => {
    expect(formatWait(24)).toBe('1d');
    expect(formatWait(26.2)).toBe('1d 2h');
    expect(formatWait(98)).toBe('4d 2h');
  });
});

describe('developerHref', () => {
  it('carries a preset window with the developer', () => {
    expect(developerHref('asha', { kind: 'preset', window: 'quarter' })).toBe(
      '../developer?window=quarter&developer=asha',
    );
  });

  it('carries a custom range with the developer', () => {
    expect(
      developerHref('a b', {
        kind: 'custom',
        from: '2026-10-01',
        to: '2026-10-15',
      }),
    ).toBe(
      '../developer?window=custom&from=2026-10-01&to=2026-10-15&developer=a+b',
    );
  });
});
