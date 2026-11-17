# Multiple GitHub Organisations Per Tenant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant collect from several GitHub organisations (first: `NHWebsite` beside `athmahealth`) where adding an organisation never changes how an existing one is collected, and the daily digest becomes one combined digest across included organisations.

**Architecture:** Each organisation is its own `TenantConfiguration` row (`github/default` stays athmahealth; others are `github/<lowercased login>`). A single helper (`github-orgs.ts`) reads those rows, applies token-ref inheritance from the default row, and answers "which org does this repo belong to". Every org-wide job (org sync, audit-log route + full sweep, Copilot sync) runs once per row with per-org state (audit checkpoint and runs gain an `organization` key). The digest gate checks every *included* org, and the card names them.

**Tech Stack:** NestJS + Prisma (PostgreSQL), Jest (backend), React + TanStack Query + Tailwind tokens, Vitest (frontend).

**Spec:** [docs/superpowers/specs/2026-11-16-multi-github-org-design.md](../specs/2026-11-16-multi-github-org-design.md)

## Global Constraints

- `github/default` (athmahealth) behaviour must be byte-identical when it is the only GitHub row: same queries' results, same run/claim behaviour, same digest/withheld/all-clear text, same Watchlist rule text.
- Every query stays filtered by `tenantId` (CLAUDE.md "Everything is tenant-scoped").
- Org login pattern (single source): `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/`.
- Non-default row key = `organization.toLowerCase()`. `organization` is immutable once saved, on every row.
- Inheritable secret refs (blank on a non-default row → use the default row's): `tokenRef`, `auditLogTokenRef`, `copilotMetricsTokenRef`. Ref **names** only ever leave the backend, never values.
- Org comparison is case-insensitive (`orgOfRepo` lowercases); the stored `organization` string is used verbatim as the checkpoint/run key.
- Frontend: existing primitives (`Badge`, `Button`, `Card`, `Field`, `Input`) and theme tokens only — no raw Tailwind palette classes (DESIGN-SYSTEM.md).
- Backend build: always `rm -rf dist` before `npm run build` (a failed `deleteOutDir` guts the running app). `npm run lint` auto-fixes and never fails — read its output, filter CRLF noise.
- Migrations are applied by hand on the host (`npx prisma migrate deploy`); locally use `npx prisma migrate dev`.
- `backend/src/modules/code/code.service.ts` is reported as binary by grep — search it with `grep -a`.
- Commit after every task; end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `feat/multi-github-org`.

## File Map

| File | Responsibility |
|---|---|
| `backend/src/collectors/sources/github/github-orgs.ts` (new) | Read GitHub org rows, inherit refs, `orgOfRepo`, `repoInOrg`, `repoInOrgWhere`, `pickGithubOrg`, login pattern |
| `backend/prisma/schema.prisma` + new migration | Per-org audit checkpoint; `organization` on audit runs |
| `backend/src/modules/configurations/configuration-catalog.ts` | `inheritSecretRefs` option on validation |
| `backend/src/modules/configurations/configurations.service.ts` | Org-row validation, immutability, uniqueness; bridge only for `default` |
| `backend/src/collectors/scheduler/github-org-sync-scheduler.service.ts` | Org sync per row |
| `backend/src/collectors/sources/github/github-audit-sync.service.ts` | Per-org settings, repos, checkpoint, claim, runs, pending ranges, status, coverage, inclusion |
| `backend/src/collectors/sources/github/github-audit-sync.fakes.ts` | Fake Prisma: `startsWith`/`mode`, per-org checkpoint key, `seedOrg` |
| `backend/src/collectors/scheduler/github-audit-scheduler.service.ts` | Loop (tenant, org) pairs |
| `backend/src/collectors/sources/github/github-audit-report.service.ts`, `github-activity-verify.service.ts` | Oldest checkpoint across orgs |
| `backend/src/collectors/sources/github/github-copilot-usage-sync.service.ts`, `scheduler/github-copilot-scheduler.service.ts` | Copilot sync per row |
| `backend/src/modules/code/code.service.ts` | `copilotCoverage` oldest-org freshness, distinct days, `orgs` |
| `backend/src/collectors/delivery/digest-card.ts` | Multi-org lead-in |
| `backend/src/metrics/no-commit-detection.service.ts` | Carry included orgs to digest and Watchlist |
| `backend/src/modules/notifications/notifications.service.ts` | Render card from included orgs |
| `backend/src/modules/configurations/configurations.controller.ts` | `organization` params; `GET github/organizations` |
| `frontend/src/lib/api/types.ts` | `GithubOrganization` type |
| `frontend/src/modules/admin/github-organizations-logic.ts` (new) + test | Pure helpers for the panel |
| `frontend/src/modules/admin/GithubOrganizationsPanel.tsx` (new) | Additional organisations panel |
| `frontend/src/modules/admin/AdminConfigurationsPage.tsx` | Mount panel; lock saved Organization |
| `frontend/src/modules/admin/AuditOrgStatusList.tsx` (new) | Per-org status rows on Sync Status |
| `frontend/src/modules/admin/SyncStatusPage.tsx` | Mount status list |
| `frontend/src/modules/dashboards/developer-activity/{previous-day.ts,PreviousDayCard.tsx,copilot-column.ts}` + `useInsights.ts` | Scope line; Copilot orgs |
| Docs (Task 11) | ADR-0013, ADR-0009/0012 amendments, CLAUDE.md/AGENTS.md, api, features, deployment, runbook, architecture |

---

### Task 1: Org-row helper, schema and migration

**Files:**
- Create: `backend/src/collectors/sources/github/github-orgs.ts`
- Test: `backend/src/collectors/sources/github/github-orgs.spec.ts`
- Modify: `backend/prisma/schema.prisma` (models `GithubAuditCheckpoint`, `GithubAuditRun`)
- Create: `backend/prisma/migrations/<timestamp>_multi_github_org/migration.sql`

**Interfaces:**
- Produces:
  - `GITHUB_CONFIG_NAMESPACE = 'github'`, `DEFAULT_GITHUB_CONFIG_KEY = 'default'`, `GITHUB_LOGIN_PATTERN: RegExp`
  - `INHERITABLE_GITHUB_REFS = ['tokenRef','auditLogTokenRef','copilotMetricsTokenRef'] as const`; `type InheritableGithubRef`
  - `interface GithubOrg { configId: string; tenantId: string; key: string; isDefault: boolean; organization: string; active: boolean; values: Record<string, unknown>; secretRefs: Record<string, string>; inheritedRefs: InheritableGithubRef[] }`
  - `orgOfRepo(repoFullName: string): string`, `repoInOrg(repoFullName: string, organization: string): boolean`, `repoInOrgWhere(organization: string): { startsWith: string; mode: 'insensitive' }`
  - `toGithubOrgs(rows: GithubOrgConfigRow[]): GithubOrg[]` (pure)
  - `loadGithubOrgs(prisma, opts?: { tenantId?: string; activeOnly?: boolean }): Promise<GithubOrg[]>`
  - `pickGithubOrg(orgs: GithubOrg[], organization?: string): GithubOrg | undefined`
  - Prisma: `GithubAuditCheckpoint @@unique([tenantId, organization])` (compound key `tenantId_organization`); `GithubAuditRun.organization String?`

- [ ] **Step 1: Write the failing test**

`backend/src/collectors/sources/github/github-orgs.spec.ts`:

```ts
import {
  orgOfRepo,
  pickGithubOrg,
  repoInOrg,
  repoInOrgWhere,
  toGithubOrgs,
} from './github-orgs';

const row = (o: Record<string, unknown>) => ({
  id: `cfg-${String(o.key)}`,
  tenantId: 't1',
  status: 'active',
  values: {},
  secretRefs: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
});

describe('github-orgs', () => {
  it('derives the lowercased org of a repo full name', () => {
    expect(orgOfRepo('NHWebsite/site')).toBe('nhwebsite');
    expect(orgOfRepo('athmahealth/ehr')).toBe('athmahealth');
    expect(repoInOrg('NHWebsite/site', 'nhwebsite')).toBe(true);
    expect(repoInOrg('athmahealth/ehr', 'NHWebsite')).toBe(false);
    expect(repoInOrgWhere('NHWebsite')).toEqual({
      startsWith: 'NHWebsite/',
      mode: 'insensitive',
    });
  });

  it('puts the default row first, then others by creation time', () => {
    const orgs = toGithubOrgs([
      row({ key: 'zeta', values: { organization: 'Zeta' }, createdAt: new Date('2026-03-01') }),
      row({ key: 'nhwebsite', values: { organization: 'NHWebsite' }, createdAt: new Date('2026-02-01') }),
      row({ key: 'default', values: { organization: 'athmahealth' }, createdAt: new Date('2026-05-01') }),
    ]);
    expect(orgs.map((o) => o.organization)).toEqual(['athmahealth', 'NHWebsite', 'Zeta']);
    expect(orgs[0].isDefault).toBe(true);
  });

  it('inherits blank token refs from the default row, and says which', () => {
    const [def, nh] = toGithubOrgs([
      row({
        key: 'default',
        values: { organization: 'athmahealth' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN', auditLogTokenRef: 'GITHUB_AUDIT_TOKEN' },
      }),
      row({
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
        createdAt: new Date('2026-11-16'),
      }),
    ]);
    expect(def.inheritedRefs).toEqual([]);
    expect(nh.secretRefs).toEqual({
      tokenRef: 'GITHUB_TOKEN_NHWEBSITE',
      auditLogTokenRef: 'GITHUB_AUDIT_TOKEN',
    });
    expect(nh.inheritedRefs).toEqual(['auditLogTokenRef']);
  });

  it('never inherits across tenants and drops rows without a valid login', () => {
    const orgs = toGithubOrgs([
      row({ key: 'default', values: { organization: 'athmahealth' }, secretRefs: { tokenRef: 'A' } }),
      row({ tenantId: 't2', key: 'other', values: { organization: 'Other' } }),
      row({ tenantId: 't2', key: 'bad', values: { organization: 'not a login' } }),
    ]);
    const other = orgs.find((o) => o.tenantId === 't2');
    expect(other?.secretRefs).toEqual({});
    expect(orgs).toHaveLength(2);
  });

  it('picks the default org when none is named, else matches case-insensitively', () => {
    const orgs = toGithubOrgs([
      row({ key: 'default', values: { organization: 'athmahealth' } }),
      row({ key: 'nhwebsite', values: { organization: 'NHWebsite' } }),
    ]);
    expect(pickGithubOrg(orgs)?.organization).toBe('athmahealth');
    expect(pickGithubOrg(orgs, 'nhwebsite')?.organization).toBe('NHWebsite');
    expect(pickGithubOrg(orgs, 'nope')).toBeUndefined();
  });

  it('marks disabled rows inactive', () => {
    const [o] = toGithubOrgs([
      row({ key: 'default', status: 'disabled', values: { organization: 'athmahealth' } }),
    ]);
    expect(o.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/collectors/sources/github/github-orgs.spec.ts`
Expected: FAIL — `Cannot find module './github-orgs'`.

- [ ] **Step 3: Write the helper**

`backend/src/collectors/sources/github/github-orgs.ts`:

```ts
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
  return (slash < 0 ? repoFullName : repoFullName.slice(0, slash)).toLowerCase();
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
        typeof values.organization === 'string' ? values.organization.trim() : '';
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
    ? orgs.find((o) => o.organization.toLowerCase() === organization.toLowerCase())
    : orgs.find((o) => o.isDefault);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/collectors/sources/github/github-orgs.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Change the schema**

In `backend/prisma/schema.prisma`, model `GithubAuditCheckpoint`: change `tenantId     String    @unique` to `tenantId     String`, replace the `runningSince` doc comment with `/// Per-(tenant, organisation) run claim: set while a sync run holds this org, cleared in a \`finally\`; a claim older than RUN_CLAIM_STALE_MS is taken over.`, and add before `@@map`:

```prisma
  /// One checkpoint per organisation (ADR-0013). The pre-existing row already
  /// carries its organisation, so it continues unchanged.
  @@unique([tenantId, organization])
```

Model `GithubAuditRun`: add after `tenantId   String`:

```prisma
  /// The organisation this run covered (ADR-0013). Null only on rows written
  /// before 2026-11-16 that the migration could not attribute.
  organization String?
```

and replace `@@index([tenantId, startedAt])` with `@@index([tenantId, organization, startedAt])`.

- [ ] **Step 6: Generate the migration and add the backfill**

Run: `cd backend && npx prisma migrate dev --create-only --name multi_github_org`
Then open the generated `prisma/migrations/<timestamp>_multi_github_org/migration.sql`, put this comment at the top, and append the backfill **after** the `ADD COLUMN` statement and before the index creation:

```sql
-- Multiple GitHub organisations per tenant (2026-11-16, ADR-0013): the audit
-- checkpoint becomes per organisation and every audit run records its
-- organisation. Additive: the existing checkpoint row already names its
-- organisation, and existing runs are attributed to it.
```

```sql
UPDATE "collectors_github_audit_run" AS r
SET "organization" = c."organization"
FROM "collectors_github_audit_checkpoint" AS c
WHERE c."tenantId" = r."tenantId" AND r."organization" IS NULL;
```

Run: `npx prisma migrate dev` (applies it locally) then `npx prisma generate`.
Expected: "Your database is now in sync with your schema". Then verify: `node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.githubAuditRun.count({where:{organization:null}}).then(n=>{console.log("unattributed runs",n);return p.$disconnect()})'` → `0` when the tenant has a checkpoint.

- [ ] **Step 7: Commit**

```bash
git add backend/src/collectors/sources/github/github-orgs.ts backend/src/collectors/sources/github/github-orgs.spec.ts backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(github): org-row helper and per-org audit checkpoint schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(The backend will not compile until Task 4 replaces `githubAuditCheckpoint.findUnique({ where: { tenantId } })`. Tasks 2–3 test files run in isolation with `npx jest <file>`; run `npx tsc --noEmit` only from Task 5 on.)

---

### Task 2: Configuration rows — validation, immutability, bridge only for `default`

**Files:**
- Modify: `backend/src/modules/configurations/configuration-catalog.ts` (`validateConfigurationValues`, line ~295)
- Modify: `backend/src/modules/configurations/configurations.service.ts` (`upsertTenantConfiguration` ~202, `buildView` ~487)
- Test: `backend/src/modules/configurations/configurations.service.spec.ts`

**Interfaces:**
- Consumes: `GITHUB_LOGIN_PATTERN`, `DEFAULT_GITHUB_CONFIG_KEY`, `INHERITABLE_GITHUB_REFS` from Task 1.
- Produces: `validateConfigurationValues(namespace, values, secretRefs, status, opts?: { inheritSecretRefs?: boolean })`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('ConfigurationsService', …)` in `configurations.service.spec.ts` (the `build()` helper already exists; `prisma.tenantConfiguration.findMany` is a `jest.fn()`):

```ts
  describe('additional GitHub organisations (ADR-0013)', () => {
    const saved = (o: Record<string, unknown>) => ({
      id: 'cfg_nh',
      tenantId: 't1',
      namespace: 'github',
      key: 'nhwebsite',
      values: { organization: 'NHWebsite' },
      secretRefs: {},
      status: 'active',
      updatedAt: new Date('2026-11-16T00:00:00Z'),
      ...o,
    });

    it('saves a non-default org row with blank token refs (they are inherited)', async () => {
      const { svc, prisma } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue(saved({}));

      await svc.upsertTenantConfiguration('t1', {
        namespace: 'github',
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        secretRefs: {},
      });

      expect(prisma.tenantConfiguration.upsert).toHaveBeenCalled();
    });

    it('never touches the bridged default-repo connection when saving a non-default row', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue(saved({}));
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'bridge',
        status: 'active',
        config: { repoFullName: 'athmahealth/ehr' },
      });

      const view = await svc.upsertTenantConfiguration('t1', {
        namespace: 'github',
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
      });

      expect(connections.setStatus).not.toHaveBeenCalled();
      expect(connections.updateConfig).not.toHaveBeenCalled();
      expect(connections.create).not.toHaveBeenCalled();
      expect(view.connection).toBeNull();
    });

    it('rejects a key that is not the lowercased login', async () => {
      const { svc, prisma } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.upsertTenantConfiguration('t1', {
          namespace: 'github',
          key: 'website',
          values: { organization: 'NHWebsite' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a default repository on a non-default row', async () => {
      const { svc, prisma } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.upsertTenantConfiguration('t1', {
          namespace: 'github',
          key: 'nhwebsite',
          values: { organization: 'NHWebsite', defaultRepo: 'site' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an organisation already configured under another key', async () => {
      const { svc, prisma } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([
        { key: 'default', values: { organization: 'nhwebsite' } },
      ]);
      await expect(
        svc.upsertTenantConfiguration('t1', {
          namespace: 'github',
          key: 'nhwebsite',
          values: { organization: 'NHWebsite' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to change the organisation of an existing row, including default', async () => {
      const { svc, prisma } = build({
        id: 'cfg_default',
        key: 'default',
        values: { organization: 'athmahealth' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        updatedAt: new Date(),
      });
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.upsertTenantConfiguration('t1', {
          namespace: 'github',
          values: { organization: 'NHWebsite' },
          secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        }),
      ).rejects.toThrow('Organisation cannot be changed');
    });

    it('still requires the token ref on the default row', async () => {
      const { svc, prisma } = build(null);
      (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);
      await expect(
        svc.upsertTenantConfiguration('t1', {
          namespace: 'github',
          values: { organization: 'athmahealth' },
          secretRefs: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest src/modules/configurations/configurations.service.spec.ts -t "additional GitHub organisations"`
Expected: FAIL — inherited-ref save rejects ("Token secret ref is required"), bridge assertions fail, key/defaultRepo/duplicate/immutable cases resolve instead of rejecting.

- [ ] **Step 3: Add the `inheritSecretRefs` option to validation**

In `configuration-catalog.ts`, change the signature and the required check:

```ts
export function validateConfigurationValues(
  namespace: ConfigurationNamespace,
  values: Record<string, unknown>,
  secretRefs: Record<string, unknown>,
  status: string,
  opts: { inheritSecretRefs?: boolean } = {},
): string[] {
```

and replace the required check inside the `for (const field of section.fields)` loop:

```ts
    // A non-default GitHub organisation row may leave a token ref blank to use
    // the default row's (ADR-0013), so its refs are never required here.
    const inherits = opts.inheritSecretRefs && field.kind === 'secret-ref';
    if (status === 'active' && field.required && !present && !inherits) {
      errors.push(`"${field.label}" is required.`);
      continue;
    }
```

- [ ] **Step 4: Validate org rows and restrict the bridge in the service**

In `configurations.service.ts` add the import:

```ts
import {
  DEFAULT_GITHUB_CONFIG_KEY,
  GITHUB_LOGIN_PATTERN,
} from '../../collectors/sources/github/github-orgs';
```

Add this module-level helper next to `isBridgedNamespace`:

```ts
/** A GitHub organisation row other than `default` (ADR-0013): never bridged. */
function isAdditionalGithubOrg(namespace: string, key: string): boolean {
  return namespace === 'github' && key !== DEFAULT_GITHUB_CONFIG_KEY;
}
```

In `upsertTenantConfiguration`, change the validation call to

```ts
    const additionalOrg = isAdditionalGithubOrg(namespace, key);
    const errors = validateConfigurationValues(
      namespace,
      values,
      secretRefs,
      status,
      { inheritSecretRefs: additionalOrg },
    );
```

then, directly after the existing `existing` lookup (`const existing = await this.prisma.tenantConfiguration.findUnique(...)`) and before the optimistic-concurrency check, insert:

```ts
    if (namespace === 'github') {
      await this.assertGithubOrgRow(tenantId, key, values, existing);
    }
```

Change the bridge call to

```ts
    if (isBridgedNamespace(namespace) && !additionalOrg) {
```

Add the private method to the class (after `validateNamespace`):

```ts
  /**
   * The org-row rules of ADR-0013: a non-default row is keyed by its
   * lowercased login and has no default repo; no login appears twice in a
   * tenant; and `organization` never changes once saved — on any row —
   * because changing it would silently re-point every org-wide job.
   */
  private async assertGithubOrgRow(
    tenantId: string,
    key: string,
    values: Record<string, unknown>,
    existing: TenantConfiguration | null,
  ): Promise<void> {
    const organization =
      typeof values.organization === 'string' ? values.organization.trim() : '';
    const previous = (existing?.values as Record<string, unknown> | null)
      ?.organization;
    if (typeof previous === 'string' && previous && previous !== organization) {
      throw new BadRequestException(
        'Organisation cannot be changed — add a new organisation instead.',
      );
    }
    if (key === DEFAULT_GITHUB_CONFIG_KEY) return;
    if (!GITHUB_LOGIN_PATTERN.test(organization)) {
      throw new BadRequestException(
        '"Organization" must be a GitHub login (letters, digits, hyphens).',
      );
    }
    if (key !== organization.toLowerCase()) {
      throw new BadRequestException(
        `An additional organisation is saved under its lowercased login ("${organization.toLowerCase()}").`,
      );
    }
    if (values.defaultRepo !== undefined && values.defaultRepo !== '') {
      throw new BadRequestException(
        'Default repository applies only to the first organisation — use Sync org for this one.',
      );
    }
    const rows = await this.prisma.tenantConfiguration.findMany({
      where: { tenantId, namespace: 'github' },
      select: { key: true, values: true },
    });
    const clash = rows.find(
      (r) =>
        r.key !== key &&
        typeof (r.values as Record<string, unknown> | null)?.organization ===
          'string' &&
        ((r.values as Record<string, unknown>).organization as string)
          .trim()
          .toLowerCase() === organization.toLowerCase(),
    );
    if (clash) {
      throw new BadRequestException(
        `GitHub organisation "${organization}" is already configured.`,
      );
    }
  }
```

In `buildView`, change the first guard so non-default GitHub rows carry no bridge summary:

```ts
    if (
      !isBridgedNamespace(config.namespace as ConfigurationNamespace) ||
      isAdditionalGithubOrg(config.namespace, config.key)
    ) {
      return { ...config, connection: null, secretsConfigured };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx jest src/modules/configurations/configurations.service.spec.ts`
Expected: PASS — new tests and every pre-existing one (they use the `default` key, so behaviour is unchanged; if any pre-existing test's `findMany` mock is unset for a github save, the `assertGithubOrgRow` early return for `default` means it is not called).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/configurations
git commit -m "feat(config): additional GitHub organisation rows, locked org, default-only bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Org sync per organisation

**Files:**
- Modify: `backend/src/collectors/scheduler/github-org-sync-scheduler.service.ts` (`tick`, `syncTenant`)
- Modify: `backend/src/modules/configurations/configurations.controller.ts` (`SyncGithubOrgDto`, `syncGithubOrg` ~297)
- Test: `backend/src/collectors/scheduler/github-org-sync-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: `loadGithubOrgs`, `pickGithubOrg`, `GithubOrg` (Task 1).
- Produces: `GithubOrgSyncSchedulerService.syncOrg(org: GithubOrg): Promise<OrgSyncResult | null>` (replaces `syncTenant`). `SyncGithubOrgDto.organization?: string`.

- [ ] **Step 1: Update the spec's fixture and write the failing test**

In `github-org-sync-scheduler.service.spec.ts`, rows passed to `setup(rows)` now need `id`, `key`, `status`, `createdAt` because the scheduler reads them through `loadGithubOrgs`. Add a fixture helper at the top and use it in every existing test (replace each literal row object `{ tenantId, values, secretRefs }` with `cfgRow({ … })`):

```ts
const cfgRow = (o: Record<string, unknown>) => ({
  id: `cfg-${String(o.tenantId)}-${String(o.key ?? 'default')}`,
  key: 'default',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
});
```

Replace calls to `svc.syncTenant(tenantId, values, secretRefs)` with `svc.syncOrg(toGithubOrgs([cfgRow({ tenantId, values, secretRefs })])[0])` (import `toGithubOrgs` from `'../sources/github/github-orgs'`). For rows whose `values.organization` is missing, `toGithubOrgs` drops the row — change those assertions to `expect(toGithubOrgs([...])).toHaveLength(0)` and assert `orgSync.syncOrgRepos` was not called by `tick()`.

Add:

```ts
  it('syncs every active organisation row, each with its own effective token ref', async () => {
    const { svc, orgSync, restore } = setup([
      cfgRow({
        tenantId: 't1',
        values: { organization: 'athmahealth', backfillDays: 30 },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      }),
      cfgRow({
        tenantId: 't1',
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
        createdAt: new Date('2026-11-16T00:00:00Z'),
      }),
      cfgRow({
        tenantId: 't1',
        key: 'paused',
        status: 'disabled',
        values: { organization: 'Paused' },
      }),
    ]);
    try {
      await svc.tick();
      expect(orgSync.syncOrgRepos.mock.calls).toEqual([
        ['t1', 'athmahealth', 'GITHUB_TOKEN', 'tok:GITHUB_TOKEN', 30],
        ['t1', 'NHWebsite', 'GITHUB_TOKEN_NHWEBSITE', 'tok:GITHUB_TOKEN_NHWEBSITE', 90],
      ]);
    } finally {
      restore();
    }
  });

  it('a failing organisation does not stop the next one', async () => {
    const { svc, orgSync, restore } = setup([
      cfgRow({ tenantId: 't1', values: { organization: 'athmahealth' }, secretRefs: { tokenRef: 'GITHUB_TOKEN' } }),
      cfgRow({ tenantId: 't1', key: 'nhwebsite', values: { organization: 'NHWebsite' }, createdAt: new Date('2026-11-16') }),
    ]);
    orgSync.syncOrgRepos.mockRejectedValueOnce(new Error('boom'));
    try {
      await svc.tick();
      expect(orgSync.syncOrgRepos).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest src/collectors/scheduler/github-org-sync-scheduler.service.spec.ts`
Expected: FAIL — `svc.syncOrg is not a function`; `tick` only reads `key: 'default'`.

- [ ] **Step 3: Implement**

In `github-org-sync-scheduler.service.ts`, import `{ GithubOrg, loadGithubOrgs } from '../sources/github/github-orgs'`, and replace `tick` and `syncTenant`:

```ts
  @Cron(ORG_SYNC_CRON)
  async tick(): Promise<void> {
    if (readGithubAuditConfig().orgSyncHours === 0 || !this.shouldSweep()) {
      return;
    }
    // One pass per organisation row (ADR-0013), in row order, so a new
    // organisation is picked up without touching the others' connections.
    const orgs = await loadGithubOrgs(this.prisma, { activeOnly: true });
    for (const org of orgs) {
      const label = `[tenant ${org.tenantId}] [org ${org.organization}]`;
      try {
        const result = await this.tenantContext.runWithTenant(org.tenantId, () =>
          this.syncOrg(org),
        );
        if (result) {
          this.logger.log(
            `${label} scheduled org sync: ${result.reposFound} repos, ${result.created} new, ${result.skipped} skipped${result.rateLimited ? ' (rate-limited, resumes next run)' : ''}`,
          );
        }
      } catch (err) {
        this.logger.error(`${label} scheduled org sync failed: ${(err as Error).message}`);
      }
    }
  }

  /** One organisation; null when it cannot sync (no token ref, or no value stored for it). */
  async syncOrg(org: GithubOrg): Promise<OrgSyncResult | null> {
    const tokenRef = org.secretRefs.tokenRef;
    if (!tokenRef) {
      return null;
    }
    const token = await this.secrets.resolve(org.tenantId, tokenRef);
    if (!token) {
      this.logger.warn(
        `[tenant ${org.tenantId}] [org ${org.organization}] scheduled org sync skipped: no value stored for secret ref "${tokenRef}"`,
      );
      return null;
    }
    const backfillDays =
      typeof org.values.backfillDays === 'number'
        ? org.values.backfillDays
        : DEFAULT_BACKFILL_DAYS;
    return this.orgSync.syncOrgRepos(
      org.tenantId,
      org.organization,
      tokenRef,
      token,
      backfillDays,
    );
  }
```

In `configurations.controller.ts` add to `SyncGithubOrgDto`:

```ts
  /** Which configured organisation to sync; omitted = the first (default) one. */
  @IsOptional()
  @IsString()
  organization?: string;
```

and replace the body of `syncGithubOrg` up to `return this.githubOrgSync.syncOrgRepos(...)` with:

```ts
    const org = pickGithubOrg(
      await loadGithubOrgs(this.prisma, { tenantId: user.tenantId }),
      dto.organization,
    );
    const tokenRef = org?.secretRefs.tokenRef;
    if (!org || !org.active || !tokenRef) {
      throw new BadRequestException(
        dto.organization
          ? `GitHub organisation "${dto.organization}" is not configured with a token secret ref and saved as active.`
          : 'Configure GitHub (organization + token secret ref, saved as active) before syncing the whole org.',
      );
    }

    const token = await this.secrets.resolve(user.tenantId, tokenRef);
    if (!token) {
      throw new BadRequestException(
        `No value is stored (or set via env var) for secret ref "${tokenRef}" yet — paste the token in the Configuration screen, or set the env var, first.`,
      );
    }

    const backfillDays =
      dto.backfillDays ??
      (typeof org.values.backfillDays === 'number' ? org.values.backfillDays : 90);

    return this.githubOrgSync.syncOrgRepos(
      user.tenantId,
      org.organization,
      tokenRef,
      token,
      backfillDays,
    );
```

The controller needs `PrismaService`: check its constructor — if `prisma` is not injected, add `private readonly prisma: PrismaService` (import from `'../../database/prisma.service'`) to the constructor and to every `new ConfigurationsController(...)` in specs (`grep -rn "new ConfigurationsController" backend/src`). Import `loadGithubOrgs, pickGithubOrg` from `'../../collectors/sources/github/github-orgs'`.

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/collectors/scheduler/github-org-sync-scheduler.service.spec.ts src/collectors/sources/github/github-org-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/scheduler/github-org-sync-scheduler.service.ts backend/src/collectors/scheduler/github-org-sync-scheduler.service.spec.ts backend/src/modules/configurations/configurations.controller.ts
git commit -m "feat(github): org sync runs per configured organisation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Audit-log route and full sweep per organisation

**Files:**
- Modify: `backend/src/collectors/sources/github/github-audit-sync.fakes.ts`
- Modify: `backend/src/collectors/sources/github/github-audit-sync.service.ts`
- Test: `backend/src/collectors/sources/github/github-audit-sync.service.spec.ts`, `github-audit-execute.spec.ts`
- Create: `backend/src/collectors/sources/github/github-audit-multi-org.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers; Prisma key `tenantId_organization`.
- Produces (public API of `GithubAuditSyncService`):
  - `listEnabledOrgs(): Promise<{ tenantId: string; organization: string }[]>` (replaces `listEnabledTenants`)
  - `runTenant(tenantId, cfg?, now?, organization?: string)` and `runFullSweep(tenantId, cfg?, now?, organization?: string)` — omitted organization = default row
  - `status(tenantId, cfg?, now?, organization?: string): Promise<AuditStatus>`; `AuditStatus.organization: string | null`
  - Every `githubAuditRun` row written carries `organization`.

- [ ] **Step 1: Teach the fakes per-org keys and prefix filters**

In `github-audit-sync.fakes.ts`:

1. In `matches`, extend the operator list and add the prefix check:

```ts
      const ops = ['in', 'gte', 'gt', 'lte', 'lt', 'startsWith'].filter(
        (op) => op in v,
      );
      if (ops.length > 0) {
        const x = row[k];
        if ('in' in v && !(v.in as unknown[]).includes(x)) return false;
        if ('gte' in v && !(x != null && x >= v.gte)) return false;
        if ('gt' in v && !(x != null && x > v.gt)) return false;
        if ('lte' in v && !(x != null && x <= v.lte)) return false;
        if ('lt' in v && !(x != null && x < v.lt)) return false;
        if ('startsWith' in v) {
          const s = String(x ?? '');
          const p = String(v.startsWith);
          const hit =
            v.mode === 'insensitive'
              ? s.toLowerCase().startsWith(p.toLowerCase())
              : s.startsWith(p);
          if (!hit) return false;
        }
        return true;
      }
```

2. Checkpoint unique key: `githubAuditCheckpoint: table(calls, [], (w) => w.tenantId_organization ?? w),`

3. Replace `seedTenant` and add `seedOrg`:

```ts
export function seedTenant(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  repos: string[],
  opts: { auditRef?: string; organization?: string } = {
    auditRef: 'GITHUB_AUDIT_TOKEN',
  },
) {
  // The org is the repos' owner unless named, so per-org repo filtering keeps
  // every repo a test registers (ADR-0013).
  const organization = opts.organization ?? repos[0]?.split('/')[0] ?? 'acme';
  prisma.tenantConfiguration.rows.push({
    id: `${tenantId}-cfg-default`,
    tenantId,
    namespace: 'github',
    key: 'default',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    values: { organization },
    secretRefs: {
      tokenRef: 'GITHUB_TOKEN',
      ...(opts.auditRef ? { auditLogTokenRef: opts.auditRef } : {}),
    },
  });
  repos.forEach((repo, i) =>
    prisma.connection.rows.push({
      id: `${tenantId}-conn-${i}`,
      tenantId,
      sourceSystem: 'github',
      status: 'active',
      name: repo,
      secretRef: 'GITHUB_TOKEN',
      config: { repoFullName: repo },
    }),
  );
}

/** A second (non-default) organisation row and its repo connections. */
export function seedOrg(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  organization: string,
  repos: string[],
  opts: { tokenRef?: string; auditRef?: string; status?: string } = {},
) {
  prisma.tenantConfiguration.rows.push({
    id: `${tenantId}-cfg-${organization.toLowerCase()}`,
    tenantId,
    namespace: 'github',
    key: organization.toLowerCase(),
    status: opts.status ?? 'active',
    createdAt: new Date('2026-11-16T00:00:00Z'),
    values: { organization },
    secretRefs: {
      ...(opts.tokenRef ? { tokenRef: opts.tokenRef } : {}),
      ...(opts.auditRef ? { auditLogTokenRef: opts.auditRef } : {}),
    },
  });
  repos.forEach((repo, i) =>
    prisma.connection.rows.push({
      id: `${tenantId}-${organization.toLowerCase()}-conn-${i}`,
      tenantId,
      sourceSystem: 'github',
      status: 'active',
      name: repo,
      secretRef: opts.tokenRef ?? 'GITHUB_TOKEN',
      config: { repoFullName: repo },
    }),
  );
}
```

4. In `github-audit-sync.service.spec.ts` and `github-audit-execute.spec.ts`, find the `seeded(...)` helper (`grep -n "^function seeded" -A 8`) and make its checkpoint org follow the repos: replace `organization: 'acme',` with `organization: Object.keys(tips)[0]?.split('/')[0] ?? 'acme',`. In the tenant-scoping assertion (`grep -n "tenantId_namespace_key?: { tenantId: string }"`), widen the type and the read:

```ts
      const where = call.where as {
        tenantId?: string;
        tenantId_namespace_key?: { tenantId: string };
        tenantId_organization?: { tenantId: string };
      };
      expect(
        where.tenantId ??
          where.tenantId_namespace_key?.tenantId ??
          where.tenantId_organization?.tenantId,
      ).toBe('t1');
```

- [ ] **Step 2: Write the failing multi-org tests**

Create `github-audit-multi-org.spec.ts`. Copy the `setup()` function verbatim from the top of `github-audit-sync.service.spec.ts` (lines from `function setup() {` to its closing brace, plus the `NOW`, `SHADOW`, `INGEST` constants and the imports it uses), then add:

```ts
import { seedOrg, seedTenant } from './github-audit-sync.fakes';

describe('GithubAuditSyncService — per organisation (ADR-0013)', () => {
  it('lists one enabled entry per active org with an effective audit ref', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']); // inherits the audit ref
    seedOrg(prisma, 't1', 'Paused', [], { status: 'disabled' });
    await expect(svc.listEnabledOrgs()).resolves.toEqual([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
  });

  it("the default org's sweep never lists another org's repos", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp1', tenantId: 't1', organization: 'athmahealth',
      seededAt: new Date(NOW.getTime() - 3_600_000), checkpointAt: new Date(NOW.getTime() - 300_000),
    });
    client.listHeadRefs.mockResolvedValue({ status: 'ok', refs: [] });

    await svc.runFullSweep('t1', SHADOW, NOW);

    expect(client.listHeadRefs.mock.calls.map((c) => c[0])).toEqual(['athmahealth/ehr']);
    const run = prisma.githubAuditRun.rows.at(-1);
    expect(run?.organization).toBe('athmahealth');
  });

  it("a refused second org fails only its own run; the default org's checkpoint is untouched", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/a', 'NHWebsite/b'], { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' });
    const athma = {
      id: 'cp1', tenantId: 't1', organization: 'athmahealth',
      seededAt: new Date(NOW.getTime() - 3_600_000), checkpointAt: new Date(NOW.getTime() - 300_000),
    };
    prisma.githubAuditCheckpoint.rows.push(athma);
    const before = { ...athma };
    client.getDefaultBranch.mockResolvedValue({ status: 'not_found' });

    const summary = await svc.runTenant('t1', SHADOW, NOW, 'NHWebsite');

    expect(summary.status).toBe('failed');
    expect(prisma.githubAuditCheckpoint.rows.find((r) => r.organization === 'athmahealth'))
      .toMatchObject({ seededAt: before.seededAt, checkpointAt: before.checkpointAt });
    expect(prisma.githubAuditCheckpoint.rows.find((r) => r.organization === 'NHWebsite')?.seededAt)
      .toBeUndefined();
    expect(prisma.githubAuditRun.rows.at(-1)?.organization).toBe('NHWebsite');
  });

  it('the second org reads its own audit log, with the inherited audit token', async () => {
    const { svc, prisma, audit, secrets } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp2', tenantId: 't1', organization: 'NHWebsite',
      seededAt: new Date(NOW.getTime() - 3_600_000), checkpointAt: new Date(NOW.getTime() - 300_000),
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete', events: [], pages: 1, nextTraversals: 0, rateLimitRemaining: 4999,
    });

    await svc.runTenant('t1', SHADOW, NOW, 'NHWebsite');

    expect(audit.listGitPushes.mock.calls[0][0]).toBe('NHWebsite');
    expect(secrets.resolve).toHaveBeenCalledWith('t1', 'GITHUB_AUDIT_TOKEN');
  });

  it("pending ranges of another org are never executed by this org's run", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp1', tenantId: 't1', organization: 'athmahealth',
      seededAt: new Date(NOW.getTime() - 3_600_000), checkpointAt: new Date(NOW.getTime() - 300_000),
    });
    prisma.githubPushRange.rows.push({
      id: 'r-nh', tenantId: 't1', connectionId: 't1-nhwebsite-conn-0', repoFullName: 'NHWebsite/site',
      ref: 'main', kind: 'push', status: 'pending', attempts: 0, createdAt: NOW,
    });
    client.listHeadRefs.mockResolvedValue({ status: 'ok', refs: [] });

    await svc.runFullSweep('t1', SHADOW, NOW);

    expect(client.compareAll).not.toHaveBeenCalled();
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('status reports one organisation at a time', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubPushRange.rows.push(
      { id: 'a', tenantId: 't1', repoFullName: 'athmahealth/ehr', status: 'pending', createdAt: NOW },
      { id: 'b', tenantId: 't1', repoFullName: 'NHWebsite/site', status: 'pending', createdAt: NOW },
      { id: 'c', tenantId: 't1', repoFullName: 'NHWebsite/site', status: 'failed', createdAt: NOW },
    );
    const def = await svc.status('t1', SHADOW, NOW);
    const nh = await svc.status('t1', SHADOW, NOW, 'nhwebsite');
    expect(def).toMatchObject({ organization: 'athmahealth', pendingRanges: 1, failedRanges: 0 });
    expect(nh).toMatchObject({ organization: 'NHWebsite', pendingRanges: 1, failedRanges: 1 });
  });
});
```

(Use the exact response shapes the existing specs use for `listHeadRefs`, `getDefaultBranch` and `listGitPushes` — check one existing test with `grep -n "listHeadRefs.mockResolvedValue\|getDefaultBranch.mockResolvedValue\|listGitPushes.mockResolvedValue" github-audit-sync.service.spec.ts | head` and copy those shapes if they differ from the ones above.)

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && npx jest src/collectors/sources/github/github-audit-multi-org.spec.ts`
Expected: FAIL — `listEnabledOrgs` missing; `runTenant` ignores the 4th argument; the full sweep lists `NHWebsite/site`; runs have no `organization`.

- [ ] **Step 4: Implement in `github-audit-sync.service.ts`**

Add the import:

```ts
import {
  loadGithubOrgs,
  orgOfRepo,
  pickGithubOrg,
  repoInOrg,
  repoInOrgWhere,
} from './github-orgs';
```

Make each change below (line numbers are from the pre-change file):

1. `AuditStatus` (line ~111): add as the first field `organization: string | null;` with doc `/** The organisation this status describes; null when none is configured. */`.

2. Replace `listEnabledTenants` (390–402):

```ts
  /** Active GitHub organisations whose effective refs name an audit-log token (ADR-0013). */
  async listEnabledOrgs(): Promise<{ tenantId: string; organization: string }[]> {
    const orgs = await loadGithubOrgs(this.prisma, { activeOnly: true });
    return orgs
      .filter((o) => typeof o.secretRefs.auditLogTokenRef === 'string')
      .map((o) => ({ tenantId: o.tenantId, organization: o.organization }));
  }
```

3. `status` (411–484): add a 4th parameter `organization?: string`, and replace the `Promise.all` block and `enabled` computation with:

```ts
    const org = pickGithubOrg(
      await loadGithubOrgs(this.prisma, { tenantId }),
      organization,
    );
    const orgName = org?.organization ?? '';
    const inOrg = { repoFullName: repoInOrgWhere(orgName) };
    const [
      checkpoint,
      pendingRanges,
      failedRanges,
      lastFullSweep,
      truncatedRanges,
      dismissedRanges,
    ] = await Promise.all([
      this.prisma.githubAuditCheckpoint.findUnique({
        where: { tenantId_organization: { tenantId, organization: orgName } },
      }),
      this.prisma.githubPushRange.findMany({
        where: { tenantId, status: 'pending', ...inOrg },
      }),
      this.prisma.githubPushRange.findMany({
        where: { tenantId, status: 'failed', ...inOrg },
      }),
      this.prisma.githubAuditRun.findFirst({
        where: { tenantId, organization: orgName, trigger: 'full_sweep' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, finishedAt: true, status: true },
      }),
      this.prisma.githubPushRange.count({
        where: { tenantId, status: 'done', truncated: true, ...inOrg },
      }),
      this.prisma.githubPushRange.count({
        where: { tenantId, status: 'dismissed', ...inOrg },
      }),
    ]);
    const enabled =
      !!org && org.active && typeof org.secretRefs.auditLogTokenRef === 'string';
```

and add `organization: org?.organization ?? null,` as the first property of the returned object.

4. `rereadBranchHistory` (572–603): replace from `const checkpoint = …` through `const unknown = …` with:

```ts
    const checkpoints = await this.prisma.githubAuditCheckpoint.findMany({
      where: { tenantId },
    });
    const seededOrgs = new Set(
      checkpoints
        .filter((c) => c.seededAt)
        .map((c) => c.organization.toLowerCase()),
    );
    if (seededOrgs.size === 0) return { status: 'not_seeded', ...empty };
    const registered = await this.registeredRepos(tenantId);
    const wanted = repos && repos.length > 0 ? repos : [...registered.keys()];
    // A repo whose organisation has not been seeded yet is not re-read: its
    // first seeding pass reads its history anyway (ADR-0013).
    const targets = wanted.filter(
      (r) => registered.has(r) && seededOrgs.has(orgOfRepo(r)),
    );
    const unknown = wanted.filter((r) => !targets.includes(r));
```

5. `coverageForDay` (718–847): **leave for Task 6** except the one compile fix — change the checkpoint read inside it to `this.prisma.githubAuditCheckpoint.findFirst({ where: { tenantId } })`. Task 6 replaces this method.

6. `runTenant` / `runFullSweep` (849–918): add `organization?: string` as the 4th parameter of both, pass it to `this.prepareRun(tenantId, cfg, organization)`; in `runFullSweep` change the checkpoint lookup to

```ts
    const checkpoint = await this.prisma.githubAuditCheckpoint.findUnique({
      where: {
        tenantId_organization: { tenantId, organization: settings.organization },
      },
    });
```

7. `prepareRun` (925–968): add parameter `organization?: string`; call `this.loadSettings(tenantId, organization)` and `this.registeredRepos(tenantId, settings.organization)`.

8. `withRunClaim` (976–1057): scope every checkpoint access to the org:

```ts
    await this.prisma.githubAuditCheckpoint.upsert({
      where: { tenantId_organization: { tenantId, organization } },
      create: { id: newId(), tenantId, organization },
      update: {},
    });
    const claim = await this.prisma.githubAuditCheckpoint.updateMany({
      where: {
        tenantId,
        organization,
        OR: [
          { runningSince: null },
          { runningSince: { lt: new Date(now.getTime() - RUN_CLAIM_STALE_MS) } },
        ],
      },
      data: { runningSince: now },
    });
    if (claim.count === 0) {
      return skipped(
        `Another audit sync run for organisation ${organization} is in progress.`,
      );
    }
```

…and in the heartbeat and release `updateMany` calls change `where: { tenantId, runningSince: held }` to `where: { tenantId, organization, runningSince: held }`. Update the method's doc comment: "Per-(tenant, organisation) claim …".

> The skipped text changes from "…for this tenant…" to "…for organisation X…". Search the specs for the old sentence (`grep -rn "for this tenant is in progress" backend/src`) and update those expectations.

9. `runClaimed` (1059–1257):
   - checkpoint read: `findUnique({ where: { tenantId_organization: { tenantId, organization: settings.organization } } })`
   - run create `data`: add `organization: settings.organization,`
   - seed upsert: `where: { tenantId_organization: { tenantId, organization: ctx.organization } }`, `create: { id: newId(), tenantId, organization: ctx.organization, seededAt: now, checkpointAt: now }`, `update: { seededAt: now, checkpointAt: now }`
   - discovery update: `where: { tenantId_organization: { tenantId, organization: ctx.organization } }`
   - final `updateMany`: `where: { tenantId, organization: ctx.organization }`
   - log line: `github audit sync tenant=${tenantId} org=${ctx.organization} mode=…`

10. `sweepClaimed` (1259–1395): run create `data` add `organization: settings.organization,`; log line add `org=${settings.organization}`.

11. `loadSettings` (1397–1446): replace with

```ts
  private async loadSettings(
    tenantId: string,
    organization?: string,
  ): Promise<AuditSettings | { reason: string }> {
    const org = pickGithubOrg(
      await loadGithubOrgs(this.prisma, { tenantId }),
      organization,
    );
    if (!org || !org.active) {
      return {
        reason: organization
          ? `GitHub organisation "${organization}" is not configured (saved as active).`
          : 'GitHub is not configured (organization, saved as active).',
      };
    }
    const auditRef = org.secretRefs.auditLogTokenRef;
    if (!auditRef) {
      return {
        reason: 'No audit-log token secret ref is configured for GitHub.',
      };
    }
    const auditToken = await this.secrets.resolve(tenantId, auditRef);
    if (!auditToken) {
      return {
        reason: `No value is stored for audit-log token ref "${auditRef}".`,
      };
    }
    const backfillDays = org.values.backfillDays;
    return {
      organization: org.organization,
      auditToken,
      collectorTokenRef: org.secretRefs.tokenRef,
      // As the admin org sync reads it (a number, else 90); a non-positive
      // value is not a usable history horizon, so it falls back too.
      backfillDays:
        typeof backfillDays === 'number' && backfillDays > 0
          ? backfillDays
          : DEFAULT_BACKFILL_DAYS,
    };
  }
```

12. `registeredRepos` (1448–1460): add `organization?: string` and filter:

```ts
  /** Active GitHub connections by repo; one organisation's only when `organization` is given (ADR-0013). */
  private async registeredRepos(
    tenantId: string,
    organization?: string,
  ): Promise<Map<string, Connection>> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, sourceSystem: 'github', status: 'active' },
    });
    const byRepo = new Map<string, Connection>();
    for (const c of connections) {
      const repo = (c.config as { repoFullName?: string } | null)?.repoFullName;
      if (repo && (!organization || repoInOrg(repo, organization))) {
        byRepo.set(repo, c);
      }
    }
    return byRepo;
  }
```

13. `executePending` (2022–2065): add `repoFullName: repoInOrgWhere(ctx.organization),` to both branches of `where` and to the final `pendingRanges` count `where`.

- [ ] **Step 5: Run the audit suites**

Run: `cd backend && npx jest src/collectors/sources/github/github-audit`
Expected: PASS for `github-audit-multi-org.spec.ts`, and every pre-existing audit test still passes. If a pre-existing test fails only because it asserts a run row with `toEqual` (now carrying `organization`), change it to `toMatchObject` — do **not** change any behavioural expectation.

- [ ] **Step 6: Commit**

```bash
git add backend/src/collectors/sources/github
git commit -m "feat(github-audit): per-organisation settings, repos, checkpoint, claim and runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Audit scheduler over organisations; other checkpoint readers

**Files:**
- Modify: `backend/src/collectors/scheduler/github-audit-scheduler.service.ts` (`runForEnabledTenants` ~104)
- Modify: `backend/src/collectors/sources/github/github-audit-report.service.ts` (~86)
- Modify: `backend/src/collectors/sources/github/github-activity-verify.service.ts` (~369)
- Modify: `backend/src/modules/configurations/configurations.controller.ts` (`runAuditSync`, `auditSyncStatus`)
- Test: `backend/src/collectors/scheduler/github-audit-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: `listEnabledOrgs`, `runTenant(…, organization)`, `runFullSweep(…, organization)`, `status(…, organization)` (Task 4).
- Produces: `POST github/audit-sync/run` body `{ organization?: string }`; `GET github/audit-sync/status?organization=`.

- [ ] **Step 1: Write the failing scheduler test**

In `github-audit-scheduler.service.spec.ts`, wherever the mock `sync` object defines `listEnabledTenants: jest.fn().mockResolvedValue([...tenantIds])`, rename it to `listEnabledOrgs` returning `[{ tenantId, organization: 'acme' }, …]`, and update assertions `runTenant` → `toHaveBeenCalledWith('t1', cfg, undefined, 'acme')` style (the scheduler passes `undefined` for `now`). Add:

```ts
  it('runs every enabled organisation of a tenant, one after another', async () => {
    const order: string[] = [];
    const { svc, sync } = setup(); // existing helper
    sync.listEnabledOrgs.mockResolvedValue([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
    sync.runTenant.mockImplementation(async (_t: string, _c: unknown, _n: unknown, org: string) => {
      order.push(`start:${org}`);
      await Promise.resolve();
      order.push(`end:${org}`);
      return { tenantId: 't1', status: 'success', counters: {}, durationMs: 0 };
    });

    await svc.tick();

    expect(order).toEqual(['start:athmahealth', 'end:athmahealth', 'start:NHWebsite', 'end:NHWebsite']);
  });

  it('a throwing organisation never stops the next', async () => {
    const { svc, sync } = setup();
    sync.listEnabledOrgs.mockResolvedValue([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
    sync.runTenant.mockRejectedValueOnce(new Error('boom'));
    sync.runTenant.mockResolvedValueOnce({ tenantId: 't1', status: 'success', counters: {}, durationMs: 0 });
    await svc.tick();
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
  });
```

(If the existing spec's helper is not called `setup`, use whatever it is — `grep -n "^function\|^const .* = (" github-audit-scheduler.service.spec.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest src/collectors/scheduler/github-audit-scheduler.service.spec.ts`
Expected: FAIL — `listEnabledOrgs` never called.

- [ ] **Step 3: Implement the scheduler loop**

In `github-audit-scheduler.service.ts` change the two callers:

```ts
      (tenantId, organization) => this.sync.runTenant(tenantId, cfg, undefined, organization),
```

```ts
      (tenantId, organization) => this.sync.runFullSweep(tenantId, cfg, undefined, organization),
```

and rewrite `runForEnabledTenants` as `runForEnabledOrgs`:

```ts
  /**
   * One pass over every enabled organisation (ADR-0013), guarded by a
   * SchedulerTick row: a pass still open and younger than twice its interval
   * (at least 10 min) is left alone. Organisations run one after another —
   * a tenant's orgs never overlap on this cron — each in its tenant's
   * context; one org's failure never stops the others, and the row is always
   * closed.
   */
  private async runForEnabledOrgs(
    key: string,
    intervalMinutes: number,
    label: string,
    run: (tenantId: string, organization: string) => Promise<AuditRunSummary>,
  ): Promise<void> {
    const staleAfterMs = Math.max(10, intervalMinutes * 2) * 60_000;
    const open = await this.prisma.schedulerTick.findUnique({
      where: { sourceSystem: key },
    });
    if (
      open?.startedAt &&
      !open.finishedAt &&
      Date.now() - open.startedAt.getTime() < staleAfterMs
    ) {
      this.logger.log(`${label} still running — skipping this tick.`);
      return;
    }

    const orgs = await this.sync.listEnabledOrgs();
    await this.prisma.schedulerTick.upsert({
      where: { sourceSystem: key },
      create: {
        sourceSystem: key,
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: orgs.length,
        connectionsProcessed: 0,
      },
      update: {
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: orgs.length,
        connectionsProcessed: 0,
      },
    });
    try {
      for (const { tenantId, organization } of orgs) {
        const who = `tenant ${tenantId} org ${organization}`;
        try {
          const summary = await this.tenantContext.runWithTenant(tenantId, () =>
            run(tenantId, organization),
          );
          if (summary?.status === 'skipped') {
            this.logger.log(
              `${label} skipped for ${who}: ${summary.reason ?? 'no reason given'}`,
            );
          }
        } catch (err) {
          this.logger.error(`${label} failed for ${who}: ${(err as Error).message}`);
        }
      }
    } finally {
      await this.prisma.schedulerTick.update({
        where: { sourceSystem: key },
        data: { finishedAt: new Date() },
      });
    }
  }
```

Rename the two call sites from `runForEnabledTenants` to `runForEnabledOrgs`.

- [ ] **Step 4: Oldest checkpoint for the report and verification**

`github-audit-report.service.ts`: replace `this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } }),` in the `Promise.all` with `this.oldestCheckpoint(tenantId),` and add to the class:

```ts
  /**
   * The checkpoint furthest behind across the tenant's organisations
   * (ADR-0013) — the conservative answer to "how far has the audit log been
   * read". Null when no organisation has a checkpoint.
   */
  private async oldestCheckpoint(tenantId: string) {
    const rows = await this.prisma.githubAuditCheckpoint.findMany({
      where: { tenantId },
    });
    if (rows.length === 0) return null;
    return rows.reduce((a, b) =>
      (a.checkpointAt?.getTime() ?? 0) <= (b.checkpointAt?.getTime() ?? 0) ? a : b,
    );
  }
```

`github-activity-verify.service.ts` (~369): replace the `findUnique` with

```ts
    // Oldest across organisations (ADR-0013): a PR is only "should have been
    // seen" once every organisation's audit log has been read past it.
    const checkpoints = await this.prisma.githubAuditCheckpoint.findMany({
      where: { tenantId: input.tenantId },
      select: { checkpointAt: true },
    });
    const auditCheckpoint =
      checkpoints.length === 0
        ? null
        : {
            checkpointAt: checkpoints.some((c) => !c.checkpointAt)
              ? null
              : new Date(
                  Math.min(...checkpoints.map((c) => c.checkpointAt!.getTime())),
                ),
          };
```

If that service's spec stubs `githubAuditCheckpoint.findUnique`, change the stub to `findMany` returning `[row]` (`grep -n "githubAuditCheckpoint" src/collectors/sources/github/github-activity-verify.service.spec.ts`).

- [ ] **Step 5: Org-scoped audit endpoints**

In `configurations.controller.ts`:

```ts
class RunAuditSyncDto {
  @IsOptional()
  @IsString()
  organization?: string;
}
```

```ts
  @Roles(Role.ADMIN)
  @Post('github/audit-sync/run')
  async runAuditSync(
    @CurrentUser() user: AuthUser,
    @Body() dto: RunAuditSyncDto,
  ) {
    const summary = await this.auditSync.runTenant(
      user.tenantId,
      undefined,
      undefined,
      dto?.organization,
    );
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'collectors.github_audit_sync.run',
      targetType: 'github_audit_run',
      targetId: summary.runId,
      metadata: {
        status: summary.status,
        counters: summary.counters,
        organization: dto?.organization ?? null,
      },
    });
    return summary;
  }
```

```ts
  @Roles(Role.ADMIN)
  @Get('github/audit-sync/status')
  async auditSyncStatus(
    @CurrentUser() user: AuthUser,
    @Query('organization') organization?: string,
  ) {
    return this.auditSync.status(user.tenantId, undefined, undefined, organization);
  }
```

- [ ] **Step 6: Compile and run**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json && npx jest src/collectors src/modules/configurations`
Expected: no type errors (every `githubAuditCheckpoint.findUnique({ where: { tenantId } })` is gone — confirm with `grep -rn "githubAuditCheckpoint.findUnique({ where: { tenantId } })" backend/src` → no output); tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src
git commit -m "feat(github-audit): schedule per organisation; org-scoped admin run/status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Digest coverage across included organisations

**Files:**
- Modify: `backend/src/collectors/sources/github/github-audit-sync.service.ts` (`AuditDayCoverage` ~142, `coverageForDay` ~718)
- Test: `backend/src/collectors/sources/github/github-audit-multi-org.spec.ts` (append)

**Interfaces:**
- Consumes: Tasks 1, 4.
- Produces:
  - `AuditDayCoverage` gains `included: string[]` (org logins in row order) and `collecting: string[]`.
  - `coverageForDay(tenantId, day, cfg?, now?)` — same signature, aggregates.
  - `digestInclusion(tenantId, cfg?): Promise<Map<string, 'included' | 'collecting' | 'disabled'>>` keyed by organisation login as saved.

- [ ] **Step 1: Write the failing tests**

Append to `github-audit-multi-org.spec.ts` (`INGEST` is the ingest-mode config constant copied from the main spec; `DAY` = the IST day key the main spec's coverage tests use — copy it too):

```ts
describe('coverageForDay across organisations (ADR-0013)', () => {
  function seededCheckpoint(prisma: ReturnType<typeof setup>['prisma'], organization: string) {
    prisma.githubAuditCheckpoint.rows.push({
      id: `cp-${organization}`, tenantId: 't1', organization,
      seededAt: new Date(NOW.getTime() - 86_400_000 * 3),
      checkpointAt: NOW,
    });
  }
  function sweptAfterDay(prisma: ReturnType<typeof setup>['prisma'], organization: string) {
    prisma.githubAuditRun.rows.push({
      id: `sw-${organization}`, tenantId: 't1', organization, trigger: 'full_sweep',
      status: 'success', mode: 'ingest', startedAt: NOW,
    });
  }

  it('single org: reasons are unprefixed and the org is included', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c.included).toEqual(['athmahealth']);
    expect(c.reasons).toContain('audit sync has not completed its seeding pass');
  });

  it('a second org that has not finished its first seeding + sweep is collecting, not included', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c).toMatchObject({ ok: true, included: ['athmahealth'], collecting: ['NHWebsite'] });
  });

  it('once included, an uncovered second org withholds, named in the reason', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    seededCheckpoint(prisma, 'NHWebsite');
    // NHWebsite swept successfully once, but long before the day ended.
    prisma.githubAuditRun.rows.push({
      id: 'old', tenantId: 't1', organization: 'NHWebsite', trigger: 'full_sweep',
      status: 'success', mode: 'ingest', startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c.included).toEqual(['athmahealth', 'NHWebsite']);
    expect(c.ok).toBe(false);
    expect(c.reasons.every((r) => r.startsWith('NHWebsite: '))).toBe(true);
  });

  it("a pending range in one org never counts against another org's coverage", async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site'], { status: 'disabled' });
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    prisma.githubPushRange.rows.push({
      id: 'r', tenantId: 't1', repoFullName: 'NHWebsite/site', ref: 'main',
      status: 'pending', createdAt: NOW,
    });
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c).toMatchObject({ ok: true, included: ['athmahealth'] });
  });

  it('digestInclusion reports included / collecting / disabled per org', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', []);
    seedOrg(prisma, 't1', 'Paused', [], { status: 'disabled' });
    const m = await svc.digestInclusion('t1', INGEST);
    expect([...m.entries()]).toEqual([
      ['athmahealth', 'included'],
      ['NHWebsite', 'collecting'],
      ['Paused', 'disabled'],
    ]);
  });

  it('outside ingest mode every active org is included immediately', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', []);
    const c = await svc.coverageForDay('t1', DAY, SHADOW, NOW);
    expect(c).toMatchObject({ applies: false, ok: true, included: ['athmahealth', 'NHWebsite'] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest src/collectors/sources/github/github-audit-multi-org.spec.ts -t "coverageForDay across"`
Expected: FAIL — `included` undefined, `digestInclusion` missing.

- [ ] **Step 3: Implement**

`AuditDayCoverage`: add

```ts
  /** Organisations the digest covers and names (ADR-0013), in row order. */
  included: string[];
  /** Active non-default organisations still on their first collection — left out until included. */
  collecting: string[];
```

Rename the existing `coverageForDay` method to `private async coverageForOrg(tenantId: string, org: GithubOrg, day: string, cfg: GithubAuditConfig, now: Date): Promise<{ applies: boolean; ok: boolean; reasons: string[] }>` (import `GithubOrg` from `./github-orgs`), and inside it:

- replace the `tenantConfiguration.findUnique` + `refs` block with

```ts
    if (!org.active || typeof org.secretRefs.auditLogTokenRef !== 'string') {
      return notApplicable;
    }
```

  (and drop `included`/`collecting` from its local `notApplicable`)
- add `repoFullName: repoInOrgWhere(org.organization),` to both `unfinishedWhere` and `truncatedWhere`
- checkpoint read: `this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId_organization: { tenantId, organization: org.organization } } })`
- sweep `findFirst` `where`: add `organization: org.organization,`

Then add the new public method and the inclusion helpers above it, keeping the original docblock on `coverageForDay` and appending "Across organisations (ADR-0013): every *included* organisation must be covered; reasons are prefixed with the organisation when the tenant has more than one active GitHub row.":

```ts
  async coverageForDay(
    tenantId: string,
    day: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditDayCoverage> {
    const orgs = await loadGithubOrgs(this.prisma, { tenantId });
    const inclusion = await this.inclusionOf(tenantId, orgs, cfg);
    const active = orgs.filter((o) => o.active);
    const included = active.filter(
      (o) => inclusion.get(o.organization) === 'included',
    );
    const prefix = active.length > 1;
    let applies = false;
    const reasons: string[] = [];
    for (const org of included) {
      const c = await this.coverageForOrg(tenantId, org, day, cfg, now);
      if (!c.applies) continue;
      applies = true;
      reasons.push(
        ...c.reasons.map((r) => (prefix ? `${org.organization}: ${r}` : r)),
      );
    }
    return {
      applies,
      ok: reasons.length === 0,
      reasons,
      included: included.map((o) => o.organization),
      collecting: active
        .filter((o) => inclusion.get(o.organization) === 'collecting')
        .map((o) => o.organization),
    };
  }

  /** Whether each of the tenant's organisations is in the digest yet (ADR-0013). */
  async digestInclusion(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
  ): Promise<Map<string, 'included' | 'collecting' | 'disabled'>> {
    return this.inclusionOf(
      tenantId,
      await loadGithubOrgs(this.prisma, { tenantId }),
      cfg,
    );
  }

  /**
   * The default organisation is always included — exactly as before, so a
   * fresh tenant still withholds until it is seeded. Any other active
   * organisation joins once its first seeding is done and, when the full
   * sweep is on, it has had one successful ingest-mode sweep; where the audit
   * route does not apply to it, it joins at once. Until then its partial data
   * can only add activity, never name someone.
   */
  private async inclusionOf(
    tenantId: string,
    orgs: GithubOrg[],
    cfg: GithubAuditConfig,
  ): Promise<Map<string, 'included' | 'collecting' | 'disabled'>> {
    const out = new Map<string, 'included' | 'collecting' | 'disabled'>();
    for (const org of orgs) {
      if (!org.active) {
        out.set(org.organization, 'disabled');
        continue;
      }
      if (
        org.isDefault ||
        cfg.mode !== 'ingest' ||
        typeof org.secretRefs.auditLogTokenRef !== 'string'
      ) {
        out.set(org.organization, 'included');
        continue;
      }
      const checkpoint = await this.prisma.githubAuditCheckpoint.findUnique({
        where: {
          tenantId_organization: { tenantId, organization: org.organization },
        },
      });
      const sweptOnce =
        cfg.fullSweepMinutes === 0 ||
        !!(await this.prisma.githubAuditRun.findFirst({
          where: {
            tenantId,
            organization: org.organization,
            trigger: 'full_sweep',
            status: 'success',
            mode: 'ingest',
          },
          select: { id: true },
        }));
      out.set(
        org.organization,
        checkpoint?.seededAt && sweptOnce ? 'included' : 'collecting',
      );
    }
    return out;
  }
```

- [ ] **Step 4: Run all audit tests**

Run: `cd backend && npx jest src/collectors/sources/github/github-audit src/metrics/no-commit-detection.service.spec.ts`
Expected: PASS. Pre-existing coverage tests that `toEqual({ applies, ok, reasons })` must become `toMatchObject({ applies, ok, reasons })` — their reasons must stay byte-identical (single org ⇒ no prefix). Any change to an expected reason string is a regression: fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github
git commit -m "feat(github-audit): digest coverage across included organisations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Copilot usage per organisation

**Files:**
- Modify: `backend/src/collectors/sources/github/github-copilot-usage-sync.service.ts` (`listEnabledTenants` ~97, `syncTenant` ~139, `loadSettings` ~335)
- Modify: `backend/src/collectors/scheduler/github-copilot-scheduler.service.ts` (`runForEnabledTenants`)
- Modify: `backend/src/modules/configurations/configurations.controller.ts` (`runCopilotSync`)
- Modify: `backend/src/modules/code/code.service.ts` (`copilotCoverage` ~920, `CopilotCoverage` ~944)
- Modify: `frontend/src/modules/dashboards/useInsights.ts` (`CopilotCoverage` ~1050), `frontend/src/modules/dashboards/developer-activity/copilot-column.ts` (`copilotCaption`)
- Test: `backend/src/collectors/sources/github/github-copilot-usage-sync.service.spec.ts`, `frontend/src/modules/dashboards/developer-activity/copilot-column.test.ts`

**Interfaces:**
- Produces: `listEnabledOrgs(): Promise<{ tenantId: string; organization: string }[]>`; `syncTenant(tenantId, now?, organization?)`; `CopilotCoverage.orgs: string[]`.

- [ ] **Step 1: Write failing backend tests**

In `github-copilot-usage-sync.service.spec.ts`, the GitHub row is stubbed via `tenantConfiguration.findUnique`. Change that stub to `tenantConfiguration.findMany` returning the row(s) with `id`, `tenantId`, `key`, `status`, `values`, `secretRefs`, `createdAt` (`grep -n "tenantConfiguration" github-copilot-usage-sync.service.spec.ts`). Then add:

```ts
  it('syncs the named organisation with its own effective Copilot ref', async () => {
    const h = setup(); // the spec's existing harness
    h.prisma.tenantConfiguration.findMany.mockResolvedValue([
      { id: 'cfg-d', tenantId: 't1', key: 'default', status: 'active', createdAt: new Date('2026-01-01'),
        values: { organization: 'athmahealth' }, secretRefs: { copilotMetricsTokenRef: 'GITHUB_COPILOT_TOKEN' } },
      { id: 'cfg-nh', tenantId: 't1', key: 'nhwebsite', status: 'active', createdAt: new Date('2026-11-16'),
        values: { organization: 'NHWebsite' }, secretRefs: {} },
    ]);
    const r = await h.svc.syncTenant('t1', NOW, 'NHWebsite');
    expect(r.org).toBe('NHWebsite');
    expect(h.secrets.resolve).toHaveBeenCalledWith('t1', 'GITHUB_COPILOT_TOKEN');
  });

  it('lists one entry per active org with an effective Copilot ref', async () => {
    const h = setup();
    h.prisma.tenantConfiguration.findMany.mockResolvedValue([
      { id: 'a', tenantId: 't1', key: 'default', status: 'active', createdAt: new Date('2026-01-01'),
        values: { organization: 'athmahealth' }, secretRefs: {} },
      { id: 'b', tenantId: 't1', key: 'nhwebsite', status: 'active', createdAt: new Date('2026-11-16'),
        values: { organization: 'NHWebsite' }, secretRefs: { copilotMetricsTokenRef: 'NH_COPILOT' } },
    ]);
    await expect(h.svc.listEnabledOrgs()).resolves.toEqual([
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
  });
```

(Adapt `setup()`, `NOW` and field names to the spec's existing harness — `grep -n "^function setup\|const NOW" github-copilot-usage-sync.service.spec.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest src/collectors/sources/github/github-copilot-usage-sync.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the sync**

In `github-copilot-usage-sync.service.ts` import `{ loadGithubOrgs, pickGithubOrg } from './github-orgs'`, replace `listEnabledTenants` with:

```ts
  /** Active GitHub organisations whose effective refs name a Copilot token (ADR-0013). */
  async listEnabledOrgs(): Promise<{ tenantId: string; organization: string }[]> {
    const orgs = await loadGithubOrgs(this.prisma, { activeOnly: true });
    return orgs
      .filter((o) => typeof o.secretRefs[COPILOT_TOKEN_REF_FIELD] === 'string')
      .map((o) => ({ tenantId: o.tenantId, organization: o.organization }));
  }
```

change `syncTenant(tenantId: string, now: Date = new Date())` to `syncTenant(tenantId: string, now: Date = new Date(), organization?: string)` and its `this.loadSettings(tenantId)` to `this.loadSettings(tenantId, organization)`, and replace `loadSettings`:

```ts
  private async loadSettings(
    tenantId: string,
    organization?: string,
  ): Promise<CopilotSettings | null> {
    const org = pickGithubOrg(
      await loadGithubOrgs(this.prisma, { tenantId }),
      organization,
    );
    const tokenRef = org?.secretRefs[COPILOT_TOKEN_REF_FIELD];
    if (!org || !org.active || typeof tokenRef !== 'string') {
      return null;
    }
    // The configuration row stands in for a connection: Copilot metrics are
    // org-level, so no repo connection owns them, and this id is what ties
    // each raw event back to the configuration (organisation) that collected it.
    return { connectionId: org.configId, org: org.organization, tokenRef };
  }
```

In `github-copilot-scheduler.service.ts` replace the loop body:

```ts
      for (const { tenantId, organization } of await this.sync.listEnabledOrgs()) {
        // One organisation's revoked token must not cancel the sweep for the rest.
        try {
          await this.tenantContext.runWithTenant(tenantId, () =>
            this.sync.syncTenant(tenantId, undefined, organization),
          );
        } catch (error) {
          this.logger.error(
            `Copilot usage sync failed for tenant ${tenantId} org ${organization}: ${(error as Error).message}`,
          );
        }
      }
```

In the controller, `runCopilotSync` gains `@Body() dto: RunAuditSyncDto` (reuse the Task 5 DTO), records `metadata: { organization: dto?.organization ?? null }` on the audit entry, and returns `this.copilotSync.syncTenant(user.tenantId, undefined, dto?.organization)`.

- [ ] **Step 4: Freshness across organisations**

In `code.service.ts` (search with `grep -an "async copilotCoverage" src/modules/code/code.service.ts`), replace the body of `copilotCoverage`:

```ts
    // Per organisation (ADR-0013): the column is only as fresh as the
    // organisation furthest behind, and a day reported by two organisations
    // is still one report day.
    const [newestByOrg, daysInWindow] = await Promise.all([
      this.prisma.copilotReportDay.groupBy({
        by: ['org'],
        where: { tenantId },
        _max: { day: true },
        orderBy: { org: 'asc' },
      }),
      this.prisma.copilotReportDay.findMany({
        where: {
          tenantId,
          day: { gte: dayDate(fromDay), lte: dayDate(toDay) },
        },
        select: { day: true },
        distinct: ['day'],
      }),
    ]);
    const newest = newestByOrg
      .map((g) => g._max.day)
      .filter((d): d is Date => d instanceof Date);
    const oldestNewest =
      newest.length > 0
        ? new Date(Math.min(...newest.map((d) => d.getTime())))
        : null;
    return {
      collected: newest.length > 0,
      coveredThrough: oldestNewest
        ? oldestNewest.toISOString().slice(0, 10)
        : null,
      reportDaysInWindow: daysInWindow.length,
      orgs: newestByOrg.map((g) => g.org),
    };
```

and add `orgs: string[];` (doc: `/** Organisations with any collected report, A–Z. */`) to `CopilotCoverage`. Update any spec that stubs `copilotReportDay.findFirst/count` for coverage (`grep -rn "copilotReportDay" backend/src --include=*.spec.ts`) to stub `groupBy` and `findMany`.

- [ ] **Step 5: Caption names the organisations (frontend)**

Add to `CopilotCoverage` in `frontend/src/modules/dashboards/useInsights.ts`: `/** Organisations with a collected report; absent on an older API. */ orgs?: string[];`

Write the failing test in `copilot-column.test.ts`:

```ts
  it('names the organisations when more than one reports', () => {
    const caption = copilotCaption({
      collected: true,
      coveredThrough: '2026-11-14',
      reportDaysInWindow: 10,
      orgs: ['athmahealth', 'NHWebsite'],
    });
    expect(caption).toContain('Across GitHub organisations athmahealth and NHWebsite.');
  });

  it('is unchanged for one organisation', () => {
    const one = copilotCaption({ collected: true, coveredThrough: '2026-11-14', reportDaysInWindow: 10, orgs: ['athmahealth'] });
    const legacy = copilotCaption({ collected: true, coveredThrough: '2026-11-14', reportDaysInWindow: 10 });
    expect(one).toBe(legacy);
  });
```

Run: `cd frontend && npx vitest run src/modules/dashboards/developer-activity/copilot-column.test.ts` → FAIL. Then in `copilotCaption`, after `const through = …`:

```ts
  const orgs = coverage.orgs ?? [];
  const scope =
    orgs.length > 1
      ? ` Across GitHub organisations ${orgs.slice(0, -1).join(', ')} and ${orgs[orgs.length - 1]}.`
      : '';
```

and append `scope` right after `through` in the returned string. Re-run → PASS.

- [ ] **Step 6: Run backend tests**

Run: `cd backend && npx jest src/collectors src/modules/code src/metrics`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src frontend/src/modules/dashboards
git commit -m "feat(copilot): usage sync per organisation; freshness of the furthest-behind org

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Combined digest card and Watchlist scope line

**Files:**
- Modify: `backend/src/collectors/delivery/digest-card.ts` (`DigestCardInput`, `sourceText`)
- Modify: `backend/src/metrics/no-commit-detection.service.ts` (`DigestDetection`, gate 1b ~487, final returns, `PreviousDayView` ~89 and its builder ~300)
- Modify: `backend/src/modules/notifications/notifications.service.ts` (`resolveGithubOrganization` ~408, card build ~290)
- Modify: `frontend/src/modules/dashboards/developer-activity/previous-day.ts`, `PreviousDayCard.tsx`
- Test: `backend/src/collectors/delivery/digest-card.spec.ts`, `backend/src/metrics/no-commit-detection.service.spec.ts`, `backend/src/modules/notifications/notifications.service.spec.ts`, `frontend/src/modules/dashboards/developer-activity/previous-day.test.ts`

**Interfaces:**
- Consumes: `AuditDayCoverage.included` (Task 6), `loadGithubOrgs`, `GITHUB_LOGIN_PATTERN` (Task 1).
- Produces: `DigestCardInput.githubOrganizations?: string[]` (replaces `githubOrganization`); `DigestDetection.githubOrganizations?: string[]`; `PreviousDayView.githubOrganizations: string[]`; frontend `githubScopeLine(orgs: string[]): string | null` in `previous-day.ts`.

- [ ] **Step 1: Card tests first**

In `digest-card.spec.ts` replace every `githubOrganization: 'athmahealth'` with `githubOrganizations: ['athmahealth']` — the expected strings stay **exactly** as they are (single-org golden). Add:

```ts
  it('names every organisation when more than one is covered', () => {
    const card = buildDigestCard({
      reportedDay: '2026-11-16',
      flagged: [{ developer: 'a', displayName: 'Ann' }],
      evaluatedCount: 70,
      unattributedCommits: 0,
      githubOrganizations: ['athmahealth', 'NHWebsite'],
    });
    expect(JSON.stringify(card)).toContain(
      'Below developers had no recorded activity in GitHub **athmahealth** and **NHWebsite** organisations:',
    );
    expect(card.text).toContain(
      'GitHub <b>athmahealth</b> and <b>NHWebsite</b> organisations',
    );
  });

  it('lists three organisations with commas and "and"', () => {
    const card = buildDigestCard({
      reportedDay: '2026-11-16',
      flagged: [],
      evaluatedCount: 70,
      unattributedCommits: 0,
      githubOrganizations: ['a1', 'b2', 'c3'],
    });
    expect(card.text).toContain(
      'All 70 tracked developers had recorded activity in GitHub <b>a1</b>, <b>b2</b> and <b>c3</b> organisations on 2026-11-16.',
    );
  });
```

Run: `cd backend && npx jest src/collectors/delivery/digest-card.spec.ts` → FAIL (property unknown / text "GitHub" alone).

- [ ] **Step 2: Implement the card**

In `digest-card.ts` replace the `githubOrganization?: string;` field (and its doc) with:

```ts
  /**
   * The GitHub organisation logins the digest covers (e.g. `['athmahealth']`,
   * ADR-0013), named in the lead-in and all-clear lines so readers know which
   * source "recorded activity" refers to. Callers pass only valid GitHub
   * logins (letters, digits, hyphens), so they need no markdown escaping;
   * empty or omitted, the line says "in GitHub" alone.
   */
  githubOrganizations?: string[];
```

and `sourceText`:

```ts
function sourceText(input: DigestCardInput, bold: Emphasise): string {
  const orgs = (input.githubOrganizations ?? []).map(bold);
  if (orgs.length === 0) return 'GitHub';
  if (orgs.length === 1) return `GitHub ${orgs[0]} organisation`;
  return `GitHub ${orgs.slice(0, -1).join(', ')} and ${orgs[orgs.length - 1]} organisations`;
}
```

Update the "None of these three interpolate untrusted data" docblock mention from `githubOrganization` to `githubOrganizations`. Re-run the card spec → PASS.

- [ ] **Step 3: Detection carries the included orgs**

In `no-commit-detection.service.ts`:
- `DigestDetection`: add `/** Organisations the day was checked across (ADR-0013); absent when the audit route was not consulted. */ githubOrganizations?: string[];`
- `PreviousDayView`: add `/** Organisations the list covers; a scope line is shown when more than one. */ githubOrganizations: string[];`
- In gate 1b, declare `let githubOrganizations: string[] | undefined;` before `if (this.auditSync)`, and right after `const coverage = await this.auditSync.coverageForDay(…)` add `githubOrganizations = coverage.included;`.
- Add `githubOrganizations,` to every `return { … }` that comes **after** gate 1b (gates 3, 4 and the final return — `grep -n "unattributedCommits,$" src/metrics/no-commit-detection.service.ts` locates them).
- In the previous-day builder (`ruleText: DIGEST_RULE_TEXT,`), add `githubOrganizations: detected.githubOrganizations ?? [],`.

Add to `no-commit-detection.service.spec.ts` (use the spec's existing harness that stubs `auditSync.coverageForDay`; `grep -n "coverageForDay" no-commit-detection.service.spec.ts`):

```ts
  it('carries the organisations the audit route covered into the detection', async () => {
    // harness: auditSync.coverageForDay resolves
    //   { applies: true, ok: true, reasons: [], included: ['athmahealth', 'NHWebsite'], collecting: [] }
    const detected = await svc.detect('t1', DAY);
    expect(detected.githubOrganizations).toEqual(['athmahealth', 'NHWebsite']);
  });
```

Existing stubs returning `{ applies, ok, reasons }` should gain `included: ['acme'], collecting: []` so types check.

- [ ] **Step 4: Notifications render from the included orgs**

In `notifications.service.ts` import `{ GITHUB_LOGIN_PATTERN, loadGithubOrgs } from '../../collectors/sources/github/github-orgs'` and replace `resolveGithubOrganization` with:

```ts
  /**
   * The GitHub organisation logins for the card's lead-in ("… no recorded
   * activity in GitHub athmahealth and NHWebsite organisations:"). The ones
   * the day's coverage check included when it ran (ADR-0013), else every
   * active organisation row. Only valid GitHub logins, so an admin-typed
   * value cannot carry markdown or HTML into the card.
   */
  private async resolveGithubOrganizations(
    tenantId: string,
    included: string[] | undefined,
  ): Promise<string[]> {
    const orgs =
      included ??
      (await loadGithubOrgs(this.prisma, { tenantId, activeOnly: true })).map(
        (o) => o.organization,
      );
    return orgs.filter((o) => GITHUB_LOGIN_PATTERN.test(o));
  }
```

and at the card build:

```ts
      const githubOrganizations = await this.resolveGithubOrganizations(
        tenantId,
        detected.githubOrganizations,
      );
      const card = buildDigestCard({
        reportedDay,
        flagged: result.flagged,
        evaluatedCount,
        unattributedCommits: detected.unattributedCommits,
        ...(detail ? { withheldDetail: detail } : {}),
        githubOrganizations,
      });
```

In `notifications.service.spec.ts`, specs that stub the GitHub row through `tenantConfiguration.findUnique` for the org name must stub `tenantConfiguration.findMany` returning `[{ id, tenantId, key: 'default', status: 'active', values: { organization: 'athmahealth' }, secretRefs: {}, createdAt }]` (`grep -n "organization" src/modules/notifications/notifications.service.spec.ts`). Expected card text is unchanged. Add one test: detection returns `githubOrganizations: ['athmahealth', 'NHWebsite']` ⇒ the posted card text contains `GitHub **athmahealth** and **NHWebsite** organisations`.

- [ ] **Step 5: Watchlist scope line (frontend)**

`previous-day.ts`: add `/** Organisations the list covers (ADR-0013); absent on an older API. */ githubOrganizations?: string[];` to `PreviousDayView`, and:

```ts
/** The scope sentence shown beside the rule when the list spans more than one organisation. */
export function githubScopeLine(orgs: readonly string[] | undefined): string | null {
  if (!orgs || orgs.length < 2) return null;
  return `Across GitHub organisations: ${orgs.join(', ')}.`;
}
```

Test in `previous-day.test.ts`:

```ts
import { githubScopeLine } from './previous-day';

describe('githubScopeLine', () => {
  it('is absent for one organisation, so the single-org card is unchanged', () => {
    expect(githubScopeLine(['athmahealth'])).toBeNull();
    expect(githubScopeLine(undefined)).toBeNull();
  });
  it('names every organisation when there are several', () => {
    expect(githubScopeLine(['athmahealth', 'NHWebsite'])).toBe(
      'Across GitHub organisations: athmahealth, NHWebsite.',
    );
  });
});
```

`PreviousDayCard.tsx`: import `githubScopeLine` and change the provenance note opening to

```tsx
          <ProvenanceNote>
            {v.ruleText}
            {githubScopeLine(v.githubOrganizations) ? ` ${githubScopeLine(v.githubOrganizations)}` : ''}{' '}
            No tracked signal is not the same as no work: pairing,
```

(keep everything after "pairing," unchanged).

- [ ] **Step 6: Run tests**

Run: `cd backend && npx jest src/collectors/delivery src/metrics src/modules/notifications` and `cd frontend && npx vitest run src/modules/dashboards/developer-activity`
Expected: PASS; every pre-existing single-org card string unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/src frontend/src/modules/dashboards
git commit -m "feat(digest): one combined digest naming every included GitHub organisation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `GET github/organizations`

**Files:**
- Modify: `backend/src/modules/configurations/configurations.controller.ts`
- Modify: `frontend/src/lib/api/types.ts`
- Test: `backend/src/modules/configurations/github-organizations.view.spec.ts` (new)

**Interfaces:**
- Consumes: `loadGithubOrgs`, `GithubOrg` (Task 1); `auditSync.status(…, organization)` (Task 4); `auditSync.digestInclusion` (Task 6).
- Produces: `toOrganizationView(org: GithubOrg, audit: AuditStatus, digest: 'included'|'collecting'|'disabled'): GithubOrganizationView` (exported from the controller file) and route `GET /api/admin/configurations/github/organizations` → `{ organizations: GithubOrganizationView[] }`. Frontend type `GithubOrganization` mirrors it.

- [ ] **Step 1: Failing test for the view mapper**

`github-organizations.view.spec.ts`:

```ts
import { toGithubOrgs } from '../../collectors/sources/github/github-orgs';
import { toOrganizationView } from './configurations.controller';

describe('toOrganizationView', () => {
  it('exposes ref names (never values), inheritance, audit status and digest inclusion', () => {
    const [, nh] = toGithubOrgs([
      { id: 'd', tenantId: 't1', key: 'default', status: 'active', values: { organization: 'athmahealth' }, secretRefs: { tokenRef: 'GITHUB_TOKEN' } },
      { id: 'n', tenantId: 't1', key: 'nhwebsite', status: 'active', values: { organization: 'NHWebsite', backfillDays: 30 }, secretRefs: {}, createdAt: new Date('2026-11-16') },
    ]);
    const audit = { organization: 'NHWebsite', enabled: false } as never;
    expect(toOrganizationView(nh, audit, 'collecting')).toEqual({
      key: 'nhwebsite',
      organization: 'NHWebsite',
      status: 'active',
      isDefault: false,
      values: { organization: 'NHWebsite', backfillDays: 30 },
      secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      inheritedRefs: ['tokenRef'],
      audit,
      digest: 'collecting',
    });
  });
});
```

Run: `cd backend && npx jest src/modules/configurations/github-organizations.view.spec.ts` → FAIL.

- [ ] **Step 2: Implement**

In `configurations.controller.ts` (module level, exported):

```ts
export interface GithubOrganizationView {
  key: string;
  organization: string;
  status: 'active' | 'disabled';
  isDefault: boolean;
  values: Record<string, unknown>;
  /** Effective ref NAMES — never secret values. */
  secretRefs: Record<string, string>;
  inheritedRefs: string[];
  audit: AuditStatus;
  digest: 'included' | 'collecting' | 'disabled';
}

export function toOrganizationView(
  org: GithubOrg,
  audit: AuditStatus,
  digest: 'included' | 'collecting' | 'disabled',
): GithubOrganizationView {
  return {
    key: org.key,
    organization: org.organization,
    status: org.active ? 'active' : 'disabled',
    isDefault: org.isDefault,
    values: org.values,
    secretRefs: org.secretRefs,
    inheritedRefs: org.inheritedRefs,
    audit,
    digest,
  };
}
```

(import `AuditStatus` from the audit sync service, `GithubOrg` from `github-orgs`), and the route:

```ts
  /**
   * Every configured GitHub organisation (ADR-0013) with its effective token
   * ref names, audit-route status and whether the digest includes it yet.
   * Read-only; never resolves or returns a secret value.
   */
  @Roles(Role.ADMIN)
  @Get('github/organizations')
  async githubOrganizations(@CurrentUser() user: AuthUser) {
    const orgs = await loadGithubOrgs(this.prisma, { tenantId: user.tenantId });
    const inclusion = await this.auditSync.digestInclusion(user.tenantId);
    const organizations: GithubOrganizationView[] = [];
    for (const org of orgs) {
      const audit = await this.auditSync.status(
        user.tenantId,
        undefined,
        undefined,
        org.organization,
      );
      organizations.push(
        toOrganizationView(org, audit, inclusion.get(org.organization) ?? 'disabled'),
      );
    }
    return { organizations };
  }
```

Frontend `types.ts` — add:

```ts
/** `GET /api/admin/configurations/github/organizations` (ADR-0013). */
export interface GithubOrganization {
  key: string;
  organization: string;
  status: 'active' | 'disabled';
  isDefault: boolean;
  values: Record<string, unknown>;
  /** Effective ref names — never values. */
  secretRefs: Record<string, string>;
  inheritedRefs: string[];
  audit: {
    organization: string | null;
    mode: string;
    enabled: boolean;
    lagMinutes: number | null;
    behind: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    pendingRanges: number;
    failedRanges: number;
  };
  digest: 'included' | 'collecting' | 'disabled';
}
```

- [ ] **Step 3: Run**

Run: `cd backend && npx jest src/modules/configurations && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/configurations frontend/src/lib/api/types.ts
git commit -m "feat(config): list GitHub organisations with audit status and digest inclusion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Admin UI — Additional organisations panel and Sync Status rows

**Files:**
- Create: `frontend/src/modules/admin/github-organizations-logic.ts`, `github-organizations-logic.test.ts`
- Create: `frontend/src/modules/admin/GithubOrganizationsPanel.tsx`
- Create: `frontend/src/modules/admin/AuditOrgStatusList.tsx`
- Modify: `frontend/src/modules/admin/AdminConfigurationsPage.tsx` (GitHub block ~585; organization input)
- Modify: `frontend/src/modules/admin/SyncStatusPage.tsx` (below `<AuditRoutePanel />`)

**Interfaces:**
- Consumes: `GithubOrganization` (Task 9); `PUT /api/admin/configurations`; `POST github/sync-org { organization }`.
- Produces: `validateOrgLogin(login: string, existing: string[]): string | null`, `orgPayload(draft: OrgDraft): UpsertConfigurationPayload`, `inheritedPlaceholder(ref: string, defaultOrg: GithubOrganization | undefined): string`, `type OrgDraft`.

- [ ] **Step 1: Failing logic tests**

`github-organizations-logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inheritedPlaceholder, orgPayload, validateOrgLogin } from './github-organizations-logic';

describe('validateOrgLogin', () => {
  it('accepts a GitHub login not yet configured', () => {
    expect(validateOrgLogin('NHWebsite', ['athmahealth'])).toBeNull();
  });
  it('rejects invalid logins and duplicates (case-insensitive)', () => {
    expect(validateOrgLogin('not a login', [])).toMatch(/GitHub login/);
    expect(validateOrgLogin('', [])).toMatch(/GitHub login/);
    expect(validateOrgLogin('AthmaHealth', ['athmahealth'])).toMatch(/already configured/);
  });
});

describe('orgPayload', () => {
  it('keys the row by the lowercased login and drops blank refs (they inherit)', () => {
    expect(
      orgPayload({
        organization: 'NHWebsite',
        tokenRef: 'GITHUB_TOKEN_NHWEBSITE',
        auditLogTokenRef: '',
        copilotMetricsTokenRef: '',
        backfillDays: '30',
        syncIntervalMinutes: '',
        enabled: true,
      }),
    ).toEqual({
      namespace: 'github',
      key: 'nhwebsite',
      values: { organization: 'NHWebsite', backfillDays: 30 },
      secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
      status: 'active',
    });
  });
});

describe('inheritedPlaceholder', () => {
  it("names the default organisation's ref", () => {
    const def = { organization: 'athmahealth', secretRefs: { tokenRef: 'GITHUB_TOKEN' } } as never;
    expect(inheritedPlaceholder('tokenRef', def)).toBe('blank = GITHUB_TOKEN from athmahealth');
    expect(inheritedPlaceholder('copilotMetricsTokenRef', def)).toBe('blank = not set');
  });
});
```

Run: `cd frontend && npx vitest run src/modules/admin/github-organizations-logic.test.ts` → FAIL.

- [ ] **Step 2: Implement the logic**

`github-organizations-logic.ts`:

```ts
import type { GithubOrganization, UpsertConfigurationPayload } from '../../lib/api/types';

/** Mirrors the backend's GITHUB_LOGIN_PATTERN (github-orgs.ts). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const ORG_REF_FIELDS = [
  { key: 'tokenRef', label: 'Token secret ref' },
  { key: 'auditLogTokenRef', label: 'Audit-log token secret ref' },
  { key: 'copilotMetricsTokenRef', label: 'Copilot metrics token secret ref' },
] as const;

export interface OrgDraft {
  organization: string;
  tokenRef: string;
  auditLogTokenRef: string;
  copilotMetricsTokenRef: string;
  backfillDays: string;
  syncIntervalMinutes: string;
  enabled: boolean;
}

export function emptyOrgDraft(): OrgDraft {
  return {
    organization: '',
    tokenRef: '',
    auditLogTokenRef: '',
    copilotMetricsTokenRef: '',
    backfillDays: '',
    syncIntervalMinutes: '',
    enabled: true,
  };
}

/** A saved organisation as an editable draft: its OWN refs only, so inherited ones stay blank. */
export function draftOf(org: GithubOrganization): OrgDraft {
  const own = (k: string) =>
    org.inheritedRefs.includes(k) ? '' : (org.secretRefs[k] ?? '');
  const num = (v: unknown) => (typeof v === 'number' ? String(v) : '');
  return {
    organization: org.organization,
    tokenRef: own('tokenRef'),
    auditLogTokenRef: own('auditLogTokenRef'),
    copilotMetricsTokenRef: own('copilotMetricsTokenRef'),
    backfillDays: num(org.values.backfillDays),
    syncIntervalMinutes: num(org.values.syncIntervalMinutes),
    enabled: org.status === 'active',
  };
}

export function validateOrgLogin(login: string, existing: readonly string[]): string | null {
  const trimmed = login.trim();
  if (!LOGIN.test(trimmed)) return 'Enter the GitHub login of the organisation (letters, digits, hyphens).';
  if (existing.some((o) => o.toLowerCase() === trimmed.toLowerCase())) {
    return `GitHub organisation "${trimmed}" is already configured.`;
  }
  return null;
}

export function orgPayload(draft: OrgDraft): UpsertConfigurationPayload {
  const organization = draft.organization.trim();
  const values: Record<string, unknown> = { organization };
  for (const k of ['backfillDays', 'syncIntervalMinutes'] as const) {
    const n = Number(draft[k]);
    if (draft[k].trim() && Number.isFinite(n) && n > 0) values[k] = n;
  }
  const secretRefs: Record<string, string> = {};
  for (const { key } of ORG_REF_FIELDS) {
    const v = draft[key].trim();
    if (v) secretRefs[key] = v;
  }
  return {
    namespace: 'github',
    key: organization.toLowerCase(),
    values,
    secretRefs,
    status: draft.enabled ? 'active' : 'disabled',
  };
}

export function inheritedPlaceholder(ref: string, defaultOrg: GithubOrganization | undefined): string {
  const name = defaultOrg?.secretRefs[ref];
  return name ? `blank = ${name} from ${defaultOrg.organization}` : 'blank = not set';
}
```

If `UpsertConfigurationPayload` in `types.ts` lacks `status` or types `namespace` as `ConfigurationNamespace`, the literal `'github'` satisfies it; if `status` is missing from the type, add `status?: 'active' | 'disabled';` to it.

Re-run the test → PASS.

- [ ] **Step 3: The panel**

`GithubOrganizationsPanel.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';
import type { GithubOrganization } from '../../lib/api/types';
import { Badge, Button, Field, Input } from '../../components/ui';
import {
  draftOf,
  emptyOrgDraft,
  inheritedPlaceholder,
  ORG_REF_FIELDS,
  orgPayload,
  validateOrgLogin,
  type OrgDraft,
} from './github-organizations-logic';

const ORGS_KEY = ['admin', 'configurations', 'github-organizations'];

export function useGithubOrganizations() {
  return useQuery({
    queryKey: ORGS_KEY,
    queryFn: () =>
      api.get<{ organizations: GithubOrganization[] }>(
        '/api/admin/configurations/github/organizations',
      ),
  });
}

const DIGEST_LABEL: Record<GithubOrganization['digest'], string> = {
  included: 'In the daily digest',
  collecting: 'Collecting — joins the digest after its first full sweep',
  disabled: 'Disabled',
};

/**
 * Organisations beyond the first (ADR-0013). The first organisation keeps
 * its own form above; each one here is a separate configuration row, so
 * saving or syncing it never changes the first one.
 */
export function GithubOrganizationsPanel() {
  const orgs = useGithubOrganizations();
  const [adding, setAdding] = useState(false);
  const all = orgs.data?.organizations ?? [];
  const defaultOrg = all.find((o) => o.isDefault);
  const others = all.filter((o) => !o.isDefault);

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">
          <strong className="text-fg-secondary">Additional organisations.</strong>{' '}
          Each is collected on its own; adding one never changes{' '}
          {defaultOrg?.organization ?? 'the first organisation'}. Blank token refs use the first
          organisation&apos;s.
        </p>
        {!adding ? (
          <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
            Add organisation
          </Button>
        ) : null}
      </div>
      {others.map((org) => (
        <OrgEditor
          key={org.key}
          initial={draftOf(org)}
          saved={org}
          defaultOrg={defaultOrg}
          existing={all.map((o) => o.organization)}
        />
      ))}
      {adding ? (
        <OrgEditor
          initial={emptyOrgDraft()}
          defaultOrg={defaultOrg}
          existing={all.map((o) => o.organization)}
          onDone={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function OrgEditor({
  initial,
  saved,
  defaultOrg,
  existing,
  onDone,
}: {
  initial: OrgDraft;
  saved?: GithubOrganization;
  defaultOrg: GithubOrganization | undefined;
  existing: string[];
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OrgDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof OrgDraft, v: string | boolean) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.put('/api/admin/configurations', orgPayload(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'configurations'] });
      onDone?.();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed.'),
  });
  const sync = useMutation({
    mutationFn: () =>
      api.post<{ reposFound: number; created: number; updated: number; skipped: number; rateLimited: boolean }>(
        '/api/admin/configurations/github/sync-org',
        { organization: saved?.organization },
      ),
  });

  const onSave = () => {
    const problem = saved ? null : validateOrgLogin(draft.organization, existing);
    setError(problem);
    if (!problem) save.mutate();
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-fg">{saved?.organization ?? 'New organisation'}</strong>
        {saved ? <Badge tone={saved.digest === 'included' ? 'success' : 'neutral'}>{DIGEST_LABEL[saved.digest]}</Badge> : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Organization">
          <Input
            value={draft.organization}
            readOnly={!!saved}
            disabled={!!saved}
            placeholder="GitHub login, e.g. NHWebsite"
            onChange={(e) => set('organization', e.target.value)}
          />
        </Field>
        {ORG_REF_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input
              value={draft[f.key]}
              placeholder={inheritedPlaceholder(f.key, defaultOrg)}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </Field>
        ))}
        <Field label="Backfill window (days)">
          <Input value={draft.backfillDays} inputMode="numeric" placeholder="90" onChange={(e) => set('backfillDays', e.target.value)} />
        </Field>
        <Field label="Sync interval (minutes)">
          <Input value={draft.syncIntervalMinutes} inputMode="numeric" onChange={(e) => set('syncIntervalMinutes', e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-fg-secondary">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} className="h-3.5 w-3.5 rounded border-border-strong" />
        Enabled
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save organisation'}
        </Button>
        {saved ? (
          <Button type="button" variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending || saved.status !== 'active'}>
            {sync.isPending ? 'Syncing…' : 'Sync org'}
          </Button>
        ) : null}
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        ) : null}
        {sync.data ? (
          <p className="text-xs text-fg-subtle">
            Found {sync.data.reposFound} · created {sync.data.created} · already registered {sync.data.updated} · skipped {sync.data.skipped}
            {sync.data.rateLimited ? ' — stopped early on the GitHub rate limit; run again to continue.' : ''}
          </p>
        ) : null}
        {sync.isError ? (
          <p className="text-xs text-danger-fg">{sync.error instanceof ApiError ? sync.error.message : 'Organisation sync failed.'}</p>
        ) : null}
        {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
      </div>
    </div>
  );
}
```

Check the primitives' prop names before compiling: `Badge` tones (`grep -n "tone" frontend/src/components/ui/badge.tsx`) and `Button` variants (`grep -n "variant" frontend/src/components/ui/button.tsx`); use the nearest existing names if `success`/`ghost` differ.

- [ ] **Step 4: Mount the panel; lock the saved Organization**

In `AdminConfigurationsPage.tsx`, import `GithubOrganizationsPanel`, and directly after the closing `</div>` of the GitHub sync-org block (the `{selected.namespace === 'github' ? ( <div className="space-y-2 rounded-md …"> … </div> ) : null}` block) add:

```tsx
            {selected.namespace === 'github' ? <GithubOrganizationsPanel /> : null}
```

In the generic field renderer, for the text `Input` of each field, add:

```tsx
                      readOnly={selected.namespace === 'github' && field.key === 'organization' && !!savedSnapshots.github?.draft.organization}
```

(and the same expression on `disabled`), so the first organisation's login cannot be edited once saved — the backend rejects it anyway (Task 2).

- [ ] **Step 5: Sync Status rows**

`AuditOrgStatusList.tsx`:

```tsx
import { Badge } from '../../components/ui';
import { useGithubOrganizations } from './GithubOrganizationsPanel';

/**
 * One compact audit-route row per additional GitHub organisation (ADR-0013).
 * The panel above stays the first organisation's; with one organisation this
 * renders nothing.
 */
export function AuditOrgStatusList() {
  const orgs = useGithubOrganizations();
  const others = (orgs.data?.organizations ?? []).filter((o) => !o.isDefault);
  if (others.length === 0) return null;
  return (
    <div className="space-y-2">
      {others.map((o) => (
        <div key={o.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-xs text-fg-secondary">
          <strong className="text-sm text-fg">{o.organization}</strong>
          <Badge tone={o.audit.enabled ? 'neutral' : 'warn'}>
            {o.audit.enabled ? `audit route ${o.audit.mode}` : 'audit route off'}
          </Badge>
          <Badge tone={o.digest === 'included' ? 'success' : 'neutral'}>{o.digest}</Badge>
          {o.audit.lagMinutes !== null ? <span>{o.audit.lagMinutes} min behind{o.audit.behind ? ' — lagging' : ''}</span> : null}
          {o.audit.lastStatus ? <span>last run: {o.audit.lastStatus}</span> : null}
          {o.audit.pendingRanges + o.audit.failedRanges > 0 ? (
            <span>{o.audit.pendingRanges} pending · {o.audit.failedRanges} failed</span>
          ) : null}
          {o.audit.lastError ? <span className="basis-full text-danger-fg">{o.audit.lastError}</span> : null}
        </div>
      ))}
    </div>
  );
}
```

In `SyncStatusPage.tsx` import it and render `<AuditOrgStatusList />` immediately after `<AuditRoutePanel />`.

- [ ] **Step 6: Verify**

Run: `cd frontend && npx vitest run src/modules/admin && npm run lint && npm run build`
Expected: tests PASS, lint clean, build succeeds. `grep -rnE "(slate|emerald|gray|red|green|amber)-[0-9]" frontend/src/modules/admin/GithubOrganizationsPanel.tsx frontend/src/modules/admin/AuditOrgStatusList.tsx` → no output.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(admin): add and sync additional GitHub organisations; per-org audit rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation and decisions

**Files:**
- Create: `docs/ADR/0013-multiple-github-organisations.md`
- Modify: `docs/ADR/0009-attributed-commit-digest.md`, `docs/ADR/0012-per-developer-copilot-usage.md`, `docs/ADR/README.md`
- Modify: `CLAUDE.md`, `AGENTS.md` (identical amendments)
- Modify: `docs/api/README.md`, `docs/features/DASHBOARDS.md`, `docs/deployment/README.md`, `docs/architecture/PRODUCT-ARCHITECTURE.md`
- Modify or create: the GitHub runbook in `docs/runbooks/` (check `ls docs/runbooks`; add a section to an existing GitHub/collector runbook if one exists, otherwise create `docs/runbooks/add-github-organisation.md`)

- [ ] **Step 1: ADR-0013**

Follow the structure of `docs/ADR/0012-per-developer-copilot-usage.md` (Status / Context / Decision / Consequences). Content: Status Accepted 2026-11-16. Context: §2 of the spec (single `github/default` row, the five readers, the sweep leak, the bridge hazard). Decision: one row per org (`github/<lowercased login>`), immutable organisation, ref inheritance, `github-orgs.ts` as the only reader, per-org checkpoint + run claim + runs, scheduler sequential per org, ranges/report tenant-wide, inclusion rule, oldest-checkpoint readers. Consequences: adding an org is additive; one org's failure is contained except the digest gate (deliberate, fails closed); tunables global; manual runs of two orgs may overlap (safe — per-run budget).

- [ ] **Step 2: ADR amendments**

ADR-0009, new "Amendment 2026-11-16" section: "The digest and its admin-only Watchlist view cover every *included* GitHub organisation of the tenant (ADR-0013), decided by the product owner on 2026-11-16. A tracked developer counts as active with a qualifying commit in any included organisation. The rule (`activeDeveloperSet`, `DIGEST_RULE_TEXT`), suppressions, alphabetical order, withhold gates, run records and audit are unchanged; the card's lead-in names every included organisation; the gate requires every included organisation to be covered; the Watchlist adds a scope line when more than one organisation is included. A newly added organisation joins once its first seeding and full sweep complete."

ADR-0012, "Amendment 2026-11-16": "Copilot usage is collected per GitHub organisation (ADR-0013). The column combines a person's usage across organisations — active days are the union of days, lines are summed, a seat in any organisation counts — and its freshness is the furthest-behind organisation's newest report day; the caption names the organisations when more than one reports. Nothing else changes: never ordered or filtered by, never feeds the grade, digest, Watchlist or notifications."

Add ADR-0013 to `docs/ADR/README.md`'s index.

- [ ] **Step 3: CLAUDE.md and AGENTS.md (same text in both)**

At the end of the ADR-0009 exception paragraph (after the "Amended 2026-11-04" sentence), append: `**Amended 2026-11-16 (same ADR, [ADR-0013](docs/ADR/0013-multiple-github-organisations.md)):** the digest and Watchlist cover every included GitHub organisation of the tenant as one list; the rule, suppressions, order, gates, run records and audit are unchanged, and the card names every included organisation.`

At the end of the ADR-0012 exception paragraph, append: `**Amended 2026-11-16 (same ADR):** the column combines a person's usage across the tenant's GitHub organisations (union of days, sum of lines, seat in any) and shows the furthest-behind organisation's freshness.`

Run `diff <(sed -n '/Metrics are ethics-first/,/Lineage is mandatory/p' CLAUDE.md) <(sed -n '/Metrics are ethics-first/,/Lineage is mandatory/p' AGENTS.md)` → no output.

- [ ] **Step 4: Canonical docs**

- `docs/api/README.md`: in the configurations/admin section document `GET github/organizations` (response shape from Task 9), the optional `organization` on `POST github/sync-org`, `POST github/audit-sync/run`, `GET github/audit-sync/status`, `POST github/copilot-sync` (omitted = first organisation), the new 400s (organisation immutable, duplicate login, key ≠ lowercased login, default repo on an additional row), and that `PUT /` accepts `github/<login>` keys with inheritable refs. In §12 gap register, add a resolved entry: "Second GitHub organisation could not be added without re-pointing the first (2026-11-16) — resolved by ADR-0013."
- `docs/features/DASHBOARDS.md`: Watchlist scope line; Copilot caption across organisations; digest lead-in naming organisations.
- `docs/deployment/README.md`: per-organisation token refs and inheritance; a fine-grained PAT covers one organisation (use one per organisation, e.g. `GITHUB_TOKEN_NHWEBSITE`) or one classic PAT SSO-authorized for all; the audit-log token must belong to an owner of each organisation and be SSO-authorized for it; env tunables apply to every organisation.
- Runbook "Add a GitHub organisation": (1) create/authorize tokens, set env vars, restart; (2) Admin → Configurations → GitHub → Additional organisations → Add organisation, login + refs (blank inherits), Save; (3) Sync org; (4) watch Sync Status until the org shows `included`; (5) add newly visible developers to Tracked Developers only after their identities appear; merge Jira/email identities that did not auto-link; (6) rollback: untick Enabled.
- `docs/architecture/PRODUCT-ARCHITECTURE.md`: in the Collector (BC-1) GitHub section, one paragraph: organisations are configuration rows read through `github-orgs.ts`; org-wide jobs run per organisation with per-organisation audit state.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md AGENTS.md
git commit -m "docs: ADR-0013 multiple GitHub organisations; ADR-0009/0012 amendments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification

- [ ] **Step 1: Backend suite, build, lint**

```bash
cd backend
npx jest
rm -rf dist && npm run build
npm run lint 2>&1 | grep -v "Delete \`␍\`" | tail -40
```

Expected: all suites PASS; build succeeds; no new lint errors in files this plan touched.

- [ ] **Step 2: Frontend suite, lint, build**

```bash
cd frontend && npm test && npm run lint && npm run build
```

Expected: PASS.

- [ ] **Step 3: Leftover single-org readers**

```bash
cd backend && grep -rn "key: 'default'" src --include=*.ts | grep -v "spec.ts\|fakes.ts"
```

Expected: only `configurations` bridge/default-row code and `github-orgs.ts` constants — no collector or notification reader of `github/default` remains. Investigate any other hit.

- [ ] **Step 4: Local single-org regression**

With the local stack running (check who serves :5173 first): `npx prisma migrate status` → up to date. As an admin, compare before/after on athmahealth only: Sync Status audit panel (same lag/status/ranges), `GET /api/admin/configurations/github/audit-sync/status` (same fields plus `organization: "athmahealth"`), and a digest dry run (`grep -rn "dryRun" src/modules/notifications/digest-admin.controller.ts` for the route) → identical outcome and card text to a dry run taken on `main` before this branch.

- [ ] **Step 5: Local second-org smoke test**

Add `NHWebsite` in the new panel with blank refs → saves; `GET github/organizations` lists it as `collecting`, inherited refs shown. Sync org → with the current token it returns `reposFound: 0` (GitHub's empty 200) — record that, it is the token-authorization prerequisite, not a bug. athmahealth's audit status, checkpoint row (`collectors_github_audit_checkpoint` where organization = 'athmahealth') and bridged connection are unchanged.

- [ ] **Step 6: Report**

Summarise: tests/build results, the regression comparison, and the doc updates; list remaining operator steps (tokens, Add organisation, tracked developers). Then use superpowers:finishing-a-development-branch.
