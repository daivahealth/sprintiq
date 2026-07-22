import { Injectable } from '@nestjs/common';
import { Connection, Prisma } from '@prisma/client';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';
import { SourceSystem } from './connection.types';

export interface CreateConnectionInput {
  sourceSystem: SourceSystem;
  name: string;
  config?: Record<string, unknown>;
  secretRef?: string;
  webhookSecretRef?: string;
}

/**
 * BC-0 registry of source connections + health. Collectors resolve which tenant
 * a webhook/poll belongs to via this registry and read credentials/cursors here.
 */
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Connection | null> {
    return this.prisma.connection.findUnique({ where: { id } });
  }

  create(tenantId: string, input: CreateConnectionInput): Promise<Connection> {
    return this.prisma.connection.create({
      data: {
        id: newId(),
        tenantId,
        sourceSystem: input.sourceSystem,
        name: input.name,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        secretRef: input.secretRef,
        webhookSecretRef: input.webhookSecretRef,
        syncCursors: {},
        rateLimitState: {},
        status: 'active',
      },
    });
  }

  listByTenant(tenantId: string): Promise<Connection[]> {
    return this.prisma.connection.findMany({ where: { tenantId } });
  }

  findActiveBySource(source: SourceSystem): Promise<Connection[]> {
    return this.prisma.connection.findMany({
      where: { sourceSystem: source, status: 'active' },
    });
  }

  /**
   * Looks up a connection by its distinguishing `name` within one tenant+source
   * — used by callers (e.g. the admin Configuration screen bridge) that own a
   * single well-known connection per namespace and must not collide with other
   * independently-registered connections for the same source system.
   */
  findByTenantSourceAndName(
    tenantId: string,
    sourceSystem: string,
    name: string,
  ): Promise<Connection | null> {
    return this.prisma.connection.findFirst({
      where: { tenantId, sourceSystem, name },
    });
  }

  /**
   * All active connections across every tenant — used only by the scheduled
   * sync sweep (BC-1), which then partitions all downstream work by each
   * connection's own tenantId. Never used to serve tenant-facing data.
   */
  listActive(): Promise<Connection[]> {
    return this.prisma.connection.findMany({ where: { status: 'active' } });
  }

  async touchSync(id: string, lagSeconds = 0): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { lastSyncAt: new Date(), syncLagSeconds: lagSeconds },
    });
  }

  /** Replaces the connection's cursor state — the collector owns cursor shape/keys. */
  async setSyncCursors(
    id: string,
    cursors: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { syncCursors: cursors as Prisma.InputJsonValue },
    });
  }

  /** Replaces the connection's rate-limit state; `{}` clears an expired cooldown. */
  async setRateLimitState(
    id: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { rateLimitState: state as Prisma.InputJsonValue },
    });
  }

  /** Updates the connection's identity/credentials (config, secret refs, status) in one write. */
  async updateConfig(
    id: string,
    input: {
      config: Record<string, unknown>;
      secretRef?: string;
      webhookSecretRef?: string;
      status: string;
    },
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: {
        config: input.config as Prisma.InputJsonValue,
        secretRef: input.secretRef,
        webhookSecretRef: input.webhookSecretRef,
        status: input.status,
      },
    });
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.prisma.connection.update({ where: { id }, data: { status } });
  }
}
