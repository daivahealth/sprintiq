import {
  IMPLAUSIBLE_FLAGGED_SHARE,
  MAX_COLLECTOR_SILENCE_SECONDS,
  NoCommitDetectionService,
} from '../../metrics/no-commit-detection.service';
import { istDayEnd, istDayStart } from '../../common/time';

/**
 * `NoCommitDetectionService.detect()` had no service-level test coverage:
 * only its pure helpers (`evaluateRoster`, `implausible`) were tested. The
 * three gates around them — staleness, truncation, implausible share — are
 * the entire reason this job is safe to run unattended. An inverted
 * comparison in any of them would pass every existing test in the repo and
 * silently name real people in a Teams channel. This file closes that gap.
 *
 * It contains the brief's tenant-isolation test verbatim, plus the gate
 * coverage the review that widened this task called for.
 */

const REPORTED_DAY = '2026-09-17';

describe('daily digest tenant isolation', () => {
  it('reads only the calling tenant roster, exclusions and commits', async () => {
    const calls: Record<string, unknown>[] = [];
    const capture = (result: unknown) =>
      jest.fn().mockImplementation((args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve(result);
      });

    const prisma = {
      // A non-empty roster: gate 0 (`skipped_no_roster`) now short-circuits
      // `detect()` before the commit read on an empty roster, which would
      // make the `code.listCommitsPage` assertion below vacuous.
      trackedDeveloper: {
        findMany: capture([
          { canonicalDeveloperId: 'dev_a', addedAs: 'dev_a' },
        ]),
      },
      watchlistExclusion: { findMany: capture([]) },
      pullRequest: { findMany: capture([]) },
      commit: { groupBy: capture([]) },
    };
    const identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map(),
        byEmail: new Map(),
        displayNames: new Map(),
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
        collectedThroughAt: new Date('2026-09-30T00:00:00.000Z'),
        failing: [],
        neverSynced: 0,
        staleSeconds: 3600,
        lastSyncAt: new Date('2026-09-30T00:00:00.000Z'),
      }),
    };

    const service = new NoCommitDetectionService(
      prisma as never,
      identities as never,
      code as never,
      connections as never,
    );

    await service.detect('tenant_a', '2026-09-17');

    // Every Prisma read this service issues must be tenant-scoped. A missing
    // filter here is a cross-tenant read, which CLAUDE.md forbids outright.
    expect(calls).not.toHaveLength(0);
    for (const args of calls) {
      const where = args.where as Record<string, unknown> | undefined;
      expect(where?.tenantId).toBe('tenant_a');
    }
    expect(identities.attributionIndex).toHaveBeenCalledWith('tenant_a');
    expect(code.listCommitsPage).toHaveBeenCalledWith(
      'tenant_a',
      expect.anything(),
    );
    expect(connections.getDataFreshness).toHaveBeenCalledWith('tenant_a');
  });
});

// ---------------------------------------------------------------------------
// Harness for the gate tests below. Every option defaults to "fresh, empty,
// nothing to report" so each test only sets the fields it is exercising.
// ---------------------------------------------------------------------------

interface HarnessOptions {
  roster?: { canonicalDeveloperId: string; addedAs: string }[];
  displayNames?: Map<string, string>;
  exclusions?: { canonicalDeveloperId: string }[];
  excludedIdentities?: Set<string>;
  /**
   * Not a gate input (see the "collector health gate" describe block) and,
   * as of this fix, not threaded through to `DigestDetection` either —
   * `DigestDetection.lastSyncAt` is threaded through instead (see that field
   * below) precisely because `collectedThroughAt` is permanently null on the
   * real deployment. Kept here only so the mock's shape matches the real
   * `ConnectionsService.getDataFreshness()` return and the "healthy tenant
   * whose tenant-wide watermark is null" regression test below can still set
   * it to null without failing to type-check. `undefined` (the default)
   * means "fresh": the reported day's last instant.
   */
  collectedThroughAt?: Date | null;
  /** Active connections currently erroring. Default: none. */
  failing?: { sourceSystem: string; name: string; error: string }[];
  /** Active connections with no successful sync yet. Default: 0. */
  neverSynced?: number;
  /**
   * Seconds since the oldest active connection last reached its source.
   * `undefined` (the default) means "recently synced" — well inside
   * `MAX_COLLECTOR_SILENCE_SECONDS`. `null` means nothing has ever synced.
   */
  staleSeconds?: number | null;
  /**
   * Oldest `lastSyncAt` across active connections — threaded straight
   * through to `DigestDetection.lastSyncAt`. No longer rendered on the card
   * (removed 2026-09-28, footer-length trim); kept as run lineage and
   * asserted on directly by the gate-1 regression test below. `undefined`
   * (the default) means "recently synced", matching the default
   * `staleSeconds` above.
   */
  lastSyncAt?: Date | null;
  commits?: { authorLogin: string | null; authorEmail: string | null }[];
  truncated?: boolean;
  prs?: { authorLogin: string | null }[];
  /** Rows `commit.groupBy` (the `committedAt: null` read) resolves to. */
  invisibleRows?: { authorLogin: string | null; authorEmail: string | null }[];
  byLogin?: Map<string, string>;
  byEmail?: Map<string, string>;
}

function roster(ids: string[]) {
  return ids.map((id) => ({ canonicalDeveloperId: id, addedAs: id }));
}

function names(pairs: [string, string][]) {
  return new Map(pairs);
}

function harness(opts: HarnessOptions = {}) {
  const prisma = {
    trackedDeveloper: {
      findMany: jest.fn().mockResolvedValue(opts.roster ?? []),
    },
    watchlistExclusion: {
      findMany: jest.fn().mockResolvedValue(opts.exclusions ?? []),
    },
    pullRequest: { findMany: jest.fn().mockResolvedValue(opts.prs ?? []) },
    commit: {
      groupBy: jest.fn().mockResolvedValue(opts.invisibleRows ?? []),
    },
  };
  const identities = {
    attributionIndex: jest.fn().mockResolvedValue({
      byLogin: opts.byLogin ?? new Map(),
      byEmail: opts.byEmail ?? new Map(),
      displayNames: opts.displayNames ?? new Map(),
      excluded: opts.excludedIdentities ?? new Set(),
    }),
  };
  const code = {
    listCommitsPage: jest.fn().mockResolvedValue({
      commits: opts.commits ?? [],
      truncated: opts.truncated ?? false,
    }),
  };
  const connections = {
    getDataFreshness: jest.fn().mockResolvedValue({
      collectedThroughAt:
        opts.collectedThroughAt === undefined
          ? istDayEnd(REPORTED_DAY)
          : opts.collectedThroughAt,
      failing: opts.failing ?? [],
      neverSynced: opts.neverSynced ?? 0,
      // Recent by default (~1h) — well inside MAX_COLLECTOR_SILENCE_SECONDS.
      staleSeconds: opts.staleSeconds === undefined ? 3600 : opts.staleSeconds,
      lastSyncAt:
        opts.lastSyncAt === undefined
          ? istDayEnd(REPORTED_DAY)
          : opts.lastSyncAt,
    }),
  };

  const service = new NoCommitDetectionService(
    prisma as never,
    identities as never,
    code as never,
    connections as never,
  );

  return { service, prisma, identities, code, connections };
}

describe('collector health gate', () => {
  // Fixture used by every case below: one tracked, resolvable developer with
  // no commit/PR signal at all, so that WITHOUT the gate they would be
  // flagged. That is what makes the withheld cases discriminating — an empty
  // roster would pass "flagged is empty" trivially, gate or no gate.
  const oneIdleDeveloper = {
    roster: roster(['erin_athma']),
    displayNames: names([['erin_athma', 'Erin E']]),
  };

  it('withholds when an active connection is failing — an expired token or refused auth means nothing about the roster can be trusted, however recent its last contact', async () => {
    const { service, code } = harness({
      ...oneIdleDeveloper,
      failing: [
        {
          sourceSystem: 'github',
          name: 'athma/pe_platform_pkg',
          error: '401 Bad credentials',
        },
      ],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.evaluation.flagged).toEqual([]);
    // The detail must name what's actually broken — the previously-deferred
    // finding this task closes — not a vague "collection is behind".
    expect(result.withhold?.detail).toContain('github');
    expect(result.withhold?.detail).toContain('athma/pe_platform_pkg');
    // The gate must short-circuit before any commit read, not merely discard
    // the result afterwards.
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('withholds when an active connection has never synced — its data is absent, not merely old, so the roster cannot be evaluated against it', async () => {
    const { service, code } = harness({
      ...oneIdleDeveloper,
      neverSynced: 1,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.withhold?.detail).toContain('never synced');
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('withholds when nothing has ever synced — staleSeconds is null rather than merely large, so "how long" cannot even be stated', async () => {
    const { service, code } = harness({
      ...oneIdleDeveloper,
      staleSeconds: null,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.evaluation.flagged).toEqual([]);
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('withholds when the collector has been silent longer than MAX_COLLECTOR_SILENCE_SECONDS — a full day of silence is a stalled collector, not normal overnight lag', async () => {
    const { service, code } = harness({
      ...oneIdleDeveloper,
      staleSeconds: MAX_COLLECTOR_SILENCE_SECONDS + 1,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.evaluation.flagged).toEqual([]);
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('does not withhold at exactly MAX_COLLECTOR_SILENCE_SECONDS — the comparison is strictly greater-than, not greater-or-equal', async () => {
    const { service, code } = harness({
      roster: roster(['erin_athma', 'frank_athma']),
      displayNames: names([
        ['erin_athma', 'Erin E'],
        ['frank_athma', 'Frank F'],
      ]),
      staleSeconds: MAX_COLLECTOR_SILENCE_SECONDS,
      // frank has a signal so the roster does not also trip the implausible
      // gate (2 evaluated, 1 flagged = 50%), keeping this test isolated to
      // the silence boundary.
      commits: [{ authorLogin: 'frank_athma', authorEmail: null }],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(code.listCommitsPage).toHaveBeenCalled();
    expect(result.withhold?.outcome).not.toBe('withheld_stale_data');
    expect(result.evaluation.flagged.map((f) => f.developer)).toEqual([
      'erin_athma',
    ]);
  });

  // The regression test for the whole bug this gate was rewritten to fix.
  // This is the EXACT shape measured on the hosted tenant via
  // GET /api/dashboards/freshness: collectedThroughAt null (13 active
  // connections mid-PR-backfill), incomplete 13 (not read by the gate at
  // all — DataFreshness doesn't even expose it to detect()), failing: [],
  // neverSynced: 0, staleSeconds ~3.9h. The old rule ("collectedThroughAt
  // must cover the reported day") withheld unconditionally and forever on
  // this shape even though nothing was broken. Without this test, that
  // defect — using collectedThroughAt/incomplete as gate inputs — could
  // silently return.
  it('does not withhold a healthy tenant whose tenant-wide watermark is null — collectedThroughAt is not a gate input', async () => {
    const measuredLastSyncAt = new Date('2026-09-17T20:06:00.000Z');
    const { service, code } = harness({
      roster: roster(['erin_athma', 'frank_athma']),
      displayNames: names([
        ['erin_athma', 'Erin E'],
        ['frank_athma', 'Frank F'],
      ]),
      collectedThroughAt: null,
      failing: [],
      neverSynced: 0,
      staleSeconds: 3.9 * 60 * 60,
      lastSyncAt: measuredLastSyncAt,
      // frank has a signal so the roster does not also trip the implausible
      // gate, keeping this test isolated to gate 1.
      commits: [{ authorLogin: 'frank_athma', authorEmail: null }],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(code.listCommitsPage).toHaveBeenCalled();
    expect(result.withhold).toBeNull();
    expect(result.evaluation.flagged.map((f) => f.developer)).toEqual([
      'erin_athma',
    ]);
    // The whole point of this fix: even on the exact shape that used to
    // withhold forever (collectedThroughAt null), `DigestDetection.lastSyncAt`
    // carries a real, non-null value through (run lineage; no longer
    // rendered on the card as of the 2026-09-28 footer-length trim).
    expect(result.lastSyncAt).toEqual(measuredLastSyncAt);
  });
});

describe('truncated read gate', () => {
  it('withholds when the commit read hit its row ceiling — committers the read omitted would otherwise be named as idle', async () => {
    const { service } = harness({
      roster: roster(['erin_athma']),
      displayNames: names([['erin_athma', 'Erin E']]),
      truncated: true,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_truncated_read');
    expect(result.evaluation.flagged).toEqual([]);
  });

  it('checks the collector health gate before the truncation gate — when both are true the broken-pipeline diagnosis wins because it is the more informative one', async () => {
    const { service, code } = harness({
      roster: roster(['erin_athma']),
      displayNames: names([['erin_athma', 'Erin E']]),
      neverSynced: 1,
      truncated: true,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    // Proof the ordering, not just the outcome, is right: the truncation
    // gate reads its verdict from the commit read, and that read never ran.
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });
});

describe('empty roster gate (skipped_no_roster)', () => {
  // Guards the fix: an empty roster must produce its own outcome, distinct
  // from both `sent_all_clear` (the bug — a confident false all-clear about
  // zero people) and `withheld_unevaluable` (gate 3, which requires
  // roster.length > 0 and still posts a card).
  it('returns skipped_no_roster before the commit read runs, with an empty evaluation and zero counts', async () => {
    const { service, code } = harness({ roster: [] });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('skipped_no_roster');
    expect(result.rosterCount).toBe(0);
    expect(result.evaluation).toEqual({
      flagged: [],
      unresolved: [],
      incomplete: [],
      suppressed: [],
    });
    expect(result.unattributedCommits).toBe(0);
    // Gate 0 short-circuits before any per-developer evaluation, same as
    // gates 1 and 2 — there is no commit read to run against zero people.
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });

  it('fires ahead of the collector-health gate — an empty roster reads as "no roster", not as a broken pipeline, even when collection is also broken', async () => {
    const { service } = harness({ roster: [], neverSynced: 1 });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('skipped_no_roster');
  });
});

describe('unevaluable roster gate', () => {
  it('withholds instead of an all-clear when a non-empty roster resolves to nothing evaluable', async () => {
    // Every roster entry unresolved: evaluated === 0. Without this gate,
    // `evaluation.flagged.length === 0` is trivially true and the digest
    // would post "All 0 tracked developers had activity" — a confident false
    // all-clear for a roster nothing could actually be said about (canonical
    // ids can shift after a re-collection — api/README.md gap #52 — or a
    // roster can be seeded before identity resolution runs).
    const { service } = harness({
      roster: roster(['ghost1', 'ghost2']),
      // No displayNames entries: both roster entries are unresolved.
      displayNames: names([]),
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_unevaluable');
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.evaluation.unresolved.map((u) => u.developer)).toEqual([
      'ghost1',
      'ghost2',
    ]);
    expect(result.withhold?.detail).toContain('2 tracked developers');
    expect(result.withhold?.detail).toMatch(/re-seed|identity resolution/);
  });

  it('produces skipped_no_roster, not withheld_unevaluable, when the roster is empty — there is nothing to say the roster needs re-seeding about, and no card should post at all', async () => {
    // Guards the fix for the empty-roster hole: `roster.length > 0` guards
    // gate 3, so an empty roster must never reach it and must never read as
    // `withhold: null` either (which would become a false `sent_all_clear`,
    // "All 0 tracked developers had activity" — see the `skipped_no_roster`
    // docblock on `DigestOutcome`). It must land on its own, distinct
    // outcome that `NotificationsService` treats as "post nothing".
    const { service } = harness({ roster: [] });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('skipped_no_roster');
    expect(result.evaluation.flagged).toEqual([]);
  });

  it('does not withhold as unevaluable when at least one roster entry is evaluable', async () => {
    const { service } = harness({
      roster: roster(['erin_athma', 'ghost1']),
      displayNames: names([['erin_athma', 'Erin E']]),
      commits: [{ authorLogin: 'erin_athma', authorEmail: null }],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold).toBeNull();
  });
});

describe('implausible-share gate', () => {
  it('withholds when more than the threshold share of the roster is flagged — that many idle people at once is a holiday or a broken pipeline, not a finding about people', async () => {
    // 5 resolvable, non-suppressed developers, none with any signal: 5/5 = 100%.
    const flaggedRoster = roster(['g1', 'g2', 'g3', 'g4', 'g5']);
    const { service } = harness({
      roster: flaggedRoster,
      displayNames: names(
        flaggedRoster.map((r) => [
          r.canonicalDeveloperId,
          r.canonicalDeveloperId,
        ]),
      ) as Map<string, string>,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_implausible');
    // flagged is emptied at this gate too (see the invariant test below), so
    // the real count lives only in the detail message now.
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.withhold?.detail).toContain('5 of 5');
  });

  it('does not withhold at exactly the threshold share — the comparison is strictly greater-than, not greater-or-equal', async () => {
    // Pin the fixture to the real constant so a future change to the
    // threshold fails this assertion rather than silently invalidating the
    // 4-of-5 split below.
    expect(IMPLAUSIBLE_FLAGGED_SHARE).toBe(0.8);

    // 5 evaluated developers, 4 flagged, 1 active: 4/5 = 0.8 exactly.
    const devs = roster(['h1', 'h2', 'h3', 'h4', 'h5']);
    const { service } = harness({
      roster: devs,
      displayNames: names(
        devs.map((r) => [r.canonicalDeveloperId, r.canonicalDeveloperId]),
      ) as Map<string, string>,
      commits: [{ authorLogin: 'h5', authorEmail: null }],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.evaluation.flagged.length).toBe(4);
    expect(result.withhold).toBeNull();
  });

  it('computes the flagged share against the roster minus unresolved and suppressed entries, not the raw roster size', async () => {
    // 10 on the roster: 3 unresolved (unknown to identity resolution), 2
    // suppressed (known bot logins), 5 evaluated — all 5 flagged.
    //
    // Evaluated share: 5/5 = 100%, over threshold.
    // Raw-roster share (the bug this guards against): 5/10 = 50%, under
    // threshold. If the denominator regressed to roster.length, this test
    // would see `withhold: null` instead and fail — a genuinely implausible
    // day would ship names because unresolved/suppressed entries diluted it.
    const unresolvedIds = ['u1', 'u2', 'u3'];
    const suppressedIds = ['dependabot', 'renovate']; // KNOWN_BOT_LOGINS entries
    const evaluatedIds = ['d1', 'd2', 'd3', 'd4', 'd5'];

    const fullRoster = roster([
      ...unresolvedIds,
      ...suppressedIds,
      ...evaluatedIds,
    ]);
    // Deliberately excludes unresolvedIds — that absence is what makes them
    // unresolved.
    const displayNames = names(
      [...suppressedIds, ...evaluatedIds].map((id) => [id, id]),
    ) as Map<string, string>;

    const { service } = harness({
      roster: fullRoster,
      displayNames,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.evaluation.unresolved.length).toBe(3);
    expect(result.evaluation.suppressed.length).toBe(2);
    // The real flagged count (5) is what drove the gate — asserted via the
    // detail message, since the array itself is emptied at this gate.
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.withhold?.outcome).toBe('withheld_implausible');
    expect(result.withhold?.detail).toContain('5 of 5');
  });

  it('empties flagged at this gate while keeping unresolved and incomplete intact, and keeps the real count in the detail message', async () => {
    // Pins the invariant documented on `DigestDetection.evaluation`: after
    // detect() returns, `flagged` is populated only when `withhold` is null,
    // at every gate — not just the two that had nothing computed yet. A
    // future caller that reads `evaluation.flagged` without first checking
    // `withhold` must never be able to see a name here. `unresolved` and
    // `incomplete` are untouched because they are lineage the spec requires
    // be reported even when names are withheld, and neither can name someone
    // as idle in a channel.
    const roster7 = roster(['u1', 'inc1', 'f1', 'f2', 'f3', 'f4', 'f5']);
    const { service } = harness({
      roster: roster7,
      // u1 deliberately excluded — that absence is what makes it unresolved.
      displayNames: names(
        ['inc1', 'f1', 'f2', 'f3', 'f4', 'f5'].map((id) => [id, id]),
      ) as Map<string, string>,
      // inc1 has a commit the day's ordinary read cannot see, so it lands in
      // `incomplete`, not `flagged`.
      invisibleRows: [{ authorLogin: 'inc1', authorEmail: null }],
      // f1..f5 have no signal at all: evaluated = 7 - 1 unresolved = 6,
      // flagged = 5, share = 5/6 ≈ 0.83 > 0.8 — implausible.
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_implausible');
    expect(result.evaluation.flagged).toEqual([]);
    expect(result.evaluation.unresolved.map((u) => u.developer)).toEqual([
      'u1',
    ]);
    expect(result.evaluation.incomplete.map((d) => d.developer)).toEqual([
      'inc1',
    ]);
    expect(result.withhold?.detail).toContain('5 of 6');
  });
});

describe('unattributedCommits count', () => {
  it('counts commits that attributeCommit cannot place against anyone, alongside an already-attributable one', async () => {
    // Guards the actual fix: a commit with no known login and no known email
    // must be counted as unattributed rather than silently vanishing from
    // the read the way it does from the active set.
    const { service } = harness({
      roster: roster(['erin_athma']),
      displayNames: names([['erin_athma', 'Erin E']]),
      byLogin: new Map([['erin_login', 'erin_athma']]),
      commits: [
        // Attributable via a known login.
        { authorLogin: 'erin_login', authorEmail: null },
        // Unattributable: no login, and the email is not in the index —
        // the ordinary GitHub case this task exists to disclose.
        { authorLogin: null, authorEmail: 'ghost@personal.example' },
        // Unattributable: an unrecognised login is still attributed to
        // itself by `attributeCommit`'s fallback, so this one must NOT be
        // counted — only a commit with neither wins.
        { authorLogin: null, authorEmail: null },
      ],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.unattributedCommits).toBe(2);
  });

  it('is zero when every commit is attributable', async () => {
    const { service } = harness({
      roster: roster(['erin_athma']),
      displayNames: names([['erin_athma', 'Erin E']]),
      byEmail: new Map([['erin@example.com', 'erin_athma']]),
      commits: [
        { authorLogin: 'erin_athma', authorEmail: null },
        { authorLogin: null, authorEmail: 'erin@example.com' },
        // A commit whose login is unknown to the index is still attributed
        // to that raw login by `attributeCommit`'s fallback — not unattributed.
        { authorLogin: 'some_unindexed_login', authorEmail: null },
      ],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.unattributedCommits).toBe(0);
  });

  it('is zero at the collector health gate, which returns before the commit read runs', async () => {
    const { service, code } = harness({
      roster: roster(['erin_athma']),
      displayNames: names([['erin_athma', 'Erin E']]),
      neverSynced: 1,
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(result.withhold?.outcome).toBe('withheld_stale_data');
    expect(result.unattributedCommits).toBe(0);
    expect(code.listCommitsPage).not.toHaveBeenCalled();
  });
});

describe('commitsInvisibleToTheDayRead query shape', () => {
  it('queries commit.groupBy for committedAt: null within the reported day, and withholds a developer found only that way as incomplete rather than flagging them', async () => {
    const { service, prisma } = harness({
      roster: roster(['gary_athma']),
      displayNames: names([['gary_athma', 'Gary G']]),
      // Nothing in the ordinary commit/PR read — gary looks idle unless the
      // committedAt-null read finds him.
      invisibleRows: [{ authorLogin: 'gary_athma', authorEmail: null }],
    });

    const result = await service.detect('tenant_a', REPORTED_DAY);

    expect(prisma.commit.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['authorLogin', 'authorEmail'],
        where: expect.objectContaining({
          tenantId: 'tenant_a',
          committedAt: null,
          authoredAt: {
            gte: istDayStart(REPORTED_DAY),
            lte: istDayEnd(REPORTED_DAY),
          },
        }),
      }),
    );

    // The guard that stops someone who genuinely committed from being named:
    // found only via the invisible-commit path, they must land in
    // `incomplete`, never in `flagged`.
    expect(result.evaluation.incomplete.map((d) => d.developer)).toEqual([
      'gary_athma',
    ]);
    expect(result.evaluation.flagged).toEqual([]);
  });
});
