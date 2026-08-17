import { Injectable, Logger } from '@nestjs/common';
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
import {
  BaseSourceCollector,
  PollOptions,
  PollResult,
} from '../../framework/source-collector';
import {
  GithubClient,
  GithubCommit,
  GithubCommitDetail,
  GithubPull,
  GithubPullCommits,
  GithubPullDetail,
  GithubPullReviews,
  GithubReviewComments,
} from './github.client';

/**
 * Reads a positive integer from the environment, falling back to the default.
 * The budgets below govern API spend per tick, and the right value depends on
 * how many connections a deployment runs — an org sync registers one per repo,
 * so a 200-repo tenant needs a far smaller per-connection budget than a
 * two-repo one to stay inside GitHub's hourly limit (api/README.md §12 #14).
 */
function envBudget(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/** Bounds how much work one scheduler tick does — large histories catch up over several ticks. */
const PAGE_BUDGET_PER_TICK = envBudget('GITHUB_PAGE_BUDGET_PER_TICK', 3);
/**
 * Enrichment the whole **fleet** may spend in one sweep, divided across the
 * connections of a tenant that are due in it. The per-connection ceilings below
 * still apply — this only ever shrinks them.
 *
 * The ceilings alone were the org-scale bug: a constant per connection
 * multiplies by fleet size, so 195 repos × 25 PRs × 4 calls demanded ~19,500
 * requests against a 5,000/hour limit. The first ~30 connections drained the
 * hour and the remaining 165 were rate-limited having collected nothing —
 * every sweep, with no setting that fixed it (backfilling connections ignore
 * the interval). Sized so one sweep costs roughly a third of an hour's quota
 * for PRs (500 × 4 calls = 2,000) plus commits (500 × 1), leaving room for the
 * reserve the reconcilers respect (§3.2).
 */
const PR_ENRICH_BUDGET_PER_SWEEP = envBudget(
  'GITHUB_PR_ENRICH_BUDGET_PER_SWEEP',
  500,
);
const COMMIT_ENRICH_BUDGET_PER_SWEEP = envBudget(
  'GITHUB_COMMIT_ENRICH_BUDGET_PER_SWEEP',
  500,
);
/**
 * Bounds the per-commit detail calls (for line-change stats) one tick makes,
 * per repo. Commits beyond this budget are left for a later tick rather than
 * ingested with stats missing — ingestion's idempotency key means a commit,
 * once ingested, can never be re-enriched afterward (a later envelope with
 * the same key is dropped as a duplicate before it ever reaches the
 * projector), so "ingest now without stats" would be a permanent gap, not a
 * temporary one. See `syncCommits`.
 */
const COMMIT_ENRICH_BUDGET_PER_TICK = envBudget(
  'GITHUB_COMMIT_ENRICH_BUDGET_PER_TICK',
  25,
);
/**
 * Same rationale as COMMIT_ENRICH_BUDGET_PER_TICK, for pull requests. NOTE one
 * unit here is **4 API calls** — detail (stats + merged_by), commits (Jira
 * keys), reviews, and review comments — none of which are available on the
 * list endpoint. Budget accordingly.
 */
const PR_ENRICH_BUDGET_PER_TICK = envBudget(
  'GITHUB_PR_ENRICH_BUDGET_PER_TICK',
  25,
);
/** Default historical lookback when a connection doesn't set `config.backfillSince`. */
const DEFAULT_BACKFILL_DAYS = 90;

interface GithubSyncCursors {
  prBackfillDone?: boolean;
  /** Next page to fetch — only meaningful while still backfilling. */
  prPage?: number;
  /**
   * Index WITHIN `prPage` where the last tick stopped (enrich budget or rate
   * limit). Without it, a page holding more items than the per-tick enrich
   * budget would restart at index 0 every tick, re-enrich the same first N,
   * and never advance the page — the backfill would never finish.
   */
  prPageOffset?: number;
  /** Watermark: newest PR `updated_at` already ingested (steady-state incremental). */
  prNewestSeenAt?: string;
  /** Floor for the next `/commits?since=` call; advances once a full pass completes. */
  commitsCursor?: string;
  /** Page to resume from within the current cursor's pass. */
  commitsResumePage?: number;
  /** Index within `commitsResumePage` where the last tick stopped — see `prPageOffset`. */
  commitsPageOffset?: number;
  /**
   * How far back each walk has actually reached. GitHub pages newest-first, so
   * these DESCEND as a backfill progresses and settle at the backfill floor
   * once it completes. Tracked per entity because PRs and commits advance
   * independently — the repo is only whole back to whichever has walked less
   * far (see `collectedBackTo`).
   */
  prOldestSeenAt?: string;
  commitsOldestSeenAt?: string;
}

/** The four per-PR calls that make up one unit of the enrich budget. */
interface EnrichedPull {
  detail: GithubPullDetail;
  commits: GithubPullCommits;
  reviews: GithubPullReviews;
  comments: GithubReviewComments;
}

interface SyncResult {
  envelopes: CanonicalEnvelope[];
  rateLimitedUntil?: Date;
  /** The source rejected a request this pass — surfaced on the connection's health. */
  failed?: boolean;
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
  private readonly logger = new Logger(GithubCollector.name);

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
  async poll(
    connection: Connection,
    options: PollOptions = {},
  ): Promise<PollResult> {
    const budgets = enrichBudgets(options.peersDue);
    const config = (connection.config ?? {}) as {
      repoFullName?: string;
      backfillSince?: string;
    };
    const repoFullName = config.repoFullName;
    if (!repoFullName) {
      return { envelopes: [], skipped: 'not-configured' };
    }

    const rateLimitState = (connection.rateLimitState ?? {}) as {
      resetAt?: string;
    };
    if (
      rateLimitState.resetAt &&
      new Date(rateLimitState.resetAt).getTime() > Date.now()
    ) {
      // Reported as skipped, not as an empty success: this pass never called
      // GitHub, so it is not evidence the connection is up to date.
      return { envelopes: [], skipped: 'rate-limited' };
    }

    const token = await this.secrets.resolve(
      connection.tenantId,
      connection.secretRef,
    );
    if (!token) {
      // Recorded, not silent: with no credential every pass returns zero events
      // forever, which is indistinguishable from a healthy idle connection.
      await this.connections.setSyncHealth(
        connection.id,
        `No credential resolved for secret ref "${connection.secretRef ?? '(unset)'}" — set it in admin/configuration or as an environment variable.`,
      );
      return { envelopes: [], skipped: 'no-credential' };
    }

    const cursors: GithubSyncCursors = {
      ...((connection.syncCursors as GithubSyncCursors | null) ?? {}),
    };
    const backfillFloor = await this.resolveBackfillFloor(connection, config);

    const prResult = cursors.prBackfillDone
      ? await this.incrementalPullRequests(
          connection,
          repoFullName,
          token,
          cursors,
          budgets.pr,
        )
      : await this.backfillPullRequests(
          connection,
          repoFullName,
          token,
          cursors,
          backfillFloor,
          budgets.pr,
        );

    const envelopes = [...prResult.envelopes];
    let rateLimitedUntil = prResult.rateLimitedUntil;
    let failed = prResult.failed ?? false;

    if (!rateLimitedUntil) {
      const commitResult = await this.syncCommits(
        connection,
        repoFullName,
        token,
        cursors,
        backfillFloor,
        budgets.commit,
      );
      envelopes.push(...commitResult.envelopes);
      rateLimitedUntil = commitResult.rateLimitedUntil;
      failed = failed || (commitResult.failed ?? false);
    }

    await this.connections.setSyncCursors(
      connection.id,
      cursors as unknown as Record<string, unknown>,
    );
    await this.connections.setRateLimitState(
      connection.id,
      rateLimitedUntil ? { resetAt: rateLimitedUntil.toISOString() } : {},
    );
    // Cleared on a clean pass so a connection recovers by itself.
    await this.connections.setSyncHealth(
      connection.id,
      failed
        ? 'GitHub rejected a request (check the token scope, repository access and that the repo still exists under this name).'
        : null,
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

    return {
      envelopes,
      // Surfaced, not just logged onto the connection's health: without this
      // the scheduler records a pass GitHub refused outright as a successful
      // zero-event sync and stamps `lastSyncAt` (§12 #29).
      failed: failed || undefined,
      collectedThroughAt: completenessWatermark(cursors),
      collectedBackTo: collectedBackTo(cursors, backfillFloor),
    };
  }

  /** Historical pass: pages backward (newest-updated-first) until the backfill floor. */
  private async backfillPullRequests(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
    backfillFloor: Date,
    prBudget: number,
  ): Promise<SyncResult> {
    const envelopes: CanonicalEnvelope[] = [];
    let page = cursors.prPage ?? 1;
    // Where in the current page the previous tick stopped. Resuming mid-page
    // is what lets a page bigger than the enrich budget make progress at all.
    let offset = cursors.prPageOffset ?? 0;
    let enrichBudget = prBudget;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const result = await this.client.listPullRequestsPage(
        repoFullName,
        token,
        page,
      );
      if (result.rateLimitedUntil) {
        this.suspendPrBackfill(cursors, page, offset);
        return { envelopes, rateLimitedUntil: result.rateLimitedUntil };
      }
      if (result.failed) {
        // Revoked token, renamed/deleted repo, SSO-blocked org. An empty page
        // here means the request failed, NOT that history is exhausted —
        // finishing the backfill on it would permanently mark the connection
        // complete having collected nothing.
        this.logger.error(
          `GitHub PR backfill request failed for ${repoFullName} (connection ${connection.id}) — keeping cursors and retrying next tick instead of concluding the backfill is complete.`,
        );
        this.suspendPrBackfill(cursors, page, offset);
        return { envelopes, failed: true };
      }
      // Anchor the incremental watermark to the true newest PR, captured once
      // at the very start of backfill — regardless of how many ticks it takes.
      if (page === 1 && !cursors.prNewestSeenAt && result.items[0]) {
        cursors.prNewestSeenAt =
          result.items[0].updated_at ?? result.items[0].created_at;
      }
      if (result.items.length === 0) {
        this.finishPrBackfill(cursors, backfillFloor);
        return { envelopes };
      }
      for (let i = offset; i < result.items.length; i++) {
        const pr = result.items[i];
        const updatedAt = pr.updated_at ?? pr.created_at;
        if (new Date(updatedAt) < backfillFloor) {
          this.finishPrBackfill(cursors, backfillFloor);
          return { envelopes };
        }
        if (enrichBudget <= 0) {
          // Resume at this exact item next tick — never ingest a PR with
          // permanently-missing stats, and never re-do the items above it.
          this.suspendPrBackfill(cursors, page, i);
          return { envelopes };
        }
        // Walked one item further back. Recorded per item rather than at the
        // end of the pass, so a tick cut short by the budget or a rate limit
        // still reports the ground it actually covered.
        cursors.prOldestSeenAt = this.trackOldest(
          cursors.prOldestSeenAt,
          updatedAt,
        );
        const enriched = await this.enrichPull(repoFullName, token, pr.number);
        enrichBudget--;
        envelopes.push(
          this.fromPolledPull(
            connection,
            repoFullName,
            pr,
            'backfill',
            enriched.detail,
            enriched.commits.messages,
            enriched.reviews,
            enriched.comments,
          ),
        );
        const rateLimitedUntil = this.enrichRateLimit(enriched);
        if (rateLimitedUntil) {
          // This PR is already enriched and emitted — resume after it.
          this.suspendPrBackfill(cursors, page, i + 1);
          return { envelopes, rateLimitedUntil };
        }
      }
      if (!result.hasNextPage) {
        this.finishPrBackfill(cursors, backfillFloor);
        return { envelopes };
      }
      page++;
      offset = 0; // moved to a fresh page — start at its first item
    }

    this.suspendPrBackfill(cursors, page, offset); // budget exhausted
    return { envelopes };
  }

  /**
   * Pins the backfill floor ONCE, on the first poll of a backfill pass, and
   * caches it onto `connection.config.backfillSince` — the same self-heal
   * `JiraCollector.resolveBackfillFloor` performs. Without it, an unset
   * `backfillSince` recomputes `now - N days` fresh every tick, so the floor
   * creeps forward while a multi-tick backfill is still walking and silently
   * truncates the oldest slice of the window it was supposed to collect.
   */
  private async resolveBackfillFloor(
    connection: Connection,
    config: { backfillSince?: string },
  ): Promise<Date> {
    if (config.backfillSince) {
      const parsed = new Date(config.backfillSince);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    const floor = new Date(
      Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.connections.updateConfig(connection.id, {
      config: {
        ...((connection.config as Record<string, unknown>) ?? {}),
        backfillSince: floor.toISOString(),
      },
      status: connection.status,
    });
    return floor;
  }

  /** Persist exactly where this tick stopped, so the next resumes there rather than at the top of the page. */
  private suspendPrBackfill(
    cursors: GithubSyncCursors,
    page: number,
    offset: number,
  ): void {
    cursors.prPage = page;
    cursors.prPageOffset = offset > 0 ? offset : undefined;
  }

  private finishPrBackfill(cursors: GithubSyncCursors, floor: Date): void {
    cursors.prBackfillDone = true;
    cursors.prPage = undefined;
    cursors.prPageOffset = undefined;
    // The walk reached the floor (or ran out of history above it), so PR
    // coverage now extends all the way back to it.
    cursors.prOldestSeenAt = floor.toISOString();
  }

  /** Descends only — the oldest point a walk has reached never moves forward. */
  private trackOldest(current: string | undefined, seen: string): string {
    return current && current < seen ? current : seen;
  }

  /** Steady-state: only page 1, stop as soon as we hit the known watermark. */
  private async incrementalPullRequests(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
    prBudget: number,
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

    if (result.failed) {
      // An empty page here means the request was rejected, not that nothing
      // changed — the same guard the backfill path carries.
      this.logger.error(
        `GitHub incremental PR sync failed for ${repoFullName} (connection ${connection.id}) — keeping the watermark and retrying next tick.`,
      );
      return { envelopes, failed: true };
    }

    const watermark = cursors.prNewestSeenAt;
    // Everything on page 1 this connection has not synced yet, still in
    // GitHub's newest-first order.
    const unsynced: GithubPull[] = [];
    for (const pr of result.items) {
      const updatedAt = pr.updated_at ?? pr.created_at;
      if (watermark && updatedAt <= watermark) {
        break; // sorted desc — everything after this is already synced
      }
      unsynced.push(pr);
    }

    // Did page 1 hold the WHOLE unsynced set? If every item on a full page is
    // unsynced, older unsynced PRs sit on page 2+ that we never fetched, and
    // moving the watermark over them would skip them permanently.
    const sawWholeSet =
      unsynced.length < result.items.length || !result.hasNextPage;

    // OLDEST first — this is the fix, not a detail. The watermark can only
    // move over a contiguous run starting at the oldest unsynced PR, so
    // enriching newest-first meant it could never move at all once the budget
    // ran out: every tick re-enriched the same newest N and the backlog only
    // grew. Harmless while the budget was 25 per connection; near-certain once
    // the fleet budget divides it to 2.
    const ordered = [...unsynced].reverse();

    // The newest PR enriched in an unbroken run from the oldest — the furthest
    // the watermark may honestly advance.
    let lastEnrichedAt: string | undefined;
    let rateLimitedUntil: Date | undefined;

    for (const pr of ordered) {
      if (envelopes.length >= prBudget) {
        break;
      }
      const enriched = await this.enrichPull(repoFullName, token, pr.number);
      envelopes.push(
        this.fromPolledPull(
          connection,
          repoFullName,
          pr,
          'poll',
          enriched.detail,
          enriched.commits.messages,
          enriched.reviews,
        ),
      );
      // Counted as done: it is enriched and emitted before the rate-limit
      // check below, so the watermark may include it.
      lastEnrichedAt = pr.updated_at ?? pr.created_at;
      rateLimitedUntil = this.enrichRateLimit(enriched);
      if (rateLimitedUntil) {
        break;
      }
    }

    if (sawWholeSet && lastEnrichedAt) {
      cursors.prNewestSeenAt = lastEnrichedAt;
    }
    return { envelopes, rateLimitedUntil };
  }

  /** Commits support `since` natively, so backfill + incremental share one loop. */
  private async syncCommits(
    connection: Connection,
    repoFullName: string,
    token: string,
    cursors: GithubSyncCursors,
    backfillFloor: Date,
    commitBudget: number,
  ): Promise<SyncResult> {
    const envelopes: CanonicalEnvelope[] = [];
    const since = cursors.commitsCursor ?? backfillFloor.toISOString();
    const mode: CollectionMode = cursors.commitsCursor ? 'poll' : 'backfill';
    let page = cursors.commitsResumePage ?? 1;
    // Where in the current page the previous tick stopped — see `prPageOffset`.
    let offset = cursors.commitsPageOffset ?? 0;
    // Captured at pass START (not completion) so nothing landing mid-pass is missed.
    const passStartedAt = this.nowIso();
    let enrichBudget = commitBudget;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const result = await this.client.listCommitsPage(
        repoFullName,
        token,
        page,
        since,
      );
      if (result.rateLimitedUntil) {
        this.suspendCommitsPass(cursors, page, offset);
        return { envelopes, rateLimitedUntil: result.rateLimitedUntil };
      }
      if (result.failed) {
        // See the equivalent guard in backfillPullRequests — a failed request
        // must never advance the `since` watermark or end the pass.
        this.logger.error(
          `GitHub commit sync request failed for ${repoFullName} (connection ${connection.id}) — keeping cursors and retrying next tick instead of advancing the watermark.`,
        );
        this.suspendCommitsPass(cursors, page, offset);
        return { envelopes, failed: true };
      }
      for (let i = offset; i < result.items.length; i++) {
        const commit = result.items[i];
        if (enrichBudget <= 0) {
          // Resume at this exact item next tick — never ingest a commit with
          // permanently-missing stats, and never re-do the items above it.
          this.suspendCommitsPass(cursors, page, i);
          return { envelopes };
        }
        cursors.commitsOldestSeenAt = this.trackOldest(
          cursors.commitsOldestSeenAt,
          commit.commit.author?.date ?? passStartedAt,
        );
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
          // This commit is already enriched and emitted — resume after it.
          this.suspendCommitsPass(cursors, page, i + 1);
          return { envelopes, rateLimitedUntil: detail.rateLimitedUntil };
        }
      }
      if (result.items.length === 0 || !result.hasNextPage) {
        cursors.commitsResumePage = undefined;
        cursors.commitsPageOffset = undefined;
        cursors.commitsCursor = passStartedAt;
        // The pass walked its whole `since` range, so commit coverage reaches
        // the backfill floor.
        cursors.commitsOldestSeenAt = this.trackOldest(
          cursors.commitsOldestSeenAt,
          backfillFloor.toISOString(),
        );
        return { envelopes };
      }
      page++;
      offset = 0; // moved to a fresh page — start at its first item
    }

    // budget exhausted — resume next tick, same `since`
    this.suspendCommitsPass(cursors, page, offset);
    return { envelopes };
  }

  /** Persist exactly where this tick stopped within the current `since` pass. */
  private suspendCommitsPass(
    cursors: GithubSyncCursors,
    page: number,
    offset: number,
  ): void {
    cursors.commitsResumePage = page;
    cursors.commitsPageOffset = offset > 0 ? offset : undefined;
  }

  /**
   * The two per-PR calls that make up one unit of the enrich budget: stats
   * (never on the list endpoint) and commit subjects (never on the list, the
   * detail, or the webhook payload — but one of the three documented
   * Jira-key sources, api/README.md §6).
   *
   * Counted as ONE enrichment rather than two so the budget stays a count of
   * PRs made whole per tick; the API cost per unit is 2 calls, not 1.
   */
  private async enrichPull(
    repoFullName: string,
    token: string,
    number: number,
  ): Promise<EnrichedPull> {
    const detail = await this.client.getPullRequestDetail(
      repoFullName,
      token,
      number,
    );
    // Each subsequent call is skipped once rate-limited — it would just 403
    // and the caller is about to stop the tick anyway.
    const commits = detail.rateLimitedUntil
      ? { messages: [] }
      : await this.client.listPullRequestCommits(repoFullName, token, number);
    const reviews =
      detail.rateLimitedUntil || commits.rateLimitedUntil
        ? { reviews: [] }
        : await this.client.listPullRequestReviews(repoFullName, token, number);
    // Only worth counting comments when there is a review to attribute them
    // to — a PR with no reviews spends nothing here.
    const comments =
      reviews.reviews.length === 0 ||
      detail.rateLimitedUntil ||
      commits.rateLimitedUntil ||
      reviews.rateLimitedUntil
        ? { countByReviewId: new Map<string, number>(), truncated: false }
        : await this.client.listPullRequestReviewComments(
            repoFullName,
            token,
            number,
          );
    return { detail, commits, reviews, comments };
  }

  /** The first rate limit any of the four per-PR calls reported, if any. */
  private enrichRateLimit(e: EnrichedPull): Date | undefined {
    return (
      e.detail.rateLimitedUntil ??
      e.commits.rateLimitedUntil ??
      e.reviews.rateLimitedUntil ??
      e.comments.rateLimitedUntil
    );
  }

  /**
   * GitHub's PR list endpoint never includes line-change stats — only a
   * per-PR detail call does (`GithubClient.getPullRequestDetail`, called via
   * `enrichPull` by `backfillPullRequests`/`incrementalPullRequests` under a
   * bounded per-tick budget before this is reached).
   */
  private fromPolledPull(
    connection: Connection,
    repoFullName: string,
    pr: GithubPull,
    mode: CollectionMode,
    detail?: GithubPullDetail,
    commitMessages?: string[],
    reviewResult?: GithubPullReviews,
    comments?: GithubReviewComments,
  ): CanonicalEnvelope {
    const merged = Boolean(pr.merged_at);
    const eventType = merged
      ? EventTypes.CODE_PR_MERGED
      : pr.state === 'open'
        ? EventTypes.CODE_PR_OPENED
        : EventTypes.CODE_PR_CLOSED;
    // A failed reviews request yields undefined, not [] — "this PR has no
    // reviews" is a reportable finding (review_coverage, self_merge_rate) and
    // must never be manufactured from a 500. Undefined leaves the stored
    // timeline untouched; [] would overwrite it.
    // A comment count is only meaningful when the count actually ran. A failed
    // comments call leaves `commentsCounted` false, so "0 comments" can never
    // be read as a rubber stamp on the strength of a failed request.
    const commentsCounted = Boolean(comments && !comments.failed);
    const reviews = (
      reviewResult && !reviewResult.failed ? reviewResult.reviews : undefined
    )?.map((r) => ({
      ...r,
      commentCount: comments?.countByReviewId.get(r.externalId) ?? 0,
      commentsCounted,
    }));
    const sorted = [...(reviews ?? [])].sort((a, b) =>
      a.submittedAt.localeCompare(b.submittedAt),
    );
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
      commitMessages,
      openedAt: pr.created_at,
      // FIRST review and FIRST approval, not the last: the sub-phases measure
      // how long the PR waited for attention, and a later re-review after
      // changes must not erase how long the first one took to arrive.
      firstReviewAt: sorted[0]?.submittedAt,
      approvedAt: sorted.find((r) => r.state === 'approved')?.submittedAt,
      mergedAt: pr.merged_at ?? undefined,
      mergedBy: detail?.mergedBy,
      reviews,
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

/** This connection's share of the sweep, for PR and commit enrichment. */
interface EnrichBudgets {
  pr: number;
  commit: number;
}

/**
 * Splits the fleet's sweep budget across the connections sharing a credential.
 *
 * Clamped at both ends, and both ends matter:
 *  - never above the per-tick ceiling, so a small deployment behaves exactly as
 *    it did before this existed (500 ÷ 2 connections is still capped at 25);
 *  - never below 1, because integer division at extreme fleet sizes floors to
 *    zero — a connection that enriches nothing makes no progress at all while
 *    still spending its list-page calls every tick.
 */
function enrichBudgets(peersDue?: number): EnrichBudgets {
  const peers = peersDue && peersDue > 0 ? peersDue : 1;
  const share = (sweepBudget: number, ceiling: number) =>
    Math.max(1, Math.min(ceiling, Math.floor(sweepBudget / peers)));
  return {
    pr: share(PR_ENRICH_BUDGET_PER_SWEEP, PR_ENRICH_BUDGET_PER_TICK),
    commit: share(
      COMMIT_ENRICH_BUDGET_PER_SWEEP,
      COMMIT_ENRICH_BUDGET_PER_TICK,
    ),
  };
}

/**
 * The point in source time this repo is genuinely complete through — the
 * **older** of the two independent watermarks, because PRs and commits advance
 * separately and the repo is only whole up to whichever lags.
 *
 * Undefined until BOTH backfills have finished. `prPage`/`commitsResumePage`
 * mean a walk is still in flight, and `prNewestSeenAt` is captured from page 1
 * at the very START of that walk — so during backfill it names a time whose
 * history has demonstrably not been collected yet. Reporting it as completeness
 * would invert the truth precisely when the connection is least complete.
 */
function completenessWatermark(cursors: GithubSyncCursors): Date | undefined {
  if (!cursors.prBackfillDone || !cursors.commitsCursor) {
    return undefined;
  }
  const candidates = [cursors.prNewestSeenAt, cursors.commitsCursor]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (candidates.length < 2) {
    return undefined;
  }
  return candidates.reduce((oldest, d) => (d < oldest ? d : oldest));
}

/**
 * How far back this repo is actually collected — the **newer** of the two
 * walks, because PRs and commits page independently and the repo is only whole
 * back to whichever has covered less ground.
 *
 * Undefined until both have walked at all: a side that has not started has no
 * coverage, and reporting the other side's depth would claim history for an
 * entity nobody has fetched. Once both backfills finish, both settle at the
 * floor and this is the floor.
 */
function collectedBackTo(
  cursors: GithubSyncCursors,
  floor: Date,
): Date | undefined {
  // Both walks finished: coverage reaches the floor by definition. Checked
  // FIRST so this self-heals connections that completed their backfill before
  // the per-walk cursors existed — they have neither, and would otherwise
  // report no coverage at all despite being fully collected.
  if (cursors.prBackfillDone && cursors.commitsCursor) {
    return floor;
  }
  const ends = [cursors.prOldestSeenAt, cursors.commitsOldestSeenAt];
  if (ends.some((v) => typeof v !== 'string')) {
    return undefined;
  }
  const dates = (ends as string[])
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (dates.length < 2) {
    return undefined;
  }
  const shallowest = dates.reduce((newest, d) => (d > newest ? d : newest));
  // Never claim to reach further back than the window actually being collected.
  return shallowest < floor ? floor : shallowest;
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
