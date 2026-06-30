import { Module } from '@nestjs/common';
import { CodeService } from './code.service';

/** BC-4 Source Control & Code Delivery (Git domain). */
@Module({
  providers: [CodeService],
  exports: [CodeService],
})
export class CodeModule {}
