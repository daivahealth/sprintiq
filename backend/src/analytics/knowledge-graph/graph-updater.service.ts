import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CodeCommitPersistedPayload,
  CodePullRequestPersistedPayload,
  CorrelationLinkPersistedPayload,
  PlanningIssuePersistedPayload,
} from '../../common/events/contracts';
import { EventBus } from '../../common/events/event-bus';
import { EventTypes } from '../../common/events/event-types';
import { KnowledgeGraphManager } from './graph-manager.service';
import { GraphSourceReader, PR_ISSUE_EDGE } from './graph-source.reader';
import { changeKey, GraphChange } from './knowledge-graph.types';

/**
 * Keeps each tenant's live graph current between rebuilds.
 *
 * Input is a stream of `{tenantId, change}` — a natural key, nothing more.
 * Today that stream is the in-process `*.persisted` events, published only
 * after a write succeeded; a transactional outbox or CDC feed can replace the
 * subscriptions in `onModuleInit` without touching anything below them.
 *
 * Every change is applied by re-reading the row from Postgres, so the graph
 * only ever holds what was committed: a row that is gone (or has left the
 * window) is removed, never guessed at. Failures mark the tenant stale and
 * the next scheduled rebuild corrects it.
 *
 * Work is queued per tenant and applied off the publisher's call stack, so
 * ingestion never waits on the graph; bursts for the same row coalesce.
 */
@Injectable()
export class KnowledgeGraphUpdater implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeGraphUpdater.name);
  private readonly queues = new Map<string, Map<string, GraphChange>>();
  private readonly draining = new Map<string, Promise<void>>();

  constructor(
    private readonly eventBus: EventBus,
    private readonly manager: KnowledgeGraphManager,
    private readonly reader: GraphSourceReader,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe<CodeCommitPersistedPayload>(
      EventTypes.CODE_COMMIT_PERSISTED,
      (e) =>
        this.enqueue(e.tenantId, {
          entity: 'commit',
          repoFullName: e.payload.repoFullName,
          sha: e.payload.sha,
        }),
    );
    this.eventBus.subscribe<CodePullRequestPersistedPayload>(
      EventTypes.CODE_PR_PERSISTED,
      (e) =>
        this.enqueue(e.tenantId, {
          entity: 'pull_request',
          repoFullName: e.payload.repoFullName,
          externalNumber: e.payload.externalNumber,
        }),
    );
    this.eventBus.subscribe<PlanningIssuePersistedPayload>(
      EventTypes.PLANNING_ISSUE_PERSISTED,
      (e) =>
        this.enqueue(e.tenantId, {
          entity: 'issue',
          externalKey: e.payload.externalKey,
        }),
    );
    this.eventBus.subscribe<CorrelationLinkPersistedPayload>(
      EventTypes.CORRELATION_LINK_PERSISTED,
      (e) => {
        const change = linkChange(e.payload);
        if (change) {
          this.enqueue(e.tenantId, change);
        }
      },
    );
    this.manager.onRebuilt((tenantId, changes) =>
      this.apply(tenantId, changes),
    );
  }

  enqueue(tenantId: string, change: GraphChange): void {
    if (!this.manager.isActive()) {
      return;
    }
    const queue = this.queues.get(tenantId) ?? new Map<string, GraphChange>();
    queue.set(changeKey(change), change);
    this.queues.set(tenantId, queue);
    if (!this.draining.has(tenantId)) {
      this.draining.set(tenantId, this.drain(tenantId));
    }
  }

  /** Settles once every queued change has been applied. */
  async idle(): Promise<void> {
    while (this.draining.size) {
      await Promise.all(this.draining.values());
    }
  }

  /** Applies changes to the tenant's live graph by re-reading each row. */
  async apply(tenantId: string, changes: GraphChange[]): Promise<void> {
    const live = this.manager.liveGraph(tenantId);
    if (!live) {
      // Nothing loaded yet: the first build reads these rows anyway.
      return;
    }
    const { graph, windowStart } = live;
    try {
      const directory = await this.reader.directory(tenantId);
      for (const change of changes) {
        switch (change.entity) {
          case 'commit': {
            const record = await this.reader.findCommit(
              tenantId,
              change.repoFullName,
              change.sha,
              windowStart,
              directory,
            );
            if (record) {
              graph.upsertCommit(record);
            } else {
              graph.removeCommit(change.repoFullName, change.sha);
            }
            break;
          }
          case 'pull_request': {
            const record = await this.reader.findPullRequest(
              tenantId,
              change.repoFullName,
              change.externalNumber,
              windowStart,
              directory,
            );
            if (record) {
              graph.upsertPullRequest(record);
            } else {
              graph.removePullRequest(
                change.repoFullName,
                change.externalNumber,
              );
            }
            break;
          }
          case 'issue': {
            const found = await this.reader.findIssue(
              tenantId,
              change.externalKey,
              windowStart,
              directory,
            );
            // Same membership rule as the full load: in by its own dates, or
            // held by a loaded PR that references it.
            if (
              found &&
              (found.inWindow || graph.isIssueReferenced(change.externalKey))
            ) {
              graph.upsertIssue(found.issue);
            } else {
              graph.removeIssue(change.externalKey);
            }
            break;
          }
        }
      }
      this.manager.markIncremental(tenantId);
    } catch (err) {
      this.manager.markStale(tenantId, err as Error);
      this.logger.error(
        `tenant=${tenantId} incremental graph update failed; marked stale until the next rebuild: ${
          (err as Error).message
        }`,
      );
    }
  }

  private async drain(tenantId: string): Promise<void> {
    // Off the publisher's stack: the write path returns before graph work runs.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      let queue = this.queues.get(tenantId);
      while (queue?.size) {
        const changes = [...queue.values()];
        queue.clear();
        if (!this.manager.deferIfRebuilding(tenantId, changes)) {
          await this.apply(tenantId, changes);
        }
        queue = this.queues.get(tenantId);
      }
    } finally {
      this.draining.delete(tenantId);
      this.queues.delete(tenantId);
    }
  }
}

/** A `pr_implements_story` link changed: re-read the PR, which carries its links. */
function linkChange(
  p: CorrelationLinkPersistedPayload,
): GraphChange | undefined {
  if (p.edgeType !== PR_ISSUE_EDGE || p.fromType !== 'pull_request') {
    return undefined;
  }
  const sep = p.fromId.lastIndexOf('#');
  if (sep <= 0) {
    return undefined;
  }
  return {
    entity: 'pull_request',
    repoFullName: p.fromId.slice(0, sep),
    externalNumber: p.fromId.slice(sep + 1),
  };
}
