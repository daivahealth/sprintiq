import { Inject, Injectable, Logger } from '@nestjs/common';
import { CodeCommitPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { IngestionService } from '../../ingestion/ingestion.service';
import { evaluateBudget } from './github-rate-budget';
import {
  GITHUB_SOURCE_CLIENT,
  GithubSourceClient,
} from './github-source-client';

export interface PrCommitBackfillResult {
  candidates: number;
  /** PRs asked about and stamped this run. */
  processed: number;
  /** Commit envelopes accepted by ingestion — i.e. commits genuinely recovered. */
  commitsIngested: number;
  /** Envelopes dropped as duplicates: already collected via the default branch. */
  alreadyPresent: number;
  skipped: number;
  rateLimited: boolean;
  /** PRs whose commits have still never been harvested — re-run to continue. */
  remaining: number;
  resumeAt?: Date;
}

/**
 * Bounds one invocation. One GitHub call per PR, matching the sibling
 * reconcilers — a full pass over the reference tenant's ~22,000-PR backlog
 * costs ~22,000 requests spread across ticks, inside the 5,000/hr limit with
 * the reserve protecting the live poller.
 */
const DEFAULT_LIMIT = 500;

/**
 * Recovers commits that were never collected because the commit walk only ever
 * read one branch (api/README.md §12 #51).
 *
 * The walk reads the repository's DEFAULT branch — REST omits `sha`, GraphQL
 * reads `defaultBranchRef` — while the reference tenant merges through
 * long-lived integration branches. Measured: **43.7% of merged PRs** targeted
 * something other than master/main/develop, leaving **71 developers
 * understated**, 26 of them missing over half their commit activity and 3 with
 * no commit activity on the board at all. The live collector now harvests
 * commits from each enriched PR, but incremental sync only walks PRs newer
 * than `prNewestSeenAt`, so every PR already behind that watermark — the
 * entire year of history — is never revisited. That is exactly the trap that
 * left §12 #6 at 2.9% coverage while its row read Done.
 *
 * **Unlike its sibling reconcilers, this one goes through the ingestion
 * pipeline rather than writing rows directly**, and the difference is
 * principled, not stylistic. Those reconcilers correct rows that already
 * exist, whose idempotency key is already burned, so a re-ingestion would be
 * dropped before reaching the projector and a direct write is the only route
 * left. These commits were *never ingested at all* — no raw event carries
 * `github:{repo}:commit:{sha}` — so they ingest normally, and the recovered
 * year keeps the same lineage guarantee as everything else. It also makes the
 * job safely re-runnable: a commit already collected from the default branch
 * is dropped as a duplicate, counted as `alreadyPresent` rather than
 * double-written.
 *
 * The head SHA is filled in as a side effect where it is missing, because the
 * PR's commit list ends at it. That is what makes the completeness anti-join
 * (`countUncollectedHeads`) answerable for historical PRs too.
 */
@Injectable()
export class GithubPrCommitBackfillService {
  private readonly logger = new Logger(GithubPrCommitBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly ingestion: IngestionService,
    @Inject(GITHUB_SOURCE_CLIENT)
    private readonly client: GithubSourceClient,
  ) {}

  /** How many PRs still need their commits harvested — without fetching any. */
  async countRemaining(tenantId: string): Promise<number> {
    return this.prisma.pullRequest.count({ where: candidateWhere(tenantId) });
  }

  /**
   * Merged PRs whose head commit has no `code_commit` row — the completeness
   * check that is independent of the collector's own cursors, and the one
   * that would have caught #51 a year earlier. Counts only PRs whose
   * `headSha` is known: absence is "unknown", never "no gap".
   */
  async countUncollectedHeads(tenantId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM code_pull_request pr
      WHERE pr."tenantId" = ${tenantId}
        AND pr."mergedAt" IS NOT NULL
        AND pr."headSha" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM code_commit c
          WHERE c."tenantId" = pr."tenantId"
            AND c."repoFullName" = pr."repoFullName"
            AND c.sha = pr."headSha"
        )`;
    return Number(row?.count ?? 0);
  }

  async reconcile(
    tenantId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<PrCommitBackfillResult> {
    const candidates = await this.prisma.pullRequest.findMany({
      where: candidateWhere(tenantId),
      // Newest first: recent PRs are the ones dashboards actually window on,
      // so the boards start correcting themselves from the first batch rather
      // than after the whole year has been walked.
      orderBy: { openedAt: 'desc' },
      take: limit,
    });

    let processed = 0;
    let commitsIngested = 0;
    let alreadyPresent = 0;
    let skipped = 0;
    let rateLimited = false;
    let resumeAt: Date | undefined;
    let reserved = false;
    const tokenCache = new Map<string, string>();

    for (const pr of candidates) {
      const connection = await this.prisma.connection.findUnique({
        where: { id: pr.connectionId },
      });
      if (!connection) {
        skipped++;
        continue;
      }

      let token = tokenCache.get(connection.id);
      if (token === undefined) {
        token =
          (await this.secrets.resolve(tenantId, connection.secretRef)) ?? '';
        tokenCache.set(connection.id, token);
      }
      if (!token) {
        skipped++;
        continue;
      }

      const result = await this.client.listPullRequestCommits(
        pr.repoFullName,
        token,
        pr.externalNumber,
      );
      if (result.rateLimitedUntil) {
        // GitHub refused the call — nothing was fetched for this PR, so it
        // must stay a candidate.
        rateLimited = true;
        resumeAt = result.rateLimitedUntil;
        break;
      }
      if (result.failed) {
        // Never stamped: an unanswered PR must not be retired as "asked, and
        // it genuinely has no commits".
        skipped++;
        continue;
      }

      const commits = result.commits ?? [];
      for (const commit of commits) {
        if (!commit.sha) {
          continue; // no key to converge on — see `commitEnvelopesFromPull`
        }
        const ingested = await this.ingestion.ingest(
          tenantId,
          this.commitEnvelope(connection.id, pr.repoFullName, commit),
        );
        if (ingested.status === 'accepted') {
          commitsIngested++;
        } else {
          // Already collected from the default branch. Not a failure — this
          // is the idempotency key doing its job, and counting it separately
          // is how a run reports what it actually recovered.
          alreadyPresent++;
        }
      }

      await this.prisma.pullRequest.update({
        where: { id: pr.id },
        data: {
          commitShasFetchedAt: new Date(),
          // The PR's commit list ends at its head, so this fills the
          // completeness key for history collected before it was captured.
          // Only written when missing — never overwrite what the collector
          // recorded from GitHub's own `head.sha`.
          ...(pr.headSha || commits.length === 0
            ? {}
            : { headSha: commits[commits.length - 1].sha }),
        },
      });
      processed++;

      // Reserve check AFTER the write: this call's quota is already spent, so
      // stopping applies to the NEXT call, not to work already paid for.
      const budget = evaluateBudget(result);
      if (budget.exhausted) {
        rateLimited = true;
        resumeAt = budget.resumeAt;
        reserved = budget.reserved;
        break;
      }
    }

    const remaining = await this.countRemaining(tenantId);

    if (processed > 0 || rateLimited) {
      this.logger.log(
        `PR commit backfill: ${processed} PRs, ${commitsIngested} commits recovered ` +
          `(${alreadyPresent} already collected), ${skipped} skipped, ${remaining} remaining` +
          (rateLimited
            ? reserved
              ? ` (paused at the rate reserve — resumes ${resumeAt?.toISOString()})`
              : ` (rate-limited by GitHub — resumes ${resumeAt?.toISOString()})`
            : ''),
      );
    }

    return {
      candidates: candidates.length,
      processed,
      commitsIngested,
      alreadyPresent,
      skipped,
      rateLimited,
      remaining,
      resumeAt,
    };
  }

  /**
   * Deliberately the same envelope `GithubCollector` mints for a PR commit —
   * same event type, same idempotency key — so a backfilled commit and a
   * later polled one converge on one row instead of racing.
   */
  private commitEnvelope(
    connectionId: string,
    repoFullName: string,
    commit: {
      sha: string;
      message: string;
      authorLogin?: string;
      authorName?: string;
      authorEmail?: string;
      authoredAt?: string;
      committedAt?: string;
      additions?: number;
      deletions?: number;
      filesChanged?: number;
    },
  ): CanonicalEnvelope {
    const authoredAt = commit.authoredAt ?? new Date().toISOString();
    const payload: CodeCommitPayload = {
      repoFullName,
      sha: commit.sha,
      message: commit.message,
      authorLogin: commit.authorLogin,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authoredAt,
      committedAt: commit.committedAt,
      additions: commit.additions,
      deletions: commit.deletions,
      filesChanged: commit.filesChanged,
    };
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      idempotencyKey: `github:${repoFullName}:commit:${commit.sha}`,
      sourceSystem: 'github',
      connectionId,
      collectionMode: 'backfill',
      eventType: EventTypes.CODE_COMMIT_PUSHED,
      occurredAt: authoredAt,
      collectedAt: new Date().toISOString(),
      externalRefs: { repo: repoFullName, sha: commit.sha },
      actor: { sourceLogin: commit.authorLogin },
      data: payload as unknown as Record<string, unknown>,
    };
  }
}

/**
 * Rows this reconciler considers outstanding — one definition shared by the
 * work loop and `countRemaining`, so the Sync Status backlog can never
 * disagree with what the reconciler actually picks up.
 *
 * Keyed on `commitShasFetchedAt`, NOT `commitsFetchedAt`. The latter is
 * already set on essentially every PR (21,930 of 21,931 on the reference
 * tenant) because the 2026-08-14 message reconciler asked them all, so
 * reusing it would retire every candidate before this backfill collected
 * anything.
 */
function candidateWhere(tenantId: string) {
  return { tenantId, commitShasFetchedAt: null };
}
