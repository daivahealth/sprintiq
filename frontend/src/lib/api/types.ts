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
  metric: 'pr_cycle_time';
  repo: string;
  sampleSize: number;
  p50Hours: number | null;
  p85Hours: number | null;
  computedAt: string;
}
