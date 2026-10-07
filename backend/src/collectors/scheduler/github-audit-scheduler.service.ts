import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AppRole, roleRunsScheduler } from '../../config/app-role';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import {
  auditCronExpression,
  readGithubAuditConfig,
} from '../sources/github/github-audit.config';
import { GithubAuditSyncService } from '../sources/github/github-audit-sync.service';

export const AUDIT_SWEEP_KEY = 'github-audit';

/**
 * The decorator needs its expression at module load. `validateEnv` has already
 * rejected an invalid interval before Nest instantiates anything; the fallback
 * only keeps an import in a test or script from throwing.
 */
const AUDIT_CRON = (() => {
  try {
    return auditCronExpression(readGithubAuditConfig().intervalMinutes);
  } catch {
    return auditCronExpression(5);
  }
})();

/**
 * Drives the GitHub audit-log sync (ADR-0010) on its own cadence
 * (`GITHUB_AUDIT_SYNC_INTERVAL_MINUTES`, default 5), independent of the
 * per-connection collector sweep. Tenants run one after another: the audit
 * bucket is per token and each tenant's run already bounds its own Compare
 * concurrency.
 */
@Injectable()
export class GithubAuditSchedulerService {
  private readonly logger = new Logger(GithubAuditSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GithubAuditSyncService,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  @Cron(AUDIT_CRON)
  async tick(): Promise<void> {
    const cfg = readGithubAuditConfig();
    if (cfg.mode === 'off' || !this.shouldSweep()) {
      return;
    }
    const staleAfterMs = Math.max(10, cfg.intervalMinutes * 2) * 60_000;
    const open = await this.prisma.schedulerTick.findUnique({
      where: { sourceSystem: AUDIT_SWEEP_KEY },
    });
    if (
      open?.startedAt &&
      !open.finishedAt &&
      Date.now() - open.startedAt.getTime() < staleAfterMs
    ) {
      this.logger.log('GitHub audit sync still running — skipping this tick.');
      return;
    }

    const tenants = await this.sync.listEnabledTenants();
    await this.prisma.schedulerTick.upsert({
      where: { sourceSystem: AUDIT_SWEEP_KEY },
      create: {
        sourceSystem: AUDIT_SWEEP_KEY,
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: tenants.length,
        connectionsProcessed: 0,
      },
      update: {
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: tenants.length,
        connectionsProcessed: 0,
      },
    });
    try {
      for (const tenantId of tenants) {
        try {
          const summary = await this.tenantContext.runWithTenant(tenantId, () =>
            this.sync.runTenant(tenantId, cfg),
          );
          if (summary?.status === 'skipped') {
            this.logger.log(
              `GitHub audit sync skipped for tenant ${tenantId}: ${summary.reason ?? 'no reason given'}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `GitHub audit sync failed for tenant ${tenantId}: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      await this.prisma.schedulerTick.update({
        where: { sourceSystem: AUDIT_SWEEP_KEY },
        data: { finishedAt: new Date() },
      });
    }
  }

  /**
   * Worker-only in production; unrestricted everywhere else. The SAME rule as
   * `NotificationSchedulerService.shouldSweep()`
   * (src/modules/notifications/notification-scheduler.service.ts), replicated
   * because that helper is private to its class: the image runs as api |
   * collector | worker and @nestjs/schedule fires this cron in every pod, so
   * without the gate production would sweep three times concurrently. Dev and
   * test run all roles in one process (APP_ROLE defaults to `api`), so the
   * gate applies only when `env === 'production'`.
   */
  private shouldSweep(): boolean {
    const role = this.config.get<AppRole>('appRole') ?? AppRole.API;
    const env = this.config.get<string>('env') ?? 'development';
    return env !== 'production' || roleRunsScheduler(role);
  }
}
