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

  async touchSync(id: string, lagSeconds = 0): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { lastSyncAt: new Date(), syncLagSeconds: lagSeconds },
    });
  }

  async updateCursor(id: string, key: string, value: string): Promise<void> {
    const conn = await this.findById(id);
    if (!conn) {
      return;
    }
    const cursors = {
      ...(conn.syncCursors as Record<string, string>),
      [key]: value,
    };
    await this.prisma.connection.update({
      where: { id },
      data: { syncCursors: cursors },
    });
  }
}
