import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { GithubClient } from './github.client';

export interface PrStatsReconcileResult {
  candidates: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
}

/**
 * One-off maintenance: fills in additions/deletions/changedFiles for
 * `code_pull_request` rows still at the default 0/0/0 — PRs ingested before
 * `GithubCollector`'s per-PR enrichment existed, or ones that outran its
 * bounded per-tick budget. Updates rows directly, bypassing the normal
 * event-sourced ingestion pipeline: a PR's idempotency key makes its stats
 * permanent once first ingested, so a corrective re-ingestion attempt would
 * just be dropped as a duplicate — this is the only way to correct data
 * already landed. The token never leaves the backend: resolved
 * per-connection via SecretsService, never returned or logged.
 */
@Injectable()
export class GithubPrReconcilerService {
  private readonly logger = new Logger(GithubPrReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: GithubClient,
  ) {}

  async reconcile(
    tenantId: string,
    limit = 200,
  ): Promise<PrStatsReconcileResult> {
    const candidates = await this.prisma.pullRequest.findMany({
      where: { tenantId, additions: 0, deletions: 0, changedFiles: 0 },
      take: limit,
    });

    let updated = 0;
    let skipped = 0;
    let rateLimited = false;
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

      const detail = await this.client.getPullRequestDetail(
        pr.repoFullName,
        token,
        pr.externalNumber,
      );
      if (detail.rateLimitedUntil) {
        rateLimited = true;
        break;
      }
      if (detail.additions === undefined && detail.deletions === undefined) {
        skipped++;
        continue;
      }

      await this.prisma.pullRequest.update({
        where: { id: pr.id },
        data: {
          additions: detail.additions ?? 0,
          deletions: detail.deletions ?? 0,
          changedFiles: detail.changedFiles ?? 0,
        },
      });
      updated++;
    }

    this.logger.log(
      `Reconciled PR stats: ${updated} updated, ${skipped} skipped, ${candidates.length} candidates` +
        (rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return { candidates: candidates.length, updated, skipped, rateLimited };
  }
}
