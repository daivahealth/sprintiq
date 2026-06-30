import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AUDIT_SINK, AuditSink } from '../audit/audit-sink';

/**
 * Records an audit entry for every mutating request (BC-16). Read traffic is
 * sampled out by default; state-changing verbs are always recorded. Secrets and
 * full PII payloads are never written (docs/security/AUTH-AND-RBAC.md §8).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);
  private readonly mutatingMethods = new Set([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ]);

  constructor(
    @Optional() @Inject(AUDIT_SINK) private readonly sink?: AuditSink,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest();
    const shouldAudit = this.mutatingMethods.has(req.method);

    return next.handle().pipe(
      tap(() => {
        if (!shouldAudit) {
          return;
        }
        const entry = {
          tenantId: req.user?.tenantId,
          actorType: 'user' as const,
          actorId: req.user?.userId,
          action: `${req.method} ${req.route?.path ?? req.url}`,
          metadata: { ip: req.ip },
        };
        if (this.sink) {
          void this.sink.record(entry);
        } else {
          this.logger.debug(
            `audit: ${entry.action} (tenant=${entry.tenantId ?? '-'})`,
          );
        }
      }),
    );
  }
}
