import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { ConnectionsService } from './connections.service';
import { SourceSystem } from './connection.types';

/**
 * How often the sweep's due-check fires (`CollectorSchedulerService`'s crons).
 * Reported to the caller so "sync now" states its own bound instead of
 * implying an instant sync it does not perform.
 */
const SWEEP_TICK_SECONDS = 5 * 60;

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
  constructor(
    private readonly connections: ConnectionsService,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

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

  /**
   * Data transfer/backfill progress + live scheduler tick state for the Sync
   * Status screen: how much has been migrated from each source and over
   * what date range, whether a sweep is running right now with a rough ETA,
   * and the history of repos/sites whose backfill has completed.
   */
  @Roles(Role.ADMIN)
  @Get('sync-status')
  async syncStatus(@CurrentUser() user: AuthUser) {
    return this.connections.getSyncStatus(user.tenantId);
  }

  /**
   * Queues this connection for the next sweep, ahead of the regular queue and
   * regardless of its configured interval.
   *
   * Why this exists: every other way to make a connection due is a side effect
   * of changing something. An admin who has just fixed a token, or who needs
   * today's data in before a stand-up, otherwise waits out the interval — up
   * to 4 hours by default — with no way to say "now".
   *
   * Deliberately queues rather than syncing inline: a sync is a paginated,
   * rate-limited walk that can take minutes, and the sweep already serialises
   * per source so two passes can't fight over the same rate limit. The
   * response says when it will actually run.
   */
  @Roles(Role.ADMIN)
  @Post(':id/sync-now')
  async syncNow(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const connection = await this.connections.findById(id);
    // Tenant-scoped by hand: the id comes from the URL, so without this check
    // an admin could queue a sync on another tenant's connection.
    if (!connection || connection.tenantId !== user.tenantId) {
      throw new NotFoundException('No such connection.');
    }
    if (connection.status !== 'active') {
      throw new BadRequestException(
        'This connection is disabled — enable it in Configuration before syncing.',
      );
    }

    await this.connections.requestSync(id);
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'connection.sync_requested',
      targetType: 'connection',
      targetId: id,
      metadata: {
        sourceSystem: connection.sourceSystem,
        name: connection.name,
      },
    });

    return {
      queued: true,
      connectionId: id,
      sourceSystem: connection.sourceSystem,
      // The sweep's due-check cadence, not the sync interval — this is the
      // outer bound on how long the request waits before it starts.
      startsWithinSeconds: SWEEP_TICK_SECONDS,
    };
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
