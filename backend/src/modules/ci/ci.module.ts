import { Module } from '@nestjs/common';
import { CiService } from './ci.service';

/** BC-6 Build, Release & CI/CD. */
@Module({
  providers: [CiService],
  exports: [CiService],
})
export class CiModule {}
