import { Module } from '@nestjs/common';
import { CollectorsModule } from '../../collectors/collectors.module';
import { MetricsModule } from '../../metrics/metrics.module';
import { NotificationsService } from './notifications.service';

/** BC-15 Notifications & Action (native delivery). */
@Module({
  // MetricsModule: the digest's detection is a metrics read.
  // CollectorsModule: outbound delivery clients live in the Collector context.
  imports: [MetricsModule, CollectorsModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
