import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Public } from '../../common/auth/public.decorator';
import { ProvisioningGuard } from '../../common/auth/provisioning.guard';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { IdentityService } from './identity.service';

const ROLE_VALUES = Object.values(Role);

class CreateTenantDto {
  @IsString()
  name!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;

  @IsString()
  adminName!: string;
}

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  displayName!: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ROLE_VALUES, { each: true })
  roles?: string[];
}

/**
 * BC-2 administration. Tenant provisioning is bootstrap-token guarded (no tenant
 * exists yet); user creation is JWT + admin-role guarded and tenant-scoped.
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @UseGuards(ProvisioningGuard)
  @Post('tenants')
  async createTenant(@Body() dto: CreateTenantDto) {
    const { tenant, admin } = await this.identity.createTenantWithAdmin(dto);
    return {
      tenant: { id: tenant.id, name: tenant.name },
      admin: { id: admin.id, email: admin.email, roles: admin.roles },
    };
  }

  @Roles(Role.ADMIN)
  @Post('users')
  async createUser(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    const created = await this.identity.createUser(user.tenantId, dto);
    return {
      id: created.id,
      email: created.email,
      displayName: created.displayName,
      roles: created.roles,
    };
  }
}
