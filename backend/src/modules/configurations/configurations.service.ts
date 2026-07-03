import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, TenantConfiguration } from '@prisma/client';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';
import {
  ConfigurationNamespace,
  isConfigurationNamespace,
} from './configuration-catalog';

export interface UpsertTenantConfigurationInput {
  namespace: string;
  key?: string;
  values?: Record<string, unknown>;
  secretRefs?: Record<string, unknown>;
  status?: string;
}

@Injectable()
export class ConfigurationsService {
  constructor(private readonly prisma: PrismaService) {}

  listTenantConfigurations(tenantId: string): Promise<TenantConfiguration[]> {
    return this.prisma.tenantConfiguration.findMany({
      where: { tenantId },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });
  }

  async upsertTenantConfiguration(
    tenantId: string,
    input: UpsertTenantConfigurationInput,
  ): Promise<TenantConfiguration> {
    const namespace = this.validateNamespace(input.namespace);
    const key = input.key?.trim() || 'default';

    return this.prisma.tenantConfiguration.upsert({
      where: { tenantId_namespace_key: { tenantId, namespace, key } },
      create: {
        id: newId(),
        tenantId,
        namespace,
        key,
        values: (input.values ?? {}) as Prisma.InputJsonValue,
        secretRefs: (input.secretRefs ?? {}) as Prisma.InputJsonValue,
        status: input.status ?? 'active',
      },
      update: {
        values: (input.values ?? {}) as Prisma.InputJsonValue,
        secretRefs: (input.secretRefs ?? {}) as Prisma.InputJsonValue,
        status: input.status ?? 'active',
      },
    });
  }

  private validateNamespace(namespace: string): ConfigurationNamespace {
    if (!isConfigurationNamespace(namespace)) {
      throw new BadRequestException('Unsupported configuration namespace.');
    }
    return namespace;
  }
}
