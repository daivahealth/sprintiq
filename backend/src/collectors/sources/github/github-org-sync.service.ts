import { Injectable, Logger } from '@nestjs/common';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import { GithubClient } from './github.client';

export interface OrgSyncResult {
  reposFound: number;
  created: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
}

/** Safety cap — up to 2000 repos per invocation; a bigger org needs a re-run. */
const PAGE_BUDGET = 20;

/**
 * One-time (admin-triggered) discovery: lists every repo in a GitHub org the
 * configured token can see, and registers a Connection per repo so the
 * regular scheduled sync (GithubCollector.poll) picks each one up from then
 * on. Complements the single-default-repo admin/configuration bridge, which
 * only ever manages one repo — this is for "sync the whole org."
 *
 * The token never leaves the backend: the caller resolves it via
 * SecretsService and passes the value in-process; this service never returns
 * it or logs it.
 */
@Injectable()
export class GithubOrgSyncService {
  private readonly logger = new Logger(GithubOrgSyncService.name);

  constructor(
    private readonly client: GithubClient,
    private readonly connections: ConnectionsService,
  ) {}

  async syncOrgRepos(
    tenantId: string,
    organization: string,
    secretRef: string,
    token: string,
    backfillDays: number,
  ): Promise<OrgSyncResult> {
    const result: OrgSyncResult = {
      reposFound: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      rateLimited: false,
    };
    const backfillSince = new Date(
      Date.now() - backfillDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    let page = 1;
    for (let fetched = 0; fetched < PAGE_BUDGET; fetched++) {
      const pageResult = await this.client.listOrgReposPage(
        organization,
        token,
        page,
      );
      if (pageResult.rateLimitedUntil) {
        result.rateLimited = true;
        this.logger.warn(
          `Org sync for "${organization}" stopped early — rate-limited until ${pageResult.rateLimitedUntil.toISOString()}`,
        );
        break;
      }

      for (const repo of pageResult.items) {
        result.reposFound++;
        if (repo.archived || repo.disabled) {
          result.skipped++;
          continue;
        }

        const existing = await this.connections.findByTenantSourceAndName(
          tenantId,
          'github',
          repo.full_name,
        );
        if (existing) {
          // Already registered (e.g. a previous sync-org run) — never reset
          // its progress; just keep the secret ref/status current.
          await this.connections.updateConfig(existing.id, {
            config: (existing.config ?? {}) as Record<string, unknown>,
            secretRef,
            webhookSecretRef: existing.webhookSecretRef ?? undefined,
            status: 'active',
          });
          result.updated++;
        } else {
          await this.connections.create(tenantId, {
            sourceSystem: 'github',
            name: repo.full_name,
            config: { repoFullName: repo.full_name, backfillSince },
            secretRef,
          });
          result.created++;
        }
      }

      if (!pageResult.hasNextPage) {
        break;
      }
      page++;
    }

    return result;
  }
}
