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

/** Empty index by default: every roster entry is unresolved unless a test says otherwise. */
function identitiesDouble(displayNames: [string, string][] = []) {
  return {
    attributionIndex: jest.fn().mockResolvedValue({
      byLogin: new Map(),
      byEmail: new Map(),
      displayNames: new Map(displayNames),
      excluded: new Set(),
    }),
  };
}

describe('TrackedDevelopersController', () => {
  it('scopes the listing to the caller tenant and only active entries', async () => {
    const prisma = prismaDouble();
    const identities = identitiesDouble();
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    await controller.list(user);

    expect(prisma.trackedDeveloper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_a', active: true },
      }),
    );
  });

  it('records who added the entry and keeps the added-as string verbatim', async () => {
    const prisma = prismaDouble();
    const identities = identitiesDouble();
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

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
    const identities = identitiesDouble();
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    await controller.remove(user, 'Adarsh-Naik_athma');

    expect(prisma.trackedDeveloper.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_a',
        canonicalDeveloperId: 'Adarsh-Naik_athma',
      },
      data: { active: false },
    });
  });

  it('reactivates a developer who was previously removed from the roster', async () => {
    // Guard: if update loses active: true, a removed developer can never be
    // re-added. The upsert's update branch must explicitly flip active back.
    const prisma = {
      trackedDeveloper: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const identities = identitiesDouble();
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    await controller.upsert(user, 'Adarsh-Naik_athma', {
      note: 'returned from leave',
    });

    const call = prisma.trackedDeveloper.upsert.mock.calls[0][0];
    expect(call.update).toEqual({
      active: true,
      note: 'returned from leave',
    });
  });

  it('marks a roster entry resolved and uses the index display name, when its id is a key of the attribution index', async () => {
    const prisma = prismaDouble();
    prisma.trackedDeveloper.findMany.mockResolvedValue([
      {
        canonicalDeveloperId: 'Adarsh-Naik_athma',
        addedAs: 'adarsh',
        note: null,
        createdByUserId: 'user_1',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    const identities = identitiesDouble([['Adarsh-Naik_athma', 'Adarsh Naik']]);
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    const result = await controller.list(user);

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        developer: 'Adarsh-Naik_athma',
        displayName: 'Adarsh Naik',
        resolved: true,
      }),
    );
  });

  it('marks a roster entry unresolved and falls back to the canonical id, when its id is not a key of the attribution index', async () => {
    const prisma = prismaDouble();
    prisma.trackedDeveloper.findMany.mockResolvedValue([
      {
        canonicalDeveloperId: 'ghost-login',
        addedAs: 'ghost-login',
        note: null,
        createdByUserId: 'user_1',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    // Index knows someone else, but not this roster entry.
    const identities = identitiesDouble([['Adarsh-Naik_athma', 'Adarsh Naik']]);
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    const result = await controller.list(user);

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        developer: 'ghost-login',
        displayName: 'ghost-login',
        resolved: false,
      }),
    );
  });

  it('calls attributionIndex with the same tenant the roster query is scoped to', async () => {
    const prisma = prismaDouble();
    const identities = identitiesDouble();
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    await controller.list(user);

    expect(identities.attributionIndex).toHaveBeenCalledWith('tenant_a');
  });

  it('keeps ordering and the existing stored fields unchanged when enriching', async () => {
    const prisma = prismaDouble();
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    prisma.trackedDeveloper.findMany.mockResolvedValue([
      {
        canonicalDeveloperId: 'Adarsh-Naik_athma',
        addedAs: 'adarsh',
        note: 'note here',
        createdByUserId: 'user_1',
        createdAt,
      },
    ]);
    const identities = identitiesDouble([['Adarsh-Naik_athma', 'Adarsh Naik']]);
    const controller = new TrackedDevelopersController(
      prisma as never,
      identities as never,
    );

    const result = await controller.list(user);

    expect(prisma.trackedDeveloper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { canonicalDeveloperId: 'asc' },
      }),
    );
    expect(result.items[0]).toEqual({
      developer: 'Adarsh-Naik_athma',
      addedAs: 'adarsh',
      note: 'note here',
      createdByUserId: 'user_1',
      createdAt: createdAt.toISOString(),
      displayName: 'Adarsh Naik',
      resolved: true,
    });
    expect(result.count).toBe(1);
  });
});
