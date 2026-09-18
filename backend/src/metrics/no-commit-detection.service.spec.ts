import {
  IMPLAUSIBLE_FLAGGED_SHARE,
  evaluateRoster,
  implausible,
} from './no-commit-detection.service';

const displayNames = new Map([
  ['alice_athma', 'Alice Anand'],
  ['bob_athma', 'Bob Bose'],
  ['zara_athma', 'Zara Ahmed'],
  ['dependabot[bot]', 'dependabot[bot]'],
]);

function base(overrides: Partial<Parameters<typeof evaluateRoster>[0]> = {}) {
  return {
    roster: [
      { canonicalDeveloperId: 'alice_athma', addedAs: 'alice_athma' },
      { canonicalDeveloperId: 'bob_athma', addedAs: 'bob_athma' },
    ],
    activeSet: new Set<string>(),
    incompleteSet: new Set<string>(),
    excludedByAdmin: new Set<string>(),
    displayNames,
    known: new Set(displayNames.keys()),
    ...overrides,
  };
}

describe('evaluateRoster', () => {
  it('flags a roster member with no signal', () => {
    const result = evaluateRoster(base());
    expect(result.flagged.map((f) => f.developer)).toEqual([
      'alice_athma',
      'bob_athma',
    ]);
  });

  it('does not flag someone who committed', () => {
    const result = evaluateRoster(
      base({ activeSet: new Set(['alice_athma']) }),
    );
    expect(result.flagged.map((f) => f.developer)).toEqual(['bob_athma']);
  });

  it('does not flag someone who only opened a PR', () => {
    // activeSet is the union of commit and PR authors (activeDeveloperSet),
    // so this is the same path — asserted separately because a regression in
    // the PR half of that union silently re-adds people to the list.
    const result = evaluateRoster(base({ activeSet: new Set(['bob_athma']) }));
    expect(result.flagged.map((f) => f.developer)).toEqual(['alice_athma']);
  });

  it('withholds someone whose commit data for the day is incomplete', () => {
    // A commit dated in the window by authoredAt whose committedAt is null:
    // the board cannot see it, and naming this person would be a false
    // accusation against someone who shipped code.
    const result = evaluateRoster(
      base({ incompleteSet: new Set(['alice_athma']) }),
    );
    expect(result.flagged.map((f) => f.developer)).toEqual(['bob_athma']);
    expect(result.incomplete.map((f) => f.developer)).toEqual(['alice_athma']);
  });

  it('reports an unresolvable roster entry instead of flagging it', () => {
    const result = evaluateRoster(
      base({
        roster: [
          { canonicalDeveloperId: 'ghost_athma', addedAs: 'ghost_athma' },
        ],
      }),
    );
    expect(result.flagged).toEqual([]);
    expect(result.unresolved).toEqual([
      { developer: 'ghost_athma', addedAs: 'ghost_athma' },
    ]);
  });

  it('suppresses admin-excluded developers, bots and anonymized accounts', () => {
    const result = evaluateRoster(
      base({
        roster: [
          { canonicalDeveloperId: 'alice_athma', addedAs: 'alice_athma' },
          {
            canonicalDeveloperId: 'dependabot[bot]',
            addedAs: 'dependabot[bot]',
          },
        ],
        excludedByAdmin: new Set(['alice_athma']),
        known: new Set([...displayNames.keys()]),
      }),
    );
    expect(result.flagged).toEqual([]);
    expect(result.suppressed.map((s) => s.developer).sort()).toEqual([
      'alice_athma',
      'dependabot[bot]',
    ]);
  });

  it('orders the flagged list alphabetically by display name, never by volume', () => {
    // CLAUDE.md: any volume ordering turns a prompt-to-check-in into the
    // leaderboard the ethics rule forbids.
    const result = evaluateRoster(
      base({
        roster: [
          { canonicalDeveloperId: 'zara_athma', addedAs: 'zara_athma' },
          { canonicalDeveloperId: 'bob_athma', addedAs: 'bob_athma' },
        ],
      }),
    );
    expect(result.flagged.map((f) => f.displayName)).toEqual([
      'Bob Bose',
      'Zara Ahmed',
    ]);
  });
});

describe('implausible', () => {
  it('is true above the share threshold', () => {
    expect(implausible(9, 10)).toBe(true);
  });

  it('is false at or below it', () => {
    expect(implausible(8, 10)).toBe(false);
    expect(IMPLAUSIBLE_FLAGGED_SHARE).toBe(0.8);
  });

  it('is false for an empty roster rather than dividing by zero', () => {
    expect(implausible(0, 0)).toBe(false);
  });
});
