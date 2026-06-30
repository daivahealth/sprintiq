import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ulid } from 'ulid';
import { Schema } from '../../../database/schemas';

/**
 * The top tenancy boundary (BC-2). Not itself tenant-scoped — it *is* the tenant.
 */
@Entity({ schema: Schema.IDENTITY, name: 'tenant' })
export class Tenant {
  @PrimaryColumn('varchar', { length: 26 })
  id!: string;

  @Column('varchar')
  name!: string;

  @Column('varchar', { default: 'trial' })
  plan!: string;

  @Column('varchar', { nullable: true })
  region?: string;

  @Column('varchar', { default: 'active' })
  status!: string;

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
