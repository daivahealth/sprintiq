import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditRecord, AuditSink } from '../../common/audit/audit-sink';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';

/** Concrete audit sink (BC-16): persists the append-only audit trail. */
@Injectable()
export class AuditService implements AuditSink {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          id: newId(),
          tenantId: entry.tenantId,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: (entry.metadata ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      // Auditing must never break the request path; failures are logged.
      this.logger.error(
        `Failed to persist audit record: ${(err as Error).message}`,
      );
    }
  }
}
