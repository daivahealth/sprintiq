import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { JiraSprintReconcilerService } from './jira-sprint-reconciler.service';
import { JiraClient } from './jira.client';

function scopeChange(
  sprintExternalId: string,
  externalKey: string,
  connectionId = 'conn_1',
) {
  return { sprintExternalId, externalKey, connectionId };
}

describe('JiraSprintReconcilerService', () => {
  let prisma: {
    sprintScopeChange: { findMany: jest.Mock };
    sprint: { findMany: jest.Mock; create: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let client: jest.Mocked<JiraClient>;
  let secrets: jest.Mocked<SecretsService>;
  let service: JiraSprintReconcilerService;

  beforeEach(() => {
    prisma = {
      sprintScopeChange: {
        findMany: jest
          .fn()
          .mockResolvedValue([scopeChange('3238', 'NHIL-412')]),
      },
      sprint: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      connection: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conn_1',
          config: {
            siteUrl: 'https://acme.atlassian.net',
            email: 'a@acme.com',
          },
          secretRef: 'JIRA_API_TOKEN',
        }),
      },
    };
    client = {
      getSprint: jest.fn().mockResolvedValue({
        id: 3238,
        name: 'Sprint-26-3',
        state: 'closed',
        startDate: '2026-03-01T00:00:00.000+0530',
        endDate: '2026-03-30T00:00:00.000+0530',
        goal: 'Ship the referral editor',
      }),
    } as unknown as jest.Mocked<JiraClient>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    service = new JiraSprintReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  it('creates the sprint a scope change references but no row exists for', async () => {
    const result = await service.reconcile('t1');

    expect(client.getSprint).toHaveBeenCalledWith(
      'https://acme.atlassian.net',
      'a@acme.com',
      'tok',
      '3238',
    );
    expect(result).toMatchObject({ candidates: 1, created: 1 });
    const arg = prisma.sprint.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({
      tenantId: 't1',
      externalId: '3238',
      name: 'Sprint-26-3',
      state: 'closed',
      startAt: new Date('2026-03-01T00:00:00.000+0530'),
      endAt: new Date('2026-03-30T00:00:00.000+0530'),
      goal: 'Ship the referral editor',
    });
  });

  // The Agile API returns no project key — only a board id. The issue that
  // referenced the sprint is the only thing that can say which project this
  // belongs to, and the board filters by project.
  it('takes the project key from the issue that referenced the sprint', async () => {
    await service.reconcile('t1');

    const arg = prisma.sprint.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({ projectKey: 'NHIL' });
  });

  it('does not fetch sprints that already have a row', async () => {
    prisma.sprint.findMany.mockResolvedValue([{ externalId: '3238' }]);

    const result = await service.reconcile('t1');

    expect(client.getSprint).not.toHaveBeenCalled();
    expect(prisma.sprint.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 0, created: 0 });
  });

  // A failed lookup must leave the gap visible. Writing a dateless placeholder
  // would put a sprint on the board with no window, and every pace, elapsed
  // and check-in figure derives from that window.
  it('creates nothing when the sprint lookup fails', async () => {
    client.getSprint.mockResolvedValue(null);

    const result = await service.reconcile('t1');

    expect(prisma.sprint.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it('skips a connection whose credential cannot be resolved', async () => {
    secrets.resolve.mockResolvedValue(null as unknown as string);

    const result = await service.reconcile('t1');

    expect(client.getSprint).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it('scopes every query by the tenant', async () => {
    await service.reconcile('t-other');

    expect(prisma.sprintScopeChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
    expect(prisma.sprint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
    const arg = prisma.sprint.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({ tenantId: 't-other' });
  });

  it('reports how many sprints are still missing without asking Jira', async () => {
    prisma.sprintScopeChange.findMany.mockResolvedValue([
      scopeChange('3238', 'NHIL-412'),
      scopeChange('2541', 'NHIL-77'),
    ]);
    prisma.sprint.findMany.mockResolvedValue([{ externalId: '2541' }]);

    expect(await service.countRemaining('t1')).toBe(1);
    expect(client.getSprint).not.toHaveBeenCalled();
  });

  // One sprint id is referenced by many issues across many projects — sprint
  // 234 on the reference tenant spans seven. One fetch, one row, not 306.
  it('fetches a sprint once however many changes reference it', async () => {
    prisma.sprintScopeChange.findMany.mockResolvedValue([
      scopeChange('234', 'ACT-1'),
      scopeChange('234', 'NHC-2'),
      scopeChange('234', 'AS2-3'),
    ]);

    const result = await service.reconcile('t1');

    expect(client.getSprint).toHaveBeenCalledTimes(1);
    expect(prisma.sprint.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ candidates: 1, created: 1 });
  });
});
