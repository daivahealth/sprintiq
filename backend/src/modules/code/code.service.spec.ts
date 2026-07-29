import { EventBus } from '../../common/events/event-bus';
import { PrismaService } from '../../database/prisma.service';
import { CodeService } from './code.service';

describe('CodeService.listCommits', () => {
  it('windows by committedAt (not authoredAt) and orders by committedAt desc', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { commit: { findMany } } as unknown as PrismaService;
    const eventBus = { subscribe: jest.fn() } as unknown as EventBus;
    const service = new CodeService(prisma, eventBus);

    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-30T00:00:00.000Z');
    await service.listCommits('tenant-a', { from, to, authorLogin: 'jdoe' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        authorLogin: 'jdoe',
        committedAt: { gte: from, lte: to },
      },
      orderBy: { committedAt: 'desc' },
      take: 2000,
    });
  });
});
