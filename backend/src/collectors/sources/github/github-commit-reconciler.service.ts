import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import {
  GITHUB_SOURCE_CLIENT,
  GithubSourceClient,
} from './github-source-client';

export interface CommitStatsReconcileResult {
  candidates: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
}

/**
 * One-off maintenance: fills in additions/deletions/filesChanged and/or
 * committedAt for `code_commit` rows missing them — commits ingested before
 * `GithubCollector`'s per-commit enrichment (or `committedAt` capture)
 * existed, or ones that outran the enrichment's bounded per-tick budget.
 * Updates rows directly, bypassing the normal event-sourced ingestion
 * pipeline: a commit's idempotency key makes its data permanent once first
 * ingested, so a corrective re-ingestion attempt would just be dropped as a
 * duplicate — this is the only way to correct data already landed. The
 * token never leaves the backend: resolved per-connection via
 * SecretsService, never returned or logged.
 */
@Injectable()
export class GithubCommitReconcilerService {
  private readonly logger = new Logger(GithubCommitReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    @Inject(GITHUB_SOURCE_CLIENT)
    private readonly client: GithubSourceClient,
  ) {}

  async reconcile(
    tenantId: string,
    limit = 200,
  ): Promise<CommitStatsReconcileResult> {
    const candidates = await this.prisma.commit.findMany({
      where: {
        tenantId,
        OR: [
          { additions: 0, deletions: 0, filesChanged: 0 },
          { committedAt: null },
        ],
      },
      take: limit,
    });

    let updated = 0;
    let skipped = 0;
    let rateLimited = false;
    const tokenCache = new Map<string, string>();

    for (const commit of candidates) {
      const connection = await this.prisma.connection.findUnique({
        where: { id: commit.connectionId },
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

      const detail = await this.client.getCommitDetail(
        commit.repoFullName,
        token,
        commit.sha,
      );
      if (detail.rateLimitedUntil) {
        rateLimited = true;
        break;
      }
      if (
        detail.additions === undefined &&
        detail.deletions === undefined &&
        detail.committedAt === undefined
      ) {
        skipped++;
        continue;
      }

      await this.prisma.commit.update({
        where: { id: commit.id },
        data: {
          additions: detail.additions ?? 0,
          deletions: detail.deletions ?? 0,
          filesChanged: detail.filesChanged ?? 0,
          ...(detail.committedAt
            ? { committedAt: new Date(detail.committedAt) }
            : {}),
        },
      });
      updated++;
    }

    this.logger.log(
      `Reconciled commit stats: ${updated} updated, ${skipped} skipped, ${candidates.length} candidates` +
        (rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return { candidates: candidates.length, updated, skipped, rateLimited };
  }

  /**
   * One-off maintenance: fills `parentCount` for commits ingested before it was
   * collected, so merge commits (2+ parents) can be excluded from LOC and
   * authorship counts (METRICS.md §0). Same direct-update rationale as
   * `reconcile`: a commit's idempotency key makes re-ingestion a no-op.
   *
   * Batched per repo, up to `PARENT_BATCH` SHAs per source call — one GraphQL
   * query on the GraphQL transport. **Resumable by cursor, not by candidacy**:
   * a commit GitHub no longer returns (a deleted repo or force-pushed history)
   * stays null forever, and re-selecting nulls from the top would wedge every
   * later run on the same unanswerable rows. Pass the returned `nextCursor` back
   * as `after` until `done`.
   */
  async reconcileParentCounts(
    tenantId: string,
    after?: string,
    limit = 5000,
  ): Promise<ParentCountReconcileResult> {
    const candidates = await this.prisma.commit.findMany({
      where: {
        tenantId,
        parentCount: null,
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, connectionId: true, repoFullName: true, sha: true },
      orderBy: { id: 'asc' },
      take: limit,
    });

    const groups = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const key = `${c.connectionId}\u0000${c.repoFullName}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }

    let updated = 0;
    let unanswered = 0;
    let rateLimited = false;
    const tokenCache = new Map<string, string>();

    outer: for (const rows of groups.values()) {
      const { connectionId, repoFullName } = rows[0];
      let token = tokenCache.get(connectionId);
      if (token === undefined) {
        const connection = await this.prisma.connection.findUnique({
          where: { id: connectionId },
          select: { secretRef: true },
        });
        token = connection
          ? ((await this.secrets.resolve(tenantId, connection.secretRef)) ??
            '')
          : '';
        tokenCache.set(connectionId, token);
      }

      for (let i = 0; i < rows.length; i += PARENT_BATCH) {
        const batch = rows.slice(i, i + PARENT_BATCH);
        if (!token) {
          unanswered += batch.length;
          continue;
        }
        const { counts, rateLimitedUntil } =
          await this.client.getCommitParentCounts(
            repoFullName,
            token,
            batch.map((r) => r.sha),
          );
        if (rateLimitedUntil) {
          rateLimited = true;
          break outer;
        }
        const byCount = new Map<number, string[]>();
        for (const row of batch) {
          const n = counts.get(row.sha);
          if (n === undefined) {
            unanswered++;
          } else {
            byCount.set(n, [...(byCount.get(n) ?? []), row.id]);
          }
        }
        for (const [parentCount, ids] of byCount) {
          const res = await this.prisma.commit.updateMany({
            where: { tenantId, id: { in: ids } },
            data: { parentCount },
          });
          updated += res.count;
        }
      }
    }

    // A rate-limited pass resumes from the cursor it was given: groups
    // interleave ids, so no later id is safely "done", and the rows it did
    // update no longer match `parentCount: null` anyway.
    const done = !rateLimited && candidates.length < limit;
    const nextCursor = done
      ? null
      : rateLimited
        ? (after ?? null)
        : candidates[candidates.length - 1].id;
    this.logger.log(
      `Reconciled commit parent counts: ${updated} updated, ${unanswered} unanswered, ${candidates.length} candidates` +
        (rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return {
      candidates: candidates.length,
      updated,
      unanswered,
      rateLimited,
      done,
      nextCursor,
    };
  }
}

/** SHAs per source call — 100 aliased objects keep a GraphQL query near 1 point. */
const PARENT_BATCH = 100;

export interface ParentCountReconcileResult {
  candidates: number;
  updated: number;
  /** Commits GitHub did not answer for (deleted, or no token); left null. */
  unanswered: number;
  rateLimited: boolean;
  /** True when this pass reached the last candidate; stop calling. */
  done: boolean;
  /** Pass back as `after` on the next call (null = from the start). */
  nextCursor: string | null;
}
