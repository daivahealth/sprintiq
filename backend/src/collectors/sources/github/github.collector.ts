import { Injectable } from '@nestjs/common';
import { Connection } from '@prisma/client';
import {
  CodeCommitPayload,
  CodePullRequestPayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import {
  CanonicalEnvelope,
  CollectionMode,
} from '../../ingestion/canonical-envelope';
import { BaseSourceCollector } from '../../framework/source-collector';
import {
  GithubClient,
  GithubCommit,
  GithubCommitDetail,
  GithubPull,
  GithubPullDetail,
} from './github.client';

/** Bounds how much work one scheduler tick does — large histories catch up over several ticks. */
const PAGE_BUDGET_PER_TICK = 3;
/**
 * Bounds the per-commit detail calls (for line-change stats) one tick makes,
 * per repo. Commits beyond this budget are left for a later tick rather than
 * ingested with stats missing — ingestion's idempotency key means a commit,
 * once ingested, can never be re-enriched afterward (a later envelope with
 * the same key is dropped as a duplicate before it ever reaches the
 * projector), so "ingest now without stats" would be a permanent gap, not a
 * temporary one. See `syncCommits`.
 */
const COMMIT_ENRICH_BUDGET_PER_TICK = 25;
/** Same rationale as COMMIT_ENRICH_BUDGET_PER_TICK, for PR line-change stats. */
const PR_ENRICH_BUDGET_PER_TICK = 25;
/** Default historical lookback when a connection doesn't set `config.backfillSince`. */
const DEFAULT_BACKFILL_DAYS = 90;

interface GithubSyncCursors {
  prBackfillDone?: boolean;
  /** Next page to fetch — only meaningful while still backfilling. */
  prPage?: number;
  /** Watermark: newest PR `updated_at` already ingested (steady-state incremental). */
  prNewestSeenAt?: string;
  /** Floor for the next `/commits?since=` call; advances once a full pass completes. */
  commitsCursor?: string;
  /** Page to resume from within the current cursor's pass. */
  commitsResumePage?: number;
}

interface SyncResult {
  envelopes: CanonicalEnvelope[];
  rateLimitedUntil?: Date;
}

/**
 * Native GitHub collector (BC-1): normalizes `pull_request`/`push` webhooks and
 * runs the scheduled sync (backfill on first runs, then incremental
 * reconciliation) into the canonical `code.*` envelope. Pagination, rate-limit
 * backoff, and cursor persistence live here — never in domain contexts.
 */
@Injectable()
export class GithubCollector extends BaseSourceCollector {
  readonly source = 'github';

  constructor(
    private readonly client: GithubClient,
    private readonly connections: ConnectionsService,
    private readonly secrets: SecretsService,
  ) {
    super();
  }

  async normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]> {
    const eventName = headers['x-github-event'];
    if (eventName === 'push') {
      return this.normalizePush(connection, rawBody);
    }
    if (eventName !== 'pull_request') {
      return []; // other event types added as collectors mature
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    const pr = body.pull_request;
    const repoFullName: string | undefined = body.repository?.full_name;
    if (!pr || !repoFullName) {
      return [];
    }
    const number = String(body.number ?? pr.number);
    const { eventType, state } = mapAction(body.action, Boolean(pr.merged));

    const payload: CodePullRequestPayload = {
      repoFullName,
      externalNumber: number,
      title: pr.title ?? '',
      branch: pr.head?.ref ?? '',
      baseBranch: pr.base?.ref,
      state,
      authorLogin: pr.user?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      openedAt: pr.created_at,
      mergedAt: pr.merged_at ?? undefined,
    };

    return [
      this.prEnvelope(
        connection,
        'webhook',
        eventType,
        number,
        repoFullName,
        pr.updated_at ?? pr.created_at,
        pr.user?.login,
        payload,
      ),
    ];
  }

  /**
   * `push` webhook → one `code.commit.pushed` envelope per commit. GitHub push
   * payloads carry file lists but NOT per-commit LOC — additions/deletions stay
   * 0 until a per-commit detail call enriches them. Deterministic idempotency:
   * repo+sha (matches backfilled commits, so webhook + poll converge).
   */
  private normalizePush(
    connection: Connection,
    rawBody: Buffer,
  ): CanonicalEnvelope[] {
    const body = JSON.parse(rawBody.toString('utf8'));
    const repoFullName: string | undefined = body.repository?.full_name;
    const commits: Array<Record<string, unknown>> = Array.isArray(body.commits)
      ? body.commits
      : [];
    if (!repoFullName || commits.length === 0) {
      return [];
    }
    return commits
      .filter((c) => typeof c.id === 'string')
      .map((c) => {
        const author = (c.author ?? {}) as Record<string, unknown>;
        const files = ['added', 'removed', 'modified']
          .map((k) => (Array.isArray(c[k]) ? (c[k] as unknown[]).length : 0))
          .reduce((a, b) => a + b, 0);
        // Push payloads carry one timestamp per commit (no separate
        // author/committer dates), so authoredAt and committedAt are the same value here.
        const commitTimestamp =
          typeof c.timestamp === 'string' ? c.timestamp : this.nowIso();
        const payload: CodeCommitPayload = {
          repoFullName,
          sha: c.id as string,
          message: typeof c.message === 'string' ? c.message : '',
          authorLogin:
            typeof author.username === 'string' ? author.username : undefined,
          authorName: typeof author.name === 'string' ? author.name : undefined,
          authorEmail:
            typeof author.email === 'string' ? author.email : undefined,
          authoredAt: commitTimestamp,
          committedAt: commitTimestamp,
          filesChanged: files,
        };
        return this.commitEnvelope(
          connection,
          'webhook',
          repoFullName,
          payload,
        );
      });
  }

  /**
   * Scheduled sync: pulls requests then commits, backfilling history on first
   * runs (bounded per tick) and reconciling incrementally thereafter. A
   * connection already cooling down from a rate limit is skipped entirely.
   */
  async poll(connection: Connection): Promise<CanonicalEnvelope[]> {
    const config = (connection.config ?? {}) as {
      repoFullName?: string;
      backfillSince?: string;
    };
    const repoFullName = config.repoFullName;
    if (!repoFullName) {
      return [];
    }

    const rateLimitState = (connection.rateLimitState ?? {}) as {
      resetAt?: string;
    };
    if (
      rateLimitState.resetAt &&
      new Date(rateLimitState.resetAt).getTime() > Date.now()
    ) {
      return [];
    }

    const token = await this.secrets.resolve(
      connection.tenantId,
      connection.secretRef,
    );
    if (!token) {
      return [];
    }

    const cursors: GithubSyncCursors = {
      ...((connection.syncCursors as GithubSyncCursors | null) ?? {}),
    };
    const backfillFloor = resolveBackfillFloor(config.backfillSince);

    const prResult = cursors.prBackfillDone
      ? await this.incrementalPullRequests(
          connection,
          repoFullName,
          token,
          cursors,
        )
      : await this.backfillPullRequests(
          connection,
          repoFullName,
          token,
          cursors,
          backfillFloor,
        );

    const envelopes = [...prResult.envelopes];
    let rateLimitedUntil = prResult.rateLimitedUntil;

    if (!rateLimitedUntil) {
      const commitResult = await this.syncCommits(
        connection,
        repoFullName,
        token,
        cursors,
        backfillFloor,
      );
      envelopes.push(...commitResult.envelopes);
      rateLimitedUntil = commitResult.rateLimitedUntil;
    }

    await this.connections.setSyncCursors(
      connection.id,
      cursors as unknown as Record<string, unknown>,
    );
    await this.connections.setRateLimitState(
      connection.id,
      rateLimitedUntil ? { resetAt: rateLimitedUntil.toISOString() } : {},
    );

    // Checked against the PERSISTED flag (not an in-memory before/after cursor
    // snapshot) so this self-heals connections that already reached poll mode
    // before backfillCompletedAt tracking existed — an in-memory transition
    // check would only ever fire once, at the moment the DB column was added,
    // and permanently miss any connection already past that point by then.
    const isNowFullyBackfilled = Boolean(
      cursors.prBackfillDone && cursors.commitsCursor,
    );
    if (isNowFullyBackfilled && !connection.backfillCompletedAt) {
      await this.connections.setBackfillCompletedAt(connection.id);
    }

    return envelopes;
  }

  /** Historical pass: pages backward (newest-updated-first) until the backfill floor. */
  private async backfillPullRequests(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
    backfillFloor: Date,
  ): Promise<SyncResult> {
    const envelopes: CanonicalEnvelope[] = [];
    let page = cursors.prPage ?? 1;
    let enrichBudget = PR_ENRICH_BUDGET_PER_TICK;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const result = await this.client.listPullRequestsPage(
        repoFullName,
        token,
        page,
      );
      if (result.rateLimitedUntil) {
        cursors.prPage = page;
        return { envelopes, rateLimitedUntil: result.rateLimitedUntil };
      }
      // Anchor the incremental watermark to the true newest PR, captured once
      // at the very start of backfill — regardless of how many ticks it takes.
      if (page === 1 && !cursors.prNewestSeenAt && result.items[0]) {
        cursors.prNewestSeenAt =
          result.items[0].updated_at ?? result.items[0].created_at;
      }
      if (result.items.length === 0) {
        this.finishPrBackfill(cursors);
        return { envelopes };
      }
      for (const pr of result.items) {
        const updatedAt = pr.updated_at ?? pr.created_at;
        if (new Date(updatedAt) < backfillFloor) {
          this.finishPrBackfill(cursors);
          return { envelopes };
        }
        if (enrichBudget <= 0) {
          // Resume at this exact page next tick — same rationale as
          // syncCommits: never ingest a PR with permanently-missing stats.
          cursors.prPage = page;
          return { envelopes };
        }
        const detail = await this.client.getPullRequestDetail(
          repoFullName,
          token,
          pr.number,
        );
        enrichBudget--;
        envelopes.push(
          this.fromPolledPull(connection, repoFullName, pr, 'backfill', detail),
        );
        if (detail.rateLimitedUntil) {
          cursors.prPage = page;
          return { envelopes, rateLimitedUntil: detail.rateLimitedUntil };
        }
      }
      if (!result.hasNextPage) {
        this.finishPrBackfill(cursors);
        return { envelopes };
      }
      page++;
    }

    cursors.prPage = page; // budget exhausted — resume here next tick
    return { envelopes };
  }

  private finishPrBackfill(cursors: GithubSyncCursors): void {
    cursors.prBackfillDone = true;
    cursors.prPage = undefined;
  }

  /** Steady-state: only page 1, stop as soon as we hit the known watermark. */
  private async incrementalPullRequests(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
  ): Promise<SyncResult> {
    const envelopes: CanonicalEnvelope[] = [];
    const result = await this.client.listPullRequestsPage(
      repoFullName,
      token,
      1,
    );
    if (result.rateLimitedUntil) {
      return { envelopes, rateLimitedUntil: result.rateLimitedUntil };
    }

    const watermark = cursors.prNewestSeenAt;
    let enrichBudget = PR_ENRICH_BUDGET_PER_TICK;
    // Only set if the enrichment budget runs out before every PR newer than
    // the old watermark has been processed — in that case advancing the
    // watermark at all would skip the un-enriched remainder forever.
    let budgetExhausted = false;

    for (const pr of result.items) {
      const updatedAt = pr.updated_at ?? pr.created_at;
      if (watermark && updatedAt <= watermark) {
        break; // sorted desc — everything after this is already synced
      }
      if (enrichBudget <= 0) {
        budgetExhausted = true;
        break;
      }
      const detail = await this.client.getPullRequestDetail(
        repoFullName,
        token,
        pr.number,
      );
      enrichBudget--;
      envelopes.push(
        this.fromPolledPull(connection, repoFullName, pr, 'poll', detail),
      );
      if (detail.rateLimitedUntil) {
        return { envelopes, rateLimitedUntil: detail.rateLimitedUntil };
      }
    }

    if (!budgetExhausted && result.items[0]) {
      cursors.prNewestSeenAt =
        result.items[0].updated_at ?? result.items[0].created_at;
    }
    return { envelopes };
  }

  /** Commits support `since` natively, so backfill + incremental share one loop. */
  private async syncCommits(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
    backfillFloor: Date,
  ): Promise<SyncResult> {
    const envelopes: CanonicalEnvelope[] = [];
    const since = cursors.commitsCursor ?? backfillFloor.toISOString();
    const mode: CollectionMode = cursors.commitsCursor ? 'poll' : 'backfill';
    let page = cursors.commitsResumePage ?? 1;
    // Captured at pass START (not completion) so nothing landing mid-pass is missed.
    const passStartedAt = this.nowIso();
    let enrichBudget = COMMIT_ENRICH_BUDGET_PER_TICK;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const result = await this.client.listCommitsPage(
        repoFullName,
        token,
        page,
        since,
      );
      if (result.rateLimitedUntil) {
        cursors.commitsResumePage = page;
        return { envelopes, rateLimitedUntil: result.rateLimitedUntil };
      }
      for (const commit of result.items) {
        if (enrichBudget <= 0) {
          // Resume at this exact page next tick — already-enriched commits
          // above re-fetch as harmless idempotent duplicates; this one and
          // the rest of the page get enriched fresh once budget resets.
          cursors.commitsResumePage = page;
          return { envelopes };
        }
        const detail = await this.client.getCommitDetail(
          repoFullName,
          token,
          commit.sha,
        );
        enrichBudget--;
        envelopes.push(
          this.fromPolledCommit(connection, repoFullName, commit, mode, detail),
        );
        if (detail.rateLimitedUntil) {
          cursors.commitsResumePage = page;
          return { envelopes, rateLimitedUntil: detail.rateLimitedUntil };
        }
      }
      if (result.items.length === 0 || !result.hasNextPage) {
        cursors.commitsResumePage = undefined;
        cursors.commitsCursor = passStartedAt;
        return { envelopes };
      }
      page++;
    }

    cursors.commitsResumePage = page; // budget exhausted — resume next tick, same `since`
    return { envelopes };
  }

  /**
   * GitHub's PR list endpoint never includes line-change stats — only a
   * per-PR detail call does (`GithubClient.getPullRequestDetail`, called by
   * `backfillPullRequests`/`incrementalPullRequests` under a bounded
   * per-tick budget before this is reached).
   */
  private fromPolledPull(
    connection: Connection,
    repoFullName: string,
    pr: GithubPull,
    mode: CollectionMode,
    detail?: GithubPullDetail,
  ): CanonicalEnvelope {
    const merged = Boolean(pr.merged_at);
    const eventType = merged
      ? EventTypes.CODE_PR_MERGED
      : pr.state === 'open'
        ? EventTypes.CODE_PR_OPENED
        : EventTypes.CODE_PR_CLOSED;
    const payload: CodePullRequestPayload = {
      repoFullName,
      externalNumber: String(pr.number),
      title: pr.title,
      branch: pr.head?.ref ?? '',
      baseBranch: pr.base?.ref,
      state: merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      authorLogin: pr.user?.login,
      additions: detail?.additions,
      deletions: detail?.deletions,
      changedFiles: detail?.changedFiles,
      openedAt: pr.created_at,
      mergedAt: pr.merged_at ?? undefined,
    };
    return this.prEnvelope(
      connection,
      mode,
      eventType,
      String(pr.number),
      repoFullName,
      pr.merged_at ?? pr.updated_at ?? pr.created_at,
      pr.user?.login,
      payload,
    );
  }

  /**
   * GitHub's commit list endpoint never includes line-change stats — only a
   * per-commit detail call does (`GithubClient.getCommitDetail`, called by
   * `syncCommits` under a bounded per-tick budget before this is reached).
   * Push webhooks still omit them (payloads carry file lists but not LOC) —
   * lower volume there makes it a smaller gap than backfill was.
   */
  private fromPolledCommit(
    connection: Connection,
    repoFullName: string,
    commit: GithubCommit,
    mode: CollectionMode,
    detail?: GithubCommitDetail,
  ): CanonicalEnvelope {
    const authoredAt = commit.commit.author?.date ?? this.nowIso();
    const payload: CodeCommitPayload = {
      repoFullName,
      sha: commit.sha,
      message: commit.commit.message ?? '',
      authorLogin: commit.author?.login,
      authorName: commit.commit.author?.name,
      authorEmail: commit.commit.author?.email,
      authoredAt,
      committedAt: commit.commit.committer?.date,
      additions: detail?.additions,
      deletions: detail?.deletions,
      filesChanged: detail?.filesChanged,
    };
    return this.commitEnvelope(connection, mode, repoFullName, payload);
  }

  private commitEnvelope(
    connection: Connection,
    mode: CollectionMode,
    repoFullName: string,
    payload: CodeCommitPayload,
  ): CanonicalEnvelope {
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      // Deterministic so a webhook push and a backfilled pull converge on one row.
      idempotencyKey: `github:${repoFullName}:commit:${payload.sha}`,
      sourceSystem: 'github',
      connectionId: connection.id,
      collectionMode: mode,
      eventType: EventTypes.CODE_COMMIT_PUSHED,
      occurredAt: payload.authoredAt,
      collectedAt: this.nowIso(),
      externalRefs: { repo: repoFullName, sha: payload.sha },
      actor: { sourceLogin: payload.authorLogin },
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private prEnvelope(
    connection: Connection,
    mode: CollectionMode,
    eventType: string,
    number: string,
    repoFullName: string,
    occurredAt: string,
    actorLogin: string | undefined,
    payload: CodePullRequestPayload,
  ): CanonicalEnvelope {
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      // Deterministic so webhook + poll converge.
      idempotencyKey: `github:${repoFullName}:pr:${number}:${eventType}`,
      sourceSystem: 'github',
      connectionId: connection.id,
      collectionMode: mode,
      eventType,
      occurredAt: occurredAt ?? this.nowIso(),
      collectedAt: this.nowIso(),
      externalRefs: {
        repo: repoFullName,
        pr_number: number,
        org: repoFullName.split('/')[0] ?? '',
      },
      actor: { sourceLogin: actorLogin },
      data: payload as unknown as Record<string, unknown>,
    };
  }
}

function resolveBackfillFloor(backfillSince: string | undefined): Date {
  if (backfillSince) {
    const parsed = new Date(backfillSince);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
}

function mapAction(
  action: string | undefined,
  merged: boolean,
): { eventType: string; state: CodePullRequestPayload['state'] } {
  if (action === 'opened' || action === 'reopened') {
    return { eventType: EventTypes.CODE_PR_OPENED, state: 'open' };
  }
  if (action === 'closed') {
    return merged
      ? { eventType: EventTypes.CODE_PR_MERGED, state: 'merged' }
      : { eventType: EventTypes.CODE_PR_CLOSED, state: 'closed' };
  }
  return { eventType: EventTypes.CODE_PR_UPDATED, state: 'open' };
}
