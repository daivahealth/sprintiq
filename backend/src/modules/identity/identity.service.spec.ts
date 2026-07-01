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
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as unknown as PrismaService;
    return { svc: new IdentityService(prisma), prisma };
  }

  it('looks up a user by email alone (no tenant needed)', async () => {
    const { svc, prisma } = build(null);
    await svc.findByEmail('a@b.com');
    expect((prisma.user.findUnique as jest.Mock)).toHaveBeenCalledWith({
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
    expect(await svc.validateCredentials('nope@b.com', 'password123')).toBeNull();
  });
});
