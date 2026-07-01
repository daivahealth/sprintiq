export interface AuthUser {
  id: string;
  email: string;
  roles: string[];
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

/** Response of GET /api/dashboards/pr-cycle-time (BC-13 → BC-8). */
export interface PrCycleTime {
  metric: 'pr_cycle_time';
  repo: string;
  sampleSize: number;
  p50Hours: number | null;
  p85Hours: number | null;
  computedAt: string;
}
