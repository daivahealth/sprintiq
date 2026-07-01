import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from './connections.service';

/**
 * Tenant-isolation contract for BC-0. Uses a mock Prisma client to assert that
 * every read/write is scoped by tenantId — the enforcement the platform depends
 * on (docs/security/AUTH-AND-RBAC.md §4, ADR-0005).
 */
describe('ConnectionsService (tenant isolation)', () => {
  const prisma = {
    connection: {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;

  const svc = new ConnectionsService(prisma);

  afterEach(() => jest.clearAllMocks());

  it('create() persists with the caller tenantId', async () => {
    await svc.create('tenant-a', { sourceSystem: 'github', name: 'acme' });
    expect(prisma.connection.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          sourceSystem: 'github',
          status: 'active',
        }),
      }),
    );
  });

  it('listByTenant() filters by tenantId only', async () => {
    await svc.listByTenant('tenant-a');
    expect(prisma.connection.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
    });
  });
});
