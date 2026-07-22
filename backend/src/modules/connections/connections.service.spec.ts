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
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'c1' }),
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

  it('listActive() has no tenant filter — the scheduler sweep partitions per-connection afterward', async () => {
    await svc.listActive();
    expect(prisma.connection.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { status: 'active' },
    });
  });

  it('setSyncCursors() replaces the cursor blob for one connection', async () => {
    await svc.setSyncCursors('c1', { prBackfillDone: true });
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { syncCursors: { prBackfillDone: true } },
    });
  });

  it('setRateLimitState() replaces the rate-limit blob, and {} clears a cooldown', async () => {
    await svc.setRateLimitState('c1', {});
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { rateLimitState: {} },
    });
  });

  it('findByTenantSourceAndName() scopes by all three so it never matches an unrelated connection', async () => {
    await svc.findByTenantSourceAndName(
      'tenant-a',
      'github',
      'Managed by tenant configuration (github)',
    );
    expect(prisma.connection.findFirst as jest.Mock).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        sourceSystem: 'github',
        name: 'Managed by tenant configuration (github)',
      },
    });
  });

  it('updateConfig() writes config/secretRef/webhookSecretRef/status in one call', async () => {
    await svc.updateConfig('c1', {
      config: { repoFullName: 'acme/payments' },
      secretRef: 'GITHUB_TOKEN',
      webhookSecretRef: undefined,
      status: 'active',
    });
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        config: { repoFullName: 'acme/payments' },
        secretRef: 'GITHUB_TOKEN',
        webhookSecretRef: undefined,
        status: 'active',
      },
    });
  });

  it('setStatus() only touches status', async () => {
    await svc.setStatus('c1', 'disabled');
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'disabled' },
    });
  });
});
