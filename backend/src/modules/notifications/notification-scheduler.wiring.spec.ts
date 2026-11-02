import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationsService } from './notifications.service';

/**
 * The scheduler through the real `@nestjs/schedule` machinery, not just its
 * decorator metadata: the job the module actually registers, when it will
 * next fire, and what a fire does. The unit spec proves the method's logic;
 * this proves the method is what runs at 09:30 IST on a weekday, whatever
 * timezone the host process is in (run it with TZ=UTC to see that).
 */
describe('NotificationSchedulerService wiring', () => {
  async function boot(config: Record<string, unknown>) {
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
      runNoCommitDigest: jest.fn().mockResolvedValue({
        reportedDay: '2026-10-29',
        outcome: 'sent',
        flagged: [],
      }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        NotificationSchedulerService,
        { provide: NotificationsService, useValue: notifications },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {} })
      .compile();
    await moduleRef.init();
    const jobs = [...moduleRef.get(SchedulerRegistry).getCronJobs().values()];
    return { moduleRef, jobs, notifications };
  }

  it('registers exactly one job, and every next fire is 09:30 IST on a weekday', async () => {
    const { moduleRef, jobs } = await boot({ env: 'development' });
    try {
      expect(jobs).toHaveLength(1);
      // cron's own luxon DateTimes, re-zoned to IST for the assertions.
      const fires = jobs[0].nextDates(10).map((d) => d.setZone('Asia/Kolkata'));
      for (const fire of fires) {
        expect(fire.hour).toBe(9);
        expect(fire.minute).toBe(30);
        expect(fire.weekday).toBeLessThanOrEqual(5); // luxon: 1 = Mon … 7 = Sun
      }
      // Ten consecutive fires cover two full weeks: Mon–Fri twice, no gaps.
      expect(new Set(fires.map((f) => f.weekday))).toEqual(
        new Set([1, 2, 3, 4, 5]),
      );
      // 09:30 IST is 04:00 UTC, the same instant on any host timezone.
      expect(fires[0].toUTC().toFormat('HH:mm')).toBe('04:00');
    } finally {
      await moduleRef.close();
    }
  });

  it.each([
    [
      'a single dev-style host process (NODE_ENV=development, APP_ROLE=api)',
      'development',
      'api',
    ],
    [
      'a production worker (NODE_ENV=production, APP_ROLE=worker)',
      'production',
      'worker',
    ],
  ])('a fire on %s sends as a cron run', async (_label, env, appRole) => {
    const { moduleRef, jobs, notifications } = await boot({ env, appRole });
    try {
      await jobs[0].fireOnTick();
      await new Promise((resolve) => setImmediate(resolve));
      expect(notifications.runNoCommitDigest).toHaveBeenCalledWith('tenant_a', {
        trigger: 'cron',
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('a fire on a production api process sends nothing', async () => {
    const { moduleRef, jobs, notifications } = await boot({
      env: 'production',
      appRole: 'api',
    });
    try {
      await jobs[0].fireOnTick();
      await new Promise((resolve) => setImmediate(resolve));
      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
      expect(notifications.runNoCommitDigest).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });
});
