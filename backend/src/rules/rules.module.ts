import { Module } from '@nestjs/common';
import { RulesService } from './rules.service';

/** BC-9 Rule & Risk Engine. */
@Module({
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
