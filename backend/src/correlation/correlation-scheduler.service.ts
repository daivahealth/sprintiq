import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { CorrelationService } from './correlation.service';
import { DeveloperIdentityService } from './developer-identity.service';

/**
 * Scheduled orphan re-matching (BC-5).
 *
 * Correlation runs once, at PR-ingestion time, and a PR whose Jira story
 * wasn't loaded yet becomes a permanent orphan because nothing looks again.
 * That race isn't incidental — it is structural during a joint backfill,
 * because the two collectors walk history in OPPOSITE directions:
 *
 *   GitHub  `sort=updated&direction=desc`  → newest PRs first
 *   Jira    `ORDER BY updated ASC`         → oldest stories first
 *
 * They converge from opposite ends, so GitHub's first pages are the newest
 * PRs, which reference exactly the stories Jira reaches last. Waiting for an
 * admin to notice and press the button is not a strategy; this closes the
 * window by construction.
 *
 * Safe to run often: pure in-database matching over titles/branches/commit
 * messages against story keys already ingested. No external API calls (so the
 * collector boundary is untouched), and idempotent — a resolved orphan stops
 * being a candidate.
 */
@Injectable()
export class CorrelationSchedulerService {
  private readonly logger = new Logger(CorrelationSchedulerService.name);

  constructor(
    private readonly correlation: CorrelationService,
    private readonly identities: DeveloperIdentityService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Every 30 minutes: frequent enough that the backfill race resolves itself
   * within one Jira sweep, cheap enough that it costs nothing to run when
   * there is nothing to do (the candidate query returns empty).
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    // Per tenant: reconcileOrphans is tenant-scoped, and cross-tenant
    // matching would be a correctness AND an isolation failure.
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });

    for (const tenant of tenants) {
      try {
        const result = await this.correlation.reconcileOrphans(tenant.id);
        if (result.resolved > 0) {
          this.logger.log(
            `Orphan sweep (tenant ${tenant.id}): resolved ${result.resolved} of ${result.candidates}, ${result.stillOrphaned} still unmatched.`,
          );
        }
      } catch (error) {
        // One tenant's failure must not abort the sweep for the rest.
        this.logger.error(
          `Orphan sweep failed for tenant ${tenant.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Same shape, different edge: identity resolution also runs once per
      // sweep because it too depends on facts that keep arriving. A person is
      // unresolvable until they open their first PR (that is where the login
      // comes from), so re-deriving on a schedule is what turns a newly-hired
      // developer's back-catalogue of commits from nobody's into theirs.
      try {
        const result = await this.identities.resolveTenant(tenant.id);
        if (result.recovered > 0 || result.ambiguous > 0) {
          this.logger.log(
            `Identity sweep (tenant ${tenant.id}): recovered ${result.recovered}, ${result.unresolved} unresolved, ${result.ambiguous} ambiguous of ${result.observed}.`,
          );
        }
        // Strictly after the GitHub pass in the same try: the Jira arm matches
        // against the canonical ids that pass mints, so running it first (or
        // after a failure) would match against a stale or empty roster and
        // record every assignee as unmatched — which the Watchlist would then
        // publish as a collapsed match rate.
        const jira = await this.identities.resolveJiraAssignees(tenant.id);
        if (jira.unmatched > 0 || jira.ambiguous > 0) {
          this.logger.log(
            `Jira assignee sweep (tenant ${tenant.id}): ${jira.matched} matched, ${jira.unmatched} unmatched, ${jira.ambiguous} ambiguous of ${jira.observed}.`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Identity sweep failed for tenant ${tenant.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
