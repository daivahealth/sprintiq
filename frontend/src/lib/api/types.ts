export interface AuthUser {
  id: string;
  email: string;
  roles: string[];
}

export type UserRole =
  | "developer"
  | "team_lead"
  | "scrum_master"
  | "eng_manager"
  | "product_owner"
  | "cto"
  | "exec"
  | "admin";

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

export interface AdminRole {
  key: UserRole;
  label: string;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  roles: UserRole[];
  status: string;
}

export type ConfigurationNamespace =
  | "github"
  | "jira"
  | "llm"
  | "notifications"
  | "metrics"
  | "security";

export type ConfigurationFieldKind =
  | "text"
  | "number"
  | "boolean"
  | "secret-ref";

export interface ConfigurationField {
  key: string;
  label: string;
  kind: ConfigurationFieldKind;
  required?: boolean;
  helper?: string;
  /** Regex SOURCE (not a RegExp — sent as JSON, reconstruct with `new RegExp()`). */
  pattern?: string;
  patternHint?: string;
}

export interface ConfigurationSection {
  namespace: ConfigurationNamespace;
  label: string;
  description: string;
  fields: ConfigurationField[];
}

/** GET /api/admin/configurations/catalog */
export interface ConfigurationCatalogResponse {
  secretRefHint: string;
  secretRefPattern: string;
  /** Whether pasting a secret value will actually work server-side (SECRETS_ENCRYPTION_KEY configured). */
  secretsStoreEnabled: boolean;
  sections: ConfigurationSection[];
}

/**
 * Whether this namespace is actually collecting data (a real BC-0 Connection
 * exists), not just saved. `null` for config-only namespaces (llm/notifications/
 * metrics/security) that have no underlying connection to speak of.
 */
export interface ConfigurationConnectionSummary {
  linked: boolean;
  status?: "active" | "disabled";
  lastSyncAt?: string | null;
  syncLagSeconds?: number;
}

export interface TenantConfiguration {
  id: string;
  namespace: ConfigurationNamespace;
  key: string;
  values: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
  status: "active" | "disabled";
  updatedAt: string;
  connection: ConfigurationConnectionSummary | null;
  /** Per secret-ref field key: whether a value is stored in the encrypted DB store. */
  secretsConfigured: Record<string, boolean>;
}

/** PUT /api/admin/configurations body. */
export interface UpsertConfigurationPayload {
  namespace: ConfigurationNamespace;
  key?: string;
  values: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
  /** Actual secret values to store (encrypted server-side). Omit a field to leave it untouched. */
  secretValues?: Record<string, unknown>;
  /** Field keys whose stored secret value should be deleted. */
  clearSecrets?: string[];
  status: "active" | "disabled";
  /** Optimistic-concurrency token: the updatedAt this draft was based on. */
  expectedUpdatedAt?: string;
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
