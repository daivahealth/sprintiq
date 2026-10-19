import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AppRole, roleRunsScheduler } from '../../config/app-role';
import { SecretsService } from '../../common/secrets/secrets.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import {
  orgSyncCronExpression,
  readGithubAuditConfig,
} from '../sources/github/github-audit.config';
import {
  GithubOrgSyncService,
  OrgSyncResult,
} from '../sources/github/github-org-sync.service';

/** Same fallback rule as the audit crons: `validateEnv` has already rejected a bad value. */
const ORG_SYNC_CRON = (() => {
  try {
    return orgSyncCronExpression(readGithubAuditConfig().orgSyncHours);
  } catch {
    return orgSyncCronExpression(24);
  }
})();

/** Matches the admin endpoint's default when the configuration sets none. */
const DEFAULT_BACKFILL_DAYS = 90;

/**
 * Registers every repo in each tenant's GitHub org on a schedule
 * (`GITHUB_ORG_SYNC_HOURS`, default 24, 0 = off), added 2026-10-19.
 *
 * Until then a repo became a connection only when an admin ran the org sync
 * or, in ingest mode, when the audit route saw a push to it. Five active repos
 * on the reference tenant were never registered, and two tracked developers'
 * work lived only there, so on days that was all they did the digest would
 * have named them. This is the same `syncOrgRepos` the admin button calls,
 * with the same arguments, and it runs whatever the audit mode is.
 */
@Injectable()
export class GithubOrgSyncSchedulerService {
  private readonly logger = new Logger(GithubOrgSyncSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly orgSync: GithubOrgSyncService,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  @Cron(ORG_SYNC_CRON)
  async tick(): Promise<void> {
    if (readGithubAuditConfig().orgSyncHours === 0 || !this.shouldSweep()) {
      return;
    }
    const rows = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: 'github', key: 'default', status: 'active' },
      select: { tenantId: true, values: true, secretRefs: true },
    });
    for (const row of rows) {
      try {
        const result = await this.tenantContext.runWithTenant(
          row.tenantId,
          () => this.syncTenant(row.tenantId, row.values, row.secretRefs),
        );
        if (result) {
          this.logger.log(
            `[tenant ${row.tenantId}] scheduled org sync: ${result.reposFound} repos, ${result.created} new, ${result.skipped} skipped${result.rateLimited ? ' (rate-limited, resumes next run)' : ''}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[tenant ${row.tenantId}] scheduled org sync failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** One tenant; null when its configuration cannot sync (no org, no token). */
  async syncTenant(
    tenantId: string,
    values: unknown,
    secretRefs: unknown,
  ): Promise<OrgSyncResult | null> {
    const v = (values ?? {}) as Record<string, unknown>;
    const refs = (secretRefs ?? {}) as Record<string, unknown>;
    const organization =
      typeof v.organization === 'string' ? v.organization : undefined;
    const tokenRef =
      typeof refs.tokenRef === 'string' ? refs.tokenRef : undefined;
    if (!organization || !tokenRef) {
      return null;
    }
    const token = await this.secrets.resolve(tenantId, tokenRef);
    if (!token) {
      this.logger.warn(
        `[tenant ${tenantId}] scheduled org sync skipped: no value stored for secret ref "${tokenRef}"`,
      );
      return null;
    }
    const backfillDays =
      typeof v.backfillDays === 'number'
        ? v.backfillDays
        : DEFAULT_BACKFILL_DAYS;
    return this.orgSync.syncOrgRepos(
      tenantId,
      organization,
      tokenRef,
      token,
      backfillDays,
    );
  }

  /** Worker-only in production; the same rule as GithubAuditSchedulerService.shouldSweep. */
  private shouldSweep(): boolean {
    const role = this.config.get<AppRole>('appRole') ?? AppRole.API;
    const env = this.config.get<string>('env') ?? 'development';
    return env !== 'production' || roleRunsScheduler(role);
  }
}
