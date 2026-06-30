import { Column, Entity, Index } from 'typeorm';
import { TenantScopedEntity } from '../../../database/base.entity';
import { Schema } from '../../../database/schemas';

export type SourceSystem =
  | 'jira'
  | 'github'
  | 'gitlab'
  | 'azure-devops'
  | 'sonarqube'
  | 'jenkins'
  | 'github-actions';

/**
 * A connected source system per tenant (BC-0). One per Jira instance / GitHub
 * org / etc. Holds collector credentials, webhook secret, and poll cursors —
 * all secrets stored by reference (vault/KMS), never plaintext (ADR-0004,
 * docs/security/AUTH-AND-RBAC.md §7).
 */
@Entity({ schema: Schema.CONNECTIONS, name: 'connection' })
@Index(['tenantId', 'sourceSystem'])
export class Connection extends TenantScopedEntity {
  @Column('varchar')
  sourceSystem!: SourceSystem;

  @Column('varchar')
  name!: string;

  @Column('jsonb', { default: {} })
  config!: Record<string, unknown>;

  /** Reference to the source credential (OAuth/app-install/PAT) in the secret store. */
  @Column('varchar', { nullable: true })
  secretRef?: string;

  /** Reference to the webhook signing secret in the secret store. */
  @Column('varchar', { nullable: true })
  webhookSecretRef?: string;

  /** Per-entity incremental-sync cursors, e.g. { issues: '2026-06-30T..' }. */
  @Column('jsonb', { default: {} })
  syncCursors!: Record<string, string>;

  @Column('jsonb', { default: {} })
  rateLimitState!: Record<string, unknown>;

  @Column('varchar', { default: 'pending' })
  status!: 'pending' | 'active' | 'error' | 'disabled';

  @Column('timestamptz', { nullable: true })
  lastSyncAt?: Date;

  @Column('int', { default: 0 })
  syncLagSeconds!: number;
}
