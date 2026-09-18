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

    if (!dryRun) {
      const existing = await this.prisma.noCommitDigestRun.findUnique({
        where: {
          tenantId_reportedDay: { tenantId, reportedDay },
        },
        select: { outcome: true },
      });
      if (
        existing &&
        DELIVERED.has(existing.outcome as DigestOutcome) &&
        options.force !== true
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

    const card = buildDigestCard({
      reportedDay,
      flagged: result.flagged,
      evaluatedCount,
      collectedThroughAt: detected.collectedThroughAt,
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
      await this.recordRun(tenantId, detected, 'failed', errorDetail(error));
      throw error;
    }

    await this.recordRun(tenantId, detected, outcome, detail);
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

  private async recordRun(
    tenantId: string,
    detected: {
      reportedDay: string;
      rosterCount: number;
      evaluation: {
        flagged: NamedDeveloper[];
        unresolved: { developer: string; addedAs: string }[];
        incomplete: NamedDeveloper[];
      };
    },
    outcome: DigestOutcome,
    detail: string | null,
  ): Promise<void> {
    const delivered = outcome !== 'failed';
    const flagged = DELIVERED.has(outcome) ? detected.evaluation.flagged : [];
    const data = {
      outcome,
      rosterCount: detected.rosterCount,
      flaggedCount: flagged.length,
      flagged: flagged as unknown as Prisma.InputJsonValue,
      unresolved: detected.evaluation
        .unresolved as unknown as Prisma.InputJsonValue,
      incomplete: detected.evaluation
        .incomplete as unknown as Prisma.InputJsonValue,
      detail,
      // A card is posted for the three withheld outcomes too — only the
      // names are withheld from it. `deliveredAt` answers "did a card reach
      // the channel?", which is true for `sent`, `sent_all_clear` AND the
      // withheld_* outcomes; it is null only when delivery itself failed.
      // `flagged` (above) is the separate question of "were names in it?",
      // which stays empty for every withheld/failed outcome.
      deliveredAt: delivered ? new Date() : null,
    };
    await this.prisma.noCommitDigestRun.upsert({
      where: {
        tenantId_reportedDay: {
          tenantId,
          reportedDay: detected.reportedDay,
        },
      },
      create: {
        id: newId(),
        tenantId,
        reportedDay: detected.reportedDay,
        ...data,
      },
      update: data,
    });
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
