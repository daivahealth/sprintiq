import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ulid } from 'ulid';

/**
 * Base for every tenant-scoped domain entity. Internal id is a ULID (string,
 * time-sortable); `tenantId` is mandatory and indexed-first so all access is
 * tenant-scoped (ADR-0004). External source IDs are separate VARCHAR columns on
 * the concrete entities — never the primary key.
 */
export abstract class TenantScopedEntity {
  @PrimaryColumn('varchar', { length: 26 })
  id!: string;

  @Index()
  @Column('varchar')
  tenantId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @BeforeInsert()
  protected assignId(): void {
    if (!this.id) {
      this.id = ulid();
    }
  }
}
