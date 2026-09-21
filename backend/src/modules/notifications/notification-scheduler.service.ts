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

    if (!this.envArmed()) {
      // One clear line so an operator wondering why nothing posted this
      // morning finds the reason in the log instead of assuming a bug.
      this.logger.log(
        'Daily digest cron disabled by DIGEST_CRON_ENABLED environment ' +
          'variable — sweep skipped for all tenants regardless of the ' +
          'per-tenant dailyDigestEnabled flag.',
      );
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

  /**
   * The `DIGEST_CRON_ENABLED` deployment-wide kill switch
   * (`configuration.ts`'s `notifications.digestCronEnabled` — see its
   * docblock for the full tri-state contract), gating the sweep alongside
   * `shouldSweep()`'s role/environment check rather than inside
   * `NotificationsService.tenantsToDigest()` — that method is about *which
   * tenants* to sweep; this is about whether the deployment is armed to
   * sweep *at all*, a question `tenantsToDigest()` has no reason to answer.
   *
   * ASYMMETRIC BY DESIGN, do not "simplify" this into a switch that mirrors
   * the per-tenant flag:
   *   - config value `undefined` (env unset/empty) → armed. Current
   *     behaviour, unchanged — the per-tenant `dailyDigestEnabled` flag
   *     alone decides who gets swept.
   *   - config value `false` (env falsey: false/0/off) → disarmed. The
   *     sweep does not run at all, for any tenant, regardless of what the
   *     database says.
   *   - config value `true` (env truthy: true/1/on) → still armed, but this
   *     does **not** force-enable every tenant. It only means "this
   *     deployment permits the cron to run" — `tenantsToDigest()` still
   *     filters to tenants with `dailyDigestEnabled === true`.
   *
   * A symmetric switch (truthy force-enabling every tenant) would let one
   * process-wide env edit start naming people in Teams channels belonging to
   * tenants who never opted in — exactly the cross-tenant blast radius
   * CLAUDE.md's multi-tenant isolation and ethics-first rules forbid.
   *
   * Does not gate `DigestAdminController`'s manual
   * `POST /admin/notifications/no-commit-digest/run` — that endpoint calls
   * `NotificationsService.runNoCommitDigest()` directly and never passes
   * through this scheduler, deliberately: it is how a human triggers a
   * single deliberate send and how the rollout's dry run is performed
   * (docs/deployment/README.md §6.4), and it must keep working under an
   * env-level disarm — disarming the unattended cron is not the same
   * decision as taking away an admin's ability to run it by hand.
   */
  private envArmed(): boolean {
    const flag = this.config.get<boolean | undefined>(
      'notifications.digestCronEnabled',
    );
    return flag !== false;
  }
}
