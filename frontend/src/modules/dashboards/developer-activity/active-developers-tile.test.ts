import { describe, expect, it } from 'vitest';
import { activeDevelopersTile } from './active-developers-tile';

describe('activeDevelopersTile', () => {
  it('counts against the tracked list', () => {
    expect(
      activeDevelopersTile({ developersWithSignal: 40, trackedDevelopers: 66 }, []),
    ).toEqual({
      label: 'Active developers',
      value: '40 / 66',
      hint: 'tracked developers with a commit or PR',
    });
  });

  it('discloses active people who are not tracked', () => {
    const tile = activeDevelopersTile(
      { developersWithSignal: 40, trackedDevelopers: 66 },
      [{}, {}, {}],
    );
    expect(tile.hint).toBe(
      'tracked developers with a commit or PR · +3 active, not tracked',
    );
  });

  it('stands alone, and says why, when nobody is tracked yet', () => {
    const tile = activeDevelopersTile(
      { developersWithSignal: 12, trackedDevelopers: null },
      [],
    );
    expect(tile.value).toBe('12');
    expect(tile.hint).toMatch(/Tracked Developers/);
  });

  it('never invents a denominator for an older API', () => {
    expect(activeDevelopersTile({ developersWithSignal: 12 }, undefined).value).toBe(
      '12',
    );
  });
});
