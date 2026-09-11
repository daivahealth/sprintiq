import { describe, expect, it } from 'vitest';
import { releaseCandidatePill } from './release-pill';

describe('releaseCandidatePill', () => {
  it('says "not yet released" when there is no lateness figure and the RC has not shipped', () => {
    expect(releaseCandidatePill({ daysLate: null, released: false })).toEqual({
      tone: 'neutral',
      text: 'Not yet released',
    });
  });

  // The other half of the same null: released, but nobody ever recorded a
  // plan. Must not be conflated with "not yet released" — and must not
  // silently read as on-time either.
  it('says "no planned date recorded" when the RC shipped but nothing was ever planned', () => {
    expect(releaseCandidatePill({ daysLate: null, released: true })).toEqual({
      tone: 'neutral',
      text: 'No planned date recorded',
    });
  });

  it('flags a positive daysLate as late', () => {
    expect(releaseCandidatePill({ daysLate: 3, released: true })).toEqual({
      tone: 'bad',
      text: '3 days late',
    });
  });

  it('treats zero days late as on time, not late', () => {
    expect(releaseCandidatePill({ daysLate: 0, released: true })).toEqual({
      tone: 'good',
      text: 'On time',
    });
  });

  it('treats a negative daysLate (shipped early) as on time', () => {
    expect(releaseCandidatePill({ daysLate: -2, released: true })).toEqual({
      tone: 'good',
      text: 'On time',
    });
  });
});
