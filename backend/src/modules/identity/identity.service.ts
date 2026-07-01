import { ConflictException, Injectable } from '@nestjs/common';
import { Tenant, User } from '@prisma/client';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';
import { hashPassword, verifyPassword } from './password.util';

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  roles?: string[];
}

/** BC-2 identity: tenant/user provisioning, lookups, and credential checks. */
@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(tenantId: string, email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { tenantId, email } });
  }

  async validateCredentials(
    tenantId: string,
    email: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.findByEmail(tenantId, email);
    if (!user || !user.passwordHash || user.status !== 'active') {
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user : null;
  }

  /** Bootstrap a tenant together with its first admin user. */
  async createTenantWithAdmin(input: {
    name: string;
    adminEmail: string;
    adminPassword: string;
    adminName: string;
  }): Promise<{ tenant: Tenant; admin: User }> {
    const tenant = await this.prisma.tenant.create({
      data: { id: newId(), name: input.name },
    });
    const admin = await this.createUser(tenant.id, {
      email: input.adminEmail,
      password: input.adminPassword,
      displayName: input.adminName,
      roles: ['admin'],
    });
    return { tenant, admin };
  }

  async createUser(tenantId: string, input: CreateUserInput): Promise<User> {
    const existing = await this.findByEmail(tenantId, input.email);
    if (existing) {
      throw new ConflictException('A user with that email already exists.');
    }
    return this.prisma.user.create({
      data: {
        id: newId(),
        tenantId,
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        roles: input.roles ?? ['developer'],
      },
    });
  }
}
