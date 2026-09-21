import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { newId } from '../../common/id';
import { previousWorkingDayKey } from '../../common/time';
import { buildDigestCard } from '../../collectors/delivery/digest-card';
import { TeamsClient } from '../../collectors/delivery/teams.client';
import {
  DigestOutcome,
  NamedDeveloper,
  NoCommitDetectionService,
} from '../../metrics/no-commit-detection.service';
import { PrismaService } from '../../database/prisma.service';

const NOTIFICATIONS_NAMESPACE = 'notifications';
const CONFIG_KEY = 'default';

/**
 * The `notifications` configuration catalog **field key** for the Teams
 * webhook secret — NOT the secret ref itself.
 *
 * `ConfigurationsService.applySecretValues` (backend/src/modules/
 * configurations/configurations.service.ts, ~line 450) calls
 * `secrets.setSecret(tenantId, secretRefs[fieldKey], value)`: the admin picks
 * an arbitrary ref name per tenant, and `secretRefs[TEAMS_WEBHOOK_FIELD]`
 * holds that chosen name. `TeamsClient.postAdaptiveCard` must be given the
 * *ref*, resolved from the tenant's `notifications` configuration row, never
 * this literal field key. Do not "simplify" this back to passing
 * `TEAMS_WEBHOOK_FIELD` straight to `postAdaptiveCard` — that only happens to
 * work if an admin names their ref identically to the field key, and fails
 * the first time a real tenant picks a different ref name.
 */
const TEAMS_WEBHOOK_FIELD = 'teamsWebhookRef';

/** Outcomes that mean a card went out with a list, or with an all-clear. */
const DELIVERED: ReadonlySet<DigestOutcome> = new Set([
  'sent',
  'sent_all_clear',
]);

/** Prisma's unique-constraint-violation error code. */
const UNIQUE_VIOLATION = 'P2002';

export interface RunDigestOptions {
  /** IST day key to report on. Defaults to the previous working day. */
  day?: string;
  /** Compute and return without posting or recording anything. */
  dryRun?: boolean;
  /** Re-run a day whose run already succeeded. */
  force?: boolean;
}

export interface RunDigestResult {
  reportedDay: string;
  outcome: DigestOutcome;
  flagged: NamedDeveloper[];
  unresolved: { developer: string; addedAs: string }[];
  incomplete: NamedDeveloper[];
  detail: string | null;
  dryRun: boolean;
}

/** Fields written when a run is first claimed, before the Teams POST. */
type ClaimData = {
  outcome: DigestOutcome;
  rosterCount: number;
  flaggedCount: number;
  flagged: Prisma.InputJsonValue;
  unresolved: Prisma.InputJsonValue;
  incomplete: Prisma.InputJsonValue;
  detail: string | null;
  deliveredAt: null;
  /** See `DigestDetection.unattributedCommits` — carried straight through. */
  unattributedCommits: number;
};

/**
 * BC-15 Notifications & Action. Decides *whether* to notify and *whom*;
 * `TeamsClient` decides *how*.
 *
 * The daily digest names people, so three things here are not optional: every
 * run is recorded with its outcome and reason (lineage — "why was I on
 * Tuesday's list?" must be answerable), every send is audit-logged, and a day
 * that already sent cannot send again without `force`.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly detection: NoCommitDetectionService,
    private readonly teams: TeamsClient,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  /** Tenants with both an enabled digest and a roster to evaluate. */
  async tenantsToDigest(): Promise<string[]> {
    const configs = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: NOTIFICATIONS_NAMESPACE, status: 'active' },
      select: { tenantId: true, values: true, secretRefs: true },
    });
    const enabled = configs
      .filter((row) => {
        const values = (row.values ?? {}) as Record<string, unknown>;
        const refs = (row.secretRefs ?? {}) as Record<string, unknown>;
        return (
          values.dailyDigestEnabled === true &&
          Boolean(refs[TEAMS_WEBHOOK_FIELD])
        );
      })
      .map((row) => row.tenantId);

    const withRoster = await Promise.all(
      enabled.map(async (tenantId) => {
        const count = await this.prisma.trackedDeveloper.count({
          where: { tenantId, active: true },
        });
        return count > 0 ? tenantId : null;
      }),
    );
    return withRoster.filter((id): id is string => id !== null);
  }

  async runNoCommitDigest(
    tenantId: string,
    options: RunDigestOptions = {},
  ): Promise<RunDigestResult> {
    const reportedDay = options.day ?? previousWorkingDayKey();
    const dryRun = options.dryRun === true;
    const force = options.force === true;

    let existing: { outcome: string } | null = null;
    if (!dryRun) {
      existing = await this.prisma.noCommitDigestRun.findUnique({
        where: {
          tenantId_reportedDay: { tenantId, reportedDay },
        },
        select: { outcome: true },
      });
      if (
        existing &&
        DELIVERED.has(existing.outcome as DigestOutcome) &&
        !force
      ) {
        throw new BadRequestException(
          `${reportedDay} was already sent for this tenant. Re-sending would post the same names twice; pass force to override.`,
        );
      }
    }

    const detected = await this.detection.detect(tenantId, reportedDay);
    const { evaluation } = detected;
    const evaluatedCount =
      detected.rosterCount -
      evaluation.unresolved.length -
      evaluation.suppressed.length;

    const outcome: DigestOutcome = detected.withhold
      ? detected.withhold.outcome
      : evaluation.flagged.length === 0
        ? 'sent_all_clear'
        : 'sent';
    const detail = detected.withhold?.detail ?? null;

    const result: RunDigestResult = {
      reportedDay,
      outcome,
      flagged: detected.withhold ? [] : evaluation.flagged,
      unresolved: evaluation.unresolved,
      incomplete: evaluation.incomplete,
      detail,
      dryRun,
    };

    if (dryRun) {
      // Deliberately writes no run row: a dry run is a question, not an
      // event, and must be repeatable for the same day.
      return result;
    }

    // Claim the (tenantId, reportedDay) row BEFORE the Teams POST, not after
    // it. This is the actual idempotency guard: two runners racing the same
    // fresh day (three role-ungated cron pods, or a manual re-run racing the
    // cron) must not both read "no row yet" and both post. `existing` was
    // read moments ago and may already be stale by the time we write — that
    // staleness is exactly the race — so a null `existing` attempts a bare
    // `create`, which only one of two concurrent callers can win; the loser's
    // unique-constraint violation means another runner already owns this
    // day, and it returns without posting. A non-null `existing` means this
    // call is a deliberate overwrite (an explicit `force`, or the documented
    // "a failed/withheld day may be re-run normally" path — the only way to
    // reach here with force absent and a row already present, since a
    // DELIVERED existing row without force already threw above), so it goes
    // straight to `update` rather than racing a `create` that would
    // predictably lose.
    const claimData: ClaimData = {
      outcome,
      rosterCount: detected.rosterCount,
      flaggedCount: result.flagged.length,
      flagged: result.flagged as unknown as Prisma.InputJsonValue,
      unresolved: result.unresolved as unknown as Prisma.InputJsonValue,
      incomplete: result.incomplete as unknown as Prisma.InputJsonValue,
      detail,
      deliveredAt: null,
      unattributedCommits: detected.unattributedCommits,
    };

    if (existing) {
      await this.prisma.noCommitDigestRun.update({
        where: { tenantId_reportedDay: { tenantId, reportedDay } },
        data: claimData,
      });
    } else {
      try {
        await this.prisma.noCommitDigestRun.create({
          data: { id: newId(), tenantId, reportedDay, ...claimData },
        });
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          // Another runner claimed this day between our read and our write.
          // That runner owns the send; returning here rather than posting is
          // what stops the same names reaching the channel twice.
          return result;
        }
        throw error;
      }
    }

    const card = buildDigestCard({
      reportedDay,
      flagged: result.flagged,
      evaluatedCount,
      collectedThroughAt: detected.collectedThroughAt,
      unattributedCommits: detected.unattributedCommits,
      ...(detail ? { withheldDetail: detail } : {}),
    });

    try {
      // Ref resolution lives inside the try too: a misconfigured tenant
      // (no ref set) is as much a failed delivery as a rejected POST, and
      // must record the same `failed` row rather than throwing silently
      // past it (requirement: a failed delivery always leaves a row).
      const webhookRef = await this.resolveTeamsWebhookRef(tenantId);
      await this.teams.postAdaptiveCard(tenantId, webhookRef, card);
    } catch (error) {
      await this.prisma.noCommitDigestRun.update({
        where: { tenantId_reportedDay: { tenantId, reportedDay } },
        data: {
          outcome: 'failed',
          flaggedCount: 0,
          flagged: [] as unknown as Prisma.InputJsonValue,
          detail: errorDetail(error),
          deliveredAt: null,
        },
      });
      throw error;
    }

    await this.prisma.noCommitDigestRun.update({
      where: { tenantId_reportedDay: { tenantId, reportedDay } },
      data: { deliveredAt: new Date() },
    });

    await this.audit?.record({
      tenantId,
      actorType: 'system',
      action: `notification.no_commit_digest.${outcome}`,
      targetType: 'no_commit_digest_run',
      targetId: reportedDay,
      metadata: {
        reportedDay,
        rosterCount: detected.rosterCount,
        flaggedCount: result.flagged.length,
        unresolvedCount: evaluation.unresolved.length,
        incompleteCount: evaluation.incomplete.length,
      },
    });

    return result;
  }

  /**
   * Resolves the tenant's actual Teams webhook secret ref.
   *
   * See the docblock on `TEAMS_WEBHOOK_FIELD`: the field key is not the ref.
   * The ref name lives in `secretRefs.teamsWebhookRef` on the tenant's
   * `notifications` configuration row, chosen by the admin when they set the
   * secret up. Throws with the field name so an admin diagnosing a failed
   * send knows exactly what to configure.
   */
  private async resolveTeamsWebhookRef(tenantId: string): Promise<string> {
    const config = await this.prisma.tenantConfiguration.findUnique({
      where: {
        tenantId_namespace_key: {
          tenantId,
          namespace: NOTIFICATIONS_NAMESPACE,
          key: CONFIG_KEY,
        },
      },
      select: { secretRefs: true },
    });
    const refs = (config?.secretRefs ?? {}) as Record<string, unknown>;
    const webhookRef = refs[TEAMS_WEBHOOK_FIELD];
    if (!webhookRef || typeof webhookRef !== 'string') {
      throw new Error(
        `Tenant ${tenantId} has no Teams webhook ref configured for "${TEAMS_WEBHOOK_FIELD}" in its notifications configuration — set it in admin/configuration before the digest can send.`,
      );
    }
    return webhookRef;
  }
}

/** Duck-typed so tests can simulate a Prisma unique-violation without the real error class. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
