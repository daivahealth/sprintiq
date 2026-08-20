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
}
