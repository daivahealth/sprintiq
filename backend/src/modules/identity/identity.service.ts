import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { verifyPassword } from './password.util';

/** BC-2 user lookups and credential checks. */
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
}
