import { EventBus } from '../../common/events/event-bus';
import { EventTypes } from '../../common/events/event-types';
import { KnowledgeGraphManager } from './graph-manager.service';
import { GraphSourceReader } from './graph-source.reader';
import { KnowledgeGraphUpdater } from './graph-updater.service';
import { CommitRecord, GraphChange } from './knowledge-graph.types';
import { TenantGraph } from './tenant-graph';

const WINDOW_START = new Date('2026-08-01T00:00:00Z');

const commitRecord: CommitRecord = {
  id: 'c1',
  repoFullName: 'acme/billing',
  sha: 'abc',
  authoredAt: new Date('2026-10-01T00:00:00Z'),
  parentCount: 1,
  author: { developerId: 'asha', displayName: 'Asha', excluded: false },
};

function setup(opts: { rebuilding?: boolean } = {}) {
  const graph = new TenantGraph('tenant_a');
  const deferred: GraphChange[] = [];
  const manager = {
    isActive: () => true,
    onRebuilt: jest.fn(),
    deferIfRebuilding: jest.fn((_t: string, changes: GraphChange[]) => {
      if (opts.rebuilding) {
        deferred.push(...changes);
      }
      return Boolean(opts.rebuilding);
    }),
    liveGraph: jest.fn((tenantId: string) =>
      tenantId === 'tenant_a'
        ? { graph, windowStart: WINDOW_START }
        : undefined,
    ),
    markIncremental: jest.fn(),
    markStale: jest.fn(),
  };
  const reader = {
    directory: jest.fn().mockResolvedValue({}),
    findCommit: jest.fn().mockResolvedValue(commitRecord),
    findPullRequest: jest.fn().mockResolvedValue(null),
    findIssue: jest.fn().mockResolvedValue(null),
  };
  const bus = new EventBus();
  const updater = new KnowledgeGraphUpdater(
    bus,
    manager as unknown as KnowledgeGraphManager,
    reader as unknown as GraphSourceReader,
  );
  updater.onModuleInit();
  const publish = (type: string, payload: unknown, tenantId = 'tenant_a') =>
    bus.publish({ type, tenantId, occurredAt: new Date(), payload });
  return { graph, manager, reader, updater, publish, deferred };
}

describe('KnowledgeGraphUpdater', () => {
  it('applies a persisted commit by re-reading it from Postgres', async () => {
    const { graph, reader, updater, manager, publish } = setup();
    await publish(EventTypes.CODE_COMMIT_PERSISTED, {
      repoFullName: 'acme/billing',
      sha: 'abc',
    });
    await updater.idle();

    expect(reader.findCommit).toHaveBeenCalledWith(
      'tenant_a',
      'acme/billing',
      'abc',
      WINDOW_START,
      {},
    );
    expect(graph.resolveRef('commit', 'acme/billing', 'abc')).toBe('COMMIT:c1');
    expect(manager.markIncremental).toHaveBeenCalledWith('tenant_a');
  });

  it('never makes the publisher wait for graph work', async () => {
    const { reader, updater, publish } = setup();
    await publish(EventTypes.CODE_COMMIT_PERSISTED, {
      repoFullName: 'acme/billing',
      sha: 'abc',
    });
    expect(reader.findCommit).not.toHaveBeenCalled();
    await updater.idle();
    expect(reader.findCommit).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of events for the same row into one re-read', async () => {
    const { reader, updater, publish } = setup();
    for (let i = 0; i < 5; i++) {
      await publish(EventTypes.CODE_COMMIT_PERSISTED, {
        repoFullName: 'acme/billing',
        sha: 'abc',
      });
    }
    await updater.idle();
    expect(reader.findCommit).toHaveBeenCalledTimes(1);
  });

  it('removes a row that is gone (or has left the window) on re-read', async () => {
    const { graph, reader, updater, publish } = setup();
    graph.upsertCommit(commitRecord);
    reader.findCommit.mockResolvedValue(null);
    await publish(EventTypes.CODE_COMMIT_PERSISTED, {
      repoFullName: 'acme/billing',
      sha: 'abc',
    });
    await updater.idle();
    expect(graph.stats().nodes).toBe(0);
  });

  it('re-reads the PR when one of its correlation links changes', async () => {
    const { reader, updater, publish } = setup();
    await publish(EventTypes.CORRELATION_LINK_PERSISTED, {
      edgeType: 'pr_implements_story',
      fromType: 'pull_request',
      fromId: 'acme/billing#7',
      toType: 'story',
      toId: 's1',
    });
    await publish(EventTypes.CORRELATION_LINK_PERSISTED, {
      edgeType: 'some_other_edge',
      fromType: 'commit',
      fromId: 'x',
      toType: 'story',
      toId: 's1',
    });
    await updater.idle();
    expect(reader.findPullRequest).toHaveBeenCalledTimes(1);
    expect(reader.findPullRequest).toHaveBeenCalledWith(
      'tenant_a',
      'acme/billing',
      '7',
      WINDOW_START,
      {},
    );
  });

  const oldIssue = {
    id: 's1',
    key: 'PAY-1',
    title: 'Invoice generation',
    status: 'Done',
    type: 'story',
    assignee: { developerId: 'asha', displayName: 'Asha', excluded: false },
  };

  it('does not pull in an old, unlinked issue that a Jira update touched', async () => {
    const { graph, reader, updater, publish } = setup();
    reader.findIssue.mockResolvedValue({ issue: oldIssue, inWindow: false });
    await publish(EventTypes.PLANNING_ISSUE_PERSISTED, {
      externalKey: 'PAY-1',
    });
    await updater.idle();
    expect(reader.findIssue).toHaveBeenCalledWith(
      'tenant_a',
      'PAY-1',
      WINDOW_START,
      {},
    );
    expect(graph.stats().nodes).toBe(0);
  });

  it('keeps updating an old issue while a loaded PR references it', async () => {
    const { graph, reader, updater, publish } = setup();
    graph.upsertPullRequest({
      id: 'p1',
      repoFullName: 'acme/billing',
      number: '7',
      title: 'PAY-1',
      state: 'merged',
      openedAt: new Date('2026-10-01T00:00:00Z'),
      mergedAt: null,
      reviews: [],
      issueLinks: [
        {
          issue: { ...oldIssue, assignee: undefined },
          confidence: 0.8,
          method: 'regex',
        },
      ],
    });
    reader.findIssue.mockResolvedValue({
      issue: { ...oldIssue, title: 'Invoice generation v2' },
      inWindow: false,
    });
    await publish(EventTypes.PLANNING_ISSUE_PERSISTED, {
      externalKey: 'PAY-1',
    });
    await updater.idle();
    expect(graph.graph.getNodeAttributes('JIRA_ISSUE:s1')).toMatchObject({
      title: 'Invoice generation v2',
    });
  });

  it('holds changes back while a rebuild is reading, for replay after the swap', async () => {
    const { reader, updater, publish, deferred } = setup({ rebuilding: true });
    await publish(EventTypes.CODE_COMMIT_PERSISTED, {
      repoFullName: 'acme/billing',
      sha: 'abc',
    });
    await updater.idle();
    expect(reader.findCommit).not.toHaveBeenCalled();
    expect(deferred).toEqual([
      { entity: 'commit', repoFullName: 'acme/billing', sha: 'abc' },
    ]);
  });

  it('marks the tenant stale for the next rebuild to correct when a re-read fails', async () => {
    const { graph, reader, updater, manager, publish } = setup();
    reader.findCommit.mockRejectedValue(new Error('db down'));
    await publish(EventTypes.CODE_COMMIT_PERSISTED, {
      repoFullName: 'acme/billing',
      sha: 'abc',
    });
    await updater.idle();
    expect(manager.markStale).toHaveBeenCalledWith(
      'tenant_a',
      expect.any(Error),
    );
    expect(manager.markIncremental).not.toHaveBeenCalled();
    expect(graph.stats().nodes).toBe(0);
  });

  it("ignores a tenant whose graph isn't loaded yet; its first build reads the row anyway", async () => {
    const { reader, updater, publish } = setup();
    await publish(
      EventTypes.CODE_COMMIT_PERSISTED,
      { repoFullName: 'acme/billing', sha: 'abc' },
      'tenant_b',
    );
    await updater.idle();
    expect(reader.findCommit).not.toHaveBeenCalled();
  });
});
