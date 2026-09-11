import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import { ReleasePlanController } from './release-plan.controller';

/**
 * Task 11: the planned release date is the one write in an otherwise
 * read-only feature. Jira overwrites its own `releaseDate` with the release
 * day the moment a version ships, so by the time "planned vs actual" is worth
 * asking, Jira's plan is gone. These pin the three things that make this
 * write safe: it can only ever land on the caller's own tenant's release
 * (findFirst-then-update, not a bare keyed update), a date that cannot parse
 * or drifts implausibly far from the release is rejected before any write,
 * and clearing removes the date and its provenance together.
 */
describe('ReleasePlanController', () => {
  function setup(
    release: Record<string, unknown> | null = {
      id: 'r1',
      tenantId: 't1',
      projectKey: 'ACT',
      name: 'RC1',
      releaseDate: new Date('2026-08-25'),
      startAt: null,
    },
  ) {
    const prisma = {
      release: {
        findFirst: jest.fn().mockResolvedValue(release),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    return {
      controller: new ReleasePlanController(prisma as unknown as PrismaService),
      prisma,
    };
  }

  let controller: ReleasePlanController;
  let prisma: ReturnType<typeof setup>['prisma'];

  beforeEach(() => {
    ({ controller, prisma } = setup());
  });

  it('records the planned date with the user who entered it', async () => {
    await controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
      projectKey: 'ACT',
      name: 'RC1',
      plannedReleaseAt: '2026-08-20',
    });

    const arg = prisma.release.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({
      plannedReleaseAt: new Date('2026-08-20'),
      plannedSetByUserId: 'u1',
    });
  });

  it('rejects a release that belongs to another tenant', async () => {
    prisma.release.findFirst.mockResolvedValue(null);
    await expect(
      controller.set({ tenantId: 't2', userId: 'u9' } as AuthUser, {
        projectKey: 'ACT',
        name: 'RC1',
        plannedReleaseAt: '2026-08-20',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.release.update).not.toHaveBeenCalled();
  });

  it('scopes the lookup by tenant', async () => {
    await controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
      projectKey: 'ACT',
      name: 'RC1',
      plannedReleaseAt: '2026-08-20',
    });
    expect(prisma.release.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't1' }),
      }),
    );
  });

  it('rejects an unparseable date', async () => {
    await expect(
      controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
        projectKey: 'ACT',
        name: 'RC1',
        plannedReleaseAt: 'soon',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // A plan years away from the release it describes produces a lateness figure
  // in the hundreds of days on a board people act on.
  it('rejects a planned date more than a year from the release own dates', async () => {
    await expect(
      controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
        projectKey: 'ACT',
        name: 'RC1',
        plannedReleaseAt: '2029-01-01',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('clears the planned date and its provenance together', async () => {
    await controller.clear(
      { tenantId: 't1', userId: 'u1' } as AuthUser,
      'ACT',
      'RC1',
    );
    const arg = prisma.release.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toEqual({
      plannedReleaseAt: null,
      plannedSetByUserId: null,
      plannedSetAt: null,
    });
  });

  it('rejects clearing a release that belongs to another tenant', async () => {
    prisma.release.findFirst.mockResolvedValue(null);
    await expect(
      controller.clear(
        { tenantId: 't2', userId: 'u9' } as AuthUser,
        'ACT',
        'RC1',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.release.update).not.toHaveBeenCalled();
  });

  // Regression test for the hole a missing query param opened: NestJS's
  // global ValidationPipe does not validate bare @Query() primitives, and
  // Prisma silently drops an undefined-valued key from a `where` clause —
  // so a request missing `projectKey` used to collapse the lookup to
  // `{ tenantId }`, match an arbitrary release, and clear ITS plan.
  it('rejects clearing with a missing projectKey, before any lookup', async () => {
    await expect(
      controller.clear(
        { tenantId: 't1', userId: 'u1' } as AuthUser,
        undefined,
        'RC1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.release.findFirst).not.toHaveBeenCalled();
    expect(prisma.release.update).not.toHaveBeenCalled();
  });

  it('rejects clearing with a missing name, before any lookup', async () => {
    await expect(
      controller.clear(
        { tenantId: 't1', userId: 'u1' } as AuthUser,
        'ACT',
        undefined,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.release.findFirst).not.toHaveBeenCalled();
    expect(prisma.release.update).not.toHaveBeenCalled();
  });
});
