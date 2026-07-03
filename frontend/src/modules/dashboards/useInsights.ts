import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { Scope } from '../../lib/scope';

// ---- Response types (mirror backend insights.service.ts) -------------------

export interface DashboardAssignment {
  key: string;
  title: string;
  path: string;
  description: string;
}

export interface LinkedPr {
  ref: string;
  state: string | null;
}

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
  linkedPrs: LinkedPr[];
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
  prCycle: { sampleSize: number; p50Hours: number | null; p85Hours: number | null };
  storyCycle: { sampleSize: number; p50Days: number | null; p85Days: number | null };
  traceability: {
    storiesWithCodePct: number | null;
    prsWithStoryPct: number | null;
    storiesTotal: number;
    prsTotal: number;
  };
  computedAt: string;
}

export interface SprintCatalogItem extends SprintSummary {}

export type ActivityWindow = 'day' | 'week' | 'month';

export interface ProjectActivityRow {
  projectKey: string;
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
  activeProjects: string[];
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

// ---- Hooks ------------------------------------------------------------------

function scopeParams(scope: Scope, from?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.projects.length > 0) params.set('projects', scope.projects.join(','));
  if (scope.repos.length > 0) params.set('repos', scope.repos.join(','));
  if (from) params.set('from', from);
  return params;
}

export function useAssignments() {
  return useQuery({
    queryKey: ['assignments'],
    queryFn: () =>
      api.get<{ dashboards: DashboardAssignment[] }>(
        '/api/dashboards/assignments',
      ),
    staleTime: 5 * 60_000,
  });
}

export function useSprintCatalog(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['catalog', 'sprints', projects.join(',')],
    queryFn: () =>
      api.get<{ items: SprintCatalogItem[] }>(`/api/catalog/sprints?${params}`),
    staleTime: 60_000,
  });
}

export function useSprintHealth(sprint: string | null) {
  return useQuery({
    queryKey: ['sprint-health', sprint],
    queryFn: () =>
      api.get<SprintHealthView>(`/api/dashboards/sprint-health?sprint=${sprint}`),
    enabled: Boolean(sprint),
  });
}

export function useSprintRisk(sprint: string | null) {
  return useQuery({
    queryKey: ['sprint-risk', sprint],
    queryFn: () =>
      api.get<SprintRiskView>(`/api/dashboards/sprint-risk?sprint=${sprint}`),
    enabled: Boolean(sprint),
  });
}

export function useVelocity(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['velocity', projects.join(',')],
    queryFn: () =>
      api.get<{ rows: VelocityRow[]; computedAt: string }>(
        `/api/dashboards/velocity?${params}`,
      ),
  });
}

export function useForecast(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['forecast', projects.join(',')],
    queryFn: () =>
      api.get<{ rows: ForecastView[]; computedAt: string }>(
        `/api/dashboards/forecast?${params}`,
      ),
  });
}

export function useProductivity(scope: Scope, from: string) {
  const params = scopeParams(scope, from);
  return useQuery({
    queryKey: ['productivity', params.toString()],
    queryFn: () =>
      api.get<{ weeks: ProductivityWeek[]; computedAt: string }>(
        `/api/dashboards/productivity?${params}`,
      ),
  });
}

export function useEfficiency(scope: Scope, from: string) {
  const params = scopeParams(scope, from);
  return useQuery({
    queryKey: ['efficiency', params.toString()],
    queryFn: () =>
      api.get<EfficiencyView>(`/api/dashboards/efficiency?${params}`),
  });
}

export function useProjectActivity(window: ActivityWindow) {
  return useQuery({
    queryKey: ['project-activity', window],
    queryFn: () =>
      api.get<{ window: string; rows: ProjectActivityRow[]; computedAt: string }>(
        `/api/dashboards/project-activity?window=${window}`,
      ),
  });
}

export function useDeveloperCatalog(search: string) {
  return useQuery({
    queryKey: ['catalog', 'developers', search],
    queryFn: () =>
      api.get<{ items: { login: string }[] }>(
        `/api/catalog/developers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useDeveloperActivity(
  developer: string | null,
  window: ActivityWindow,
) {
  return useQuery({
    queryKey: ['developer-activity', developer, window],
    queryFn: () =>
      api.get<DeveloperActivityView>(
        `/api/dashboards/developer-activity?developer=${encodeURIComponent(developer!)}&window=${window}`,
      ),
    enabled: Boolean(developer),
  });
}

export function useWorkItems(filters: {
  projects?: string[];
  types?: string[];
  sprint?: string;
  epic?: string;
  release?: string;
}) {
  const params = new URLSearchParams();
  if (filters.projects?.length) params.set('projects', filters.projects.join(','));
  if (filters.types?.length) params.set('types', filters.types.join(','));
  if (filters.sprint) params.set('sprint', filters.sprint);
  if (filters.epic) params.set('epic', filters.epic);
  if (filters.release) params.set('release', filters.release);
  return useQuery({
    queryKey: ['work-items', params.toString()],
    queryFn: () =>
      api.get<{ items: WorkItemView[]; computedAt: string }>(
        `/api/dashboards/work-items?${params}`,
      ),
  });
}
