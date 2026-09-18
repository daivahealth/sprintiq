import { Injectable } from '@nestjs/common';
import {
  isAnonymizedAccount,
  isBotDeveloper,
} from '../correlation/developer-identity.util';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { istDayEnd, istDayStart } from '../common/time';
import { CodeService } from '../modules/code/code.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import { PrismaService } from '../database/prisma.service';
import { activeDeveloperSet } from './developer-activity.service';

/**
 * The share of the roster above which a named list is withheld.
 *
 * SprintIQ models no holiday calendar — `workingDaysAgo` records that
 * inventing one per tenant "would be a guess dressed as a fact" — so a public
 * holiday arrives here as the whole roster reading idle. Naming 60 people at
 * once is never a finding about 60 people; it is a finding about the day or
 * about the pipeline.
 *
 * A constant rather than tenant configuration until some tenant needs a
 * different value.
 */
export const IMPLAUSIBLE_FLAGGED_SHARE = 0.8;

export type DigestOutcome =
  | 'sent'
  | 'sent_all_clear'
  | 'withheld_stale_data'
  | 'withheld_truncated_read'
  | 'withheld_implausible'
  | 'failed';

export interface NamedDeveloper {
  developer: string;
  displayName: string;
}

export interface RosterEvaluation {
  /** The list that goes out. Alphabetical by display name. */
  flagged: NamedDeveloper[];
  /** Roster entries identity resolution does not know. Reported, never named. */
  unresolved: { developer: string; addedAs: string }[];
  /** Withheld because their commit data for the day is incomplete. */
  incomplete: NamedDeveloper[];
  /** Bots, anonymized accounts, and people an admin has excluded. */
  suppressed: NamedDeveloper[];
}

export interface EvaluateRosterInput {
  roster: readonly { canonicalDeveloperId: string; addedAs: string }[];
  /** Who had a signal on the day — from `activeDeveloperSet`. */
  activeSet: ReadonlySet<string>;
  /** Who has a commit dated in the window that the day's read cannot see. */
  incompleteSet: ReadonlySet<string>;
  /** Live Watchlist exclusions plus identity-override exclusions, unioned. */
  excludedByAdmin: ReadonlySet<string>;
  displayNames: ReadonlyMap<string, string>;
  /** Every developer identity resolution knows about. */
  known: ReadonlySet<string>;
}

/**
 * Roster minus active set, with the four reasons a name is withheld.
 *
 * Pure, and ordered deliberately. Resolution is checked before anything else
 * because an entry nobody can resolve is a data problem, not a person, and
 * must never fall through to the flagged list. Suppression comes next, then
 * activity, then incompleteness — so the most specific reason a person is
 * absent from the list is the one recorded against them.
 */
export function evaluateRoster(input: EvaluateRosterInput): RosterEvaluation {
  const flagged: NamedDeveloper[] = [];
  const unresolved: { developer: string; addedAs: string }[] = [];
  const incomplete: NamedDeveloper[] = [];
  const suppressed: NamedDeveloper[] = [];

  for (const entry of input.roster) {
    const developer = entry.canonicalDeveloperId;
    const named = {
      developer,
      displayName: input.displayNames.get(developer) ?? developer,
    };

    if (!input.known.has(developer)) {
      unresolved.push({ developer, addedAs: entry.addedAs });
      continue;
    }
    if (
      input.excludedByAdmin.has(developer) ||
      isBotDeveloper(developer) ||
      isAnonymizedAccount(developer)
    ) {
      suppressed.push(named);
      continue;
    }
    if (input.activeSet.has(developer)) {
      continue;
    }
    if (input.incompleteSet.has(developer)) {
      incomplete.push(named);
      continue;
    }
    flagged.push(named);
  }

  // Alphabetical, always. These are people, and any volume ordering would
  // turn a prompt-to-check-in into the leaderboard CLAUDE.md forbids.
  flagged.sort((a, b) => a.displayName.localeCompare(b.displayName));
  incomplete.sort((a, b) => a.displayName.localeCompare(b.displayName));
  unresolved.sort((a, b) => a.developer.localeCompare(b.developer));
  suppressed.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { flagged, unresolved, incomplete, suppressed };
}

/** Whether the flagged share is too high to be a finding about people. */
export function implausible(flaggedCount: number, evaluated: number): boolean {
  if (evaluated === 0) {
    return false;
  }
  return flaggedCount / evaluated > IMPLAUSIBLE_FLAGGED_SHARE;
}

export interface DigestDetection {
  reportedDay: string;
  rosterCount: number;
  evaluation: RosterEvaluation;
  /** Non-null when the names must not be sent, with the reason to record. */
  withhold: { outcome: DigestOutcome; detail: string } | null;
  collectedThroughAt: Date | null;
}

/**
 * Computes the daily digest: the tracked roster minus the developers active on
 * the reported day.
 *
 * Tenant-explicit throughout. `TenantContextService.requireTenantId()` is
 * request-scoped and this runs from a cron, which is also why it cannot simply
 * call `DeveloperActivityService.overview()` — it performs the same reads
 * instead, through the shared `activeDeveloperSet`, so the digest and the
 * Overview board cannot disagree about the same person on the same day.
 */
@Injectable()
export class NoCommitDetectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: DeveloperIdentityService,
    private readonly code: CodeService,
    private readonly connections: ConnectionsService,
  ) {}

  async detect(
    tenantId: string,
    reportedDay: string,
  ): Promise<DigestDetection> {
    const from = istDayStart(reportedDay);
    const to = istDayEnd(reportedDay);

    const [roster, freshness, index, exclusionRows] = await Promise.all([
      this.prisma.trackedDeveloper.findMany({
        where: { tenantId, active: true },
        select: { canonicalDeveloperId: true, addedAs: true },
      }),
      this.connections.getDataFreshness(tenantId),
      this.identities.attributionIndex(tenantId),
      this.prisma.watchlistExclusion.findMany({
        // Live exclusions only — a lapsed one is not a statement about today.
        where: { tenantId, expiresAt: { gt: new Date() } },
        select: { canonicalDeveloperId: true },
      }),
    ]);

    const empty: RosterEvaluation = {
      flagged: [],
      unresolved: [],
      incomplete: [],
      suppressed: [],
    };

    // Gate 1: is the day's data actually in? `collectedThroughAt` is null
    // whenever ANY active connection has no watermark, and is the oldest
    // watermark otherwise — so this is genuinely "the whole tenant is
    // collected through here", which is what the question needs.
    //
    // Ingest is poll-based. A stalled collector or an expired token makes the
    // entire roster read as inactive, and without this gate the job would
    // name every one of them in a channel.
    if (!freshness.collectedThroughAt || freshness.collectedThroughAt < to) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation: empty,
        withhold: {
          outcome: 'withheld_stale_data',
          detail: `Collection reaches ${
            freshness.collectedThroughAt?.toISOString() ?? 'nothing'
          }, which does not cover ${reportedDay}. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    const [{ commits, truncated }, prs] = await Promise.all([
      this.code.listCommitsPage(tenantId, { from, to }),
      this.prisma.pullRequest.findMany({
        where: { tenantId, openedAt: { gte: from, lte: to } },
        select: { authorLogin: true },
      }),
    ]);

    // Gate 2: a short commit read makes the active set unreliable, and every
    // developer it omitted would be flagged. The flag exists precisely so
    // that hitting the ceiling is reported rather than quietly changing the
    // answer.
    if (truncated) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation: empty,
        withhold: {
          outcome: 'withheld_truncated_read',
          detail: `The commit read for ${reportedDay} hit its row ceiling, so the active set is incomplete. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    const activeSet = activeDeveloperSet(commits, prs, index);
    const incompleteSet = await this.commitsInvisibleToTheDayRead(
      tenantId,
      index,
      from,
      to,
    );

    const excludedByAdmin = new Set<string>([
      ...exclusionRows.map((row) => row.canonicalDeveloperId),
      ...index.excluded,
    ]);

    const evaluation = evaluateRoster({
      roster,
      activeSet,
      incompleteSet,
      excludedByAdmin,
      displayNames: index.displayNames,
      known: new Set(index.displayNames.keys()),
    });

    const evaluated =
      roster.length -
      evaluation.unresolved.length -
      evaluation.suppressed.length;

    // Gate 3: too many to be a finding about people.
    if (implausible(evaluation.flagged.length, evaluated)) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation,
        withhold: {
          outcome: 'withheld_implausible',
          detail: `${evaluation.flagged.length} of ${evaluated} evaluated developers had no signal on ${reportedDay} — more likely a holiday or a collection problem than that many idle developers. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    return {
      reportedDay,
      rosterCount: roster.length,
      evaluation,
      withhold: null,
      collectedThroughAt: freshness.collectedThroughAt,
    };
  }

  /**
   * Developers with a commit dated inside the window that the day's read
   * cannot see, because its `committedAt` is null.
   *
   * `CodeService.listCommitsPage` windows on `committedAt`, which is nullable.
   * The only thing that backfills it — `GithubCommitReconcilerService` — is
   * one-off maintenance behind an admin endpoint, not a scheduled job, and one
   * of its stated causes is ongoing: commits "that outran the enrichment's
   * bounded per-tick budget". So a commit can land today with a null
   * `committedAt` and stay invisible indefinitely.
   *
   * Everyone found here is withheld from the list rather than named. It is the
   * one place the digest departs from the Overview board, and it departs only
   * where the board is provably missing a commit. (The board's own day
   * bucketing already falls back to `committedAt ?? authoredAt`, so the
   * fallback is this codebase's established idiom for the column.)
   */
  private async commitsInvisibleToTheDayRead(
    tenantId: string,
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
    from: Date,
    to: Date,
  ): Promise<Set<string>> {
    const rows = await this.prisma.commit.groupBy({
      by: ['authorLogin', 'authorEmail'],
      where: {
        tenantId,
        committedAt: null,
        authoredAt: { gte: from, lte: to },
      },
    });
    // Same attribution as the active set, with no PRs to consider — so a
    // developer identified here is identified by exactly the rules that would
    // have recognised them had the column been populated.
    return activeDeveloperSet(rows, [], index);
  }
}
