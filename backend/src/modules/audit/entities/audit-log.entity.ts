import { Column, Entity, Index } from 'typeorm';
import { TenantScopedEntity } from '../../../database/base.entity';
import { Schema } from '../../../database/schemas';

/**
 * Append-only audit trail of user, agent, and system actions (BC-16).
 * Secrets and full PII payloads are never written here.
 */
@Entity({ schema: Schema.AUDIT, name: 'audit_log' })
@Index(['tenantId', 'createdAt'])
export class AuditLog extends TenantScopedEntity {
  @Column('varchar')
  actorType!: 'user' | 'agent' | 'system';

  @Column('varchar', { nullable: true })
  actorId?: string;

  @Column('varchar')
  action!: string;

  @Column('varchar', { nullable: true })
  targetType?: string;

  @Column('varchar', { nullable: true })
  targetId?: string;

  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>;
}
