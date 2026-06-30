import { Global, Module } from '@nestjs/common';
import { AUDIT_SINK } from '../../common/audit/audit-sink';
import { AuditService } from './audit.service';

/**
 * BC-16 Audit. Global so the cross-cutting AuditInterceptor (in CommonModule)
 * can resolve AUDIT_SINK app-wide without import cycles.
 */
@Global()
@Module({
  providers: [AuditService, { provide: AUDIT_SINK, useExisting: AuditService }],
  exports: [AUDIT_SINK, AuditService],
})
export class AuditModule {}
