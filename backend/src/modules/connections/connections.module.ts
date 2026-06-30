import { Module } from '@nestjs/common';
import { ConnectionsService } from './connections.service';

/** BC-0 Source-System Registry & Connection Health. */
@Module({
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
