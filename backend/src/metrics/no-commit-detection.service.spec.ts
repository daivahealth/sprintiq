import { Test } from '@nestjs/testing';
import { GithubAuditSyncService } from '../collectors/sources/github/github-audit-sync.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import { DIGEST_RULE_TEXT } from '../common/digest-rule';
import {
  DigestDetection,
  IMPLAUSIBLE_FLAGGED_SHARE,
  NoCommitDetectionService,
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

// ---------------------------------------------------------------------------
// Audit-sync coverage gate (the digest seal, ADR-0010 spec item 5).
// ---------------------------------------------------------------------------

describe('NoCommitDetectionService audit-sync coverage gate', () => {
  const DAY = '2026-10-05';
  const LAST_SYNC = new Date('2026-10-06T02:00:00.000Z');

  /**
   * One tracked, resolvable developer with commits from nobody. Without a
   * gate they would be flagged — that is what makes a withhold discriminating.
   * A two-person roster with one active keeps the implausible gate quiet.
   */
  function harness(
    opts: {
      audit?: { coverageForDay: jest.Mock } | null;
      failing?: { sourceSystem: string; name: string; error: string }[];
    } = {},
  ) {
    const prisma = {
      trackedDeveloper: {
        findMany: jest.fn().mockResolvedValue([
          { canonicalDeveloperId: 'erin', addedAs: 'erin' },
          { canonicalDeveloperId: 'finn', addedAs: 'finn' },
        ]),
      },
      watchlistExclusion: { findMany: jest.fn().mockResolvedValue([]) },
      pullRequest: {
        findMany: jest.fn().mockResolvedValue([{ authorLogin: 'finn' }]),
      },
      commit: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map([
          ['erin', 'erin'],
          ['finn', 'finn'],
        ]),
        byEmail: new Map(),
        displayNames: new Map([
          ['erin', 'Erin E'],
          ['finn', 'Finn F'],
        ]),
        excluded: new Set(),
      }),
    };
    const code = {
      listCommitsPage: jest
        .fn()
        .mockResolvedValue({ commits: [], truncated: false }),
    };
    const connections = {
      getDataFreshness: jest.fn().mockResolvedValue({
        collectedThroughAt: null,
        failing: opts.failing ?? [],
        neverSynced: 0,
        staleSeconds: 3600,
        lastSyncAt: LAST_SYNC,
      }),
    };
    const args = [
      prisma as never,
      identities as never,
      code as never,
      connections as never,
    ] as const;
    const service =
      opts.audit === null || opts.audit === undefined
        ? new NoCommitDetectionService(...args)
        : new NoCommitDetectionService(...args, opts.audit as never);
    return { service, code };
  }

  const coverage = (value: unknown) => ({
    coverageForDay: jest.fn().mockResolvedValue(value),
  });

  it('withholds as withheld_stale_data, naming every reason, when the audit route applies and has not covered the day', async () => {
    const audit = coverage({
      applies: true,
      ok: false,
      reasons: [
        'audit log read only through 2026-10-05T12:00:00.000Z',
        '2 unfinished range(s): acme/ehr@main, acme/lab@dev',
      ],
    });
    const { service, code } = harness({ audit });

    const result = await service.detect('tenant_a', DAY);

    expect(audit.coverageForDay).toHaveBeenCalledWith('tenant_a', DAY);
    expect(result).toEqual({
      reportedDay: DAY,
      rosterCount: 2,
      evaluation: {
        flagged: [],
        unresolved: [],
        incomplete: [],
        suppressed: [],
      },
      withhold: {
        outcome: 'withheld_stale_data',
        detail:
          'GitHub audit sync has not covered 2026-10-05: audit log read only through 2026-10-05T12:00:00.000Z; 2 unfinished range(s): acme/ehr@main, acme/lab@dev. Names withheld.',
      },
      lastSyncAt: LAST_SYNC,
      unattributedCommits: 0,
    });
    // Short-circuits before the commit read, like gate 1.
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('fails closed — withholds — when the coverage check throws', async () => {
    const audit = {
      coverageForDay: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const { service, code } = harness({ audit });

    const result = await service.detect('tenant_a', DAY);

    expect(result.withhold).toEqual({
      outcome: 'withheld_stale_data',
      detail:
        'GitHub audit sync coverage could not be checked for 2026-10-05: db down. Names withheld.',
    });
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.unattributedCommits).toBe(0);
    expect(result.lastSyncAt).toBe(LAST_SYNC);
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('falls through to the existing behaviour when the route does not apply', async () => {
    const audit = coverage({ applies: false, ok: true, reasons: [] });
    const gated = await harness({ audit }).service.detect('tenant_a', DAY);
    const plain = await harness().service.detect('tenant_a', DAY);

    expect(gated).toEqual(plain);
    expect(gated.withhold).toBeNull();
    expect(gated.evaluation.flagged.map((f) => f.developer)).toEqual(['erin']);
  });

  it('falls through when the route applies and has covered the day', async () => {
    const audit = coverage({ applies: true, ok: true, reasons: [] });
    const result = await harness({ audit }).service.detect('tenant_a', DAY);
    expect(result.withhold).toBeNull();
    expect(result.evaluation.flagged.map((f) => f.developer)).toEqual(['erin']);
  });

  it('reports how many tracked developers were active, and no count when the roster was never evaluated', async () => {
    // Finn opened a PR, Erin did nothing: "active 1 / 2 tracked".
    const evaluated = await harness().service.detect('tenant_a', DAY);
    expect(evaluated.rosterCount).toBe(2);
    expect(evaluated.activeCount).toBe(1);

    // Withheld before the roster is read: unknown, not zero.
    const audit = coverage({ applies: true, ok: false, reasons: ['x'] });
    const withheld = await harness({ audit }).service.detect('tenant_a', DAY);
    expect(withheld.activeCount).toBeUndefined();
  });

  it('is unchanged when the service is absent (positional 4-arg construction)', async () => {
    const result = await harness({ audit: null }).service.detect(
      'tenant_a',
      DAY,
    );
    expect(result.withhold).toBeNull();
    expect(result.evaluation.flagged.map((f) => f.developer)).toEqual(['erin']);
  });

  it('runs after gate 1 — a broken collector wins and the coverage check is never consulted', async () => {
    const audit = coverage({ applies: true, ok: false, reasons: ['x'] });
    const { service } = harness({
      audit,
      failing: [{ sourceSystem: 'github', name: 'acme/ehr', error: '401' }],
    });

    const result = await service.detect('tenant_a', DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.withhold?.detail).toMatch(/^Collector pipeline looks broken/);
    expect(audit.coverageForDay).not.toHaveBeenCalled();
  });
});

describe('NoCommitDetectionService dependency injection (ethics gate)', () => {
  // The audit-coverage gate (gate 1b) is the only thing standing between an
  // un-vouched day and named developers. If the provider ever went missing
  // from the module graph, an `@Optional()` injection would silently drop the
  // gate; it must fail the boot instead (final review, I6).
  const baseProviders = [
    NoCommitDetectionService,
    { provide: PrismaService, useValue: {} },
    { provide: DeveloperIdentityService, useValue: {} },
    { provide: CodeService, useValue: {} },
    { provide: ConnectionsService, useValue: {} },
  ];

  it('fails to resolve when GithubAuditSyncService is not provided', async () => {
    await expect(
      Test.createTestingModule({ providers: baseProviders }).compile(),
    ).rejects.toThrow(/GithubAuditSyncService/);
  });

  it('injects GithubAuditSyncService when it is provided', async () => {
    const auditSync = { coverageForDay: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...baseProviders,
        { provide: GithubAuditSyncService, useValue: auditSync },
      ],
    }).compile();
    const svc = moduleRef.get(NoCommitDetectionService);
    expect((svc as unknown as { auditSync: unknown }).auditSync).toBe(
      auditSync,
    );
  });
});

describe('NoCommitDetectionService.previousDayView (admin Watchlist view)', () => {
  const alice = { developer: 'alice', displayName: 'Alice' };
  const bob = { developer: 'bob', displayName: 'Bob' };

  function setup(
    detection: Partial<DigestDetection>,
    run: Record<string, unknown> | null,
  ) {
    const prisma = {
      noCommitDigestRun: { findUnique: jest.fn().mockResolvedValue(run) },
    };
    const svc = new NoCommitDetectionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(svc, 'detect').mockResolvedValue({
      reportedDay: '2026-10-16',
      rosterCount: 66,
      evaluation: {
        flagged: [],
        unresolved: [],
        incomplete: [],
        suppressed: [],
      },
      withhold: null,
      unattributedCommits: 0,
      ...detection,
    } as DigestDetection);
    return { svc, prisma };
  }

  it('lists the flagged people with the digest rule text, and reads only', async () => {
    const { svc, prisma } = setup(
      {
        evaluation: {
          flagged: [alice],
          unresolved: [{ developer: 'x', addedAs: 'x' }],
          incomplete: [bob],
          suppressed: [],
        },
      },
      null,
    );
    const view = await svc.previousDayView('t1', '2026-10-16');
    expect(svc.detect).toHaveBeenCalledWith('t1', '2026-10-16');
    expect(prisma.noCommitDigestRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_reportedDay: { tenantId: 't1', reportedDay: '2026-10-16' },
        },
      }),
    );
    expect(view).toMatchObject({
      day: '2026-10-16',
      outcome: 'named',
      flagged: [alice],
      unresolved: [{ developer: 'x', addedAs: 'x' }],
      incomplete: [bob],
      rosterCount: 66,
      lastDigestRun: null,
      namedThenNowActive: [],
    });
    expect(view.ruleText).toBe(DIGEST_RULE_TEXT);
  });

  it('names no one when the gates withhold, and says why', async () => {
    const { svc } = setup(
      {
        evaluation: {
          flagged: [alice],
          unresolved: [],
          incomplete: [],
          suppressed: [],
        },
        withhold: {
          outcome: 'withheld_stale_data',
          detail: 'audit log behind',
        },
      },
      null,
    );
    const view = await svc.previousDayView('t1', '2026-10-16');
    expect(view.outcome).toBe('withheld');
    expect(view.flagged).toEqual([]);
    expect(view.withheld).toEqual({
      outcome: 'withheld_stale_data',
      detail: 'audit log behind',
    });
  });

  it('reports the all-clear when the roster had nobody to name', async () => {
    const { svc } = setup({}, null);
    expect((await svc.previousDayView('t1', '2026-10-16')).outcome).toBe(
      'all_clear',
    );
  });

  it('shows who the Teams card named but who has since shown work (late pushes)', async () => {
    const { svc } = setup(
      {
        evaluation: {
          flagged: [alice],
          unresolved: [],
          incomplete: [],
          suppressed: [],
        },
      },
      {
        outcome: 'sent',
        deliveredAt: new Date('2026-10-17T05:00:00Z'),
        flaggedCount: 2,
        flagged: [alice, bob],
      },
    );
    const view = await svc.previousDayView('t1', '2026-10-16');
    expect(view.lastDigestRun).toEqual({
      outcome: 'sent',
      deliveredAt: new Date('2026-10-17T05:00:00Z'),
      flaggedCount: 2,
    });
    expect(view.namedThenNowActive).toEqual([bob]);
  });

  it("does not claim anyone became active while today's evaluation is withheld", async () => {
    const { svc } = setup(
      {
        withhold: { outcome: 'withheld_truncated_read', detail: 'read cap' },
      },
      { outcome: 'sent', deliveredAt: null, flaggedCount: 1, flagged: [bob] },
    );
    expect(
      (await svc.previousDayView('t1', '2026-10-16')).namedThenNowActive,
    ).toEqual([]);
  });
});
