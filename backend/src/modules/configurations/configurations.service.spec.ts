import { PrismaService } from '../../database/prisma.service';
import { ConfigurationsService } from './configurations.service';

describe('ConfigurationsService', () => {
  function build() {
    const prisma = {
      tenantConfiguration: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
    } as unknown as PrismaService;
    return { svc: new ConfigurationsService(prisma), prisma };
  }

  it('lists configurations only for the caller tenant', async () => {
    const { svc, prisma } = build();
    (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);

    await svc.listTenantConfigurations('tenant-a');

    expect(
      prisma.tenantConfiguration.findMany as jest.Mock,
    ).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });
  });

  it('upserts a tenant namespace/key configuration', async () => {
    const { svc, prisma } = build();
    (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
      id: 'cfg_1',
    });

    await svc.upsertTenantConfiguration('tenant-a', {
      namespace: 'llm',
      key: 'default',
      values: { provider: 'openai' },
      secretRefs: { apiKeyRef: 'secret://tenant-a/llm' },
      status: 'active',
    });

    expect(prisma.tenantConfiguration.upsert as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_namespace_key: {
            tenantId: 'tenant-a',
            namespace: 'llm',
            key: 'default',
          },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-a',
          namespace: 'llm',
          key: 'default',
          values: { provider: 'openai' },
          secretRefs: { apiKeyRef: 'secret://tenant-a/llm' },
          status: 'active',
        }),
        update: {
          values: { provider: 'openai' },
          secretRefs: { apiKeyRef: 'secret://tenant-a/llm' },
          status: 'active',
        },
      }),
    );
  });

  it('rejects unsupported namespaces', async () => {
    const { svc } = build();

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'unsupported',
        values: {},
      }),
    ).rejects.toThrow('Unsupported configuration namespace.');
  });
});
