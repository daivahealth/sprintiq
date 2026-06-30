import { Module } from '@nestjs/common';
import { QualityService } from './quality.service';

/** BC-7 Quality & Security. */
@Module({
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
