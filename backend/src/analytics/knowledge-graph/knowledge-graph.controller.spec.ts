import { BadRequestException } from '@nestjs/common';
import { AuditSink } from '../../common/audit/audit-sink';
import { Role } from '../../common/auth/role.enum';
import { ROLES_KEY } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { KnowledgeGraphManager } from './graph-manager.service';
import { KNOWLEDGE_GRAPH_RULE } from './graph-queries';
import { KnowledgeGraphController } from './knowledge-graph.controller';
import { TenantGraph } from './tenant-graph';

const user: AuthUser = {
  userId: 'u_admin',
  tenantId: 'tenant_a',
  email: 'admin@acme.dev',
  roles: ['admin'],
};

function setup() {
  const graph = new TenantGraph('tenant_a');
  graph.load({
    commits: [
      {
        id: 'c1',
        repoFullName: 'acme/billing',
        sha: 'abc',
        authoredAt: new Date('2026-10-01T00:00:00Z'),
        parentCount: 1,
        author: { developerId: 'asha', displayName: 'Asha', excluded: false },
      },
    ],
    pullRequests: [],
    issues: [],
  });
  const freshness = { builtAt: '2026-11-02T00:00:00.000Z' };
  const manager = {
    readyGraph: jest.fn(() => ({ graph, freshness })),
    status: jest.fn(() => ({ status: 'ready' })),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const controller = new KnowledgeGraphController(
    manager as unknown as KnowledgeGraphManager,
    audit as AuditSink,
  );
  return { controller, manager, audit, freshness };
}

describe('KnowledgeGraphController', () => {
  it('restricts every route to admins (ADR-0013)', () => {
    const routes = [
      'status',
      'search',
      'repositoryDevelopers',
      'developerRepositories',
      'repositoryActivities',
    ] as const;
    for (const route of routes) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          KnowledgeGraphController.prototype[route],
        ),
      ).toEqual([Role.ADMIN]);
    }
  });

  it("reads only the caller's tenant", async () => {
    const { controller, manager } = setup();
    controller.status(user);
    controller.search(user, 'billing');
    await controller.repositoryDevelopers(user, 'acme/billing');
    await controller.developerRepositories(user, 'asha');
    await controller.repositoryActivities(user, 'acme/billing');
    expect(manager.status).toHaveBeenCalledWith('tenant_a');
    for (const call of manager.readyGraph.mock.calls) {
      expect(call).toEqual(['tenant_a']);
    }
  });

  it('audits every read that names people, with the rule and freshness in the response', async () => {
    const { controller, audit, freshness } = setup();

    // Express decodes `ACME%2Fbilling` to this before the handler sees it.
    const devs = await controller.repositoryDevelopers(user, 'ACME/billing');
    expect(devs.rule).toBe(KNOWLEDGE_GRAPH_RULE);
    expect(devs.freshness).toBe(freshness);
    expect(devs.developers.map((d) => d.displayName)).toEqual(['Asha']);

    const repos = await controller.developerRepositories(user, 'asha');
    expect(repos.rule).toBe(KNOWLEDGE_GRAPH_RULE);

    const activities = await controller.repositoryActivities(user, 'billing');
    expect(activities.rule).toBe(KNOWLEDGE_GRAPH_RULE);

    expect(
      audit.record.mock.calls.map(([r]) => [r.action, r.targetId]),
    ).toEqual([
      ['analytics.knowledge_graph.repository_developers.view', 'acme/billing'],
      ['analytics.knowledge_graph.developer_repositories.view', 'asha'],
      ['analytics.knowledge_graph.repository_activities.view', 'acme/billing'],
    ]);
    for (const [record] of audit.record.mock.calls) {
      expect(record).toMatchObject({
        tenantId: 'tenant_a',
        actorType: 'user',
        actorId: 'u_admin',
      });
    }
  });

  it('does not audit status or search, which return no names', () => {
    const { controller, audit } = setup();
    controller.status(user);
    const result = controller.search(user, 'bill');
    expect(result.items.map((r) => r.id)).toEqual(['acme/billing']);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a limit outside 1..200', async () => {
    const { controller } = setup();
    expect(() => controller.search(user, 'bill', '0')).toThrow(
      BadRequestException,
    );
    await expect(
      controller.developerRepositories(user, 'asha', '500'),
    ).rejects.toThrow(BadRequestException);
  });
});
