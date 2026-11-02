import { describe, expect, it } from 'vitest';
import { activeDevelopersTile } from './active-developers-tile';

describe('activeDevelopersTile', () => {
  it('counts against the tracked list, and mentions no one outside it', () => {
    expect(
      activeDevelopersTile({ developersWithSignal: 40, trackedDevelopers: 66 }),
    ).toEqual({
      label: 'Active developers',
      value: '40 / 66',
      hint: 'tracked developers with a commit or PR',
    });
  });

  it('stands alone, and says why, when nobody is tracked yet', () => {
    const tile = activeDevelopersTile({
      developersWithSignal: 12,
      trackedDevelopers: null,
    });
    expect(tile.value).toBe('12');
    expect(tile.hint).toMatch(/Developers with No GH-Recorded Activity/);
  });

  it('never invents a denominator for an older API', () => {
    expect(activeDevelopersTile({ developersWithSignal: 12 }).value).toBe('12');
  });
});
