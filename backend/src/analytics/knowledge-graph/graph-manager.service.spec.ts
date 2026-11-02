import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppRole } from '../../config/app-role';
import { PrismaService } from '../../database/prisma.service';
import { KnowledgeGraphLoader } from './graph-loader.service';
import { KnowledgeGraphManager } from './graph-manager.service';
import { TenantGraph } from './tenant-graph';

function graphWithCommit(tenantId: string): TenantGraph {
  const g = new TenantGraph(tenantId);
  g.upsertCommit({
    id: `c-${tenantId}`,
    repoFullName: 'acme/billing',
    sha: 'abc',
    authoredAt: new Date('2026-10-01T00:00:00Z'),
    parentCount: 1,
  });
  return g;
}

function setup(opts: { role?: AppRole; tenants?: string[] } = {}) {
  const prisma = {
    tenant: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (opts.tenants ?? ['tenant_a']).map((id) => ({ id })),
        ),
    },
  } as unknown as PrismaService;
  const build = jest.fn((tenantId: string) =>
    Promise.resolve(graphWithCommit(tenantId)),
  );
  const loader = { build } as unknown as KnowledgeGraphLoader;
  const config = {
    get: jest.fn(() => opts.role ?? AppRole.API),
  } as unknown as ConfigService;
  const manager = new KnowledgeGraphManager(prisma, loader, config);
  return { manager, build };
}

describe('KnowledgeGraphManager', () => {
  const env = process.env.KNOWLEDGE_GRAPH_ENABLED;
  afterEach(() => {
    // Assigning undefined to process.env stores the string "undefined".
    if (env === undefined) {
      delete process.env.KNOWLEDGE_GRAPH_ENABLED;
    } else {
      process.env.KNOWLEDGE_GRAPH_ENABLED = env;
    }
  });

  it('answers 503 until the tenant graph is built, then serves it with freshness', async () => {
    const { manager } = setup();
    expect(() => manager.readyGraph('tenant_a')).toThrow(
      ServiceUnavailableException,
    );

    await manager.initialize();
    const { graph, freshness } = manager.readyGraph('tenant_a');
    expect(graph.tenantId).toBe('tenant_a');
    expect(freshness).toMatchObject({
      windowDays: 90,
      stale: false,
      lastIncrementalAt: null,
    });
    expect(manager.status('tenant_a')).toMatchObject({
      status: 'ready',
      tenant: { state: 'ready', totalNodes: 2, totalEdges: 1 },
    });
  });

  it('keeps one graph per tenant, so no read can see another tenant', async () => {
    const { manager } = setup({ tenants: ['tenant_a', 'tenant_b'] });
    await manager.initialize();
    const a = manager.readyGraph('tenant_a').graph;
    const b = manager.readyGraph('tenant_b').graph;
    expect(a).not.toBe(b);
    expect(a.resolveRef('commit', 'acme/billing', 'abc')).toBe(
      'COMMIT:c-tenant_a',
    );
    expect(b.resolveRef('commit', 'acme/billing', 'abc')).toBe(
      'COMMIT:c-tenant_b',
    );
  });

  it('does not let one tenant failing to build stop the others', async () => {
    const { manager, build } = setup({ tenants: ['tenant_a', 'tenant_b'] });
    build.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
    await manager.initialize();

    expect(manager.status('tenant_a').tenant).toMatchObject({
      state: 'failed',
      error: 'timeout',
    });
    expect(manager.readyGraph('tenant_b').graph.tenantId).toBe('tenant_b');
  });

  it('keeps serving the previous graph, marked stale, when a rebuild fails', async () => {
    const { manager, build } = setup();
    await manager.initialize();
    const before = manager.readyGraph('tenant_a').graph;
    build.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
    await manager.rebuildTenant('tenant_a');

    const after = manager.readyGraph('tenant_a');
    expect(after.graph).toBe(before);
    expect(after.freshness.stale).toBe(true);
  });

  it('swaps a rebuilt graph in whole, then replays changes that arrived mid-build', async () => {
    const { manager, build } = setup();
    await manager.initialize();
    const before = manager.readyGraph('tenant_a').graph;

    let finish!: (g: TenantGraph) => void;
    build.mockImplementationOnce(
      () => new Promise<TenantGraph>((resolve) => (finish = resolve)),
    );
    const replay = jest.fn().mockResolvedValue(undefined);
    manager.onRebuilt(replay);

    const rebuilding = manager.rebuildTenant('tenant_a');
    const change = { entity: 'issue' as const, externalKey: 'PAY-1' };
    expect(manager.deferIfRebuilding('tenant_a', [change])).toBe(true);
    // Readers still see the old graph while the new one is being built.
    expect(manager.readyGraph('tenant_a').graph).toBe(before);

    const next = graphWithCommit('tenant_a');
    finish(next);
    await rebuilding;

    expect(manager.readyGraph('tenant_a').graph).toBe(next);
    expect(replay).toHaveBeenCalledWith('tenant_a', [change]);
    expect(manager.deferIfRebuilding('tenant_a', [change])).toBe(false);
  });

  it('stays disabled when switched off', () => {
    process.env.KNOWLEDGE_GRAPH_ENABLED = 'false';
    const { manager, build } = setup();
    manager.onApplicationBootstrap();

    expect(manager.isActive()).toBe(false);
    expect(build).not.toHaveBeenCalled();
    expect(() => manager.readyGraph('tenant_a')).toThrow(
      ServiceUnavailableException,
    );
    expect(manager.status('tenant_a')).toMatchObject({
      status: 'disabled',
      enabled: false,
    });
  });

  it('does not build on a process that serves no HTTP (the worker)', () => {
    const { manager, build } = setup({ role: AppRole.WORKER });
    manager.onApplicationBootstrap();
    expect(manager.isActive()).toBe(false);
    expect(build).not.toHaveBeenCalled();
  });
});
