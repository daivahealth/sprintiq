import { describe, expect, it } from 'vitest';
import { resolutionBadge, sortByDisplayName } from './tracked-developers-logic';
import type { TrackedDeveloper } from '../../lib/api/types';

function dev(overrides: Partial<TrackedDeveloper> = {}): TrackedDeveloper {
  return {
    developer: 'zeta-login',
    addedAs: 'zeta-login',
    displayName: 'Zeta',
    resolved: true,
    note: null,
    createdByUserId: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sortByDisplayName', () => {
  it('orders by display name, not by login and not by fetch order', () => {
    const items = [
      dev({ developer: 'z-login', displayName: 'Zara Khan' }),
      dev({ developer: 'a-login', displayName: 'Amit Rao' }),
      dev({ developer: 'm-login', displayName: 'Meera Nair' }),
    ];
    expect(sortByDisplayName(items).map((d) => d.displayName)).toEqual([
      'Amit Rao',
      'Meera Nair',
      'Zara Khan',
    ]);
  });

  it('sorts case-insensitively', () => {
    const items = [
      dev({ developer: 'b-login', displayName: 'bob' }),
      dev({ developer: 'a-login', displayName: 'Alice' }),
    ];
    expect(sortByDisplayName(items).map((d) => d.displayName)).toEqual([
      'Alice',
      'bob',
    ]);
  });

  it('breaks a tied display name by login, for a stable order', () => {
    const items = [
      dev({ developer: 'z-login', displayName: 'Sam' }),
      dev({ developer: 'a-login', displayName: 'Sam' }),
    ];
    expect(sortByDisplayName(items).map((d) => d.developer)).toEqual([
      'a-login',
      'z-login',
    ]);
  });

  it('does not mutate the input array', () => {
    const items = [
      dev({ developer: 'z-login', displayName: 'Zara' }),
      dev({ developer: 'a-login', displayName: 'Amit' }),
    ];
    const original = [...items];
    sortByDisplayName(items);
    expect(items).toEqual(original);
  });
});

describe('resolutionBadge', () => {
  it('reads as a positive, quiet state when resolved', () => {
    const badge = resolutionBadge(true);
    expect(badge.tone).toBe('good');
    expect(badge.label).toBe('Resolved');
  });

  // The reason this page exists: an unresolved entry must not read as a
  // neutral chip, and must say plainly that it is a broken entry, not an
  // idle person.
  it('reads as a warning with a plain-language explanation when unresolved', () => {
    const badge = resolutionBadge(false);
    expect(badge.tone).toBe('warn');
    expect(badge.label).toBe('Unresolved');
    expect(badge.explanation).toMatch(/matches no developer/i);
    expect(badge.explanation).toMatch(/not.*someone idle|not as someone idle/i);
  });
});
