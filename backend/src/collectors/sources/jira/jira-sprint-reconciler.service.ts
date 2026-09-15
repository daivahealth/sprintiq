import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { JiraClient } from './jira.client';

export interface SprintReconcileResult {
  /** Distinct sprint ids referenced by the scope log with no sprint row. */
  candidates: number;
  created: number;
  /** Referenced sprints Jira would not return — the gap stays visible. */
  skipped: number;
}

/**
 * Bounds one invocation: one request per missing sprint, so this is a request
 * budget, not a row budget. A larger backlog catches up over ticks, the same
 * shape as the story-date and GitHub reconcilers.
 */
const MAX_SPRINTS_PER_RUN = 50;

/**
 * Creates the sprints that exist in Jira but never became rows here.
 *
 * `PlanningService` learns of a sprint only from an issue's CURRENT sprint
 * field, so a sprint becomes invisible the moment no collected issue still
 * sits in it — which, with monthly sprints and ordinary carry-over, is every
 * closed sprint whose work rolled forward. On the reference tenant the scope
 * log referenced 77 distinct sprint ids while only 63 sprint rows existed:
 * fourteen sprints that issues demonstrably moved through, absent from every
 * picker and every board. Sprint 234 alone carried 306 scope changes across
 * seven projects.
 *
 * The scope log is the evidence. It records every sprint an issue was ever
 * added to or removed from, so it knows about sprints current membership has
 * forgotten — and this service asks Jira for each one it cannot find.
 *
 * Why this is a reconciler rather than a change to the collector. Re-walking
 * cannot fix it: the Jira envelope's idempotency key derives from the issue's
 * own `updated` timestamp, so re-collecting an unchanged issue produces the
 * identical key and is dropped before it reaches a projection. The same trap
 * `JiraStoryDateReconcilerService` documents. Fetching the missing sprints
 * directly is the only route — and it costs one request each rather than a
 * re-walk of every issue.
 *
 * The token never leaves the backend: resolved per-connection via
 * SecretsService, never returned or logged.
 */
@Injectable()
export class JiraSprintReconcilerService {
  private readonly logger = new Logger(JiraSprintReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: JiraClient,
  ) {}

  /**
   * How many referenced sprints are still missing — without asking Jira, so
   * the Sync Status backlog costs nothing to display.
   */
  async countRemaining(tenantId: string): Promise<number> {
    return (await this.missingSprints(tenantId)).length;
  }

  async reconcile(tenantId: string): Promise<SprintReconcileResult> {
    const missing = (await this.missingSprints(tenantId)).slice(
      0,
      MAX_SPRINTS_PER_RUN,
    );
    let created = 0;
    let skipped = 0;

    for (const candidate of missing) {
      const connection = await this.prisma.connection.findUnique({
        where: { id: candidate.connectionId },
      });
      const config = (connection?.config ?? {}) as {
        siteUrl?: string;
        email?: string;
      };
      if (!connection || !config.siteUrl || !config.email) {
        skipped += 1;
        continue;
      }

      const apiToken = await this.secrets.resolve(
        tenantId,
        connection.secretRef,
      );
      if (!apiToken) {
        skipped += 1;
        continue;
      }

      const sprint = await this.client.getSprint(
        config.siteUrl,
        config.email,
        apiToken,
        candidate.sprintExternalId,
      );
      // Null covers both a transient failure and a sprint Jira no longer has.
      // Neither is a sprint, and a row written from a failed lookup would have
      // no window — which is what pace, elapsed and the check-in grid are all
      // computed from. The gap stays visible instead.
      if (!sprint) {
        skipped += 1;
        continue;
      }

      await this.prisma.sprint.create({
        data: {
          id: newId(),
          tenantId,
          connectionId: candidate.connectionId,
          externalId: candidate.sprintExternalId,
          name: sprint.name,
          state: sprint.state ?? 'closed',
          projectKey: candidate.projectKey,
          startAt: sprint.startDate ? new Date(sprint.startDate) : null,
          endAt: sprint.endDate ? new Date(sprint.endDate) : null,
          goal: sprint.goal ?? null,
        },
      });
      created += 1;
    }

    if (created > 0) {
      this.logger.log(
        `Recovered ${created} sprint(s) referenced by the scope log for tenant ${tenantId}.`,
      );
    }
    return { candidates: missing.length, created, skipped };
  }

  /**
   * Sprint ids the scope log references and `planning_sprint` does not hold,
   * each with the first issue seen referencing it.
   *
   * The issue matters for more than provenance: the Agile API returns a board
   * id, never a project key, so the referencing issue's key is the only thing
   * that can place the sprint in a project. A sprint shared across projects
   * therefore lands under the first one observed — imperfect, and no worse
   * than the single `projectKey` the model already assumes.
   */
  private async missingSprints(tenantId: string): Promise<
    {
      sprintExternalId: string;
      connectionId: string;
      projectKey: string;
    }[]
  > {
    const referenced = await this.prisma.sprintScopeChange.findMany({
      where: { tenantId },
      select: {
        sprintExternalId: true,
        connectionId: true,
        externalKey: true,
      },
      distinct: ['sprintExternalId'],
    });
    if (referenced.length === 0) {
      return [];
    }

    const existing = await this.prisma.sprint.findMany({
      where: {
        tenantId,
        externalId: { in: referenced.map((r) => r.sprintExternalId) },
      },
      select: { externalId: true },
    });
    const known = new Set(existing.map((s) => s.externalId));

    // De-duplicated here as well as in the query. The `distinct` above is an
    // efficiency measure; this is the guarantee. One sprint id can carry
    // hundreds of scope changes — 306 for sprint 234 on the reference tenant —
    // and fetching it once per change would spend hundreds of requests to
    // write one row, then fail the unique key on every attempt after the first.
    const seen = new Set<string>();
    const missing: {
      sprintExternalId: string;
      connectionId: string;
      projectKey: string;
    }[] = [];
    for (const row of referenced) {
      if (known.has(row.sprintExternalId) || seen.has(row.sprintExternalId)) {
        continue;
      }
      seen.add(row.sprintExternalId);
      missing.push({
        sprintExternalId: row.sprintExternalId,
        connectionId: row.connectionId,
        // `NHIL-412` -> `NHIL`. Jira keys are `<PROJECT>-<number>`.
        projectKey: row.externalKey.split('-')[0],
      });
    }
    return missing;
  }
}
