import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  AuthUser,
  TenantContextService,
} from '../tenancy/tenant-context.service';

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
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('auth.jwtSecret') ?? 'change-me-in-prod',
    });
  }

  validate(payload: JwtPayload): AuthUser {
    if (!payload?.tenantId || !payload?.sub) {
      throw new UnauthorizedException('Token missing tenant or subject.');
    }
    const user: AuthUser = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      roles: payload.roles ?? [],
    };
    // Bind tenant for the rest of the request (visible to all async work).
    this.tenantContext.setUser(user);
    return user;
  }
}
