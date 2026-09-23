import { Module } from '@nestjs/common';
import { CollectorsModule } from '../../collectors/collectors.module';
import { MetricsModule } from '../../metrics/metrics.module';
import { DigestAdminController } from './digest-admin.controller';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationsService } from './notifications.service';

/** BC-15 Notifications & Action (native delivery). */
@Module({
  // MetricsModule: the digest's detection is a metrics read.
  // CollectorsModule: outbound delivery clients live in the Collector context.
  imports: [MetricsModule, CollectorsModule],
  providers: [NotificationsService, NotificationSchedulerService],
  controllers: [DigestAdminController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
