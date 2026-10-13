import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Connection, GithubPushRange } from '@prisma/client';
import { AUDIT_SINK, AuditSink } from '../../../common/audit/audit-sink';
import { forEachBounded } from '../../../common/concurrency';
import { CodeCommitPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { istDayEnd, istDayStart } from '../../../common/time';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { IngestionService } from '../../ingestion/ingestion.service';
import {
  effectiveLagWarnMinutes,
  GithubAuditConfig,
  GithubAuditMode,
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
  /** Registered repos (active connection at run start) the audit log reported pushes to. */
  reposTouched: number;
  /**
   * Pushed repos left without an active connection this run: a connection
   * exists but is not active (an admin decision, left alone), the repo is
   * archived/disabled, or no collector tokenRef is configured to register it.
   */
  reposUnregistered: number;
  /** Pushed repos that had no connection at all and were auto-registered this run (spec item 4). */
  reposRegistered: number;
  /**
   * Shadow mode only: pushed repos with no connection that passed the
   * existence/archived checks and WOULD have been auto-registered in ingest
   * mode. Shadow never creates a connection (that would make the regular
   * collectors backfill the repo), seeds it or plans ranges for it.
   */
  reposWouldRegister: number;
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

/**
 * "Is the audit route currently trustworthy?" — the admin-facing status
 * (spec item 2). `lagMinutes`/`behind` are computed from the checkpoint as of
 * `now`, not from the last run's own report, so a cron that stopped firing
 * entirely still shows as behind.
 */
export interface AuditStatus {
  mode: GithubAuditMode;
  enabled: boolean;
  seededAt: Date | null;
  checkpointAt: Date | null;
  lagMinutes: number | null;
  behind: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  pendingRanges: number;
  failedRanges: number;
  /** The latest full-branch-sweep run for the tenant (any status), or null if none has ever run. */
  lastFullSweep: {
    startedAt: Date;
    finishedAt: Date | null;
    status: string;
  } | null;
}

/**
 * Whether the audit route can vouch that a reported IST day's commits are in
 * (spec item 5, the digest seal). `applies` is false when the route is not
 * part of commit collection for the tenant (mode not `ingest`, or no
 * audit-log token ref) — then `ok` is true and `reasons` empty, and the
 * digest behaves exactly as before the route existed.
 */
export interface AuditDayCoverage {
  applies: boolean;
  ok: boolean;
  reasons: string[];
}

/** Ranges named in a coverage reason; the rest are counted. */
const COVERAGE_RANGES_SHOWN = 5;

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
  /**
   * Repos skipped as unseedable this run, named in `run.error` — GitHub
   * answered either 403 (forbidden: the token has no access) or 404
   * (not_found: deleted, renamed, OR a repo the token can no longer see,
   * which is indistinguishable from "gone" at this API). An org-wide access
   * loss (SSO revoked, wrong org, rotated-but-unauthorized token) typically
   * shows up as 404 on every repo, not 403 — GitHub does not reveal a
   * private repo's existence to a token it has revoked (controller ruling,
   * fix round 1) — so the org-wide refusal guard below must count both the
   * same way rather than only 403. Populated only during `seedAll`'s own
   * seeding pass and read by it alone; entries added later in the same run
   * by `planRepo` seeding a never-seen touched repo are never read back into
   * the guard, since the guard applies only to the initial seeding pass.
   */
  unseedable: string[];
  /** Repos whose seeding was skipped because the core budget reached the reserve. */
  budgetSkipped: string[];
  /** Auto-registration of pushed repos with no connection (spec item 4); read only by `discover`. */
  registration: RegistrationContext;
}

/** What the audit sync needs from the tenant's GitHub configuration. */
interface AuditSettings {
  organization: string;
  auditToken: string;
  /** The GitHub configuration's collector `tokenRef` — what an auto-registered connection uses. Never the audit-log ref. */
  collectorTokenRef?: string;
  /** The GitHub configuration's `backfillDays` (default 90), as the org sync uses it. */
  backfillDays: number;
}

export interface RegistrationContext {
  secretRef?: string;
  backfillDays: number;
  /** Pushed repos with no connection that could not be registered for want of a collector tokenRef. */
  noTokenRef: string[];
  /** Repos registered this run with more branches than GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES — seeded only. */
  overCap: string[];
  /** Shadow mode: repos that would have been auto-registered, named in `run.error`. */
  wouldRegister: string[];
}

/** Org-sync default when the GitHub configuration sets no `backfillDays`. */
const DEFAULT_BACKFILL_DAYS = 90;

function registrationOf(settings: AuditSettings): RegistrationContext {
  return {
    secretRef: settings.collectorTokenRef,
    backfillDays: settings.backfillDays,
    noTokenRef: [],
    overCap: [],
    wouldRegister: [],
  };
}

/** `seedAll`'s own outcome, distinct from a single repo's `SeedOutcome`. */
interface SeedAllResult {
  /**
   * `refused` overrides `complete`/`incomplete`: the org-wide refusal guard
   * fired (spec item 1) because the token itself cannot be trusted for this
   * tenant, so the run must never start the checkpoint from here, even if
   * every OTHER repo happened to seed cleanly.
   */
  status: 'complete' | 'incomplete' | 'refused';
  /** Repos this seeding pass tried (excludes ones already seeded by an earlier run). */
  attempted: number;
  /** Repos this pass answered 403 or 404 for (see `RunContext.unseedable`). */
  refusedCount: number;
}

/**
 * A seeding pass cannot be trusted to represent the org — and must not be
 * reported `seeded`, which would start the checkpoint as if the org had
 * actually been observed — when (controller ruling, fix round 1):
 *   - at least half the attempted repos were refused (403 or 404), since an
 *     org-wide access loss (SSO revoked, wrong org) usually shows up as 404
 *     on every repo, not 403; or
 *   - nothing seeded AND at least one repo was refused — catching a smaller
 *     refused fraction sitting alongside otherwise-transient failures,
 *     which alone (zero refused) must still retry as `partial`.
 * A pass with 0 seeded, 0 refused, and only transient failures (rate
 * limits, 5xx) is deliberately NOT refused — those retry next run.
 */
function isRefused(
  attempted: number,
  seededCount: number,
  refusedCount: number,
): boolean {
  if (attempted === 0) return false;
  if (refusedCount * 2 >= attempted) return true;
  return seededCount === 0 && refusedCount > 0;
}

/** The `run.error` wording when `isRefused` fires — shared by seeding and the full sweep. */
function refusalMessage(refusedCount: number, attempted: number): string {
  return `collector token refused (403/404) for ${refusedCount} of ${attempted} repos — check token scope, SSO authorization and that these repos still exist`;
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
    reposRegistered: 0,
    reposWouldRegister: 0,
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
    private readonly connections: ConnectionsService,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
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

  /**
   * "Is the audit route currently trustworthy for this tenant?" — read-only,
   * tenant-scoped, and independent of whether a run is in flight (spec item
   * 2). `lagMinutes`/`behind` are computed against `now`, not against the
   * last run's own report, so a cron that silently stopped firing still
   * shows as behind rather than reporting the last success forever.
   */
  async status(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditStatus> {
    const [config, checkpoint, pendingRanges, failedRanges, lastFullSweep] =
      await Promise.all([
        this.prisma.tenantConfiguration.findUnique({
          where: {
            tenantId_namespace_key: {
              tenantId,
              namespace: 'github',
              key: 'default',
            },
          },
        }),
        this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } }),
        this.prisma.githubPushRange.findMany({
          where: { tenantId, status: 'pending' },
        }),
        this.prisma.githubPushRange.findMany({
          where: { tenantId, status: 'failed' },
        }),
        this.prisma.githubAuditRun.findFirst({
          where: { tenantId, trigger: 'full_sweep' },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true, finishedAt: true, status: true },
        }),
      ]);
    const refs = (config?.secretRefs as Record<string, unknown> | null) ?? {};
    const enabled =
      !!config &&
      config.status === 'active' &&
      typeof refs.auditLogTokenRef === 'string';
    const checkpointAt = checkpoint?.checkpointAt ?? null;
    const lagMinutes = checkpointAt
      ? Math.round((now.getTime() - checkpointAt.getTime()) / 60_000)
      : null;
    return {
      mode: cfg.mode,
      enabled,
      seededAt: checkpoint?.seededAt ?? null,
      checkpointAt,
      lagMinutes,
      behind: lagMinutes !== null && lagMinutes > effectiveLagWarnMinutes(cfg),
      lastRunAt: checkpoint?.lastRunAt ?? null,
      lastStatus: checkpoint?.lastStatus ?? null,
      lastError: checkpoint?.lastError ?? null,
      pendingRanges: pendingRanges.length,
      failedRanges: failedRanges.length,
      lastFullSweep: lastFullSweep
        ? {
            startedAt: lastFullSweep.startedAt,
            finishedAt: lastFullSweep.finishedAt,
            status: lastFullSweep.status,
          }
        : null,
    };
  }

  /**
   * "Can the audit route vouch for `day`?" — the digest's seal (spec item 5).
   * Read-only and tenant-scoped: it never resolves a secret (the ref's
   * presence is what makes the route part of collection) and never calls
   * GitHub. Completeness, not liveness, is what it proves, and all of:
   *   - the audit log has been read through the day's last instant plus the
   *     overlap the next window re-reads (`checkpointAt`, which only moves
   *     once a window's work is durably queued);
   *   - nothing created at or after day start — no upper bound (controller
   *     ruling, fix round 1): a late catch-up or a sweep that stops on
   *     budget can create the day's ranges long after any fixed window, and
   *     the pusher must still be withheld — is `pending` or `failed`, and
   *     nothing `shadowed` from the day is still inside the replay window
   *     (`executePending` would yet replay it, so its commits are not in);
   *   - when the full sweep is on, an `ingest`-mode sweep STARTED (not
   *     finished) successfully after the day ended, covering pushes the
   *     audit log never records.
   * Every failing condition is reported, so the withheld card names them all.
   */
  async coverageForDay(
    tenantId: string,
    day: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditDayCoverage> {
    const notApplicable: AuditDayCoverage = {
      applies: false,
      ok: true,
      reasons: [],
    };
    if (cfg.mode !== 'ingest') return notApplicable;
    const config = await this.prisma.tenantConfiguration.findUnique({
      where: {
        tenantId_namespace_key: {
          tenantId,
          namespace: 'github',
          key: 'default',
        },
      },
    });
    const refs = (config?.secretRefs as Record<string, unknown> | null) ?? {};
    if (
      !config ||
      config.status !== 'active' ||
      typeof refs.auditLogTokenRef !== 'string'
    ) {
      return notApplicable;
    }

    const dayEndMs = istDayEnd(day).getTime();
    const overlapMs = cfg.overlapMinutes * 60_000;
    const mustReach = new Date(dayEndMs + overlapMs);
    const dayStart = istDayStart(day);
    // A `shadowed` range younger than the replay window is exactly what
    // `executePending` will still replay in ingest mode — its commits are not
    // in yet, so it is unfinished work for the day too (final review, I2).
    // One older than the window will never be replayed and is ignored.
    const replayFrom = new Date(
      Math.max(dayStart.getTime(), now.getTime() - SHADOW_REPLAY_MS),
    );
    const unfinishedWhere = {
      tenantId,
      // No upper bound (controller ruling, fix round 1): an audit catch-up
      // after a stall, or a late sweep that plans a missed push and stops on
      // budget, can create the day's ranges well after any fixed window —
      // the person who pushed must still be withheld, not silently cleared.
      // Still a bounded read (count + take:5 below), never the whole queue.
      OR: [
        {
          status: { in: ['pending', 'failed'] },
          createdAt: { gte: dayStart },
        },
        { status: 'shadowed', createdAt: { gte: replayFrom } },
      ],
    };
    const [checkpoint, unfinished, shown, sweep] = await Promise.all([
      this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } }),
      this.prisma.githubPushRange.count({ where: unfinishedWhere }),
      this.prisma.githubPushRange.findMany({
        where: unfinishedWhere,
        select: { repoFullName: true, ref: true },
        orderBy: { createdAt: 'asc' },
        take: COVERAGE_RANGES_SHOWN,
      }),
      cfg.fullSweepMinutes > 0
        ? this.prisma.githubAuditRun.findFirst({
            where: {
              tenantId,
              trigger: 'full_sweep',
              status: 'success',
              // A shadow-mode sweep ingests nothing — its ranges are only
              // `shadowed` — so it is not evidence the day's commits are in
              // (final review, I2).
              mode: 'ingest',
              // startedAt, not finishedAt (controller ruling, fix round 1):
              // a sweep that started before the day ended but finished after
              // was already running against the old branch tips and cannot
              // vouch for pushes made during the day.
              startedAt: { gt: new Date(dayEndMs) },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const reasons: string[] = [];
    if (!checkpoint?.seededAt) {
      reasons.push('audit sync has not completed its seeding pass');
    }
    const checkpointAt = checkpoint?.checkpointAt ?? null;
    if (!checkpointAt) {
      reasons.push('audit log never read');
    } else if (checkpointAt.getTime() < mustReach.getTime()) {
      reasons.push(`audit log read only through ${checkpointAt.toISOString()}`);
    }
    if (unfinished > 0) {
      const named = shown.map((r) => `${r.repoFullName}@${r.ref}`).join(', ');
      const rest = unfinished - shown.length;
      reasons.push(
        `${unfinished} unfinished range(s): ${named}${
          rest > 0 ? ` (and ${rest} more)` : ''
        }`,
      );
    }
    if (cfg.fullSweepMinutes > 0 && !sweep) {
      reasons.push(
        `no successful full branch sweep has started since ${day} ended`,
      );
    }
    return { applies: true, ok: reasons.length === 0, reasons };
  }

  async runTenant(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditRunSummary> {
    const prep = await this.prepareRun(tenantId, cfg);
    if ('summary' in prep) return prep.summary;
    const { settings, repos, counters, startedMs, skipped } = prep;
    return this.withRunClaim(
      tenantId,
      settings.organization,
      now,
      skipped,
      () =>
        this.runClaimed(
          tenantId,
          cfg,
          now,
          settings,
          repos,
          counters,
          startedMs,
        ),
    );
  }

  /**
   * Full branch sweep (spec item 3): the backstop for pushes the audit log
   * never records (web-UI/API pushes, merges, anything it drops). Lists the
   * branches of EVERY registered repo, plans ranges from the tip diff exactly
   * as discovery does (with no audit evidence attached), then executes the
   * pending queue. It never reads the audit log and never moves
   * `checkpointAt`/`seededAt` — the checkpoint answers only for what the
   * audit log covered. Shares the per-tenant run claim with `runTenant`, so a
   * sweep and an audit run never plan or execute at the same time.
   */
  async runFullSweep(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditRunSummary> {
    const prep = await this.prepareRun(tenantId, cfg);
    if ('summary' in prep) return prep.summary;
    const { settings, repos, counters, startedMs, skipped } = prep;
    // Seeding is the audit sync's job (it owns seededAt/checkpointAt and the
    // org-wide refusal guard); a sweep before it would seed every repo with
    // none of those checks, so it waits.
    const checkpoint = await this.prisma.githubAuditCheckpoint.findUnique({
      where: { tenantId },
    });
    if (!checkpoint?.seededAt) {
      return skipped('not seeded yet — the audit sync seeds first');
    }
    return this.withRunClaim(
      tenantId,
      settings.organization,
      now,
      skipped,
      () =>
        this.sweepClaimed(
          tenantId,
          cfg,
          now,
          settings,
          repos,
          counters,
          startedMs,
        ),
    );
  }

  /**
   * Shared opening of `runTenant` and `runFullSweep`: mode gate, settings and
   * registered repos. Both skip/fail here before any run row exists, so a
   * thrown error never leaves a `githubAuditRun` row stuck at 'running'.
   */
  private async prepareRun(
    tenantId: string,
    cfg: GithubAuditConfig,
  ): Promise<
    | { summary: AuditRunSummary }
    | {
        settings: AuditSettings;
        repos: Map<string, Connection>;
        counters: AuditRunCounters;
        startedMs: number;
        skipped: (reason: string) => AuditRunSummary;
      }
  > {
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
      return { summary: skipped('GITHUB_AUDIT_SYNC_MODE is off.') };
    }
    const settings = await this.loadSettings(tenantId);
    if ('reason' in settings) {
      return { summary: skipped(settings.reason) };
    }
    try {
      const repos = await this.registeredRepos(tenantId);
      return { settings, repos, counters, startedMs, skipped };
    } catch (err) {
      return {
        summary: {
          tenantId,
          status: 'failed',
          reason: (err as Error).message.slice(0, 500),
          counters,
          durationMs: Date.now() - startedMs,
        },
      };
    }
  }

  /**
   * Per-tenant claim, shared by the audit cron, the sweep cron and the manual
   * admin endpoint, so two runs for one tenant never plan/execute at once.
   * `body` runs only while the claim is held; the claim is released after it
   * whatever happens.
   */
  private async withRunClaim(
    tenantId: string,
    organization: string,
    now: Date,
    skipped: (reason: string) => AuditRunSummary,
    body: () => Promise<AuditRunSummary>,
  ): Promise<AuditRunSummary> {
    // The row must exist before it can be claimed; the upsert leaves
    // seededAt/checkpointAt untouched on an existing row.
    await this.prisma.githubAuditCheckpoint.upsert({
      where: { tenantId },
      create: { id: newId(), tenantId, organization },
      update: { organization },
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
      return await body();
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
    settings: AuditSettings,
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
        trigger: 'audit',
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
      registration: registrationOf(settings),
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
    // Lag is measured against that SAME pre-run value, at the start of the
    // run — "no warning before seeding exists" falls out for free, since
    // priorCheckpointAt is undefined until a first seeding run has happened
    // (spec item 2).
    let lagWarning: string | undefined;
    if (priorCheckpointAt) {
      const lagMinutes = Math.round(
        (now.getTime() - priorCheckpointAt.getTime()) / 60_000,
      );
      if (lagMinutes > effectiveLagWarnMinutes(cfg)) {
        lagWarning = `Audit sync is ${lagMinutes} minutes behind.`;
        this.logger.warn(`[tenant ${tenantId}] ${lagWarning}`);
      }
    }

    try {
      if (!checkpoint?.seededAt) {
        const seedResult = await this.seedAll(ctx);
        if (seedResult.status === 'complete') {
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
        } else if (seedResult.status === 'refused') {
          // Never set seededAt/checkpointAt here: a refused token has not
          // actually observed the org, so starting the checkpoint would
          // silently assert coverage it does not have (spec item 1).
          status = 'failed';
          error = refusalMessage(seedResult.refusedCount, seedResult.attempted);
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
    const { overCap, noTokenRef } = ctx.registration;
    if (overCap.length > 0) {
      const note = `${overCap.length} auto-registered repo(s) have more than GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES (${cfg.newRepoMaxBranches}) branches, so they were seeded only — their non-default-branch pushes in this window are left to the regular collector: ${nameRepos(overCap)}.`;
      error = error ? `${error} ${note}` : note;
    }
    if (ctx.registration.wouldRegister.length > 0) {
      const note = `would auto-register (shadow): ${nameRepos(ctx.registration.wouldRegister)}.`;
      error = error ? `${error} ${note}` : note;
    }
    if (noTokenRef.length > 0) {
      const note = `${noTokenRef.length} pushed repo(s) have no connection and were not auto-registered because the GitHub configuration has no collector tokenRef: ${nameRepos(noTokenRef)}.`;
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

    // Prefixed last so it lands first when both apply (spec item 2): the
    // lag sentence is the most actionable one-liner for an admin skimming
    // `run.error`, ahead of the retention-risk detail.
    if (lagWarning) {
      error = error ? `${lagWarning} ${error}` : lagWarning;
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

  private async sweepClaimed(
    tenantId: string,
    cfg: GithubAuditConfig,
    now: Date,
    settings: AuditSettings,
    repos: Map<string, Connection>,
    counters: AuditRunCounters,
    startedMs: number,
  ): Promise<AuditRunSummary> {
    const run = await this.prisma.githubAuditRun.create({
      data: {
        id: newId(),
        tenantId,
        mode: cfg.mode,
        trigger: 'full_sweep',
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
      registration: registrationOf(settings),
    };

    let status: AuditRunSummary['status'] = 'success';
    const notes: string[] = [];
    const notPlanned: string[] = [];
    const failures: string[] = [];
    let sweptOk = 0;
    try {
      await forEachBounded(
        [...repos.entries()],
        cfg.compareConcurrency,
        async ([repo, connection]) => {
          // No audit evidence: these ranges were found by listing, not by a
          // recorded push, so `auditDocumentIds` stays empty.
          const planned = await this.planRepo(ctx, repo, connection, []);
          if (planned.ok) {
            if (!ctx.unseedable.includes(repo)) {
              counters.reposTouched++;
              sweptOk++;
            }
          } else if (planned.error === BUDGET_NOT_PLANNED) {
            // Tips are left as they were, so the next sweep still sees the move.
            notPlanned.push(repo);
          } else {
            failures.push(`${repo}: ${planned.error}`);
          }
        },
      );
      // The same org-wide refusal guard as seeding (final review, I3): a
      // token refused (403 or 404) for most repos has not observed the org,
      // so the sweep must not report `success` — which the digest gate would
      // otherwise take as evidence the day's pushes were swept. Pending
      // ranges are not executed under a refused token: they would only burn
      // attempts toward GITHUB_AUDIT_MAX_RANGE_ATTEMPTS; the audit run
      // retries them.
      const attempted = repos.size;
      const refusedCount = ctx.unseedable.length;
      if (isRefused(attempted, sweptOk, refusedCount)) {
        status = 'failed';
        notes.push(refusalMessage(refusedCount, attempted));
      } else {
        await this.executePending(ctx);
        if (failures.length > 0) {
          status = 'partial';
          notes.push(
            `Could not list branches for ${failures.length} repo(s): ${failures.slice(0, 5).join('; ')}.`,
          );
        }
        if (notPlanned.length > 0) {
          status = 'partial';
          notes.push(
            `${notPlanned.length} repo(s) not swept because the core rate budget reached the reserve (GITHUB_BACKFILL_RATE_RESERVE): ${nameRepos(notPlanned)}.`,
          );
        }
      }
    } catch (err) {
      status = 'failed';
      notes.push((err as Error).message.slice(0, 500));
    }
    if (ctx.unseedable.length > 0) {
      notes.push(
        `${ctx.unseedable.length} repo(s) skipped as unseedable (GitHub answered 404/403 — deleted, renamed or no access): ${nameRepos(ctx.unseedable)}.`,
      );
    }
    const error = notes.length > 0 ? notes.join(' ') : undefined;

    // The checkpoint row's lastRunAt/lastStatus/lastError describe the AUDIT
    // route and feed `status()`; a sweep reports only through its own run row.
    await this.prisma.githubAuditRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status,
        error: error ?? null,
        windowFrom: null,
        windowTo: null,
        counters: counters as unknown as object,
      },
    });

    const durationMs = Date.now() - startedMs;
    this.logger.log(
      `github audit full sweep tenant=${tenantId} mode=${cfg.mode} status=${status} ` +
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
      durationMs,
    };
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<AuditSettings | { reason: string }> {
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
    return {
      organization: values.organization,
      auditToken,
      collectorTokenRef:
        typeof refs.tokenRef === 'string' ? refs.tokenRef : undefined,
      // As the admin org sync reads it (a number, else 90); a non-positive
      // value is not a usable history horizon, so it falls back too.
      backfillDays:
        typeof values.backfillDays === 'number' && values.backfillDays > 0
          ? values.backfillDays
          : DEFAULT_BACKFILL_DAYS,
    };
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
    return this.tokenForRef(ctx, connection.secretRef);
  }

  /** Resolves a collector secret ref once per run. Callers never pass the audit-log ref. */
  private async tokenForRef(
    ctx: RunContext,
    secretRef: string | null | undefined,
  ): Promise<string> {
    const ref = secretRef ?? '';
    if (!ctx.tokens.has(ref)) {
      ctx.tokens.set(ref, await this.secrets.resolve(ctx.tenantId, secretRef));
    }
    return ctx.tokens.get(ref) ?? '';
  }

  /**
   * Every repo the tenant has ANY GitHub connection for, active or not, by
   * name and by `config.repoFullName` — so auto-registration never creates a
   * second connection beside one an admin disabled, whatever it is named.
   */
  private async knownGithubRepos(tenantId: string): Promise<Set<string>> {
    const rows = await this.prisma.connection.findMany({
      where: { tenantId, sourceSystem: 'github' },
    });
    const known = new Set<string>();
    for (const c of rows) {
      known.add(c.name);
      const repo = (c.config as { repoFullName?: string } | null)?.repoFullName;
      if (repo) known.add(repo);
    }
    return known;
  }

  /** One-off pass storing every repo's tips; repos already seeded are skipped. */
  private async seedAll(ctx: RunContext): Promise<SeedAllResult> {
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
    const attempted = todo.length;
    const refusedCount = ctx.unseedable.length;
    const seededCount = ctx.counters.reposSeeded;
    if (isRefused(attempted, seededCount, refusedCount)) {
      return { status: 'refused', attempted, refusedCount };
    }
    return {
      status: complete ? 'complete' : 'incomplete',
      attempted,
      refusedCount,
    };
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
    // plan time, and in registerRepo only when it plans ranges — seed-only
    // and skipped repos could never be Compared, so counting them would
    // overstate `compareRequestsSaved`.

    const byRepo = [...pushesByRepo(pushes).entries()];
    counters.reposTouched = byRepo.filter(([repo]) =>
      ctx.repos.has(repo),
    ).length;
    // Only read when some pushed repo has no active connection.
    const known = byRepo.some(([repo]) => !ctx.repos.has(repo))
      ? await this.knownGithubRepos(ctx.tenantId)
      : new Set<string>();

    const failures: string[] = [];
    await forEachBounded(
      byRepo,
      ctx.cfg.compareConcurrency,
      async ([repo, events]) => {
        const documentIds = events.map((e) => e.documentId);
        const registered = ctx.repos.get(repo);
        if (!registered) {
          const outcome = await this.registerRepo(
            ctx,
            repo,
            documentIds,
            known,
          );
          if (!outcome.ok) {
            failures.push(`${repo}: ${outcome.error}`);
            return;
          }
          // Push evidence is stored only once the repo has a connection to
          // hang it on; a skipped repo's pushes are not kept (as before).
          if (outcome.connection) {
            for (const e of events) {
              await this.ingestion.ingest(
                ctx.tenantId,
                pushEnvelope(outcome.connection.id, e, ctx.now),
              );
            }
          }
          return;
        }
        const connection = registered;
        for (const e of events) {
          await this.ingestion.ingest(
            ctx.tenantId,
            pushEnvelope(connection.id, e, ctx.now),
          );
        }
        const planned = await this.planRepo(ctx, repo, connection, documentIds);
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

  /**
   * Auto-registration (spec item 4): a pushed repo with NO GitHub connection
   * in the tenant is registered exactly as the admin org sync would register
   * it, seeded, and — up to GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES branches — given
   * a `new_ref` range per non-default branch, so the pushes that revealed it
   * are collected now rather than lost. The regular collector then backfills
   * its history like any org-synced repo.
   *
   * - Any existing connection (any status, any name) → left alone: a disabled
   *   connection is an admin decision. Counted `reposUnregistered`.
   * - 404/403 → skipped, counted and named as unseedable.
   * - archived/disabled → skipped, counted `reposUnregistered`, no connection.
   * - Shadow mode → after those checks, only counted `reposWouldRegister` and
   *   named in `run.error`; no connection, tips or ranges, checkpoint not held.
   * - Transient failure or the core budget at the reserve → `ok: false`, which
   *   holds the checkpoint so the window is re-read, as in `planRepo`.
   *
   * GitHub is checked BEFORE the connection is created, so a transient failure
   * never leaves a connection behind without its tips. Every call uses the
   * collector token of the configuration's `tokenRef` — never the audit token.
   */
  private async registerRepo(
    ctx: RunContext,
    repo: string,
    documentIds: string[],
    known: Set<string>,
  ): Promise<
    { ok: true; connection?: Connection } | { ok: false; error: string }
  > {
    const { counters, registration } = ctx;
    if (
      known.has(repo) ||
      (await this.connections.findByTenantSourceAndName(
        ctx.tenantId,
        'github',
        repo,
      ))
    ) {
      counters.reposUnregistered++;
      return { ok: true };
    }
    const secretRef = registration.secretRef;
    if (!secretRef) {
      counters.reposUnregistered++;
      registration.noTokenRef.push(repo);
      return { ok: true };
    }
    if (ctx.stopForBudget) return { ok: false, error: BUDGET_NOT_PLANNED };
    const token = await this.tokenForRef(ctx, secretRef);
    const branch = await this.client.getDefaultBranch(repo, token);
    this.chargeCore(ctx, branch.rateLimit);
    if (branch.failure || !branch.name) {
      return this.registrationFailure(ctx, repo, branch.failure);
    }
    if (branch.archived || branch.disabled) {
      counters.reposUnregistered++;
      return { ok: true };
    }
    if (ctx.cfg.mode !== 'ingest') {
      // Shadow mode must not change collection outside the audit route's own
      // state: a connection would make the regular collectors backfill this
      // repo. Report it only — no connection, tips or ranges — and do not
      // hold the checkpoint: it was examined, nothing is pending.
      counters.reposWouldRegister++;
      registration.wouldRegister.push(repo);
      return { ok: true };
    }
    if (ctx.stopForBudget) return { ok: false, error: BUDGET_NOT_PLANNED };
    const refs = await this.client.listHeadRefs(repo, token);
    this.chargeCore(ctx, refs.rateLimit);
    if (!refs.tips) return this.registrationFailure(ctx, repo, refs.failure);

    const backfillSince = new Date(
      ctx.now.getTime() - registration.backfillDays * 86_400_000,
    ).toISOString();
    const connection = await this.connections.create(ctx.tenantId, {
      sourceSystem: 'github',
      name: repo,
      config: { repoFullName: repo, backfillSince },
      secretRef,
    });
    ctx.repos.set(repo, connection);
    counters.reposRegistered++;

    // Against an empty store every branch is new: the default branch gets a
    // tip only, every other branch a `new_ref` range based on it.
    const diff = diffTips(repo, new Map(), refs.tips, branch.name);
    const planRanges = refs.tips.size <= ctx.cfg.newRepoMaxBranches;
    if (!planRanges) registration.overCap.push(repo);
    const ranges = planRanges ? diff.ranges : [];
    const c = countRanges(ranges);
    counters.compareRequestsPlanned += c.compareRequestsPlanned;
    counters.refsNew += c.refsNew;
    if (ranges.length > 0)
      counters.compareCandidatesNaive += documentIds.length;

    const tips = [
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
      await tx.githubRefTip.createMany({ data: tips });
      for (const r of ranges) {
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
            status: 'pending',
          },
        });
      }
    });
    counters.reposSeeded++;

    this.logger.log(
      `auto-registered GitHub repo ${repo} for tenant ${ctx.tenantId}`,
    );
    await this.audit?.record({
      tenantId: ctx.tenantId,
      actorType: 'system',
      action: 'connection.auto_registered',
      targetType: 'connection',
      targetId: connection.id,
      metadata: {
        repoFullName: repo,
        source: 'github_audit_sync',
        runId: ctx.runId,
        backfillSince,
        rangesPlanned: ranges.length,
        seedOnly: !planRanges,
      },
    });
    return { ok: true, connection };
  }

  /** A failed GitHub read while registering: 404/403 skip the repo for good; anything else holds the checkpoint. */
  private registrationFailure(
    ctx: RunContext,
    repo: string,
    failure: GithubCallFailure | undefined,
  ): { ok: true } | { ok: false; error: string } {
    if (isUnseedable(failure)) {
      this.noteUnseedable(ctx, repo);
      return { ok: true };
    }
    if (failure === 'rate_limited') ctx.stopForBudget = true;
    return { ok: false, error: failure ?? 'failed' };
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
