import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/** BC-15 Notifications & Action (native delivery). */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
