import { TrackedDevelopersController } from './tracked-developers.controller';
import { AuthUser } from '../../common/tenancy/tenant-context.service';

const user: AuthUser = {
  userId: 'user_1',
  tenantId: 'tenant_a',
  email: 'admin@example.com',
  roles: ['admin'],
};

function prismaDouble() {
  return {
    trackedDeveloper: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockImplementation(({ create }) => ({
        canonicalDeveloperId: create.canonicalDeveloperId,
        addedAs: create.addedAs,
        active: true,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('TrackedDevelopersController', () => {
  it('scopes the listing to the caller tenant and only active entries', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.list(user);

    expect(prisma.trackedDeveloper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_a', active: true },
      }),
    );
  });

  it('records who added the entry and keeps the added-as string verbatim', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.upsert(user, 'Adarsh-Naik_athma', {});

    const call = prisma.trackedDeveloper.upsert.mock.calls[0][0];
    expect(call.create.createdByUserId).toBe('user_1');
    expect(call.create.tenantId).toBe('tenant_a');
    expect(call.create.addedAs).toBe('Adarsh-Naik_athma');
    expect(call.where.tenantId_canonicalDeveloperId).toEqual({
      tenantId: 'tenant_a',
      canonicalDeveloperId: 'Adarsh-Naik_athma',
    });
  });

  it('deactivates rather than deletes, so the removal stays on the record', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.remove(user, 'Adarsh-Naik_athma');

    expect(prisma.trackedDeveloper.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_a',
        canonicalDeveloperId: 'Adarsh-Naik_athma',
      },
      data: { active: false },
    });
  });
});
