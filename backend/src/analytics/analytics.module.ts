import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/** BC-10 Analytics & Insight. */
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
