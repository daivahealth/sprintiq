import { PrismaService } from '../../../database/prisma.service';

/**
 * One GitHub organisation per `TenantConfiguration` row (ADR-0013): the
 * `github/default` row is the tenant's first organisation, every further one
 * is `github/<lowercased login>`. This is the single place that reads those
 * rows, so every org-wide job (org sync, audit-log route, Copilot sync,
 * digest) agrees on which organisations exist and which token refs they use.
 */
export const GITHUB_CONFIG_NAMESPACE = 'github';
export const DEFAULT_GITHUB_CONFIG_KEY = 'default';

/** A GitHub login: what may be stored as `organization` and rendered on the digest card. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Refs a non-default row may leave blank to use the default row's (shown as inherited). */
export const INHERITABLE_GITHUB_REFS = [
  'tokenRef',
  'auditLogTokenRef',
  'copilotMetricsTokenRef',
] as const;
export type InheritableGithubRef = (typeof INHERITABLE_GITHUB_REFS)[number];

export interface GithubOrgConfigRow {
  id: string;
  tenantId: string;
  key: string;
  status: string;
  values: unknown;
  secretRefs: unknown;
  createdAt?: Date | null;
}

export interface GithubOrg {
  configId: string;
  tenantId: string;
  key: string;
  isDefault: boolean;
  /** The login exactly as saved — the audit checkpoint/run key. */
  organization: string;
  active: boolean;
  values: Record<string, unknown>;
  /** Effective refs: the row's own, plus inherited ones. Names only. */
  secretRefs: Record<string, string>;
  inheritedRefs: InheritableGithubRef[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** The lowercased owner of `owner/name`. */
export function orgOfRepo(repoFullName: string): string {
  const slash = repoFullName.indexOf('/');
  return (
    slash < 0 ? repoFullName : repoFullName.slice(0, slash)
  ).toLowerCase();
}

export function repoInOrg(repoFullName: string, organization: string): boolean {
  return orgOfRepo(repoFullName) === organization.toLowerCase();
}

/** Prisma filter on a `repoFullName` column for one organisation's repos. */
export function repoInOrgWhere(organization: string): {
  startsWith: string;
  mode: 'insensitive';
} {
  return { startsWith: `${organization}/`, mode: 'insensitive' };
}

function createdMs(row: GithubOrgConfigRow): number {
  return row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
}

export function toGithubOrgs(rows: GithubOrgConfigRow[]): GithubOrg[] {
  const byTenant = new Map<string, GithubOrgConfigRow[]>();
  for (const row of rows) {
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);
  }
  const out: GithubOrg[] = [];
  for (const tenantRows of byTenant.values()) {
    const defaultRefs = asRecord(
      tenantRows.find((r) => r.key === DEFAULT_GITHUB_CONFIG_KEY)?.secretRefs,
    );
    const ordered = [...tenantRows].sort((a, b) => {
      if (a.key === DEFAULT_GITHUB_CONFIG_KEY) return -1;
      if (b.key === DEFAULT_GITHUB_CONFIG_KEY) return 1;
      return createdMs(a) - createdMs(b) || a.key.localeCompare(b.key);
    });
    for (const row of ordered) {
      const values = asRecord(row.values);
      const organization =
        typeof values.organization === 'string'
          ? values.organization.trim()
          : '';
      if (!GITHUB_LOGIN_PATTERN.test(organization)) continue;
      const isDefault = row.key === DEFAULT_GITHUB_CONFIG_KEY;
      const secretRefs: Record<string, string> = {};
      for (const [k, v] of Object.entries(asRecord(row.secretRefs))) {
        if (typeof v === 'string' && v) secretRefs[k] = v;
      }
      const inheritedRefs: InheritableGithubRef[] = [];
      if (!isDefault) {
        for (const k of INHERITABLE_GITHUB_REFS) {
          const fallback = defaultRefs[k];
          if (!secretRefs[k] && typeof fallback === 'string' && fallback) {
            secretRefs[k] = fallback;
            inheritedRefs.push(k);
          }
        }
      }
      out.push({
        configId: row.id,
        tenantId: row.tenantId,
        key: row.key,
        isDefault,
        organization,
        active: row.status === 'active',
        values,
        secretRefs,
        inheritedRefs,
      });
    }
  }
  return out;
}

export async function loadGithubOrgs(
  prisma: Pick<PrismaService, 'tenantConfiguration'>,
  opts: { tenantId?: string; activeOnly?: boolean } = {},
): Promise<GithubOrg[]> {
  const rows = await prisma.tenantConfiguration.findMany({
    where: {
      namespace: GITHUB_CONFIG_NAMESPACE,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      key: true,
      status: true,
      values: true,
      secretRefs: true,
      createdAt: true,
    },
  });
  const orgs = toGithubOrgs(rows);
  return opts.activeOnly ? orgs.filter((o) => o.active) : orgs;
}

/** The named organisation (case-insensitive), or the default row's when none is named. */
export function pickGithubOrg(
  orgs: GithubOrg[],
  organization?: string,
): GithubOrg | undefined {
  return organization
    ? orgs.find(
        (o) => o.organization.toLowerCase() === organization.toLowerCase(),
      )
    : orgs.find((o) => o.isDefault);
}
