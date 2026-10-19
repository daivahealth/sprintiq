import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AppRole, roleRunsScheduler } from '../../config/app-role';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { readGithubCopilotConfig } from '../sources/github/github-copilot.config';
import { GithubCopilotUsageSyncService } from '../sources/github/github-copilot-usage-sync.service';

/**
 * Runs the Copilot usage-metrics sync (ADR-0012) once a day, at 04:30 UTC.
 *
 * Daily because the source is daily: GitHub publishes one report per UTC day,
 * about two days after it closes, so polling more often only asks for reports
 * that don't exist yet. 04:30 UTC (10:00 IST) is after GitHub's overnight
 * processing and before the working day reads the boards.
 *
 * Off unless `GITHUB_COPILOT_USAGE_SYNC` is on, and worker-only in production
 * — the same gate as the digest cron, for the same reason: every role loads
 * every module, so an ungated cron would fire once per pod.
 */
@Injectable()
export class GithubCopilotSchedulerService {
  private readonly logger = new Logger(GithubCopilotSchedulerService.name);
  /**
   * In-process overlap guard. A run is minutes long and the cron is daily, so
   * overlap means a manual run and the cron colliding in one process; across
   * processes, the worker-only gate leaves one runner per deployment.
   */
  private running = false;

  constructor(
    private readonly sync: GithubCopilotUsageSyncService,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  @Cron('30 4 * * *', { timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (!this.shouldRun()) {
      return;
    }
    if (!readGithubCopilotConfig().syncEnabled) {
      this.logger.debug(
        'Copilot usage sync is off (GITHUB_COPILOT_USAGE_SYNC) — skipped.',
      );
      return;
    }
    await this.runForEnabledTenants();
  }

  async runForEnabledTenants(): Promise<void> {
    if (this.running) {
      this.logger.log('Copilot usage sync already running — skipped.');
      return;
    }
    this.running = true;
    try {
      for (const tenantId of await this.sync.listEnabledTenants()) {
        // One tenant's revoked token must not cancel the sweep for the rest.
        try {
          await this.tenantContext.runWithTenant(tenantId, () =>
            this.sync.syncTenant(tenantId),
          );
        } catch (error) {
          this.logger.error(
            `Copilot usage sync failed for tenant ${tenantId}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private shouldRun(): boolean {
    const role = this.config.get<AppRole>('appRole') ?? AppRole.API;
    const env = this.config.get<string>('env') ?? 'development';
    return env !== 'production' || roleRunsScheduler(role);
  }
}
