import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { ConnectionsService } from '../connections/connections.service';
import { GithubCommitMessageReconcilerService } from '../../collectors/sources/github/github-commit-message-reconciler.service';
import { GithubCommitReconcilerService } from '../../collectors/sources/github/github-commit-reconciler.service';
import { GithubOrgSyncService } from '../../collectors/sources/github/github-org-sync.service';
import { GithubPrReconcilerService } from '../../collectors/sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from '../../collectors/sources/github/github-review-reconciler.service';
import { JiraAssigneeEmailReconcilerService } from '../../collectors/sources/jira/jira-assignee-email-reconciler.service';
import { JiraStoryDateReconcilerService } from '../../collectors/sources/jira/jira-story-date-reconciler.service';
import { CollectionProgressService } from '../../collectors/scheduler/collection-progress.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { SecretsService } from '../../common/secrets/secrets.service';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { CorrelationService } from '../../correlation/correlation.service';
import { DeveloperIdentityService } from '../../correlation/developer-identity.service';
import {
  CONFIGURATION_CATALOG,
  CONFIGURATION_NAMESPACES,
  SECRET_REF_HINT,
  SECRET_REF_PATTERN,
} from './configuration-catalog';
import {
  ConfigurationsService,
  TenantConfigurationView,
} from './configurations.service';

class UpsertConfigurationDto {
  @IsIn(CONFIGURATION_NAMESPACES)
  namespace!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secretRefs?: Record<string, unknown>;

  /** Actual secret values to store (encrypted). Never echoed back by any response. */
  @IsOptional()
  @IsObject()
  secretValues?: Record<string, unknown>;

  /** Field keys whose stored secret value should be deleted (reverts to any env-var fallback). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  clearSecrets?: string[];

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;

  /** Optimistic-concurrency token: the updatedAt the client last saw. */
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}

class SyncGithubOrgDto {
  /** Overrides the github namespace's own backfillDays for this sync only. */
  @IsOptional()
  @IsNumber()
  backfillDays?: number;
}

/**
 * Upper bound on a re-backfill request. Not a technical limit — a guard against
 * a typo turning into an unbounded API walk across every repository, which on a
 * 200-repo org is measured in days of rate-limited catch-up.
 */
const MAX_REBACKFILL_MONTHS = 60;

@Controller('admin/configurations')
export class ConfigurationsController {
  constructor(
    private readonly configurations: ConfigurationsService,
    private readonly secrets: SecretsService,
    private readonly githubOrgSync: GithubOrgSyncService,
    private readonly commitReconciler: GithubCommitReconcilerService,
    private readonly commitMessageReconciler: GithubCommitMessageReconcilerService,
    private readonly prReconciler: GithubPrReconcilerService,
    private readonly reviewReconciler: GithubReviewReconcilerService,
    private readonly storyDateReconciler: JiraStoryDateReconcilerService,
    private readonly assigneeEmailReconciler: JiraAssigneeEmailReconcilerService,
    private readonly correlation: CorrelationService,
    private readonly identities: DeveloperIdentityService,
    private readonly connections: ConnectionsService,
    private readonly progress: CollectionProgressService,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  @Roles(Role.ADMIN)
  @Get('catalog')
  catalog() {
    // RegExp objects don't survive JSON.stringify (serialize to `{}`) — send
    // the pattern source as a string; the frontend reconstructs it for
    // client-side validation that mirrors the server-side check exactly.
    return {
      secretRefHint: SECRET_REF_HINT,
      secretRefPattern: SECRET_REF_PATTERN.source,
      // Whether pasting a secret value will actually work server-side
      // (SECRETS_ENCRYPTION_KEY configured) — lets the UI explain itself
      // instead of failing opaquely on save.
      secretsStoreEnabled: this.secrets.isEnabled(),
      sections: CONFIGURATION_CATALOG.map((section) => ({
        ...section,
        fields: section.fields.map((field) => ({
          ...field,
          pattern: field.pattern?.source,
        })),
      })),
    };
  }

  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const configs = await this.configurations.listTenantConfigurations(
      user.tenantId,
    );
    return { configurations: configs.map((config) => this.toView(config)) };
  }

  @Roles(Role.ADMIN)
  @Put()
  async upsert(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertConfigurationDto,
  ) {
    const config = await this.configurations.upsertTenantConfiguration(
      user.tenantId,
      dto,
      { actorId: user.userId },
    );
    return this.toView(config);
  }

  /**
   * Discovers every repo in the tenant's configured GitHub org and registers
   * a Connection per repo (skipping ones already registered, and archived/
   * disabled repos) so the regular scheduler picks each one up. Complements
   * the single-default-repo bridge above — this is "sync the whole org."
   * The token is resolved server-side and never appears in the response.
   */
  @Roles(Role.ADMIN)
  @Post('github/sync-org')
  async syncGithubOrg(
    @CurrentUser() user: AuthUser,
    @Body() dto: SyncGithubOrgDto,
  ) {
    const configs = await this.configurations.listTenantConfigurations(
      user.tenantId,
    );
    const github = configs.find(
      (c) => c.namespace === 'github' && c.key === 'default',
    );
    const values = (github?.values ?? {}) as Record<string, unknown>;
    const secretRefs = (github?.secretRefs ?? {}) as Record<string, unknown>;
    const organization =
      typeof values.organization === 'string' ? values.organization : undefined;
    const tokenRef =
      typeof secretRefs.tokenRef === 'string' ? secretRefs.tokenRef : undefined;

    if (!github || github.status !== 'active' || !organization || !tokenRef) {
      throw new BadRequestException(
        'Configure GitHub (organization + token secret ref, saved as active) before syncing the whole org.',
      );
    }

    const token = await this.secrets.resolve(user.tenantId, tokenRef);
    if (!token) {
      throw new BadRequestException(
        `No value is stored (or set via env var) for secret ref "${tokenRef}" yet — paste the token in the Configuration screen, or set the env var, first.`,
      );
    }

    const backfillDays =
      dto.backfillDays ??
      (typeof values.backfillDays === 'number' ? values.backfillDays : 90);

    return this.githubOrgSync.syncOrgRepos(
      user.tenantId,
      organization,
      tokenRef,
      token,
      backfillDays,
    );
  }

  /**
   * One-off maintenance: fills in additions/deletions/filesChanged for
   * already-ingested commits still at 0/0/0 (see
   * `GithubCommitReconcilerService` for why this can't happen via normal
   * re-ingestion). Updates `code_commit` rows directly.
   */
  /**
   * "Is this tenant converging, and roughly when?" — the question Sync Status
   * could not answer. It reported what had *happened* (runs, event counts,
   * badges) but nothing said whether the outstanding backfill work was going
   * to finish, which is exactly what an admin needs before the end of the day.
   *
   * Read-only and cheap (one COUNT per reconciler); it starts no work. Lives
   * here rather than on `/admin/connections/sync-status` because the backlog
   * is collector state (BC-1) and BC-0's `ConnectionsService` must not depend
   * on the context that already depends on it.
   */
  @Roles(Role.ADMIN)
  @Get('collection-progress')
  async collectionProgress(@CurrentUser() user: AuthUser) {
    return this.progress.getBacklog(user.tenantId);
  }

  @Roles(Role.ADMIN)
  @Post('github/reconcile-commit-stats')
  async reconcileCommitStats(@CurrentUser() user: AuthUser) {
    return this.commitReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: fills in additions/deletions/changedFiles for
   * already-ingested PRs still at 0/0/0 (see `GithubPrReconcilerService` for
   * why this can't happen via normal re-ingestion). Updates
   * `code_pull_request` rows directly.
   */
  @Roles(Role.ADMIN)
  @Post('github/reconcile-pr-stats')
  async reconcilePrStats(@CurrentUser() user: AuthUser) {
    return this.prReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: fetches the review timeline for PRs ingested before
   * reviews were collected. The regular sync will never reach them — it only
   * walks PRs newer than the `prNewestSeenAt` watermark, and every existing PR
   * sits behind it (see `GithubReviewReconcilerService`).
   *
   * Bounded per invocation (one API call per PR) and resumable — re-run until
   * `remaining` is 0.
   */
  @Roles(Role.ADMIN)
  @Post('github/reconcile-reviews')
  async reconcileReviews(@CurrentUser() user: AuthUser) {
    return this.reviewReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: fetches commit subjects for PRs ingested before
   * commit-message collection existed — the same watermark trap as reviews
   * (see `GithubCommitMessageReconcilerService`). Commit messages are one of
   * the three Jira-key sources correlation matches on (§6); once they land,
   * the 30-minute orphan sweep re-attempts linkage automatically.
   *
   * Bounded per invocation (one API call per PR) and resumable — re-run until
   * `remaining` is 0.
   */
  @Roles(Role.ADMIN)
  @Post('github/reconcile-commit-messages')
  async reconcileCommitMessages(@CurrentUser() user: AuthUser) {
    return this.commitMessageReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: fills in `story.sourceCreatedAt` (Jira's own `created`
   * date) for work items ingested before that field was collected, so they
   * rejoin `lead_time` instead of being excluded.
   *
   * A cursor reset and re-walk cannot do this: the Jira idempotency key is
   * derived from the issue's `updated` timestamp, so re-collecting an unchanged
   * issue produces the same key and is dropped as a duplicate before it reaches
   * the projector (see `JiraStoryDateReconcilerService`).
   */
  @Roles(Role.ADMIN)
  @Post('jira/reconcile-story-dates')
  async reconcileStoryDates(@CurrentUser() user: AuthUser) {
    return this.storyDateReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: fills in `story.assigneeEmail` for work items ingested
   * before the assignee's email was read (api/README.md §12 #46). That address
   * is the strong rung of the Jira↔GitHub identity bridge (DATA-MODEL.md §3.1),
   * so this is what turns display-name guessing into an exact match.
   *
   * Same watermark trap as the story dates above — a re-walk produces identical
   * idempotency keys and is dropped as a duplicate — but keyed on the ASSIGNEE
   * rather than the story, since an email is a fact about a person: one issue
   * per distinct assignee teaches us the address for every issue they hold.
   *
   * `emailsWithheld: true` in the response means Jira answered and disclosed
   * nobody's address. That is not a failure of this endpoint: Jira Cloud hides
   * `emailAddress` unless user-profile visibility permits it, so it is a
   * setting to change, and until it is the bridge keeps using display names.
   */
  @Roles(Role.ADMIN)
  @Post('jira/reconcile-assignee-emails')
  async reconcileAssigneeEmails(@CurrentUser() user: AuthUser) {
    return this.assigneeEmailReconciler.reconcile(user.tenantId);
  }

  /**
   * One-off maintenance: re-attempts Jira↔GitHub correlation for PRs already
   * flagged as orphans (see `CorrelationService.reconcileOrphans` for why a
   * PR ingested before its Jira story existed needs this instead of
   * resolving on its own). Pure in-database matching — no external API calls.
   */
  @Roles(Role.ADMIN)
  @Post('correlation/reconcile-orphans')
  async reconcileOrphans(@CurrentUser() user: AuthUser) {
    return this.correlation.reconcileOrphans(user.tenantId);
  }

  /**
   * Rebuilds the developer identity map (BC-5): links the git identities a
   * person commits under to the GitHub account their pull requests carry.
   *
   * Needed because GitHub attributes a commit only when its email is verified
   * on an account — otherwise the commit lands with a name and email and no
   * login, and Engineering Activity reports "0 commits" for someone who has been
   * committing all month. Runs on the correlation sweep too; this is the
   * button for applying it immediately. Pure in-database matching, no external
   * API calls, safe to re-run.
   */
  @Roles(Role.ADMIN)
  @Post('correlation/resolve-identities')
  async resolveIdentities(@CurrentUser() user: AuthUser) {
    return this.identities.resolveTenant(user.tenantId);
  }

  /**
   * Re-opens collection history for every connection of a source system.
   *
   * The only way to deepen the data horizon. Raising `backfillDays` in the
   * configuration above reaches only the one connection that configuration
   * manages — connections created by an org sync (one per repository) are not
   * config-managed, so before this endpoint there was no supported way to widen
   * their window at all.
   *
   * Additive, never destructive: no rows are deleted. Re-collected records
   * upsert in place on their natural keys and already-seen events are dropped
   * by the ingestion idempotency key, so the cost is API calls and time, not
   * data loss. See `ConnectionsService.reopenBackfill`.
   */
  @Roles(Role.ADMIN)
  @Post(':source/rebackfill')
  async rebackfill(
    @CurrentUser() user: AuthUser,
    @Param('source') source: string,
    @Body() body: { months?: number },
  ) {
    if (source !== 'github' && source !== 'jira') {
      throw new BadRequestException(
        `Unsupported source "${source}". Supported: github, jira.`,
      );
    }
    const months = Number(body?.months);
    if (
      !Number.isFinite(months) ||
      months <= 0 ||
      months > MAX_REBACKFILL_MONTHS
    ) {
      throw new BadRequestException(
        `"months" must be between 1 and ${MAX_REBACKFILL_MONTHS}.`,
      );
    }

    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - months);

    const connections = await this.connections.listForTenant(
      user.tenantId,
      source,
    );
    // Only widen. Re-pointing a connection at a NEWER floor would strand the
    // history already collected behind it — the rows stay, but nothing would
    // ever re-walk the gap, so the data would silently have a hole in it.
    const widened = connections.filter((c) => {
      const current = (c.config as { backfillSince?: string } | null)
        ?.backfillSince;
      return !current || new Date(current) > since;
    });

    for (const connection of widened) {
      await this.connections.reopenBackfill(connection.id, since);
    }

    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'connection.rebackfill',
      targetType: 'connection',
      targetId: source,
      metadata: {
        source,
        months,
        since: since.toISOString(),
        connectionsReopened: widened.length,
        connectionsAlreadyDeeper: connections.length - widened.length,
      },
    });

    return {
      source,
      since: since.toISOString(),
      months,
      connectionsReopened: widened.length,
      connectionsAlreadyDeeper: connections.length - widened.length,
      note: 'Cursors cleared. The scheduled sweep walks the new window from the next tick; no data was deleted.',
    };
  }

  private toView(config: TenantConfigurationView) {
    return {
      id: config.id,
      namespace: config.namespace,
      key: config.key,
      values: config.values,
      secretRefs: config.secretRefs,
      status: config.status,
      updatedAt: config.updatedAt,
      // Whether this namespace is actually collecting data, not just saved —
      // null for config-only namespaces (llm/notifications/metrics/security).
      connection: config.connection,
      // Per secret-ref field: whether a value is stored in the encrypted DB
      // store. Never the value itself — write-only from the admin's side.
      secretsConfigured: config.secretsConfigured,
    };
  }
}
