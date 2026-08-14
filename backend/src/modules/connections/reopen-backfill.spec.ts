import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from './connections.service';

/**
 * `reopenBackfill` is the only mechanism that can deepen the data horizon, and
 * it is destructive-looking but additive. These cover the two ways it could
 * silently fail: writing the floor without clearing cursors (a no-op, because
 * every collector checks its cursor first), and losing the rest of the config
 * while writing the floor.
 */
describe('ConnectionsService.reopenBackfill', () => {
  function setup(config: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      connection: {
        findUnique: jest.fn().mockResolvedValue({ config }),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return args.data;
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;
    return { service: new ConnectionsService(prisma), updates };
  }

  const since = new Date('2025-08-14T00:00:00.000Z');

  it('moves the floor back AND clears the cursors', async () => {
    // Both halves matter: GitHub goes straight to incremental mode once
    // `prBackfillDone` is set and Jira's `updatedCursor` overrides the floor
    // entirely, so a new floor without a cursor reset collects nothing new.
    const { service, updates } = setup({
      repoFullName: 'acme/app',
      backfillSince: '2026-05-13T00:00:00.000Z',
    });

    await service.reopenBackfill('c1', since);

    expect(updates[0].syncCursors).toEqual({});
    expect((updates[0].config as { backfillSince: string }).backfillSince).toBe(
      since.toISOString(),
    );
  });

  it('preserves the rest of the connection config', async () => {
    // The floor lives alongside repoFullName / siteUrl / syncIntervalMinutes;
    // replacing the object wholesale would disconnect the connection from its
    // repository and stop collection entirely.
    const { service, updates } = setup({
      repoFullName: 'acme/app',
      syncIntervalMinutes: 60,
      backfillSince: '2026-05-13T00:00:00.000Z',
    });

    await service.reopenBackfill('c1', since);

    expect(updates[0].config).toMatchObject({
      repoFullName: 'acme/app',
      syncIntervalMinutes: 60,
    });
  });

  it('clears backfillCompletedAt so the sweep re-prioritises the connection', async () => {
    // The sweep orders neediest-first; a connection that is walking history
    // again but still marked complete would be treated as idle.
    const { service, updates } = setup({ repoFullName: 'acme/app' });

    await service.reopenBackfill('c1', since);

    expect(updates[0].backfillCompletedAt).toBeNull();
  });

  it('does nothing for a connection that no longer exists', async () => {
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      connection: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(async (a: { data: Record<string, unknown> }) => {
          updates.push(a.data);
          return a.data;
        }),
      },
    } as unknown as PrismaService;

    await new ConnectionsService(prisma).reopenBackfill('gone', since);

    expect(updates).toHaveLength(0);
  });
});
