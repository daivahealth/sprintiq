import { Column, Entity, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from '../../../database/base.entity';
import { Schema } from '../../../database/schemas';

/**
 * A platform user — a person who logs in (BC-2). Roles are stored on the user
 * for the scaffold; a richer role/permission model can be introduced later.
 */
@Entity({ schema: Schema.IDENTITY, name: 'user' })
@Unique(['tenantId', 'email'])
@Index(['tenantId'])
export class User extends TenantScopedEntity {
  @Column('varchar')
  email!: string;

  @Column('varchar')
  displayName!: string;

  /** Null for SSO-only users. */
  @Column('varchar', { nullable: true })
  passwordHash?: string;

  /** Subject from the SSO IdP, when applicable. */
  @Column('varchar', { nullable: true })
  ssoSubject?: string;

  @Column('text', { array: true, default: '{}' })
  roles!: string[];

  @Column('varchar', { default: 'active' })
  status!: string;
}
