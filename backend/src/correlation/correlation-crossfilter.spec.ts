import { EventBus } from '../common/events/event-bus';
import { PrismaService } from '../database/prisma.service';
import { PlanningService } from '../modules/planning/planning.service';
import { CorrelationService } from './correlation.service';

/** Project → repo cross-filter over the delivery graph (DASHBOARDS.md §3.2). */
describe('CorrelationService.reposLinkedToProjects', () => {
  const planning = {
    listStoryIdsForProjects: jest.fn().mockResolvedValue(['s1', 's2']),
  } as unknown as PlanningService;

  const prisma = {
    correlationLink: {
      findMany: jest.fn().mockResolvedValue([
        { fromId: 'acme/payments#4521' },
        { fromId: 'acme/payments#4530' }, // same repo, deduped
        { fromId: 'acme/web#12' },
      ]),
    },
  } as unknown as PrismaService;

  const svc = new CorrelationService(prisma, new EventBus(), planning);

  it('returns distinct repos parsed from pr_implements_story edges, tenant-scoped', async () => {
    const repos = await svc.reposLinkedToProjects('tenant-a', ['PAY']);
    expect(repos).toEqual(['acme/payments', 'acme/web']);

    expect(planning.listStoryIdsForProjects as jest.Mock).toHaveBeenCalledWith(
      'tenant-a',
      ['PAY'],
    );
    expect(
      (prisma.correlationLink.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({
      tenantId: 'tenant-a',
      edgeType: 'pr_implements_story',
      toId: { in: ['s1', 's2'] },
    });
  });

  it('short-circuits to [] when the projects have no stories', async () => {
    (planning.listStoryIdsForProjects as jest.Mock).mockResolvedValueOnce([]);
    expect(await svc.reposLinkedToProjects('tenant-a', ['NONE'])).toEqual([]);
  });
});
