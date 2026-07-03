import { PrismaService } from '../../database/prisma.service';
import { IdentityService } from './identity.service';
import { hashPassword } from './password.util';

/**
 * BC-2: login resolves the tenant from the user via a global-unique email
 * (ADR-0006). Uses a mock Prisma client — no database needed.
 */
describe('IdentityService', () => {
  function build(user: unknown) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as PrismaService;
    return { svc: new IdentityService(prisma), prisma };
  }

  it('looks up a user by email alone (no tenant needed)', async () => {
    const { svc, prisma } = build(null);
    await svc.findByEmail('a@b.com');
    expect(prisma.user.findUnique as jest.Mock).toHaveBeenCalledWith({
      where: { email: 'a@b.com' },
    });
  });

  it('validates credentials and returns the user (carrying its tenantId)', async () => {
    const passwordHash = await hashPassword('password123');
    const { svc } = build({
      id: 'u1',
      tenantId: 'tenant-a',
      email: 'a@b.com',
      passwordHash,
      status: 'active',
      roles: ['developer'],
    });
    const user = await svc.validateCredentials('a@b.com', 'password123');
    expect(user?.tenantId).toBe('tenant-a');
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await hashPassword('password123');
    const { svc } = build({
      id: 'u1',
      tenantId: 'tenant-a',
      email: 'a@b.com',
      passwordHash,
      status: 'active',
      roles: [],
    });
    expect(await svc.validateCredentials('a@b.com', 'wrong-pass')).toBeNull();
  });

  it('rejects an unknown email', async () => {
    const { svc } = build(null);
    expect(
      await svc.validateCredentials('nope@b.com', 'password123'),
    ).toBeNull();
  });

  it('lists only users in the caller tenant', async () => {
    const { svc, prisma } = build(null);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

    await svc.listTenantUsers('tenant-a');

    expect(prisma.user.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
      orderBy: { email: 'asc' },
    });
  });

  it('updates roles only after finding the user in the caller tenant', async () => {
    const { svc, prisma } = build(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenantId: 'tenant-a',
      roles: ['developer'],
    });
    (prisma.user.update as jest.Mock).mockResolvedValue({
      id: 'u1',
      roles: ['developer', 'team_lead'],
    });

    await svc.updateUserRoles('tenant-a', 'u1', ['developer', 'team_lead']);

    expect(prisma.user.findFirst as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'u1', tenantId: 'tenant-a' },
    });
    expect(prisma.user.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { roles: ['developer', 'team_lead'] },
    });
  });

  it('does not remove the last tenant admin', async () => {
    const { svc, prisma } = build(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenantId: 'tenant-a',
      status: 'active',
      roles: ['admin'],
    });
    (prisma.user.count as jest.Mock).mockResolvedValue(1);

    await expect(
      svc.updateUserRoles('tenant-a', 'u1', ['developer']),
    ).rejects.toThrow('At least one active tenant admin must remain.');
    expect(prisma.user.count as jest.Mock).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        status: 'active',
        roles: { has: 'admin' },
      },
    });
    expect(prisma.user.update as jest.Mock).not.toHaveBeenCalled();
  });
});
