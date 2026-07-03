import { Injectable } from '@nestjs/common';
import { PullRequest, Sprint, Story } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { CodeService } from '../modules/code/code.service';
import {
  DONE_STATUSES,
  PlanningService,
  WorkItemFilters,
} from '../modules/planning/planning.service';

/** One work item with its bi-directional GitHub linkage (Jira → PRs). */
export interface WorkItemView {
  key: string;
  title: string;
  type: string;
  status: string;
  done: boolean;
  storyPoints: number | null;
  assigneeName: string | null;
  epicKey: string | null;
  parentKey: string | null;
  sprintExternalId: string | null;
  releases: string[];
  resolvedAt: string | null;
  linkedPrs: { ref: string; state: string | null }[];
}

export interface SprintSummary {
  externalId: string;
  name: string;
  state: string;
  projectKey: string;
  startAt: string | null;
  endAt: string | null;
}

export interface SprintHealthView {
  sprint: SprintSummary;
  committedPoints: number;
  completedPoints: number;
  completionPct: number | null;
  itemsTotal: number;
  itemsDone: number;
  unestimatedItems: number;
  itemsWithCode: number;
  codeLinkagePct: number | null;
  daysRemaining: number | null;
  byType: { type: string; total: number; done: number }[];
}

export interface SprintRiskView {
  sprint: SprintSummary;
  openWithoutCode: WorkItemView[];
  openBugs: number;
  unestimatedOpen: number;
  atRiskPoints: number;
}

export interface VelocityRow {
  sprint: SprintSummary;
  committedPoints: number;
  completedPoints: number;
  itemsDone: number;
}

export interface ForecastView {
  projectKey: string;
  sprintsSampled: number;
  avgVelocityPoints: number | null;
  remainingPoints: number;
  remainingItems: number;
  unestimatedItems: number;
  sprintsNeeded: number | null;
  projectedDate: string | null;
  assumedSprintDays: number;
}

export interface ProductivityWeek {
  weekStart: string;
  itemsCompleted: number;
  pointsCompleted: number;
  prsMerged: number;
  locChanged: number;
}

export interface EfficiencyView {
  prCycle: {
    sampleSize: number;
    p50Hours: number | null;
    p85Hours: number | null;
  };
  storyCycle: {
    sampleSize: number;
    p50Days: number | null;
    p85Days: number | null;
  };
  traceability: {
    storiesWithCodePct: number | null; // Jira → GitHub direction
    prsWithStoryPct: number | null; // GitHub → Jira direction
    storiesTotal: number;
    prsTotal: number;
  };
}

export interface ProjectActivityRow {
  projectKey: string; // '(unlinked repos)' bucket for repos mapped to no project
  commits: number;
  locChanged: number;
  additions: number;
  deletions: number;
  activeRepos: number;
  topRepo: string | null;
  contributors: number;
}

export interface DeveloperActivityView {
  developer: string;
  totals: {
    commits: number;
    additions: number;
    deletions: number;
    locChanged: number;
    filesChanged: number;
    prsAuthored: number;
    activeRepos: number;
  };
  activeProjects: string[]; // via repo→project graph mapping
  byRepo: {
    repo: string;
    commits: number;
    locChanged: number;
    lastCommitAt: string;
  }[];
  dailySeries: { date: string; commits: number; locChanged: number }[];
  recentCommits: {
    sha: string;
    repo: string;
    message: string;
    authoredAt: string;
    additions: number;
    deletions: number;
  }[];
}

const DEFAULT_SPRINT_DAYS = 14;

/**
 * BC-8 insight read models behind the common dashboards (Sprint Health, Sprint
 * Risk, Velocity, Forecast, Productivity, Efficiency) plus work-item detailing
 * at every granularity (story/bug/subtask/epic/developer/release/sprint) with
 * bi-directional Jira↔GitHub traceability. Read-only; numbers are computed from
 * persisted facts + correlation links — never fabricated.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly correlation: CorrelationService,
  ) {}

  /** Work-item detail rows (any granularity) with linked PRs per item. */
  async workItems(filters: WorkItemFilters): Promise<WorkItemView[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const items = await this.planning.listWorkItems(tenantId, filters);
    return this.toViews(tenantId, items);
  }

  async sprintHealth(
    sprintExternalId: string,
  ): Promise<SprintHealthView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprint = await this.findSprint(tenantId, sprintExternalId);
    if (!sprint) {
      return null;
    }
    const items = (
      await this.planning.listItemsForSprint(tenantId, sprintExternalId)
    ).filter((i) => i.type !== 'epic');
    const views = await this.toViews(tenantId, items);

    const done = views.filter((v) => v.done);
    const committedPoints = sumPoints(views);
    const completedPoints = sumPoints(done);
    const estimable = views.filter((v) => v.storyPoints !== null);
    const withCode = views.filter((v) => v.linkedPrs.length > 0);

    const byTypeMap = new Map<string, { total: number; done: number }>();
    for (const v of views) {
      const t = byTypeMap.get(v.type) ?? { total: 0, done: 0 };
      t.total += 1;
      if (v.done) t.done += 1;
      byTypeMap.set(v.type, t);
    }

    return {
      sprint: toSprintSummary(sprint),
      committedPoints,
      completedPoints,
      completionPct: pct(completedPoints, committedPoints),
      itemsTotal: views.length,
      itemsDone: done.length,
      unestimatedItems: views.length - estimable.length,
      itemsWithCode: withCode.length,
      codeLinkagePct: pct(withCode.length, views.length),
      daysRemaining: sprint.endAt
        ? Math.max(
            0,
            Math.ceil((sprint.endAt.getTime() - Date.now()) / 86_400_000),
          )
        : null,
      byType: [...byTypeMap.entries()].map(([type, t]) => ({ type, ...t })),
    };
  }

  async sprintRisk(sprintExternalId: string): Promise<SprintRiskView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprint = await this.findSprint(tenantId, sprintExternalId);
    if (!sprint) {
      return null;
    }
    const items = (
      await this.planning.listItemsForSprint(tenantId, sprintExternalId)
    ).filter((i) => i.type !== 'epic');
    const views = await this.toViews(tenantId, items);
    const open = views.filter((v) => !v.done);
    const openWithoutCode = open.filter((v) => v.linkedPrs.length === 0);

    return {
      sprint: toSprintSummary(sprint),
      openWithoutCode,
      openBugs: open.filter((v) => v.type === 'bug').length,
      unestimatedOpen: open.filter((v) => v.storyPoints === null).length,
      atRiskPoints: sumPoints(openWithoutCode),
    };
  }

  /** Completed vs committed points per closed sprint (most recent first). */
  async velocity(projectKeys: string[], limit = 6): Promise<VelocityRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprints = (
      await this.planning.listSprints(tenantId, projectKeys, 'closed')
    ).slice(0, limit);

    const rows: VelocityRow[] = [];
    for (const sprint of sprints) {
      const items = (
        await this.planning.listItemsForSprint(tenantId, sprint.externalId)
      ).filter((i) => i.type !== 'epic');
      const done = items.filter((i) => isDone(i));
      rows.push({
        sprint: toSprintSummary(sprint),
        committedPoints: sumStoryPoints(items),
        completedPoints: sumStoryPoints(done),
        itemsDone: done.length,
      });
    }
    return rows;
  }

  /** Naive-but-honest forecast: avg velocity of closed sprints vs open backlog. */
  async forecast(projectKeys: string[]): Promise<ForecastView[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const projects =
      projectKeys.length > 0
        ? projectKeys
        : await this.planning.listProjectKeys(tenantId);

    const out: ForecastView[] = [];
    for (const projectKey of projects) {
      const velocityRows = await this.velocity([projectKey], 3);
      const sampled = velocityRows.filter((r) => r.completedPoints > 0);
      const avg =
        sampled.length > 0
          ? sampled.reduce((s, r) => s + r.completedPoints, 0) / sampled.length
          : null;

      const backlog = await this.planning.listOpenBacklog(tenantId, [
        projectKey,
      ]);
      const remainingPoints = sumStoryPoints(backlog);
      const sprintDays = await this.avgSprintDays(tenantId, projectKey);
      const sprintsNeeded =
        avg && avg > 0 ? Math.ceil(remainingPoints / avg) : null;

      out.push({
        projectKey,
        sprintsSampled: sampled.length,
        avgVelocityPoints: avg === null ? null : Number(avg.toFixed(1)),
        remainingPoints,
        remainingItems: backlog.length,
        unestimatedItems: backlog.filter((b) => b.storyPoints === null).length,
        sprintsNeeded,
        projectedDate:
          sprintsNeeded === null
            ? null
            : new Date(
                Date.now() + sprintsNeeded * sprintDays * 86_400_000,
              ).toISOString(),
        assumedSprintDays: sprintDays,
      });
    }
    return out;
  }

  /** Weekly throughput: completed items/points (Jira) + merged PRs/LOC (GitHub). */
  async productivity(
    projectKeys: string[],
    repos: string[],
    from: Date,
    to?: Date,
  ): Promise<ProductivityWeek[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();

    const items = await this.planning.listWorkItems(tenantId, {
      projects: projectKeys,
      from,
      to: end,
    });
    const doneItems = items.filter(
      (i) => i.type !== 'epic' && isDone(i) && i.resolvedAt,
    );
    const prs = (
      await this.code.listDashboardPullRequests(tenantId, repos, from, end)
    ).filter((pr) => pr.mergedAt);

    const weeks = new Map<string, ProductivityWeek>();
    const bucket = (d: Date) => {
      const day = new Date(d);
      day.setUTCHours(0, 0, 0, 0);
      day.setUTCDate(day.getUTCDate() - day.getUTCDay()); // week starts Sunday
      return day.toISOString().slice(0, 10);
    };
    const ensure = (w: string) => {
      const cur = weeks.get(w) ?? {
        weekStart: w,
        itemsCompleted: 0,
        pointsCompleted: 0,
        prsMerged: 0,
        locChanged: 0,
      };
      weeks.set(w, cur);
      return cur;
    };
    for (const item of doneItems) {
      const w = ensure(bucket(item.resolvedAt!));
      w.itemsCompleted += 1;
      w.pointsCompleted += item.storyPoints ?? 0;
    }
    for (const pr of prs) {
      const w = ensure(bucket(pr.mergedAt!));
      w.prsMerged += 1;
      w.locChanged += pr.additions + pr.deletions;
    }
    return [...weeks.values()].sort((a, b) =>
      a.weekStart.localeCompare(b.weekStart),
    );
  }

  /** Cycle times + bi-directional Jira↔GitHub traceability for the scope. */
  async efficiency(
    projectKeys: string[],
    repos: string[],
    from: Date,
    to?: Date,
  ): Promise<EfficiencyView> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();

    const prs = await this.code.listDashboardPullRequests(
      tenantId,
      repos,
      from,
      end,
    );
    const merged = prs.filter((pr) => pr.mergedAt && pr.openedAt);
    const prHours = merged
      .map(
        (pr) => (pr.mergedAt!.getTime() - pr.openedAt!.getTime()) / 3_600_000,
      )
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);

    const items = (
      await this.planning.listWorkItems(tenantId, {
        projects: projectKeys,
        from,
        to: end,
      })
    ).filter((i) => i.type !== 'epic');
    const resolved = items.filter((i) => i.resolvedAt);
    const storyDays = resolved
      .map(
        (i) => (i.resolvedAt!.getTime() - i.createdAt.getTime()) / 86_400_000,
      )
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);

    const linkByStory = await this.correlation.prRefsByStoryId(
      tenantId,
      items.map((i) => i.id),
    );
    const storiesWithCode = items.filter(
      (i) => (linkByStory.get(i.id) ?? []).length > 0,
    ).length;
    const linkedRefs = new Set(
      [...linkByStory.values()].flat().map((r) => r.toLowerCase()),
    );
    const prsWithStory = prs.filter((pr) =>
      linkedRefs.has(`${pr.repoFullName}#${pr.externalNumber}`.toLowerCase()),
    ).length;

    return {
      prCycle: {
        sampleSize: prHours.length,
        p50Hours: round2(percentile(prHours, 50)),
        p85Hours: round2(percentile(prHours, 85)),
      },
      storyCycle: {
        sampleSize: storyDays.length,
        p50Days: round2(percentile(storyDays, 50)),
        p85Days: round2(percentile(storyDays, 85)),
      },
      traceability: {
        storiesWithCodePct: pct(storiesWithCode, items.length),
        prsWithStoryPct: pct(prsWithStory, prs.length),
        storiesTotal: items.length,
        prsTotal: prs.length,
      },
    };
  }

  /**
   * Most-active projects for a window (day/week/month): commits + LOC across
   * every repo mapped to the project via the delivery graph. Repos linked to no
   * project are reported honestly in an "(unlinked repos)" bucket.
   */
  async projectActivity(from: Date, to?: Date): Promise<ProjectActivityRow[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const repoToProjects = await this.repoToProjects(tenantId);
    const commits = await this.code.listCommits(tenantId, {
      from,
      to: to ?? new Date(),
    });

    interface Acc {
      commits: number;
      additions: number;
      deletions: number;
      repoCommits: Map<string, number>;
      contributors: Set<string>;
    }
    const acc = new Map<string, Acc>();
    const ensure = (key: string): Acc => {
      const cur =
        acc.get(key) ??
        ({
          commits: 0,
          additions: 0,
          deletions: 0,
          repoCommits: new Map(),
          contributors: new Set(),
        } as Acc);
      acc.set(key, cur);
      return cur;
    };

    for (const c of commits) {
      const projects = repoToProjects.get(c.repoFullName) ?? [
        '(unlinked repos)',
      ];
      for (const project of projects) {
        const a = ensure(project);
        a.commits += 1;
        a.additions += c.additions;
        a.deletions += c.deletions;
        a.repoCommits.set(
          c.repoFullName,
          (a.repoCommits.get(c.repoFullName) ?? 0) + 1,
        );
        if (c.authorLogin) {
          a.contributors.add(c.authorLogin);
        }
      }
    }

    return [...acc.entries()]
      .map(([projectKey, a]) => ({
        projectKey,
        commits: a.commits,
        additions: a.additions,
        deletions: a.deletions,
        locChanged: a.additions + a.deletions,
        activeRepos: a.repoCommits.size,
        topRepo:
          [...a.repoCommits.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ??
          null,
        contributors: a.contributors.size,
      }))
      .sort((x, y) => y.commits - x.commits || y.locChanged - x.locChanged);
  }

  /** GitHub-style activity profile for one developer (activity context, not ranking). */
  async developerActivity(
    developer: string,
    from: Date,
    to?: Date,
  ): Promise<DeveloperActivityView> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();
    const commits = await this.code.listCommits(tenantId, {
      authorLogin: developer,
      from,
      to: end,
    });
    const prs = await this.code.listPullRequestsByAuthor(
      tenantId,
      developer,
      from,
      end,
    );

    const byRepo = new Map<
      string,
      { commits: number; loc: number; last: Date }
    >();
    const byDay = new Map<string, { commits: number; loc: number }>();
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const c of commits) {
      additions += c.additions;
      deletions += c.deletions;
      filesChanged += c.filesChanged;
      const r = byRepo.get(c.repoFullName) ?? {
        commits: 0,
        loc: 0,
        last: c.authoredAt,
      };
      r.commits += 1;
      r.loc += c.additions + c.deletions;
      if (c.authoredAt > r.last) r.last = c.authoredAt;
      byRepo.set(c.repoFullName, r);

      const day = c.authoredAt.toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { commits: 0, loc: 0 };
      d.commits += 1;
      d.loc += c.additions + c.deletions;
      byDay.set(day, d);
    }

    const repoToProjects = await this.repoToProjects(tenantId);
    const activeProjects = new Set<string>();
    for (const repo of byRepo.keys()) {
      for (const project of repoToProjects.get(repo) ?? []) {
        activeProjects.add(project);
      }
    }

    return {
      developer,
      totals: {
        commits: commits.length,
        additions,
        deletions,
        locChanged: additions + deletions,
        filesChanged,
        prsAuthored: prs.length,
        activeRepos: byRepo.size,
      },
      activeProjects: [...activeProjects].sort(),
      byRepo: [...byRepo.entries()]
        .map(([repo, r]) => ({
          repo,
          commits: r.commits,
          locChanged: r.loc,
          lastCommitAt: r.last.toISOString(),
        }))
        .sort((a, b) => b.commits - a.commits),
      dailySeries: [...byDay.entries()]
        .map(([date, d]) => ({ date, commits: d.commits, locChanged: d.loc }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      recentCommits: commits.slice(0, 20).map((c) => ({
        sha: c.sha.slice(0, 7),
        repo: c.repoFullName,
        message: c.message.split('\n')[0],
        authoredAt: c.authoredAt.toISOString(),
        additions: c.additions,
        deletions: c.deletions,
      })),
    };
  }

  /** repo → project keys via the delivery graph (cached per call, N≤60 projects). */
  private async repoToProjects(
    tenantId: string,
  ): Promise<Map<string, string[]>> {
    const projects = await this.planning.listProjectKeys(tenantId);
    const map = new Map<string, string[]>();
    for (const project of projects) {
      const repos = await this.correlation.reposLinkedToProjects(tenantId, [
        project,
      ]);
      for (const repo of repos) {
        map.set(repo, [...(map.get(repo) ?? []), project]);
      }
    }
    return map;
  }

  // ---- helpers -------------------------------------------------------------

  private async findSprint(
    tenantId: string,
    externalId: string,
  ): Promise<Sprint | null> {
    const sprints = await this.planning.listSprints(tenantId);
    return sprints.find((s) => s.externalId === externalId) ?? null;
  }

  private async toViews(
    tenantId: string,
    items: Story[],
  ): Promise<WorkItemView[]> {
    const linkByStory = await this.correlation.prRefsByStoryId(
      tenantId,
      items.map((i) => i.id),
    );
    const allRefs = [...new Set([...linkByStory.values()].flat())];
    const prs = await this.code.listPullRequestsByRefs(tenantId, allRefs);
    const prByRef = new Map<string, PullRequest>(
      prs.map((pr) => [
        `${pr.repoFullName}#${pr.externalNumber}`.toLowerCase(),
        pr,
      ]),
    );
    return items.map((i) => ({
      key: i.externalKey,
      title: i.title,
      type: i.type,
      status: i.status,
      done: isDone(i),
      storyPoints: i.storyPoints,
      assigneeName: i.assigneeName,
      epicKey: i.epicKey,
      parentKey: i.parentKey,
      sprintExternalId: i.sprintExternalId,
      releases: i.releases,
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      linkedPrs: (linkByStory.get(i.id) ?? []).map((ref) => ({
        ref,
        state: prByRef.get(ref.toLowerCase())?.state ?? null,
      })),
    }));
  }

  private async avgSprintDays(
    tenantId: string,
    projectKey: string,
  ): Promise<number> {
    const closed = await this.planning.listSprints(
      tenantId,
      [projectKey],
      'closed',
    );
    const spans = closed
      .filter((s) => s.startAt && s.endAt)
      .map((s) => (s.endAt!.getTime() - s.startAt!.getTime()) / 86_400_000)
      .filter((d) => d > 0);
    if (spans.length === 0) {
      return DEFAULT_SPRINT_DAYS;
    }
    return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  }
}

function isDone(item: { status: string }): boolean {
  return DONE_STATUSES.includes(item.status);
}

function sumPoints(views: WorkItemView[]): number {
  return views.reduce((s, v) => s + (v.storyPoints ?? 0), 0);
}

function sumStoryPoints(items: Story[]): number {
  return items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

function toSprintSummary(sprint: Sprint): SprintSummary {
  return {
    externalId: sprint.externalId,
    name: sprint.name,
    state: sprint.state,
    projectKey: sprint.projectKey,
    startAt: sprint.startAt ? sprint.startAt.toISOString() : null,
    endAt: sprint.endAt ? sprint.endAt.toISOString() : null,
  };
}

function pct(part: number, total: number): number | null {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : null;
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
