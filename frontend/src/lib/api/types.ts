export interface AuthUser {
  id: string;
  email: string;
  roles: string[];
}

export interface Tenant {
  id: string;
  name: string;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
  tenant: Tenant | null;
}

/** GET /api/auth/me — current identity + active tenant. */
export interface MeResponse {
  user: AuthUser;
  tenant: Tenant | null;
}

/** Response of GET /api/dashboards/pr-cycle-time (BC-13 → BC-8). */
export interface PrCycleTime {
  metric: "pr_cycle_time";
  repo: string;
  sampleSize: number;
  p50Hours: number | null;
  p85Hours: number | null;
  computedAt: string;
}

/** GET /api/catalog/projects | /api/catalog/repos */
export interface ProjectCatalog {
  items: { key: string }[];
}
export interface RepoCatalog {
  items: { name: string }[];
  crossFiltered: boolean;
}

/** GET /api/dashboards/metrics — the batch scope endpoint. */
export interface MetricCell {
  sampleSize: number;
  value?: number | null;
  p50Hours: number | null;
  p85Hours: number | null;
  additions?: number;
  deletions?: number;
  netChanged?: number;
}
export interface MetricRow {
  key: string;
  metrics: Record<string, MetricCell>;
}
export interface BatchMetricsResponse {
  groupBy: "repo" | "project" | "developer" | "day";
  scope: { repos: string[]; projects: string[]; from?: string; to?: string };
  rows: MetricRow[];
  computedAt: string;
}
