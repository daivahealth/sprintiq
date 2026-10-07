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
import { GithubClient, GithubCompareResult } from './github.client';

export interface AuditRunCounters {
  reposSeeded: number;
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
    let allOk = true;
    const todo = [...ctx.repos.entries()].filter(([repo]) => !done.has(repo));
    await forEachBounded(
      todo,
      ctx.cfg.compareConcurrency,
      async ([repo, connection]) => {
        const ok = await this.seedRepo(ctx, repo, connection);
        if (ok) ctx.counters.reposSeeded++;
        else allOk = false;
      },
    );
    return allOk;
  }

  private async seedRepo(
    ctx: RunContext,
    repo: string,
    connection: Connection,
  ): Promise<boolean> {
    const token = await this.collectorToken(ctx, connection);
    const [branch, refs] = [
      await this.client.getDefaultBranch(repo, token),
      await this.client.listHeadRefs(repo, token),
    ];
    if (!branch.name || !refs.tips) {
      this.logger.warn(
        `[tenant ${ctx.tenantId}] could not seed ${repo}: ${branch.failure ?? refs.failure ?? 'unknown'}`,
      );
      return false;
    }
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
    return true;
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
    counters.compareCandidatesNaive = pushes.length;

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
      const ok = await this.seedRepo(ctx, repo, connection);
      if (ok) ctx.counters.reposSeeded++;
      return ok ? { ok: true } : { ok: false, error: 'seed failed' };
    }
    const token = await this.collectorToken(ctx, connection);
    const refs = await this.client.listHeadRefs(repo, token);
    if (!refs.tips) {
      return { ok: false, error: refs.failure ?? 'failed' };
    }
    ctx.counters.coreRateRemaining =
      refs.rateLimit?.remaining ?? ctx.counters.coreRateRemaining;

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
    // Declared outside the try so a `finally` can flush them to ctx.counters
    // on EVERY exit path (success, budget stop, detail-missing failure, or a
    // thrown exception) — a mid-range throw must never drop the commits
    // already ingested before it (review round 1, issue 3).
    let alreadyPresent = 0;
    let ingested = 0;
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
      ctx.counters.coreRateRemaining =
        compared.rateLimit?.remaining ?? ctx.counters.coreRateRemaining;

      // Run-level `core` budget estimate (review round 1, issue 1): refresh
      // from the latest reading, then charge this Compare's own pages so a
      // range that burns the rest of the reserve on Compare never reaches
      // the per-commit detail calls below. Concurrent ranges share `ctx`, so
      // one range crossing zero stops every other range's next detail call
      // too, not just its own.
      if (compared.rateLimit) {
        ctx.coreBudget = compared.rateLimit.remaining - rateReserve();
      }
      if (ctx.coreBudget !== undefined) {
        ctx.coreBudget -= compared.pages;
        if (ctx.coreBudget <= 0) ctx.stopForBudget = true;
      }

      let detailFailure: string | undefined;
      let stoppedForBudget = false;
      for (const c of compared.commits) {
        if (!c.authorLogin) ctx.counters.commitsWithoutLogin++;
        const key = commitIdempotencyKey(range.repoFullName, c.sha);
        if (ctx.seenKeys.has(key)) {
          alreadyPresent++;
          continue;
        }
        // Claimed synchronously, before any `await` below, so a concurrent
        // range resolving the same commit sees it immediately instead of
        // racing to double-count it as `wouldIngest` or issue a second
        // detail call for it (review round 1, issue 5).
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
          continue;
        }
        if (ctx.cfg.mode === 'shadow') {
          ctx.counters.wouldIngest++;
          continue;
        }
        if (ctx.stopForBudget) {
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
        if (result.status === 'accepted') ingested++;
        else alreadyPresent++;
        if (detail.rateLimitedUntil) ctx.stopForBudget = true;
      }

      if (detailFailure) {
        await fail(detailFailure);
        return;
      }
      if (stoppedForBudget) {
        // Leave the range pending for the next run; partial counts are
        // still flushed below via `finally`.
        return;
      }

      await this.prisma.githubPushRange.update({
        where: { id: range.id },
        data: {
          status: ctx.cfg.mode === 'shadow' ? 'shadowed' : 'done',
          commitsFound: compared.commits.length,
          alreadyPresent,
          ingested,
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
