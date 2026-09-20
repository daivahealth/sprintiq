import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AppRole, roleRunsScheduler } from '../../config/app-role';
import { IST_TIMEZONE } from '../../common/time';
import { NotificationsService } from './notifications.service';

/**
 * Fires the daily digest at 10:30 IST, Monday to Friday.
 *
 * Mon–Fri, not daily: a Monday run reporting Sunday would name nearly the
 * whole roster for a day nobody was expected to work, and a notification that
 * is mostly noise stops being read. `previousWorkingDayKey` makes Monday
 * report Friday.
 *
 * 10:30 rather than at the day's close also buys the poll-based collectors
 * roughly ten hours to bring in late commits before anyone is named.
 *
 * This class holds no digest logic deliberately — it decides only *when*, and
 * (see `shouldSweep`) *whether this process is the one that should*.
 */
@Injectable()
export class NotificationSchedulerService {
  private readonly logger = new Logger(NotificationSchedulerService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  @Cron('30 10 * * 1-5', { timeZone: IST_TIMEZONE })
  async sendDailyDigest(): Promise<void> {
    if (!this.shouldSweep()) {
      // The same image runs as api | collector | worker via APP_ROLE, all
      // three loaded with every module (app.module.ts), and @nestjs/schedule
      // fires this handler in every one of them. Outbound egress — this cron
      // included — is worker-only (docs/deployment/README.md §1: "External
      // egress ... originates from collector/worker pods only — never from
      // api"); without this gate, production runs `api`, `collector` and
      // `worker` pods of the same image and the digest fires three times.
      return;
    }

    const tenants = await this.notifications.tenantsToDigest();
    for (const tenantId of tenants) {
      // Per-tenant isolation: one tenant's rotated webhook or empty roster
      // must not cancel the sweep for the others.
      try {
        const result = await this.notifications.runNoCommitDigest(tenantId);
        this.logger.log(
          `Daily digest for ${tenantId} (${result.reportedDay}): ${result.outcome}, ${result.flagged.length} named.`,
        );
      } catch (error) {
        this.logger.error(
          `Daily digest failed for ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Worker-only in production; unrestricted everywhere else.
   *
   * `docs/deployment/README.md` §1: "In dev, all three roles run in **one**
   * process" — and that dev process's `APP_ROLE` defaults to `api`
   * (`backend/.env.example`, `docker-compose.yml`), same as `configuration.ts`
   * defaulting an unset `APP_ROLE` to `AppRole.API`. Gating on role alone
   * would silently stop this cron from ever firing in dev or in the Jest
   * environment (`NODE_ENV=test`), which is not what "all three roles run in
   * one process" means. So the gate is scoped to `env === 'production'`: a
   * deployed `api` pod is skipped, but a dev or test process — where "worker"
   * has no separate identity — still sweeps.
   */
  private shouldSweep(): boolean {
    const role = this.config.get<AppRole>('appRole') ?? AppRole.API;
    const env = this.config.get<string>('env') ?? 'development';
    return env !== 'production' || roleRunsScheduler(role);
  }
}
