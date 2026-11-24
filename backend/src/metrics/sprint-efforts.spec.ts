import {
  BuildEffortsInput,
  EFFORTS_ROSTER_LIMIT,
  buildEfforts,
} from './sprint-efforts';

const DAYS = ['2026-11-17', '2026-11-18', '2026-11-19'];

function input(overrides: Partial<BuildEffortsInput> = {}): BuildEffortsInput {
  return {
    days: DAYS,
    sprintFrom: '2026-11-17',
    sprintTo: '2026-11-19',
    rule: 'RULE',
    roster: [
      { canonicalDeveloperId: 'asha' },
      { canonicalDeveloperId: 'bala' },
    ],
    displayNames: new Map([
      ['asha', 'Asha Rao'],
      ['bala', 'Bala Iyer'],
    ]),
    excluded: new Set(),
    jiraLinkedDevelopers: new Set(['asha', 'bala']),
    people: new Map([
      ['login:acc-asha', { developer: 'asha', excluded: false }],
      ['login:acc-bala', { developer: 'bala', excluded: false }],
    ]),
    worklogs: [],
    itemsInScope: 4,
    itemsWithoutWorklogSnapshot: 1,
    ...overrides,
  };
}

const log = (
  login: string | null,
  startedAt: string,
  seconds: number,
  name: string | null = null,
) => ({
  authorLogin: login,
  authorName: name,
  authorEmail: null,
  startedAt: new Date(startedAt),
  timeSpentSeconds: seconds,
});

describe('buildEfforts', () => {
  it('lists the first ten evaluable tracked developers A–Z — chosen by name, never by any figure', () => {
    const ids = Array.from(
      { length: 13 },
      (_, i) => `dev${String(i).padStart(2, '0')}`,
    );
    const view = buildEfforts(
      input({
        // Roster order deliberately reversed: the cut must follow the sort.
        roster: [...ids].reverse().map((id) => ({ canonicalDeveloperId: id })),
        displayNames: new Map(ids.map((id) => [id, id.toUpperCase()])),
        jiraLinkedDevelopers: new Set(ids),
        // The busiest person sorts last and must still not jump the queue.
        people: new Map([
          ['login:acc-12', { developer: 'dev12', excluded: false }],
        ]),
        worklogs: [log('acc-12', '2026-11-18T10:00:00+05:30', 36_000)],
      }),
    );
    expect(view.rows).toHaveLength(EFFORTS_ROSTER_LIMIT);
    expect(view.rows.map((r) => r.developer)).toEqual(ids.slice(0, 10));
    expect(view.roster).toMatchObject({ tracked: 13, shown: 10, notShown: 3 });
  });

  it('counts but never names unresolved and suppressed roster entries', () => {
    const view = buildEfforts(
      input({
        roster: [
          { canonicalDeveloperId: 'asha' },
          { canonicalDeveloperId: 'ghost' }, // unknown to identity resolution
          { canonicalDeveloperId: 'bala' }, // excluded by an admin
          { canonicalDeveloperId: 'dependabot[bot]' },
        ],
        displayNames: new Map([
          ['asha', 'Asha Rao'],
          ['bala', 'Bala Iyer'],
          ['dependabot[bot]', 'dependabot'],
        ]),
        excluded: new Set(['bala']),
      }),
    );
    expect(view.rows.map((r) => r.developer)).toEqual(['asha']);
    expect(view.roster).toMatchObject({
      tracked: 4,
      shown: 1,
      unresolved: 1,
      suppressed: 2,
    });
  });

  it('buckets hours by the IST day the work was started', () => {
    const view = buildEfforts(
      input({
        worklogs: [
          // 23:30 IST on the 17th is 18:00 UTC — still the 17th's column.
          log('acc-asha', '2026-11-17T18:00:00.000Z', 1800),
          // 00:30 IST on the 18th is 19:00 UTC on the 17th — the 18th's column.
          log('acc-asha', '2026-11-17T19:00:00.000Z', 3600),
          log('acc-asha', '2026-11-19T10:00:00+05:30', 600),
        ],
      }),
    );
    expect(view.rows[0].effortSeconds).toEqual([1800, 3600, 600]);
  });

  it('ignores worklogs outside the shown days — a carried-over item’s earlier time is not this sprint’s', () => {
    const view = buildEfforts(
      input({ worklogs: [log('acc-asha', '2026-11-10T10:00:00+05:30', 7200)] }),
    );
    expect(view.rows[0].effortSeconds).toEqual([0, 0, 0]);
    expect(view.disclosures.unattributedWorklogs).toBe(0);
  });

  it('reports effort logged only — no per-person figure beyond hours', () => {
    const view = buildEfforts(
      input({ worklogs: [log('acc-bala', '2026-11-18T11:00:00+05:30', 900)] }),
    );
    expect(Object.keys(view.rows[0]).sort()).toEqual([
      'developer',
      'displayName',
      'effortSeconds',
      'jiraLinked',
    ]);
    expect(
      view.rows.find((r) => r.developer === 'bala')?.effortSeconds,
    ).toEqual([0, 900, 0]);
  });

  it('a person with no Jira link gets a null series — a data gap, never a row of zeros', () => {
    const view = buildEfforts(
      input({ jiraLinkedDevelopers: new Set(['asha']), people: new Map() }),
    );
    const bala = view.rows.find((r) => r.developer === 'bala');
    expect(bala).toMatchObject({
      jiraLinked: false,
      effortSeconds: null,
    });
  });

  it('treats someone linked only through this sprint’s worklogs as linked', () => {
    const view = buildEfforts(
      input({
        jiraLinkedDevelopers: new Set(),
        worklogs: [log('acc-bala', '2026-11-17T10:00:00+05:30', 60)],
      }),
    );
    expect(view.rows.find((r) => r.developer === 'bala')?.jiraLinked).toBe(
      true,
    );
    expect(view.rows.find((r) => r.developer === 'asha')?.jiraLinked).toBe(
      false,
    );
  });

  it('counts a worklog whose author resolves to nobody — or to an excluded identity — as unattributed', () => {
    const view = buildEfforts(
      input({
        people: new Map([
          ['login:acc-asha', { developer: 'asha', excluded: false }],
          ['login:acc-x', { developer: null, excluded: false }],
          ['login:acc-bot', { developer: 'bot', excluded: true }],
        ]),
        worklogs: [
          log('acc-x', '2026-11-17T10:00:00+05:30', 60),
          log('acc-bot', '2026-11-17T10:00:00+05:30', 60),
          log('acc-asha', '2026-11-17T10:00:00+05:30', 60),
        ],
      }),
    );
    expect(view.disclosures.unattributedWorklogs).toBe(2);
    expect(view.rows[0].effortSeconds).toEqual([60, 0, 0]);
  });

  it('carries the rule and the collection disclosures through', () => {
    const view = buildEfforts(input());
    expect(view.rule).toBe('RULE');
    expect(view.disclosures).toMatchObject({
      itemsInScope: 4,
      itemsWithoutWorklogSnapshot: 1,
    });
  });
});
