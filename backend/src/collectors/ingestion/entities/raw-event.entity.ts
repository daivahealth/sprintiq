import { Column, Entity, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from '../../../database/base.entity';
import { Schema } from '../../../database/schemas';
import { CollectionMode } from '../canonical-envelope';

export type ProcessingStatus =
  'received' | 'normalized' | 'correlated' | 'failed';

/**
 * Append-only, replayable raw-event store (BC-1). The unique (tenant_id,
 * idempotency_key) constraint enforces effectively-once persistence across
 * webhooks and pollers. `envelope` keeps the full canonical payload so the
 * delivery graph / metrics can be recomputed without re-fetching from sources
 * (lineage — DATA-MODEL §2).
 */
@Entity({ schema: Schema.COLLECTORS, name: 'raw_event' })
@Unique(['tenantId', 'idempotencyKey'])
@Index(['tenantId', 'processingStatus'])
export class RawEvent extends TenantScopedEntity {
  @Column('varchar')
  connectionId!: string;

  @Column('varchar')
  sourceSystem!: string;

  @Column('varchar')
  collectionMode!: CollectionMode;

  @Column('varchar')
  eventType!: string;

  @Column('varchar')
  idempotencyKey!: string;

  @Column('timestamptz')
  occurredAt!: Date;

  @Column('timestamptz')
  collectedAt!: Date;

  @Column('jsonb')
  envelope!: Record<string, unknown>;

  @Column('varchar', { default: 'received' })
  processingStatus!: ProcessingStatus;

  @Column('timestamptz', { nullable: true })
  processedAt?: Date;
}
