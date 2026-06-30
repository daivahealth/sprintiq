import { Module } from '@nestjs/common';
import { CodeModule } from '../modules/code/code.module';
import { MetricsService } from './metrics.service';

/** BC-8 Metrics & Aggregation Engine. */
@Module({
  imports: [CodeModule],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
