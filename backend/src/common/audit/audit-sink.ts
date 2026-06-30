/**
 * Audit sink contract (BC-16). Defined in common so the global audit interceptor
 * can depend on it without coupling to the audit module's implementation. The
 * AuditModule binds a concrete sink to AUDIT_SINK.
 */
export const AUDIT_SINK = Symbol('AUDIT_SINK');

export interface AuditRecord {
  tenantId?: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}
