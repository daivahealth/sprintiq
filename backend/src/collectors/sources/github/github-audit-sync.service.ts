import { Injectable, Logger } from '@nestjs/common';
import { Connection, GithubPushRange } from '@prisma/client';
import { forEachBounded } from '../../../common/concurrency';
import { CodeCommitPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { IngestionService } from '../../ingestion/ingestion.service';
import {
  GithubAuditConfig,
  readGithubAuditConfig,
} from './github-audit.config';
import {
  GitPushAuditEvent,
  GithubAuditLogClient,
} from './github-audit-log.client';
import {
  countRanges,
  DEFAULT_BRANCH_MARKER,
  dedupePushes,
  diffTips,
  pushesByRepo,
} from './github-audit-push-planner';
import {
  buildCommitEnvelope,
  commitIdempotencyKey,
} from './github-commit-envelope';
import { evaluateBudget, rateReserve } from './github-rate-budget';
import {
  GithubCallFailure,
  GithubClient,
  GithubCompareResult,
  GithubRateLimit,
} from './github.client';

export interface AuditRunCounters {
  reposSeeded: number;
  /** Repos skipped because GitHub answered 404/403 for them (deleted, renamed, or no access) — never block seeding or the checkpoint. */
  reposUnseedable: number;
  auditPages: number;
  auditNextTraversals: number;
  auditEvents: number;
  uniquePushes: number;
  reposTouched: number;
  reposUnregistered: number;
  refsMoved: number;
  refsNew: number;
  refsDeleted: number;
  compareCandidatesNaive: number;
  compareRequestsPlanned: number;
  compareRequestsSaved: number;
  compareRequestsExecuted: number;
  comparePages: number;
  commitsDiscovered: number;
  alreadyPresent: number;
  ingested: number;
  wouldIngest: number;
  commitsWithoutLogin: number;
  truncatedRanges: number;
  failedRanges: number;
  pendingRanges: number;
  auditRateRemaining?: number;
  coreRateRemaining?: number;
}

export interface AuditRunSummary {
  tenantId: string;
  runId?: string;
  status: 'skipped' | 'seeded' | 'success' | 'partial' | 'failed';
  reason?: string;
  counters: AuditRunCounters;
  windowFrom?: Date;
  checkpointAt?: Date;
  durationMs: number;
}

export interface RunContext {
  tenantId: string;
  runId: string;
  cfg: GithubAuditConfig;
  counters: AuditRunCounters;
  now: Date;
  organization: string;
  auditToken: string;
  repos: Map<string, Connection>;
  tokens: Map<string, string>;
  stopForBudget: boolean;
  /** Run-level estimate of `core` quota left above the reserve; undefined until a Compare reports a reading (review round 1, issue 1). */
  coreBudget?: number;
  /** Idempotency keys already resolved this run, so a commit reachable from two ranges is counted once, not once per range (review round 1, issue 5). */
  seenKeys: Set<string>;
  /** Repos skipped as unseedable (404/403) this run, named in `run.error`. */
  unseedable: string[];
  /** Repos whose seeding was skipped because the core budget reached the reserve. */
  budgetSkipped: string[];
}

/** One commit's outcome inside a push range — the per-SHA evidence shadow-mode acceptance compares with ground truth (spec §9 step 3). */
export type CommitOutcome = {
  sha: string;
  outcome: 'ingested' | 'alreadyPresent' | 'wouldIngest';
};

type SeedOutcome = 'seeded' | 'unseedable' | 'budget' | 'failed';

/**
 * A run claim older than this is treated as abandoned (crashed process) and
 * taken over. Sized well above any realistic run — including the first
 * ingest-mode run, which replays up to a week of shadowed ranges — so a slow
 * but live run is never run over by a second one.
 */
export const RUN_CLAIM_STALE_MS = 60 * 60_000;

/** At most this many repos are named in `run.error` for one note. */
const MAX_NAMED_REPOS = 10;

const BUDGET_NOT_PLANNED =
  'not planned: the core rate budget reached the reserve (GITHUB_BACKFILL_RATE_RESERVE)';

function isUnseedable(failure?: GithubCallFailure): boolean {
  return failure === 'not_found' || failure === 'forbidden';
}

function nameRepos(repos: string[]): string {
  const shown = repos.slice(0, MAX_NAMED_REPOS).join(', ');
  return repos.length > MAX_NAMED_REPOS
    ? `${shown} (+${repos.length - MAX_NAMED_REPOS} more)`
    : shown;
}

/** Git events live 7 days (spec F6); warn a day before the window is lost. */
export const RETENTION_RISK_MS = 6 * 86_400_000;

/** GitHub's actual git-event retention (spec F6) — past this, the audit log can no longer answer for the window. */
const RETENTION_LOSS_MS = 7 * 86_400_000;

/** Shadow-mode ranges younger than this are replayed when the mode becomes `ingest`. */
export const SHADOW_REPLAY_MS = 7 * 86_400_000;

export function emptyCounters(): AuditRunCounters {
  return {
    reposSeeded: 0,
    reposUnseedable: 0,
    auditPages: 0,
    auditNextTraversals: 0,
    auditEvents: 0,
    uniquePushes: 0,
    reposTouched: 0,
    reposUnregistered: 0,
    refsMoved: 0,
    refsNew: 0,
    refsDeleted: 0,
    compareCandidatesNaive: 0,
    compareRequestsPlanned: 0,
    compareRequestsSaved: 0,
    compareRequestsExecuted: 0,
    comparePages: 0,
    commitsDiscovered: 0,
    alreadyPresent: 0,
    ingested: 0,
    wouldIngest: 0,
    commitsWithoutLogin: 0,
    truncatedRanges: 0,
    failedRanges: 0,
    pendingRanges: 0,
  };
}

/**
 * Third commit-discovery route (BC-1, ADR-0010): org audit log → touched repos
 * → branch-tip diff → Compare → the ordinary ingestion pipeline.
 *
 * The audit log is the change DETECTOR (which repos were pushed to, by whom,
 * when); it cannot say which ref or SHAs (spec F2), so the ranges come from
 * diffing branch tips. The checkpoint moves only once a window's complete
 * audit set is fetched AND its work is durably queued, so a failure anywhere
 * before that re-reads the window, and a failure after it is a retry of a
 * persisted range — never lost data (spec §4.5).
 */
@Injectable()
export class GithubAuditSyncService {
  private readonly logger = new Logger(GithubAuditSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly ingestion: IngestionService,
    private readonly auditClient: GithubAuditLogClient,
    private readonly client: GithubClient,
  ) {}

  /** Tenants with an active GitHub configuration that names an audit-log token ref. */
  async listEnabledTenants(): Promise<string[]> {
    const rows = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: 'github', key: 'default', status: 'active' },
      select: { tenantId: true, secretRefs: true },
    });
    return rows
      .filter(
        (r) =>
          typeof (r.secretRefs as Record<string, unknown> | null)
            ?.auditLogTokenRef === 'string',
      )
      .map((r) => r.tenantId);
  }

  async runTenant(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditRunSummary> {
    const startedMs = Date.now();
    const counters = emptyCounters();
    const skipped = (reason: string): AuditRunSummary => ({
      tenantId,
      status: 'skipped',
      reason,
      counters,
      durationMs: Date.now() - startedMs,
    });
    if (cfg.mode === 'off') {
      return skipped('GITHUB_AUDIT_SYNC_MODE is off.');
    }
    const settings = await this.loadSettings(tenantId);
    if ('reason' in settings) {
      return skipped(settings.reason);
    }

    // Loaded — and allowed to fail gracefully — before any run row exists, so a
    // thrown error here never leaves a `githubAuditRun` row stuck at 'running'.
    let repos: Map<string, Connection>;
    try {
      repos = await this.registeredRepos(tenantId);
    } catch (err) {
      return {
        tenantId,
        status: 'failed',
        reason: (err as Error).message.slice(0, 500),
        counters,
        durationMs: Date.now() - startedMs,
      };
    }

    // Per-tenant claim, shared by the cron and the manual admin endpoint, so
    // two runs for one tenant never plan/execute the same window at once. The
    // row must exist before it can be claimed; the upsert leaves
    // seededAt/checkpointAt untouched on an existing row.
    await this.prisma.githubAuditCheckpoint.upsert({
      where: { tenantId },
      create: { id: newId(), tenantId, organization: settings.organization },
      update: { organization: settings.organization },
    });
    const claim = await this.prisma.githubAuditCheckpoint.updateMany({
      where: {
        tenantId,
        OR: [
          { runningSince: null },
          {
            runningSince: { lt: new Date(now.getTime() - RUN_CLAIM_STALE_MS) },
          },
        ],
      },
      data: { runningSince: now },
    });
    if (claim.count === 0) {
      return skipped('Another audit sync run for this tenant is in progress.');
    }
    try {
      return await this.runClaimed(
        tenantId,
        cfg,
        now,
        settings,
        repos,
        counters,
        startedMs,
      );
    } finally {
      try {
        // Release only OUR claim: if a stale claim of ours was taken over,
        // the newer run's claim must stay in place.
        await this.prisma.githubAuditCheckpoint.updateMany({
          where: { tenantId, runningSince: now },
          data: { runningSince: null },
        });
      } catch (err) {
        this.logger.error(
          `[tenant ${tenantId}] could not release the audit sync run claim (it expires after ${RUN_CLAIM_STALE_MS / 60_000} min): ${(err as Error).message}`,
        );
      }
    }
  }

  private async runClaimed(
    tenantId: string,
    cfg: GithubAuditConfig,
    now: Date,
    settings: { organization: string; auditToken: string },
    repos: Map<string, Connection>,
    counters: AuditRunCounters,
    startedMs: number,
  ): Promise<AuditRunSummary> {
    const checkpoint = await this.prisma.githubAuditCheckpoint.findUnique({
      where: { tenantId },
    });
    const run = await this.prisma.githubAuditRun.create({
      data: {
        id: newId(),
        tenantId,
        mode: cfg.mode,
        startedAt: now,
        status: 'running',
        counters: {},
      },
    });
    const ctx: RunContext = {
      tenantId,
      runId: run.id,
      cfg,
      counters,
      now,
      organization: settings.organization,
      auditToken: settings.auditToken,
      repos,
      tokens: new Map(),
      stopForBudget: false,
      seenKeys: new Set(),
      unseedable: [],
      budgetSkipped: [],
    };

    let status: AuditRunSummary['status'] = 'success';
    let error: string | undefined;
    let windowFrom: Date | undefined;
    let checkpointAt = checkpoint?.checkpointAt ?? undefined;
    // Snapshot BEFORE this run can advance the checkpoint, so a successful run
    // from a stale checkpoint still gets flagged — checking the post-advance
    // value (now) would always read as fresh (defect fixed in review round 1).
    const priorCheckpointAt =
      checkpoint?.checkpointAt ?? checkpoint?.seededAt ?? undefined;

    try {
      if (!checkpoint?.seededAt) {
        const allSeeded = await this.seedAll(ctx);
        if (allSeeded) {
          await this.prisma.githubAuditCheckpoint.upsert({
            where: { tenantId },
            create: {
              id: newId(),
              tenantId,
              organization: ctx.organization,
              seededAt: now,
              checkpointAt: now,
            },
            update: {
              organization: ctx.organization,
              seededAt: now,
              checkpointAt: now,
            },
          });
          checkpointAt = now;
          status = 'seeded';
        } else {
          status = 'partial';
          error =
            'Some repositories could not be seeded; they are retried next run before discovery starts.';
          if (ctx.budgetSkipped.length > 0) {
            error += ` ${ctx.budgetSkipped.length} repo(s) were left unseeded because the core rate budget reached the reserve (GITHUB_BACKFILL_RATE_RESERVE).`;
          }
        }
      } else {
        const from = checkpoint.checkpointAt ?? checkpoint.seededAt;
        windowFrom = new Date(from.getTime() - cfg.overlapMinutes * 60_000);
        const discovered = await this.discover(ctx, windowFrom);
        if (discovered.ok) {
          await this.prisma.githubAuditCheckpoint.update({
            where: { tenantId },
            data: { checkpointAt: now },
          });
          checkpointAt = now;
        } else {
          status = 'failed';
          error = discovered.error;
        }
      }

      // Independent of whether THIS window's discovery succeeded: ranges
      // queued by earlier runs are retried regardless.
      if (checkpoint?.seededAt) {
        await this.executePending(ctx);
      }
    } catch (err) {
      status = 'failed';
      error = (err as Error).message.slice(0, 500);
    }

    if (ctx.unseedable.length > 0) {
      const note = `${ctx.unseedable.length} repo(s) skipped as unseedable (GitHub answered 404/403 — deleted, renamed or no access): ${nameRepos(ctx.unseedable)}.`;
      error = error ? `${error} ${note}` : note;
    }

    if (
      priorCheckpointAt &&
      now.getTime() - priorCheckpointAt.getTime() > RETENTION_RISK_MS
    ) {
      const ageMs = now.getTime() - priorCheckpointAt.getTime();
      let warning = `Retention risk: the audit checkpoint is ${Math.round(ageMs / 3_600_000)}h old and GitHub keeps git events for 7 days.`;
      if (ageMs > RETENTION_LOSS_MS) {
        warning +=
          " This window is older than GitHub's 7-day git-event retention and cannot be recovered from the audit log.";
      }
      this.logger.error(`[tenant ${tenantId}] ${warning}`);
      error = error ? `${warning} ${error}` : warning;
    }

    await this.prisma.githubAuditRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status,
        error: error ?? null,
        windowFrom: windowFrom ?? null,
        windowTo: windowFrom ? now : null,
        counters: counters as unknown as object,
      },
    });
    await this.prisma.githubAuditCheckpoint.updateMany({
      where: { tenantId },
      data: { lastRunAt: now, lastStatus: status, lastError: error ?? null },
    });

    const durationMs = Date.now() - startedMs;
    this.logger.log(
      `github audit sync tenant=${tenantId} mode=${cfg.mode} status=${status} ` +
        Object.entries(counters)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') +
        ` durationMs=${durationMs}`,
    );
    return {
      tenantId,
      runId: run.id,
      status,
      reason: error,
      counters,
      windowFrom,
      checkpointAt,
      durationMs,
    };
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<
    { organization: string; auditToken: string } | { reason: string }
  > {
    const config = await this.prisma.tenantConfiguration.findUnique({
      where: {
        tenantId_namespace_key: {
          tenantId,
          namespace: 'github',
          key: 'default',
        },
      },
    });
    const values = (config?.values ?? {}) as Record<string, unknown>;
    const refs = (config?.secretRefs ?? {}) as Record<string, unknown>;
    if (
      !config ||
      config.status !== 'active' ||
      typeof values.organization !== 'string'
    ) {
      return {
        reason: 'GitHub is not configured (organization, saved as active).',
      };
    }
    if (typeof refs.auditLogTokenRef !== 'string') {
      return {
        reason: 'No audit-log token secret ref is configured for GitHub.',
      };
    }
    const auditToken = await this.secrets.resolve(
      tenantId,
      refs.auditLogTokenRef,
    );
    if (!auditToken) {
      return {
        reason: `No value is stored for audit-log token ref "${refs.auditLogTokenRef}".`,
      };
    }
    return { organization: values.organization, auditToken };
  }

  private async registeredRepos(
    tenantId: string,
  ): Promise<Map<string, Connection>> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, sourceSystem: 'github', status: 'active' },
    });
    const byRepo = new Map<string, Connection>();
    for (const c of connections) {
      const repo = (c.config as { repoFullName?: string } | null)?.repoFullName;
      if (repo) byRepo.set(repo, c);
    }
    return byRepo;
  }

  /** The collector's own token for a repo (never the audit token), cached per secret ref for this run. */
  protected async collectorToken(
    ctx: RunContext,
    connection: Connection,
  ): Promise<string> {
    const ref = connection.secretRef ?? '';
    if (!ctx.tokens.has(ref)) {
      ctx.tokens.set(
        ref,
        await this.secrets.resolve(ctx.tenantId, connection.secretRef),
      );
    }
    return ctx.tokens.get(ref) ?? '';
  }

  /** One-off pass storing every repo's tips; repos already seeded are skipped. */
  private async seedAll(ctx: RunContext): Promise<boolean> {
    const markers = await this.prisma.githubRefTip.findMany({
      where: { tenantId: ctx.tenantId, ref: DEFAULT_BRANCH_MARKER },
    });
    const done = new Set(markers.map((m) => m.repoFullName));
    // Unseedable (404/403) repos do not block completion — they would hold
    // seeding, and so the whole route, forever. Transient failures and
    // budget skips do: they are retried next run.
    let complete = true;
    const todo = [...ctx.repos.entries()].filter(([repo]) => !done.has(repo));
    await forEachBounded(
      todo,
      ctx.cfg.compareConcurrency,
      async ([repo, connection]) => {
        const outcome = await this.seedRepo(ctx, repo, connection);
        if (outcome === 'seeded') ctx.counters.reposSeeded++;
        else if (outcome === 'budget') {
          ctx.budgetSkipped.push(repo);
          complete = false;
        } else if (outcome === 'failed') complete = false;
      },
    );
    return complete;
  }

  /**
   * Refreshes the run-level `core` budget from a response's rate-limit
   * reading (remaining − reserve) and charges `calls` against it; at or below
   * zero the run stops spending `core` (seeding, listing, Compare, detail).
   */
  private chargeCore(
    ctx: RunContext,
    rateLimit: GithubRateLimit | undefined,
    calls = 1,
  ): void {
    if (rateLimit) {
      ctx.coreBudget = rateLimit.remaining - rateReserve();
      ctx.counters.coreRateRemaining = rateLimit.remaining;
    }
    if (ctx.coreBudget !== undefined) {
      ctx.coreBudget -= calls;
      if (ctx.coreBudget <= 0) ctx.stopForBudget = true;
    }
  }

  private seedFailure(
    ctx: RunContext,
    repo: string,
    failure: GithubCallFailure | undefined,
  ): SeedOutcome {
    this.logger.warn(
      `[tenant ${ctx.tenantId}] could not seed ${repo}: ${failure ?? 'unknown'}`,
    );
    if (isUnseedable(failure)) {
      this.noteUnseedable(ctx, repo);
      return 'unseedable';
    }
    if (failure === 'rate_limited') ctx.stopForBudget = true;
    return 'failed';
  }

  private noteUnseedable(ctx: RunContext, repo: string): void {
    ctx.counters.reposUnseedable++;
    ctx.unseedable.push(repo);
  }

  private async seedRepo(
    ctx: RunContext,
    repo: string,
    connection: Connection,
  ): Promise<SeedOutcome> {
    if (ctx.stopForBudget) return 'budget';
    const token = await this.collectorToken(ctx, connection);
    const branch = await this.client.getDefaultBranch(repo, token);
    this.chargeCore(ctx, branch.rateLimit);
    if (!branch.name) return this.seedFailure(ctx, repo, branch.failure);
    if (ctx.stopForBudget) return 'budget';
    const refs = await this.client.listHeadRefs(repo, token);
    this.chargeCore(ctx, refs.rateLimit);
    if (!refs.tips) return this.seedFailure(ctx, repo, refs.failure);
    const rows = [
      { ref: DEFAULT_BRANCH_MARKER, sha: branch.name },
      ...[...refs.tips].map(([ref, sha]) => ({ ref, sha })),
    ].map((t) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      repoFullName: repo,
      seenAt: ctx.now,
      ...t,
    }));
    await this.prisma.$transaction(async (tx) => {
      await tx.githubRefTip.deleteMany({
        where: { tenantId: ctx.tenantId, repoFullName: repo },
      });
      await tx.githubRefTip.createMany({ data: rows });
    });
    return 'seeded';
  }

  private async discover(
    ctx: RunContext,
    windowFrom: Date,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { counters } = ctx;
    const audit = await this.auditClient.listGitPushes(
      ctx.organization,
      ctx.auditToken,
      windowFrom,
      ctx.cfg.pageSize,
      ctx.cfg.maxPages,
    );
    counters.auditPages = audit.pages;
    if (audit.status !== 'complete') {
      return {
        ok: false,
        error: `Audit log ${audit.status}: ${audit.message}`,
      };
    }
    counters.auditNextTraversals = audit.nextTraversals;
    counters.auditEvents = audit.events.length;
    counters.auditRateRemaining = audit.rateLimitRemaining;

    const pushes = dedupePushes(audit.events);
    counters.uniquePushes = pushes.length;
    // `compareCandidatesNaive` ("one Compare per push") is accumulated in
    // planRepo, only for repos that were registered AND already seeded at
    // plan time — unregistered and seed-only repos could never be Compared,
    // so counting them would overstate `compareRequestsSaved`.

    const touched = [...pushesByRepo(pushes).entries()].filter(([repo]) => {
      if (ctx.repos.has(repo)) return true;
      counters.reposUnregistered++;
      return false;
    });
    counters.reposTouched = touched.length;

    const failures: string[] = [];
    await forEachBounded(
      touched,
      ctx.cfg.compareConcurrency,
      async ([repo, events]) => {
        const connection = ctx.repos.get(repo) as Connection;
        for (const e of events) {
          await this.ingestion.ingest(
            ctx.tenantId,
            pushEnvelope(connection.id, e, ctx.now),
          );
        }
        const planned = await this.planRepo(
          ctx,
          repo,
          connection,
          events.map((e) => e.documentId),
        );
        if (!planned.ok) failures.push(`${repo}: ${planned.error}`);
      },
    );
    counters.compareRequestsSaved = Math.max(
      0,
      counters.compareCandidatesNaive - counters.compareRequestsPlanned,
    );

    return failures.length === 0
      ? { ok: true }
      : {
          ok: false,
          error: `Could not list branches for ${failures.length} repo(s): ${failures.slice(0, 5).join('; ')}`,
        };
  }

  private async planRepo(
    ctx: RunContext,
    repo: string,
    connection: Connection,
    documentIds: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const stored = await this.prisma.githubRefTip.findMany({
      where: { tenantId: ctx.tenantId, repoFullName: repo },
    });
    const marker = stored.find((t) => t.ref === DEFAULT_BRANCH_MARKER);
    if (!marker) {
      // Never seen: seed only. Its first push stays with the existing routes (spec §10).
      const outcome = await this.seedRepo(ctx, repo, connection);
      if (outcome === 'seeded') ctx.counters.reposSeeded++;
      if (outcome === 'seeded' || outcome === 'unseedable') return { ok: true };
      return {
        ok: false,
        error: outcome === 'budget' ? BUDGET_NOT_PLANNED : 'seed failed',
      };
    }
    // Not listed → not planned: the window must be re-read, so this holds
    // the checkpoint (the reason lands in run.error via discover()).
    if (ctx.stopForBudget) return { ok: false, error: BUDGET_NOT_PLANNED };
    const token = await this.collectorToken(ctx, connection);
    const refs = await this.client.listHeadRefs(repo, token);
    this.chargeCore(ctx, refs.rateLimit);
    if (!refs.tips) {
      if (isUnseedable(refs.failure)) {
        // Deleted / renamed / access revoked: nothing to plan, ever — skip it
        // rather than hold the checkpoint for every other repo.
        this.noteUnseedable(ctx, repo);
        return { ok: true };
      }
      if (refs.failure === 'rate_limited') ctx.stopForBudget = true;
      return { ok: false, error: refs.failure ?? 'failed' };
    }
    ctx.counters.compareCandidatesNaive += documentIds.length;

    const diff = diffTips(
      repo,
      new Map(
        stored
          .filter((t) => t.ref !== DEFAULT_BRANCH_MARKER)
          .map((t) => [t.ref, t.sha]),
      ),
      refs.tips,
      marker.sha,
    );
    const c = countRanges(diff.ranges);
    ctx.counters.compareRequestsPlanned += c.compareRequestsPlanned;
    ctx.counters.refsMoved += c.refsMoved;
    ctx.counters.refsNew += c.refsNew;
    ctx.counters.refsDeleted += c.refsDeleted;

    await this.prisma.$transaction(async (tx) => {
      for (const r of diff.ranges) {
        await tx.githubPushRange.create({
          data: {
            id: newId(),
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            connectionId: connection.id,
            repoFullName: repo,
            ref: r.ref,
            baseSha: r.baseSha ?? null,
            baseRef: r.baseRef ?? null,
            headSha: r.headSha ?? null,
            kind: r.kind,
            auditDocumentIds: documentIds,
            status: r.kind === 'deleted' ? 'done' : 'pending',
          },
        });
      }
      for (const u of diff.upserts) {
        await tx.githubRefTip.upsert({
          where: {
            tenantId_repoFullName_ref: {
              tenantId: ctx.tenantId,
              repoFullName: repo,
              ref: u.ref,
            },
          },
          create: {
            id: newId(),
            tenantId: ctx.tenantId,
            repoFullName: repo,
            ref: u.ref,
            sha: u.sha,
            seenAt: ctx.now,
          },
          update: { sha: u.sha, seenAt: ctx.now },
        });
      }
      if (diff.deletes.length > 0) {
        await tx.githubRefTip.deleteMany({
          where: {
            tenantId: ctx.tenantId,
            repoFullName: repo,
            ref: { in: diff.deletes },
          },
        });
      }
    });
    return { ok: true };
  }

  private async executePending(ctx: RunContext): Promise<void> {
    // `pending` ranges are always eligible until they finish or hit
    // maxRangeAttempts — the 7-day window applies only to `shadowed` ranges,
    // which ingest mode replays. A `pending` range aging out here would be
    // silently abandoned while still counted in `pendingRanges` (review
    // round 1, issue 4).
    const where =
      ctx.cfg.mode === 'ingest'
        ? {
            tenantId: ctx.tenantId,
            OR: [
              { status: 'pending' },
              {
                status: 'shadowed',
                createdAt: {
                  gte: new Date(ctx.now.getTime() - SHADOW_REPLAY_MS),
                },
              },
            ],
          }
        : { tenantId: ctx.tenantId, status: 'pending' };
    const ranges = await this.prisma.githubPushRange.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    await forEachBounded(ranges, ctx.cfg.compareConcurrency, async (range) => {
      if (ctx.stopForBudget) return;
      await this.executeRange(ctx, range);
    });
    ctx.counters.pendingRanges = (
      await this.prisma.githubPushRange.findMany({
        where: { tenantId: ctx.tenantId, status: { in: ['pending'] } },
      })
    ).length;
  }

  private async executeRange(
    ctx: RunContext,
    range: GithubPushRange,
  ): Promise<void> {
    const connection = [...ctx.repos.values()].find(
      (c) => c.id === range.connectionId,
    );
    // Declared before `fail` and outside the try so a `finally` can flush
    // them to ctx.counters on EVERY exit path (success, budget stop,
    // detail-missing failure, or a thrown exception) — a mid-range throw must
    // never drop the commits already ingested before it (review round 1,
    // issue 3) — and so every partial exit also writes the per-SHA evidence
    // processed so far onto the range (final review I-2).
    let alreadyPresent = 0;
    let ingested = 0;
    let commitsFound: number | undefined;
    const outcomes: CommitOutcome[] = [];
    const progress = () =>
      commitsFound === undefined
        ? {}
        : {
            commitsFound,
            alreadyPresent,
            ingested,
            commitOutcomes: outcomes,
          };
    const fail = async (message: string) => {
      const attempts = range.attempts + 1;
      const failed = attempts >= ctx.cfg.maxRangeAttempts;
      if (failed) ctx.counters.failedRanges++;
      await this.prisma.githubPushRange.update({
        where: { id: range.id },
        data: {
          attempts,
          status: failed ? 'failed' : 'pending',
          lastError: message.slice(0, 500),
          ...progress(),
        },
      });
    };
    if (!connection || !range.headSha) {
      await fail(
        connection
          ? 'Range has no head SHA.'
          : 'Connection is no longer active.',
      );
      return;
    }
    try {
      const token = await this.collectorToken(ctx, connection);
      const compared = await this.compareRange(ctx, range, token);
      if (compared.failure === 'rate_limited') {
        ctx.stopForBudget = true;
        return;
      }
      if (compared.failure) {
        await fail(`Compare ${compared.failure}`);
        return;
      }
      ctx.counters.compareRequestsExecuted++;
      ctx.counters.comparePages += compared.pages;
      ctx.counters.commitsDiscovered += compared.commits.length;
      if (compared.truncated) ctx.counters.truncatedRanges++;
      commitsFound = compared.commits.length;

      // Run-level `core` budget estimate (review round 1, issue 1): refresh
      // from the latest reading, then charge this Compare's own pages so a
      // range that burns the rest of the reserve on Compare never reaches
      // the per-commit detail calls below. Concurrent ranges share `ctx`, so
      // one range crossing zero stops every other range's next detail call
      // too, not just its own.
      this.chargeCore(ctx, compared.rateLimit, compared.pages);

      let detailFailure: string | undefined;
      let stoppedForBudget = false;
      for (const c of compared.commits) {
        if (!c.authorLogin) ctx.counters.commitsWithoutLogin++;
        const key = commitIdempotencyKey(range.repoFullName, c.sha);
        if (ctx.seenKeys.has(key)) {
          alreadyPresent++;
          outcomes.push({ sha: c.sha, outcome: 'alreadyPresent' });
          continue;
        }
        if (ctx.cfg.mode === 'shadow') {
          // Shadow mode can never fail after this point, so — exactly as in
          // review round 1 — the key is claimed synchronously, before the
          // `rawEvent` lookup's `await` below, so a concurrent shadow range
          // resolving the same commit always sees the claim rather than
          // racing it (claiming AFTER that `await`, like ingest mode now
          // does, would reopen the round-1 race here, since both ranges
          // could then pass the lookup before either claims).
          ctx.seenKeys.add(key);
          const existing = await this.prisma.rawEvent.findUnique({
            where: {
              tenantId_idempotencyKey: {
                tenantId: ctx.tenantId,
                idempotencyKey: key,
              },
            },
            select: { id: true },
          });
          if (existing) {
            alreadyPresent++;
            outcomes.push({ sha: c.sha, outcome: 'alreadyPresent' });
          } else {
            ctx.counters.wouldIngest++;
            outcomes.push({ sha: c.sha, outcome: 'wouldIngest' });
          }
          continue;
        }

        // Ingest mode: the key is deliberately NOT claimed yet. It is
        // claimed below only once the outcome is known to be final — either
        // "already present" (a completed fact) or "ingestion.ingest actually
        // returned" — never while the commit might still fail to be
        // ingested by this range (review round 2: claiming any earlier, as
        // round 1's ruling had it, stranded a commit forever if this range
        // then hit a budget stop, a stats-less detail call, or a thrown
        // exception before ingesting it, and had no attempts left).
        const existing = await this.prisma.rawEvent.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: ctx.tenantId,
              idempotencyKey: key,
            },
          },
          select: { id: true },
        });
        if (existing) {
          ctx.seenKeys.add(key);
          alreadyPresent++;
          outcomes.push({ sha: c.sha, outcome: 'alreadyPresent' });
          continue;
        }
        if (ctx.stopForBudget) {
          // NOT claimed: this commit was never ingested, so a sibling range
          // or the next run must still be free to pick it up.
          stoppedForBudget = true;
          break;
        }
        const detail = await this.client.getCommitDetail(
          range.repoFullName,
          token,
          c.sha,
        );
        if (ctx.coreBudget !== undefined) {
          ctx.coreBudget -= 1;
          if (ctx.coreBudget <= 0) ctx.stopForBudget = true;
        }
        if (detail.rateLimitedUntil && detail.additions === undefined) {
          // No stats to write and quota gone: leave the range pending. Commits
          // already ingested above are dropped as duplicates on the retry.
          ctx.stopForBudget = true;
          stoppedForBudget = true;
          break;
        }
        if (detail.additions === undefined) {
          // Stats-less for a reason OTHER than rate-limiting (404, 5xx, blank
          // token): never ingest a commit with no line stats permanently —
          // fail this attempt so the next run retries the detail call
          // (review round 1, issue 2).
          detailFailure = `Commit detail unavailable for ${c.sha.slice(0, 7)}`;
          break;
        }
        const payload: CodeCommitPayload = {
          repoFullName: range.repoFullName,
          sha: c.sha,
          message: c.message,
          authorLogin: c.authorLogin,
          authorName: c.authorName,
          authorEmail: c.authorEmail,
          authoredAt: c.authoredAt ?? ctx.now.toISOString(),
          committedAt: detail.committedAt ?? c.committedAt,
          additions: detail.additions,
          deletions: detail.deletions,
          filesChanged: detail.filesChanged,
          parentCount: c.parentCount,
        };
        const result = await this.ingestion.ingest(
          ctx.tenantId,
          buildCommitEnvelope({
            connectionId: connection.id,
            mode: 'poll',
            repoFullName: range.repoFullName,
            payload,
            extraRefs: {
              ref: range.ref,
              discoveredBy: 'github-audit-compare',
              pushRangeId: range.id,
            },
          }),
        );
        // Claimed only now, after ingestion.ingest has actually returned
        // (accepted or duplicate) — never before. A commit that failed
        // above (budget stop, detail failure, or a thrown exception) is
        // thus never marked seen, so a sibling range or the next run can
        // still ingest it (review round 2; claiming it synchronously at
        // the top of the loop, per round 1's ruling, could strand it
        // forever if this range then failed or ran out of attempts).
        // Two concurrent ranges may now occasionally both call
        // getCommitDetail for the same commit — accepted cost; ingestion's
        // idempotency key keeps the data correct either way.
        ctx.seenKeys.add(key);
        if (result.status === 'accepted') {
          ingested++;
          outcomes.push({ sha: c.sha, outcome: 'ingested' });
        } else {
          alreadyPresent++;
          outcomes.push({ sha: c.sha, outcome: 'alreadyPresent' });
        }
        if (detail.rateLimitedUntil) ctx.stopForBudget = true;
      }

      if (detailFailure) {
        await fail(detailFailure);
        return;
      }
      if (stoppedForBudget) {
        // Leave the range pending for the next run (no attempt burned), but
        // record what was processed so far; the run counters are flushed
        // below via `finally`.
        await this.prisma.githubPushRange.update({
          where: { id: range.id },
          data: progress(),
        });
        return;
      }

      await this.prisma.githubPushRange.update({
        where: { id: range.id },
        data: {
          status: ctx.cfg.mode === 'shadow' ? 'shadowed' : 'done',
          ...progress(),
          truncated: compared.truncated,
          lastError: null,
        },
      });
      if (evaluateBudget({ rateLimit: compared.rateLimit }).exhausted) {
        ctx.stopForBudget = true;
      }
    } catch (err) {
      await fail((err as Error).message);
    } finally {
      ctx.counters.alreadyPresent += alreadyPresent;
      ctx.counters.ingested += ingested;
    }
  }

  /** Compare base...head; a `moved` range whose base is gone falls back to the default branch. */
  private async compareRange(
    ctx: RunContext,
    range: GithubPushRange,
    token: string,
  ): Promise<GithubCompareResult> {
    const base = range.baseSha ?? range.baseRef;
    const head = range.headSha as string;
    if (!base) {
      return { commits: [], pages: 0, truncated: false, failure: 'failed' };
    }
    const first = await this.client.compareAll(
      range.repoFullName,
      token,
      base,
      head,
    );
    if (first.failure !== 'not_found' || range.kind !== 'moved') {
      return first;
    }
    const marker = await this.prisma.githubRefTip.findUnique({
      where: {
        tenantId_repoFullName_ref: {
          tenantId: ctx.tenantId,
          repoFullName: range.repoFullName,
          ref: DEFAULT_BRANCH_MARKER,
        },
      },
    });
    return marker
      ? this.client.compareAll(range.repoFullName, token, marker.sha, head)
      : first;
  }
}

/**
 * One observed push, kept in the raw-event store (not a second store) so the
 * audit evidence outlives GitHub's 7-day retention. No subscriber projects it;
 * it is lineage. Network/token fields were already dropped by the client.
 */
export function pushEnvelope(
  connectionId: string,
  e: GitPushAuditEvent,
  now: Date,
): CanonicalEnvelope {
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: `github:audit:${e.documentId}`,
    sourceSystem: 'github',
    connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_PUSH_OBSERVED,
    occurredAt: e.timestamp.toISOString(),
    collectedAt: now.toISOString(),
    externalRefs: { repo: e.repoFullName, auditDocumentId: e.documentId },
    actor: { sourceLogin: e.actor },
    data: {
      repoFullName: e.repoFullName,
      pushedAt: e.timestamp.toISOString(),
      actor: e.actor,
      externalIdentityUsername: e.externalIdentityUsername,
      programmaticAccessType: e.programmaticAccessType,
      transportProtocolName: e.transportProtocolName,
    },
  };
}
