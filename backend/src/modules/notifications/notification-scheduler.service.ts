import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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
 * This class holds no logic deliberately — it decides only *when*.
 */
@Injectable()
export class NotificationSchedulerService {
  private readonly logger = new Logger(NotificationSchedulerService.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Cron('30 10 * * 1-5', { timeZone: IST_TIMEZONE })
  async sendDailyDigest(): Promise<void> {
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
}
