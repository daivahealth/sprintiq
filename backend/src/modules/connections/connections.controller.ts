import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { ConnectionsService } from './connections.service';
import { SourceSystem } from './connection.types';

const SOURCE_SYSTEMS: SourceSystem[] = [
  'jira',
  'github',
  'gitlab',
  'azure-devops',
  'sonarqube',
  'jenkins',
  'github-actions',
];

class CreateConnectionDto {
  @IsIn(SOURCE_SYSTEMS)
  sourceSystem!: SourceSystem;

  @IsString()
  name!: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  secretRef?: string;

  @IsOptional()
  @IsString()
  webhookSecretRef?: string;
}

/**
 * BC-0 connection administration. Admin-only, tenant-scoped: register a source
 * system (credentials/webhook secret by reference) and list the tenant's
 * connections + health.
 */
@Controller('admin/connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Roles(Role.ADMIN)
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConnectionDto,
  ) {
    const conn = await this.connections.create(user.tenantId, dto);
    return this.toView(conn);
  }

  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const conns = await this.connections.listByTenant(user.tenantId);
    return conns.map((c) => this.toView(c));
  }

  // Never expose secret references over the API.
  private toView(c: {
    id: string;
    sourceSystem: string;
    name: string;
    status: string;
    lastSyncAt: Date | null;
    syncLagSeconds: number;
  }) {
    return {
      id: c.id,
      sourceSystem: c.sourceSystem,
      name: c.name,
      status: c.status,
      lastSyncAt: c.lastSyncAt,
      syncLagSeconds: c.syncLagSeconds,
    };
  }
}
