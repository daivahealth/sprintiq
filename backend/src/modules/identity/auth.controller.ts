import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { JwtPayload } from '../../common/auth/jwt.strategy';
import { Public } from '../../common/auth/public.decorator';
import { IdentityService } from './identity.service';

class LoginDto {
  @IsString()
  tenantId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

/** Application-plane login (BC-2). Issues a tenant-scoped JWT. */
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
      dto.tenantId,
      dto.email,
      dto.password,
    );
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, roles: user.roles },
    };
  }
}
