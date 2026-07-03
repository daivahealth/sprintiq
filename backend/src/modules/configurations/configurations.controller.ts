import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_NAMESPACES,
} from './configuration-catalog';
import { ConfigurationsService } from './configurations.service';

class UpsertConfigurationDto {
  @IsIn(CONFIGURATION_NAMESPACES)
  namespace!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secretRefs?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;
}

@Controller('admin/configurations')
export class ConfigurationsController {
  constructor(private readonly configurations: ConfigurationsService) {}

  @Roles(Role.ADMIN)
  @Get('catalog')
  catalog() {
    return { sections: CONFIGURATION_CATALOG };
  }

  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const configs = await this.configurations.listTenantConfigurations(
      user.tenantId,
    );
    return { configurations: configs.map((config) => this.toView(config)) };
  }

  @Roles(Role.ADMIN)
  @Put()
  async upsert(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertConfigurationDto,
  ) {
    const config = await this.configurations.upsertTenantConfiguration(
      user.tenantId,
      dto,
    );
    return this.toView(config);
  }

  private toView(config: {
    id: string;
    namespace: string;
    key: string;
    values: unknown;
    secretRefs: unknown;
    status: string;
    updatedAt: Date;
  }) {
    return {
      id: config.id,
      namespace: config.namespace,
      key: config.key,
      values: config.values,
      secretRefs: config.secretRefs,
      status: config.status,
      updatedAt: config.updatedAt,
    };
  }
}
