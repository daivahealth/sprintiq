import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  AuthUser,
  TenantContextService,
} from '../tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';

export interface JwtPayload {
  sub: string; // user id
  tenantId: string;
  email: string;
  roles: string[];
}

/**
 * Application-plane authentication. On every authenticated request, resolves the
 * tenant from the token and populates the tenant context so downstream services
 * are correctly scoped (ADR-0004).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('auth.jwtSecret') ?? 'change-me-in-prod',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload?.tenantId || !payload?.sub) {
      throw new UnauthorizedException('Token missing tenant or subject.');
    }
    const currentUser = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        tenantId: payload.tenantId,
        status: 'active',
      },
    });
    if (!currentUser) {
      throw new UnauthorizedException('User is not active in this tenant.');
    }
    const user: AuthUser = {
      userId: currentUser.id,
      tenantId: currentUser.tenantId,
      email: currentUser.email,
      roles: currentUser.roles,
    };
    // Bind tenant for the rest of the request (visible to all async work).
    this.tenantContext.setUser(user);
    return user;
  }
}
