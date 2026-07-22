import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';

/** Global so any context can resolve a tenant secret without re-importing (matches CommonModule pattern). */
@Global()
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
