import { Injectable } from '@nestjs/common';
import { PullRequest } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { newId } from '../common/id';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';

export interface PrCycleTimeResult {
  metric: 'pr_cycle_time';
  repo: string;
  sampleSize: number;
  p50Hours: number | null;
  p85Hours: number | null;
  computedAt: string;
}

export interface MetricCell {
  sampleSize: number;
  value?: number | null;
  p50Hours: number | null;
  p85Hours: number | null;
  additions?: number;
  deletions?: number;
  netChanged?: number;
}

/** One row of the batch response: a group key + its metric values. */
export interface MetricRow {
  key: string; // group identity, e.g. repo full name
  metrics: Record<string, MetricCell>;
}

/**
 * BC-8 Metrics & Aggregation Engine. Scaffold computes one real metric end to
 * end — PR cycle time (open → merge, p50/p85) — over correlated PR facts, and
 * persists a lineage-tagged metric_value. Tenant-scoped via TenantContextService.
 * See docs/features/METRICS.md.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly code: CodeService,
    private readonly correlation: CorrelationService,
    private readonly planning: PlanningService,
  ) {}

  async computePrCycleTime(repoFullName: string): Promise<PrCycleTimeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const prs = await this.code.listMergedPullRequests(tenantId, repoFullName);

    const durationsHours = prs
      .filter((pr) => pr.mergedAt && pr.openedAt)
      .map(
        (pr) =>
          (pr.mergedAt!.getTime() - pr.openedAt!.getTime()) / (1000 * 60 * 60),
      )
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);

    const p50 = percentile(durationsHours, 50);
    const p85 = percentile(durationsHours, 85);
    const computedAt = new Date();

    if (durationsHours.length > 0) {
      const now = computedAt;
      await this.prisma.metricValue.create({
        data: {
          id: newId(),
          tenantId,
          metricKey: 'pr_cycle_time',
          scopeType: 'repo',
          scopeId: repoFullName,
          periodStart: prs.reduce(
            (min, pr) => (pr.openedAt! < min ? pr.openedAt! : min),
            now,
          ),
          periodEnd: now,
          value: p50 ?? 0,
          sampleSize: durationsHours.length,
          lineage: { prIds: prs.map((pr) => pr.id) },
        },
      });
    }

    return {
      metric: 'pr_cycle_time',
      repo: repoFullName,
      sampleSize: durationsHours.length,
      p50Hours: round2(p50),
      p85Hours: round2(p85),
      computedAt: computedAt.toISOString(),
    };
  }

  /**
   * Batch PR cycle time for the dashboard scope system: one call for N repos,
   * optional time window, grouped by repo. Read-only (no metric_value writes —
   * persistence stays with the scheduled rollups / single-scope path).
   */
  async computePrCycleTimeForRepos(
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<MetricRow[]> {
    return this.computeMetricsForRepos(['pr_cycle_time'], repos, from, to);
  }

  async computeMetricsForRepos(
    metricKeys: string[],
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<MetricRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const prs = await this.code.listPullRequestsForRepos(
      tenantId,
      repos,
      from,
      to,
    );
    const prsByRepo = groupPullRequestsByRepo(prs);
    const bugIdsByRepo = metricKeys.includes('bug_count')
      ? await this.correlation.bugStoryIdsByRepo(tenantId, repos, from, to)
      : new Map<string, Set<string>>();

    return repos.map((repo) => {
      const rowPrs = prsByRepo.get(repo) ?? [];
      return {
        key: repo,
        metrics: buildMetricCells(metricKeys, rowPrs, bugIdsByRepo.get(repo)),
      };
    });
  }

  async computeMetricsForProjects(
    metricKeys: string[],
    projectKeys: string[],
    from?: Date,
    to?: Date,
  ): Promise<MetricRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const refsByProject = await this.correlation.pullRequestRefsByProject(
      tenantId,
      projectKeys,
    );
    const allRefs = [...new Set([...refsByProject.values()].flat())];
    const prs = await this.code.listPullRequestsByRefs(
      tenantId,
      allRefs,
      from,
      to,
    );
    const prsByRef = new Map(prs.map((pr) => [pullRequestRef(pr), pr]));
    const bugIdsByProject = metricKeys.includes('bug_count')
      ? await this.planning.listBugStoryIdsByProject(
          tenantId,
          projectKeys,
          from,
          to,
        )
      : new Map<string, string[]>();

    return projectKeys.map((project) => {
      const rowPrs = (refsByProject.get(project) ?? [])
        .map((ref) => prsByRef.get(ref))
        .filter((pr): pr is PullRequest => Boolean(pr));
      return {
        key: project,
        metrics: buildMetricCells(
          metricKeys,
          rowPrs,
          new Set(bugIdsByProject.get(project) ?? []),
        ),
      };
    });
  }

  async computeMetricsForDevelopers(
    metricKeys: string[],
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<MetricRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const prs = await this.code.listDashboardPullRequests(
      tenantId,
      repos,
      from,
      to,
    );
    const byAuthor = new Map<string, PullRequest[]>();
    for (const pr of prs) {
      const author = pr.authorLogin || 'Unassigned';
      byAuthor.set(author, [...(byAuthor.get(author) ?? []), pr]);
    }
    return [...byAuthor.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([author, authorPrs]) => ({
        key: author,
        metrics: buildMetricCells(
          metricKeys.filter((key) => key !== 'bug_count'),
          authorPrs,
        ),
      }));
  }

  async computeMetricsByDay(
    metricKeys: string[],
    repos: string[],
    projectKeys: string[],
    from?: Date,
    to?: Date,
  ): Promise<MetricRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const prs = await this.code.listDashboardPullRequests(
      tenantId,
      repos,
      from,
      to,
    );
    const byDay = new Map<string, PullRequest[]>();
    for (const pr of prs) {
      if (!pr.mergedAt) {
        continue;
      }
      const day = pr.mergedAt.toISOString().slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), pr]);
    }
    const bugCountsByDay = metricKeys.includes('bug_count')
      ? await this.planning.listBugCountsByDay(tenantId, projectKeys, from, to)
      : new Map<string, number>();
    const days = new Set([...byDay.keys(), ...bugCountsByDay.keys()]);

    return [...days].sort().map((day) => {
      const metrics = buildMetricCells(metricKeys, byDay.get(day) ?? []);
      if (metricKeys.includes('bug_count')) {
        const count = bugCountsByDay.get(day) ?? 0;
        metrics.bug_count = {
          sampleSize: count,
          value: count,
          p50Hours: null,
          p85Hours: null,
        };
      }
      return { key: day, metrics };
    });
  }
}

function buildMetricCells(
  metricKeys: string[],
  prs: PullRequest[],
  bugIds?: Set<string>,
): Record<string, MetricCell> {
  const metrics: Record<string, MetricCell> = {};
  for (const key of metricKeys) {
    if (key === 'pr_cycle_time') {
      metrics[key] = cycleTimeCell(prs);
    } else if (key === 'loc_added_deleted') {
      metrics[key] = locCell(prs);
    } else if (key === 'bug_count') {
      const count = bugIds?.size ?? 0;
      metrics[key] = {
        sampleSize: count,
        value: count,
        p50Hours: null,
        p85Hours: null,
      };
    }
  }
  return metrics;
}

function cycleTimeCell(prs: PullRequest[]): MetricCell {
  const durations = prs
    .filter((pr) => pr.mergedAt && pr.openedAt)
    .map(
      (pr) =>
        (pr.mergedAt!.getTime() - pr.openedAt!.getTime()) / (1000 * 60 * 60),
    )
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  return {
    sampleSize: durations.length,
    p50Hours: round2(percentile(durations, 50)),
    p85Hours: round2(percentile(durations, 85)),
  };
}

function locCell(prs: PullRequest[]): MetricCell {
  const additions = prs.reduce((sum, pr) => sum + pr.additions, 0);
  const deletions = prs.reduce((sum, pr) => sum + pr.deletions, 0);
  return {
    sampleSize: prs.length,
    value: additions + deletions,
    p50Hours: null,
    p85Hours: null,
    additions,
    deletions,
    netChanged: additions - deletions,
  };
}

function groupPullRequestsByRepo(
  prs: PullRequest[],
): Map<string, PullRequest[]> {
  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    byRepo.set(pr.repoFullName, [...(byRepo.get(pr.repoFullName) ?? []), pr]);
  }
  return byRepo;
}

function pullRequestRef(pr: PullRequest): string {
  return `${pr.repoFullName}#${pr.externalNumber}`;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}

function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}
