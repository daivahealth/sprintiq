import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../../common/auth/jwt.strategy';
import { Public } from '../../common/auth/public.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { IdentityService } from './identity.service';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

/**
 * Application-plane auth (BC-2). Login is email + password only — the tenant is
 * resolved from the user and carried in the signed JWT (never a client header),
 * so every request is scoped to exactly one tenant (ADR-0006).
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const user = await this.identity.validateCredentials(
      dto.email,
      dto.password,
    );
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const tenant = await this.identity.getTenant(user.tenantId);
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, roles: user.roles },
      tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
    };
  }

  /** Current identity + active tenant (used by the SPA on load to validate the token). */
  @Get('me')
  async me(@CurrentUser() current: AuthUser) {
    const [user, tenant] = await Promise.all([
      this.identity.getUserById(current.userId),
      this.identity.getTenant(current.tenantId),
    ]);
    if (!user) {
      throw new UnauthorizedException();
    }
    return {
      user: { id: user.id, email: user.email, roles: user.roles },
      tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
    };
  }
}
