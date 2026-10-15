# GitHub Audit Log Commit Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover every git push in the GitHub org from the Audit Log, find the moved branches by branch-tip diff, fetch their commits through Compare, and ingest them through the existing pipeline. This is Phase 1 of closing gap #51 (branch-only commits).

**Architecture:** A new BC-1 sync runs on an env-configured cron per tenant. It fetches the complete audit-log window (following `Link rel="next"` verbatim) and stores each push as a raw `code.push.observed` event. For touched repos only, it diffs `matching-refs/heads` against stored tips, persists one `GithubPushRange` per moved ref, and then advances the checkpoint. Pending ranges are executed with bounded concurrency: Compare is paged to the end, and each commit is ingested with the same envelope and `github:{repo}:commit:{sha}` key the existing collectors mint.

**Tech Stack:** NestJS 10, TypeScript, Prisma/PostgreSQL, `@nestjs/schedule`, global `fetch`, Jest + ts-jest.

**Spec:** [docs/superpowers/specs/2026-10-06-github-audit-log-commit-discovery-design.md](../specs/2026-10-06-github-audit-log-commit-discovery-design.md)

## Global Constraints

- All new collector code lives under `backend/src/collectors/` (BC-1). No other context calls GitHub.
- Every commit goes through `IngestionService.ingest`. Never write to `code_commit`.
- The commit idempotency key is `github:${repoFullName}:commit:${sha}`; the push key is `github:audit:${documentId}`.
- Every query and row carries `tenantId`. There are no cross-tenant reads.
- Never log or store the token, the `Authorization` header, `after`/`before` cursors, `actor_location`, `hashed_token`, `token_id` or `user_agent`. URLs are logged as `origin + pathname` only.
- The audit request is `GET /orgs/{org}/audit-log?include=git&phrase=action:git.push created:>={ISO}&order=desc&per_page={size}`, with `per_page` defaulting to 100.
- Every follow-on page is the URL from `Link: <…>; rel="next"`, used verbatim. Assert the origin is `https://api.github.com` before sending a token.
- Modes are `off` | `shadow` | `ingest`, defaulting to `off`. The interval is one of 5, 10, 15, 20, 30, 60 minutes, defaulting to 5.
- There is no unbounded `Promise.all` over Compare calls. Use `forEachBounded`.
- Respect `evaluateBudget` (`GITHUB_BACKFILL_RATE_RESERVE`) on the `core` bucket.
- Unresolved authors stay unattributed and are never treated as idle. No new identity logic.
- No git mirror code.
- Lint gate: `cd backend && npx eslint <files> 2>&1 | grep -v 'Delete \`␍\`'`, zero errors. Typecheck: `npx tsc --noEmit -p tsconfig.json`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The digest stays off (`dailyDigestEnabled:false`). Do not touch notification behaviour.

## File Map

| File | Responsibility |
|---|---|
| `backend/src/collectors/sources/github/github-link.ts` (new) | Pure `Link` header parsing and safe-origin check |
| `backend/src/common/concurrency.ts` (new) | `forEachBounded`, extracted from the scheduler |
| `backend/src/collectors/sources/github/github-audit.config.ts` (new) | Parses and validates every `GITHUB_AUDIT_*` env var; builds the cron expression |
| `backend/src/config/env.validation.ts` (mod) | Boot validation for the new vars |
| `backend/src/collectors/sources/github/github-audit-log.client.ts` (new) | Audit-log REST: complete pagination, 403 classification, typed events |
| `backend/src/collectors/sources/github/github.client.ts` (mod) | `listHeadRefs`, `getDefaultBranch`, `compareAll` |
| `backend/src/collectors/sources/github/github-commit-envelope.ts` (new) | Single builder for `code.commit.pushed` envelopes |
| `backend/src/collectors/sources/github/github-audit-push-planner.ts` (new) | Pure dedupe, touched repos and tip diff |
| `backend/prisma/schema.prisma` + migration (mod/new) | 4 tables |
| `backend/src/collectors/sources/github/github-audit-sync.service.ts` (new) | Orchestrates a tenant run |
| `backend/src/collectors/scheduler/github-audit-scheduler.service.ts` (new) | Cron and running guard |
| `backend/src/collectors/sources/github/github-audit-report.service.ts` (new) | IST-day aggregation |
| `backend/src/modules/configurations/*` (mod) | Secret-ref field and 2 admin endpoints |
| Docs (mod/new) | ADR-0010, architecture, data model, api README, deployment, notifications, `.env.example` |

Run all backend commands from `backend/`. Run single tests with `npx jest <path> -t "<name>"`.

---

### Task 1: Link parsing and bounded concurrency utilities

**Files:**
- Create: `backend/src/collectors/sources/github/github-link.ts`
- Create: `backend/src/collectors/sources/github/github-link.spec.ts`
- Create: `backend/src/common/concurrency.ts`
- Create: `backend/src/common/concurrency.spec.ts`
- Modify: `backend/src/collectors/scheduler/collector-scheduler.service.ts` (remove the private `forEachBounded` at ~line 215 and use the shared one)

**Interfaces:**
- Produces: `nextLinkUrl(linkHeader: string | null): string | undefined`, `isGithubApiUrl(url: string): boolean`, `redactUrl(url: string): string`, `forEachBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`github-link.spec.ts`:
```ts
import { isGithubApiUrl, nextLinkUrl, redactUrl } from './github-link';

describe('github-link', () => {
  it('returns the rel="next" URL verbatim, including cursors', () => {
    const header =
      '<https://api.github.com/organizations/96329559/audit-log?include=git&phrase=action%3Agit.push&order=desc&per_page=100&after=abc%3D%3D&before=>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextLinkUrl(header)).toBe(
      'https://api.github.com/organizations/96329559/audit-log?include=git&phrase=action%3Agit.push&order=desc&per_page=100&after=abc%3D%3D&before=',
    );
  });

  it('returns undefined when there is no next relation or no header', () => {
    expect(nextLinkUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
    expect(nextLinkUrl(null)).toBeUndefined();
    expect(nextLinkUrl('')).toBeUndefined();
  });

  it('accepts only https://api.github.com as a token-bearing origin', () => {
    expect(isGithubApiUrl('https://api.github.com/orgs/a/audit-log')).toBe(true);
    expect(isGithubApiUrl('https://evil.example.com/orgs/a')).toBe(false);
    expect(isGithubApiUrl('http://api.github.com/orgs/a')).toBe(false);
    expect(isGithubApiUrl('not a url')).toBe(false);
  });

  it('redacts the query string so cursors never reach a log', () => {
    expect(redactUrl('https://api.github.com/orgs/a/audit-log?after=SECRET')).toBe(
      'https://api.github.com/orgs/a/audit-log',
    );
    expect(redactUrl('garbage')).toBe('<invalid-url>');
  });
});
```

`concurrency.spec.ts`:
```ts
import { forEachBounded } from './concurrency';

describe('forEachBounded', () => {
  it('never runs more than `limit` at once and visits every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('drains every item before rethrowing the first error', async () => {
    const seen: number[] = [];
    await expect(
      forEachBounded([1, 2, 3], 1, async (n) => {
        seen.push(n);
        if (n === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/collectors/sources/github/github-link.spec.ts src/common/concurrency.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`github-link.ts`:
```ts
/**
 * GitHub pagination helpers shared by every client that must consume a result
 * set completely (audit log, compare). The `rel="next"` URL is returned
 * VERBATIM: GitHub rewrites it (the audit log moves from `/orgs/{login}` to
 * `/organizations/{id}` and adds opaque `after`/`before` cursors), so a URL
 * rebuilt by hand would not be the page GitHub meant.
 */
export function nextLinkUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** A token is only ever sent to GitHub's own API origin, whatever a Link header says. */
export function isGithubApiUrl(url: string): boolean {
  try {
    return new URL(url).origin === 'https://api.github.com';
  } catch {
    return false;
  }
}

/** For logs: origin + path only. Query strings carry cursors and search phrases. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
```

`concurrency.ts` (moved verbatim from `CollectorSchedulerService.forEachBounded`, now a free function):
```ts
/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * `allSettled` semantics without `allSettled`: every worker drains the queue
 * even after a failure, then the first error is rethrown, so a caller's
 * `finally` never runs while work is still in flight. Errors are caught per
 * ITEM so one bad item costs one item, not the rest of the queue.
 */
export async function forEachBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  // Safe without a lock: the read-and-increment is synchronous.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      try {
        await fn(items[next++]);
      } catch (err) {
        firstError ??= err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
}
```

In `collector-scheduler.service.ts`: add `import { forEachBounded } from '../../common/concurrency';`, replace `await this.forEachBounded(due, SWEEP_CONCURRENCY, async (connection) => {` with `await forEachBounded(due, SWEEP_CONCURRENCY, async (connection) => {`, and delete the private method together with its doc comment.

- [ ] **Step 4: Run the tests, including the scheduler's own spec**

Run: `npx jest src/collectors/sources/github/github-link.spec.ts src/common/concurrency.spec.ts src/collectors/scheduler/collector-scheduler.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github-link.ts backend/src/collectors/sources/github/github-link.spec.ts backend/src/common/concurrency.ts backend/src/common/concurrency.spec.ts backend/src/collectors/scheduler/collector-scheduler.service.ts
git commit -m "refactor(collectors): share Link parsing and bounded concurrency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Audit sync configuration

**Files:**
- Create: `backend/src/collectors/sources/github/github-audit.config.ts`
- Create: `backend/src/collectors/sources/github/github-audit.config.spec.ts`
- Modify: `backend/src/config/env.validation.ts`
- Modify: `backend/src/config/env.validation.spec.ts`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `type GithubAuditMode = 'off' | 'shadow' | 'ingest'`; `interface GithubAuditConfig { mode; intervalMinutes; pageSize; overlapMinutes; compareConcurrency; maxRangeAttempts; maxPages }`; `readGithubAuditConfig(env?: NodeJS.ProcessEnv): GithubAuditConfig` (throws on invalid input); `auditCronExpression(intervalMinutes: number): string`; `ALLOWED_AUDIT_INTERVALS: readonly number[]`

- [ ] **Step 1: Write the failing tests**

`github-audit.config.spec.ts`:
```ts
import {
  auditCronExpression,
  readGithubAuditConfig,
} from './github-audit.config';

describe('readGithubAuditConfig', () => {
  it('defaults to off, every 5 minutes, 100 per page', () => {
    expect(readGithubAuditConfig({})).toEqual({
      mode: 'off',
      intervalMinutes: 5,
      pageSize: 100,
      overlapMinutes: 15,
      compareConcurrency: 2,
      maxRangeAttempts: 5,
      maxPages: 200,
    });
  });

  it.each([5, 10, 15, 20, 30, 60])('accepts a %i-minute interval', (n) => {
    expect(
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: String(n) })
        .intervalMinutes,
    ).toBe(n);
  });

  it('rejects an interval outside the allowed set', () => {
    expect(() =>
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '7' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_INTERVAL_MINUTES/);
  });

  it('rejects an unknown mode and accepts shadow/ingest case-insensitively', () => {
    expect(() => readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'on' })).toThrow(
      /GITHUB_AUDIT_SYNC_MODE/,
    );
    expect(readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'Shadow' }).mode).toBe('shadow');
    expect(readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' }).mode).toBe('ingest');
  });

  it('bounds page size to 1..100', () => {
    expect(() => readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '101' })).toThrow();
    expect(readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '50' }).pageSize).toBe(50);
  });

  it('treats empty strings as unset', () => {
    expect(readGithubAuditConfig({ GITHUB_AUDIT_PAGE_SIZE: '' }).pageSize).toBe(100);
  });
});

describe('auditCronExpression', () => {
  it('builds a seconds-precision cron for each interval', () => {
    expect(auditCronExpression(5)).toBe('0 */5 * * * *');
    expect(auditCronExpression(30)).toBe('0 */30 * * * *');
    expect(auditCronExpression(60)).toBe('0 0 * * * *');
  });
});
```

Append to `env.validation.spec.ts` (follow the file's existing `validateEnv` calls and base-env fixture; if the fixture is named differently, use that name):
```ts
describe('GitHub audit sync env', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 's' };
  it('fails boot on an invalid audit interval', () => {
    expect(() =>
      validateEnv({ ...base, GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '7' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_INTERVAL_MINUTES/);
  });
  it('fails boot on an invalid audit mode', () => {
    expect(() => validateEnv({ ...base, GITHUB_AUDIT_SYNC_MODE: 'yes' })).toThrow(
      /GITHUB_AUDIT_SYNC_MODE/,
    );
  });
  it('accepts valid audit settings', () => {
    expect(() =>
      validateEnv({
        ...base,
        GITHUB_AUDIT_SYNC_MODE: 'shadow',
        GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '15',
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/collectors/sources/github/github-audit.config.spec.ts src/config/env.validation.spec.ts`
Expected: FAIL. The module is missing, and validateEnv does not yet throw.

- [ ] **Step 3: Implement**

`github-audit.config.ts`:
```ts
/**
 * Every tunable of the GitHub audit-log sync, parsed in ONE place (spec §4.7).
 * Invalid values throw — `validateEnv` calls this at boot, so a typo fails the
 * deploy instead of silently running at a default the operator didn't choose.
 */
export type GithubAuditMode = 'off' | 'shadow' | 'ingest';

export const ALLOWED_AUDIT_INTERVALS = [5, 10, 15, 20, 30, 60] as const;

export interface GithubAuditConfig {
  mode: GithubAuditMode;
  intervalMinutes: number;
  pageSize: number;
  overlapMinutes: number;
  compareConcurrency: number;
  maxRangeAttempts: number;
  maxPages: number;
}

function intIn(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name} "${raw}". Expected an integer ${min}–${max}.`);
  }
  return n;
}

export function readGithubAuditConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubAuditConfig {
  const rawMode = (env.GITHUB_AUDIT_SYNC_MODE ?? '').trim().toLowerCase();
  const mode = (rawMode === '' ? 'off' : rawMode) as GithubAuditMode;
  if (!['off', 'shadow', 'ingest'].includes(mode)) {
    throw new Error(
      `Invalid GITHUB_AUDIT_SYNC_MODE "${env.GITHUB_AUDIT_SYNC_MODE}". Expected off | shadow | ingest.`,
    );
  }
  const intervalMinutes = intIn(env, 'GITHUB_AUDIT_SYNC_INTERVAL_MINUTES', 5, 1, 60);
  if (!(ALLOWED_AUDIT_INTERVALS as readonly number[]).includes(intervalMinutes)) {
    throw new Error(
      `Invalid GITHUB_AUDIT_SYNC_INTERVAL_MINUTES "${intervalMinutes}". Expected one of ${ALLOWED_AUDIT_INTERVALS.join(', ')}.`,
    );
  }
  return {
    mode,
    intervalMinutes,
    pageSize: intIn(env, 'GITHUB_AUDIT_PAGE_SIZE', 100, 1, 100),
    overlapMinutes: intIn(env, 'GITHUB_AUDIT_OVERLAP_MINUTES', 15, 0, 120),
    compareConcurrency: intIn(env, 'GITHUB_AUDIT_COMPARE_CONCURRENCY', 2, 1, 8),
    maxRangeAttempts: intIn(env, 'GITHUB_AUDIT_MAX_RANGE_ATTEMPTS', 5, 1, 20),
    maxPages: intIn(env, 'GITHUB_AUDIT_MAX_PAGES', 200, 1, 1000),
  };
}

/** Six-field (seconds-first) cron, as `@nestjs/schedule` accepts. 60 ⇒ top of every hour. */
export function auditCronExpression(intervalMinutes: number): string {
  return intervalMinutes === 60 ? '0 0 * * * *' : `0 */${intervalMinutes} * * * *`;
}
```

In `env.validation.ts`, add `import { readGithubAuditConfig } from '../collectors/sources/github/github-audit.config';`. Then, in `validateEnv`, before `plainToInstance`, insert:
```ts
  // Parsed by the same function the sync uses, so boot and runtime can never
  // disagree about what a value means.
  try {
    readGithubAuditConfig(config as NodeJS.ProcessEnv);
  } catch (err) {
    throw new Error(`Environment validation failed:\n  - ${(err as Error).message}`);
  }
```

Append to `backend/.env.example`:
```
# --- GitHub audit-log push discovery (ADR-0010) ---
# Org-owner classic PAT with read:audit_log, SSO-authorized for the org.
# Referenced from the GitHub configuration's "Audit-log token secret ref".
GITHUB_AUDIT_TOKEN=
# off | shadow | ingest (default off)
GITHUB_AUDIT_SYNC_MODE=
# 5 | 10 | 15 | 20 | 30 | 60 (default 5)
GITHUB_AUDIT_SYNC_INTERVAL_MINUTES=
# 1-100 (default 100)
GITHUB_AUDIT_PAGE_SIZE=
# 0-120 (default 15) — re-read window to catch late-surfacing audit events
GITHUB_AUDIT_OVERLAP_MINUTES=
# 1-8 (default 2)
GITHUB_AUDIT_COMPARE_CONCURRENCY=
# 1-20 (default 5)
GITHUB_AUDIT_MAX_RANGE_ATTEMPTS=
# 1-1000 (default 200) — runaway guard; hitting it FAILS the run
GITHUB_AUDIT_MAX_PAGES=
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/collectors/sources/github/github-audit.config.spec.ts src/config/env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit.config.ts backend/src/collectors/sources/github/github-audit.config.spec.ts backend/src/config/env.validation.ts backend/src/config/env.validation.spec.ts backend/.env.example
git commit -m "feat(collectors): add validated GitHub audit sync configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Audit-log client with complete pagination

**Files:**
- Create: `backend/src/collectors/sources/github/github-audit-log.client.ts`
- Create: `backend/src/collectors/sources/github/github-audit-log.client.spec.ts`

**Interfaces:**
- Consumes: `nextLinkUrl`, `isGithubApiUrl`, `redactUrl` (Task 1)
- Produces:
```ts
export interface GitPushAuditEvent {
  documentId: string;            // `_document_id`
  timestamp: Date;               // `@timestamp` (epoch ms)
  repoFullName: string;          // `repo` (falls back to `repository`)
  actor?: string;                // `actor` — the PUSHER, never used for attribution
  externalIdentityUsername?: string;
  programmaticAccessType?: string;
  transportProtocolName?: string;
}
export type AuditFetchResult =
  | { status: 'complete'; events: GitPushAuditEvent[]; pages: number; nextTraversals: number; rateLimitRemaining?: number }
  | { status: 'failed' | 'forbidden' | 'rate_limited' | 'too_many_pages'; pages: number; message: string; resumeAt?: Date };
export function buildAuditLogUrl(org: string, windowFrom: Date, pageSize: number): string;
export function classifyForbidden(res: { status: number; headers: { get(n: string): string | null } }): 'rate_limited' | 'forbidden';
@Injectable() export class GithubAuditLogClient {
  listGitPushes(org: string, token: string, windowFrom: Date, pageSize: number, maxPages: number): Promise<AuditFetchResult>;
}
```

- [ ] **Step 1: Write the failing tests**

`github-audit-log.client.spec.ts`:
```ts
import {
  GithubAuditLogClient,
  buildAuditLogUrl,
  classifyForbidden,
} from './github-audit-log.client';

function res(opts: { status?: number; headers?: Record<string, string>; body?: unknown }) {
  const h = new Map(Object.entries(opts.headers ?? {}));
  return {
    ok: (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => opts.body ?? [],
  };
}

const push = (id: string, ms: number, repo = 'acme/ehr') => ({
  '@timestamp': ms,
  _document_id: id,
  action: 'git.push',
  actor: 'dev1',
  repo,
  repository: repo,
  hashed_token: 'SECRET',
  actor_location: { country_code: 'IN' },
  user_agent: 'git/2.4',
  transport_protocol_name: 'ssh',
});

const NEXT = (cursor: string) =>
  `<https://api.github.com/organizations/1/audit-log?include=git&per_page=100&after=${cursor}&before=>; rel="next"`;

describe('buildAuditLogUrl', () => {
  it('builds the verified request with per_page=100 and the window start', () => {
    expect(
      buildAuditLogUrl('athmahealth', new Date('2026-09-29T06:30:00.000Z'), 100),
    ).toBe(
      'https://api.github.com/orgs/athmahealth/audit-log?include=git&phrase=action%3Agit.push%20created%3A%3E%3D2026-09-29T06%3A30%3A00%2B00%3A00&order=desc&per_page=100',
    );
  });
});

describe('classifyForbidden', () => {
  it('reads remaining=0 or retry-after as a rate limit, anything else as forbidden', () => {
    expect(classifyForbidden(res({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }))).toBe('rate_limited');
    expect(classifyForbidden(res({ status: 403, headers: { 'retry-after': '60' } }))).toBe('rate_limited');
    expect(classifyForbidden(res({ status: 429 }))).toBe('rate_limited');
    expect(classifyForbidden(res({ status: 403, headers: { 'x-ratelimit-remaining': '1700' } }))).toBe('forbidden');
  });
});

describe('GithubAuditLogClient.listGitPushes', () => {
  const client = new GithubAuditLogClient();
  const from = new Date('2026-10-06T00:00:00Z');
  afterEach(() => jest.restoreAllMocks());

  it('returns one page when there is no next link', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ body: [push('a', 1)], headers: { 'x-ratelimit-remaining': '1749' } }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({ status: 'complete', pages: 1, nextTraversals: 0, rateLimitRemaining: 1749 });
    if (r.status === 'complete') {
      expect(r.events).toEqual([
        {
          documentId: 'a',
          timestamp: new Date(1),
          repoFullName: 'acme/ehr',
          actor: 'dev1',
          externalIdentityUsername: undefined,
          programmaticAccessType: undefined,
          transportProtocolName: 'ssh',
        },
      ]);
      expect(JSON.stringify(r.events)).not.toMatch(/SECRET|country_code|git\/2/);
    }
  });

  it('follows rel="next" verbatim across pages until it is absent', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(res({ body: [push('a', 3)], headers: { link: NEXT('c1') } }))
      .mockResolvedValueOnce(res({ body: [push('b', 2)], headers: { link: NEXT('c2') } }))
      .mockResolvedValueOnce(res({ body: [push('c', 1)] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({ status: 'complete', pages: 3, nextTraversals: 2 });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/organizations/1/audit-log?include=git&per_page=100&after=c1&before=',
    );
    expect(fetchMock.mock.calls[2][0]).toContain('after=c2');
    if (r.status === 'complete') expect(r.events.map((e) => e.documentId)).toEqual(['a', 'b', 'c']);
  });

  it('fails the whole fetch (no partial list) when page 3 errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(res({ body: [push('a', 3)], headers: { link: NEXT('c1') } }))
      .mockResolvedValueOnce(res({ body: [push('b', 2)], headers: { link: NEXT('c2') } }))
      .mockResolvedValueOnce(res({ status: 502 })) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('failed');
    expect(r).not.toHaveProperty('events');
    expect(r.pages).toBe(2);
  });

  it('reports a permission 403 as forbidden with a remediation message', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ status: 403, headers: { 'x-ratelimit-remaining': '1700' } }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('forbidden');
    if (r.status !== 'complete') expect(r.message).toMatch(/read:audit_log/);
  });

  it('reports a real rate limit with its reset time', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({ status: 'rate_limited', resumeAt: new Date(2_000_000_000_000) });
  });

  it('refuses to send the token to a next link on another origin', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      res({ body: [push('a', 1)], headers: { link: '<https://evil.example.com/x>; rel="next"' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails rather than stopping silently at the page ceiling', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ body: [push('a', 1)], headers: { link: NEXT('again') } }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 2);
    expect(r).toMatchObject({ status: 'too_many_pages', pages: 2 });
  });

  it('drops entries without a document id or repo instead of inventing keys', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ body: [{ action: 'git.push', '@timestamp': 1 }, push('ok', 2)] }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    if (r.status === 'complete') expect(r.events.map((e) => e.documentId)).toEqual(['ok']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-audit-log.client.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`github-audit-log.client.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { isGithubApiUrl, nextLinkUrl, redactUrl } from './github-link';

/**
 * One `git.push` from the org audit log (spec F2). Only fields seen in the live
 * response are read; network/token fields (`actor_location`, `hashed_token`,
 * `token_id`, `user_agent`) are dropped here so they can never be stored or
 * logged downstream. NOTE: GitHub sends NO ref and NO before/after SHA on this
 * event — the ref range comes from branch-tip diffing (planner).
 */
export interface GitPushAuditEvent {
  documentId: string;
  timestamp: Date;
  repoFullName: string;
  /** Who pushed. Never used for commit attribution — the commit author is. */
  actor?: string;
  externalIdentityUsername?: string;
  programmaticAccessType?: string;
  transportProtocolName?: string;
}

export type AuditFetchResult =
  | {
      status: 'complete';
      events: GitPushAuditEvent[];
      pages: number;
      nextTraversals: number;
      rateLimitRemaining?: number;
    }
  | {
      status: 'failed' | 'forbidden' | 'rate_limited' | 'too_many_pages';
      pages: number;
      message: string;
      resumeAt?: Date;
    };

interface HeaderBag {
  get(name: string): string | null;
}

export function buildAuditLogUrl(org: string, windowFrom: Date, pageSize: number): string {
  // `+00:00` rather than `Z`, matching the request verified against GitHub.
  const iso = windowFrom.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const phrase = encodeURIComponent(`action:git.push created:>=${iso}`);
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/audit-log?include=git&phrase=${phrase}&order=desc&per_page=${pageSize}`;
}

/**
 * A 403 is NOT always a rate limit (spec F8). Only an exhausted bucket or a
 * secondary limit (`retry-after`) is; everything else is a permission or SSO
 * refusal that waiting will never fix.
 */
export function classifyForbidden(res: { status: number; headers: HeaderBag }): 'rate_limited' | 'forbidden' {
  if (res.status === 429) return 'rate_limited';
  if (res.headers.get('retry-after')) return 'rate_limited';
  return res.headers.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'forbidden';
}

function resetAt(headers: HeaderBag): Date {
  const retry = Number(headers.get('retry-after') ?? NaN);
  if (!Number.isNaN(retry)) return new Date(Date.now() + retry * 1000);
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
  return Number.isNaN(reset) ? new Date(Date.now() + 60_000) : new Date(reset * 1000);
}

function toEvent(raw: Record<string, unknown>): GitPushAuditEvent | undefined {
  const documentId = typeof raw._document_id === 'string' ? raw._document_id : undefined;
  const repo =
    typeof raw.repo === 'string' ? raw.repo : typeof raw.repository === 'string' ? raw.repository : undefined;
  const ms = typeof raw['@timestamp'] === 'number' ? raw['@timestamp'] : undefined;
  if (!documentId || !repo || ms === undefined) {
    return undefined; // no stable key or no repo: dropped, never keyed on something invented
  }
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    documentId,
    timestamp: new Date(ms),
    repoFullName: repo,
    actor: str(raw.actor),
    externalIdentityUsername: str(raw.external_identity_username),
    programmaticAccessType: str(raw.programmatic_access_type),
    transportProtocolName: str(raw.transport_protocol_name),
  };
}

/**
 * GitHub Organization Audit Log, REST (spec §4.1–4.2). Uses its own `audit_log`
 * rate bucket (1,750/h) and its own org-owner token — never the collector's.
 * The result is all-or-nothing: a window is only usable once the LAST page
 * (no `rel="next"`) has been read.
 */
@Injectable()
export class GithubAuditLogClient {
  private readonly logger = new Logger(GithubAuditLogClient.name);

  async listGitPushes(
    org: string,
    token: string,
    windowFrom: Date,
    pageSize: number,
    maxPages: number,
  ): Promise<AuditFetchResult> {
    const events: GitPushAuditEvent[] = [];
    let url: string | undefined = buildAuditLogUrl(org, windowFrom, pageSize);
    let pages = 0;
    let rateLimitRemaining: number | undefined;

    while (url) {
      if (pages >= maxPages) {
        return {
          status: 'too_many_pages',
          pages,
          message: `Audit log still had more pages after ${maxPages}; raise GITHUB_AUDIT_MAX_PAGES or shorten the interval.`,
        };
      }
      if (!isGithubApiUrl(url)) {
        this.logger.error(`Refusing audit-log next link outside api.github.com: ${redactUrl(url)}`);
        return { status: 'failed', pages, message: 'Next link pointed outside api.github.com.' };
      }
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (res.status === 403 || res.status === 429) {
        const kind = classifyForbidden(res);
        return kind === 'rate_limited'
          ? { status: 'rate_limited', pages, message: 'Audit-log rate limit reached.', resumeAt: resetAt(res.headers) }
          : {
              status: 'forbidden',
              pages,
              message:
                'GitHub refused the audit log (403). The audit-log token must be an org-owner classic PAT with read:audit_log, SSO-authorized for the org.',
            };
      }
      if (!res.ok) {
        this.logger.warn(`Audit-log page failed (${res.status}): ${redactUrl(url)}`);
        return { status: 'failed', pages, message: `Audit-log page failed with HTTP ${res.status}.` };
      }
      const body = (await res.json()) as unknown;
      pages++;
      for (const raw of Array.isArray(body) ? body : []) {
        const e = toEvent(raw as Record<string, unknown>);
        if (e) events.push(e);
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      rateLimitRemaining = Number.isNaN(remaining) ? rateLimitRemaining : remaining;
      url = nextLinkUrl(res.headers.get('link'));
    }

    return { status: 'complete', events, pages, nextTraversals: pages - 1, rateLimitRemaining };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/collectors/sources/github/github-audit-log.client.spec.ts`
Expected: PASS. If the `buildAuditLogUrl` expectation differs only in encoding, keep the implementation and fix the expected string: `encodeURIComponent` turns `>=` into `%3E%3D`, which GitHub accepts. The test pins the format so it cannot drift.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit-log.client.ts backend/src/collectors/sources/github/github-audit-log.client.spec.ts
git commit -m "feat(collectors): add GitHub audit-log client with complete Link pagination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: REST client: branch tips, default branch, complete Compare

**Files:**
- Modify: `backend/src/collectors/sources/github/github.client.ts` (add 3 methods and their types; add an import of `nextLinkUrl`/`isGithubApiUrl`/`redactUrl` from `./github-link`)
- Create: `backend/src/collectors/sources/github/github-compare.client.spec.ts`

**Interfaces:**
- Consumes: `nextLinkUrl`, `isGithubApiUrl`, `redactUrl` (Task 1)
- Produces (exported from `github.client.ts`):
```ts
export type GithubCallFailure = 'not_found' | 'failed' | 'rate_limited' | 'forbidden';
export interface GithubHeadRefs { tips?: Map<string, string>; failure?: GithubCallFailure; rateLimit?: GithubRateLimit; resumeAt?: Date }
export interface GithubDefaultBranch { name?: string; failure?: GithubCallFailure; rateLimit?: GithubRateLimit; resumeAt?: Date }
export interface GithubCompareCommit { sha: string; message: string; authorLogin?: string; authorName?: string; authorEmail?: string; authoredAt?: string; committedAt?: string; parentCount: number }
export interface GithubCompareResult {
  commits: GithubCompareCommit[]; status?: string; totalCommits?: number; pages: number; truncated: boolean;
  failure?: GithubCallFailure; rateLimit?: GithubRateLimit; resumeAt?: Date;
}
// on GithubClient:
listHeadRefs(repoFullName: string, token: string): Promise<GithubHeadRefs>;          // ref name WITHOUT 'refs/heads/' → sha
getDefaultBranch(repoFullName: string, token: string): Promise<GithubDefaultBranch>;
compareAll(repoFullName: string, token: string, base: string, head: string, maxPages?: number): Promise<GithubCompareResult>;
```

- [ ] **Step 1: Write the failing tests**

`github-compare.client.spec.ts`:
```ts
import { GithubClient } from './github.client';

function res(opts: { status?: number; headers?: Record<string, string>; body?: unknown }) {
  const h = new Map(Object.entries(opts.headers ?? {}));
  return {
    ok: (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => opts.body ?? {},
  };
}

const commit = (sha: string, parents = 1, login?: string) => ({
  sha,
  commit: {
    message: `msg ${sha}`,
    author: { name: 'Arun', email: 'arun@x.org', date: '2026-09-25T10:00:00Z' },
    committer: { date: '2026-09-25T10:05:00Z' },
  },
  author: login ? { login } : null,
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
});

describe('GithubClient REST additions', () => {
  const client = new GithubClient();
  afterEach(() => jest.restoreAllMocks());

  it('listHeadRefs maps every branch tip from one matching-refs call', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      res({
        body: [
          { ref: 'refs/heads/master', object: { sha: 'm1' } },
          { ref: 'refs/heads/ACT-92441-aot-induction', object: { sha: 'b1' } },
        ],
        headers: { 'x-ratelimit-remaining': '4990' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listHeadRefs('acme/ehr', 'tok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/ehr/git/matching-refs/heads/');
    expect([...(r.tips ?? new Map())]).toEqual([
      ['master', 'm1'],
      ['ACT-92441-aot-induction', 'b1'],
    ]);
    expect(r.rateLimit?.remaining).toBe(4990);
  });

  it('listHeadRefs reports not_found for a vanished repo', async () => {
    global.fetch = jest.fn().mockResolvedValue(res({ status: 404 })) as unknown as typeof fetch;
    expect((await client.listHeadRefs('acme/gone', 'tok')).failure).toBe('not_found');
  });

  it('getDefaultBranch reads default_branch', async () => {
    global.fetch = jest.fn().mockResolvedValue(res({ body: { default_branch: 'master' } })) as unknown as typeof fetch;
    expect((await client.getDefaultBranch('acme/ehr', 'tok')).name).toBe('master');
  });

  it('compareAll follows rel="next" and collects every page of commits', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        res({
          body: { status: 'ahead', total_commits: 3, commits: [commit('c1'), commit('c2', 2, 'arun')] },
          headers: { link: '<https://api.github.com/repos/acme/ehr/compare/a...b?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(res({ body: { status: 'ahead', total_commits: 3, commits: [commit('c3')] } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'a', 'b');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/ehr/compare/a...b?per_page=100');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/ehr/compare/a...b?page=2');
    expect(r.commits.map((c) => c.sha)).toEqual(['c1', 'c2', 'c3']);
    expect(r.commits[1]).toMatchObject({ authorLogin: 'arun', parentCount: 2, authorEmail: 'arun@x.org' });
    expect(r).toMatchObject({ pages: 2, truncated: false, totalCommits: 3 });
  });

  it('compareAll returns the new commits on a diverged (force-pushed) range', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ body: { status: 'diverged', total_commits: 1, commits: [commit('new1')] } }),
    ) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'old', 'new1');
    expect(r).toMatchObject({ status: 'diverged', truncated: false });
    expect(r.commits.map((c) => c.sha)).toEqual(['new1']);
  });

  it('compareAll flags truncation when GitHub returns fewer than total_commits', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ body: { status: 'ahead', total_commits: 300, commits: [commit('c1')] } }),
    ) as unknown as typeof fetch;
    expect((await client.compareAll('acme/ehr', 'tok', 'a', 'b')).truncated).toBe(true);
  });

  it('compareAll reports not_found (e.g. a garbage-collected base) without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue(res({ status: 404 })) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'gone', 'b');
    expect(r).toMatchObject({ failure: 'not_found', commits: [] });
  });

  it('compareAll separates a rate limit from a permission refusal', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } }),
    ) as unknown as typeof fetch;
    expect((await client.compareAll('acme/ehr', 'tok', 'a', 'b')).failure).toBe('rate_limited');
    global.fetch = jest.fn().mockResolvedValue(
      res({ status: 403, headers: { 'x-ratelimit-remaining': '4000' } }),
    ) as unknown as typeof fetch;
    expect((await client.compareAll('acme/ehr', 'tok', 'a', 'b')).failure).toBe('forbidden');
  });

  it('compareAll fails rather than partially succeeding when a later page errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        res({
          body: { status: 'ahead', total_commits: 2, commits: [commit('c1')] },
          headers: { link: '<https://api.github.com/repos/acme/ehr/compare/a...b?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(res({ status: 500 })) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'a', 'b');
    expect(r).toMatchObject({ failure: 'failed', commits: [] });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-compare.client.spec.ts`
Expected: FAIL with "client.listHeadRefs is not a function".

- [ ] **Step 3: Implement**

Add the exported types (above) near the other interfaces in `github.client.ts`. Add `import { classifyForbidden } from './github-audit-log.client';` and `import { isGithubApiUrl, nextLinkUrl, redactUrl } from './github-link';`. Then add these methods to `GithubClient`, before `private async getPage`:

```ts
  /**
   * Every branch tip of a repo in ONE call (spec F7: `ehr`'s 1,474 refs in a
   * single unpaginated response). The audit sync diffs these against the tips
   * it stored last run — the only way to learn which ref a push moved, since
   * `git.push` audit events carry no ref (spec F2).
   */
  async listHeadRefs(repoFullName: string, token: string): Promise<GithubHeadRefs> {
    const res = await this.restGet(`${this.baseUrl}/repos/${repoFullName}/git/matching-refs/heads/`, token);
    if ('failure' in res) return res;
    const body = (await res.response.json()) as { ref?: string; object?: { sha?: string } }[];
    const tips = new Map<string, string>();
    for (const r of Array.isArray(body) ? body : []) {
      if (r.ref?.startsWith('refs/heads/') && r.object?.sha) {
        tips.set(r.ref.slice('refs/heads/'.length), r.object.sha);
      }
    }
    return { tips, rateLimit: this.readRateLimit(res.response) };
  }

  async getDefaultBranch(repoFullName: string, token: string): Promise<GithubDefaultBranch> {
    const res = await this.restGet(`${this.baseUrl}/repos/${repoFullName}`, token);
    if ('failure' in res) return res;
    const body = (await res.response.json()) as { default_branch?: string };
    return { name: body.default_branch, rateLimit: this.readRateLimit(res.response) };
  }

  /**
   * `GET /repos/{repo}/compare/{base}...{head}`, consumed to the LAST page
   * (`Link rel="next"`, followed verbatim). Returns the commits reachable from
   * `head` and not from `base` — on a force-push (`status: diverged`) those are
   * exactly the new commits. GitHub caps a comparison at 250 commits; when it
   * returns fewer than `total_commits`, `truncated` says so rather than letting
   * a partial range pass for a complete one.
   *
   * All-or-nothing: any failed page yields `failure` with no commits, so the
   * caller retries the range instead of half-ingesting it.
   */
  async compareAll(
    repoFullName: string,
    token: string,
    base: string,
    head: string,
    maxPages = 10,
  ): Promise<GithubCompareResult> {
    const commits: GithubCompareCommit[] = [];
    let url: string | undefined =
      `${this.baseUrl}/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`;
    let pages = 0;
    let status: string | undefined;
    let totalCommits: number | undefined;
    let rateLimit: GithubRateLimit | undefined;

    while (url && pages < maxPages) {
      if (!isGithubApiUrl(url)) {
        return { commits: [], pages, truncated: false, failure: 'failed' };
      }
      const res = await this.restGet(url, token);
      if ('failure' in res) {
        return { commits: [], pages, truncated: false, ...res };
      }
      const body = (await res.response.json()) as {
        status?: string;
        total_commits?: number;
        commits?: {
          sha?: string;
          commit?: {
            message?: string;
            author?: { name?: string; email?: string; date?: string } | null;
            committer?: { date?: string } | null;
          };
          author?: { login?: string } | null;
          parents?: unknown[];
        }[];
      };
      pages++;
      status = body.status ?? status;
      totalCommits = body.total_commits ?? totalCommits;
      rateLimit = this.readRateLimit(res.response) ?? rateLimit;
      for (const c of body.commits ?? []) {
        if (!c.sha) continue;
        commits.push({
          sha: c.sha,
          message: c.commit?.message ?? '',
          authorLogin: c.author?.login,
          authorName: c.commit?.author?.name,
          authorEmail: c.commit?.author?.email,
          authoredAt: c.commit?.author?.date,
          committedAt: c.commit?.committer?.date,
          parentCount: Array.isArray(c.parents) ? c.parents.length : 0,
        });
      }
      url = nextLinkUrl(res.response.headers.get('link'));
    }

    const truncated = Boolean(url) || (totalCommits !== undefined && commits.length < totalCommits);
    return { commits, status, totalCommits, pages, truncated, rateLimit };
  }

  /** One authenticated GET, with 403 split into rate-limit vs permission (spec F8). */
  private async restGet(
    url: string,
    token: string,
  ): Promise<
    | { response: Response }
    | { failure: GithubCallFailure; resumeAt?: Date; rateLimit?: GithubRateLimit }
  > {
    if (!token) {
      return { failure: 'forbidden' };
    }
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 403 || response.status === 429) {
      if (classifyForbidden(response) === 'rate_limited') {
        const resumeAt = this.parseResetHeader(response.headers.get('x-ratelimit-reset'));
        this.logger.warn(`GitHub rate-limited until ${resumeAt.toISOString()}`);
        return { failure: 'rate_limited', resumeAt };
      }
      this.logger.warn(`GitHub refused (403): ${redactUrl(url)}`);
      return { failure: 'forbidden' };
    }
    if (response.status === 404) {
      return { failure: 'not_found' };
    }
    if (!response.ok) {
      this.logger.warn(`GitHub request failed (${response.status}): ${redactUrl(url)}`);
      return { failure: 'failed' };
    }
    return { response };
  }
```

If `readRateLimit` takes a narrower type, `Response` already satisfies `{ headers: { get(name: string): string | null } }`, so no change is needed.

- [ ] **Step 4: Run the new spec and the existing client spec**

Run: `npx jest src/collectors/sources/github/github-compare.client.spec.ts src/collectors/sources/github/github.client.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github.client.ts backend/src/collectors/sources/github/github-compare.client.spec.ts
git commit -m "feat(collectors): add branch-tip listing and fully paged Compare to the REST client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: One commit-envelope builder for every route

**Files:**
- Create: `backend/src/collectors/sources/github/github-commit-envelope.ts`
- Create: `backend/src/collectors/sources/github/github-commit-envelope.spec.ts`
- Modify: `backend/src/collectors/sources/github/github.collector.ts` (`commitEnvelope`, ~line 1072, now delegates)
- Modify: `backend/src/collectors/sources/github/github-pr-commit-backfill.service.ts` (`commitEnvelope`, ~line 245, now delegates)
- Modify: `backend/src/common/events/contracts.ts` (`CodeCommitPayload` gains `parentCount?: number`)
- Modify: `backend/src/common/events/event-types.ts` (adds `CODE_PUSH_OBSERVED: 'code.push.observed'`)

**Interfaces:**
- Produces: `buildCommitEnvelope(args: { connectionId: string; mode: CollectionMode; repoFullName: string; payload: CodeCommitPayload; extraRefs?: Record<string, string>; collectedAt?: string }): CanonicalEnvelope`, `commitIdempotencyKey(repoFullName: string, sha: string): string`

- [ ] **Step 1: Write the failing test**

`github-commit-envelope.spec.ts`:
```ts
import { EventTypes } from '../../../common/events/event-types';
import { buildCommitEnvelope, commitIdempotencyKey } from './github-commit-envelope';

describe('buildCommitEnvelope', () => {
  const payload = {
    repoFullName: 'acme/ehr',
    sha: '0defa5a6e4',
    message: 'm',
    authorEmail: 'a@x.org',
    authoredAt: '2026-09-25T10:00:00Z',
  };

  it('mints the key every route converges on', () => {
    const e = buildCommitEnvelope({ connectionId: 'c1', mode: 'poll', repoFullName: 'acme/ehr', payload });
    expect(e.idempotencyKey).toBe('github:acme/ehr:commit:0defa5a6e4');
    expect(commitIdempotencyKey('acme/ehr', '0defa5a6e4')).toBe(e.idempotencyKey);
    expect(e).toMatchObject({
      sourceSystem: 'github',
      connectionId: 'c1',
      collectionMode: 'poll',
      eventType: EventTypes.CODE_COMMIT_PUSHED,
      occurredAt: '2026-09-25T10:00:00Z',
      externalRefs: { repo: 'acme/ehr', sha: '0defa5a6e4' },
    });
  });

  it('adds lineage refs without changing the key', () => {
    const e = buildCommitEnvelope({
      connectionId: 'c1',
      mode: 'poll',
      repoFullName: 'acme/ehr',
      payload,
      extraRefs: { ref: 'ACT-92441-aot-induction', discoveredBy: 'github-audit-compare' },
    });
    expect(e.externalRefs).toEqual({
      repo: 'acme/ehr',
      sha: '0defa5a6e4',
      ref: 'ACT-92441-aot-induction',
      discoveredBy: 'github-audit-compare',
    });
    expect(e.idempotencyKey).toBe('github:acme/ehr:commit:0defa5a6e4');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-commit-envelope.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`github-commit-envelope.ts`:
```ts
import { CodeCommitPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { CanonicalEnvelope, CollectionMode } from '../../ingestion/canonical-envelope';

/** The one key every commit route converges on (api/README.md §5). */
export function commitIdempotencyKey(repoFullName: string, sha: string): string {
  return `github:${repoFullName}:commit:${sha}`;
}

/**
 * The single builder for `code.commit.pushed` envelopes. The default-branch
 * walk, the PR harvest, the PR backfill and the audit-log route all mint
 * through here, so a commit reached by several routes converges on one raw
 * event and one `code_commit` row. Lineage-only refs (`extraRefs`) never
 * change the key.
 */
export function buildCommitEnvelope(args: {
  connectionId: string;
  mode: CollectionMode;
  repoFullName: string;
  payload: CodeCommitPayload;
  extraRefs?: Record<string, string>;
  collectedAt?: string;
}): CanonicalEnvelope {
  const { connectionId, mode, repoFullName, payload } = args;
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: commitIdempotencyKey(repoFullName, payload.sha),
    sourceSystem: 'github',
    connectionId,
    collectionMode: mode,
    eventType: EventTypes.CODE_COMMIT_PUSHED,
    occurredAt: payload.authoredAt,
    collectedAt: args.collectedAt ?? new Date().toISOString(),
    externalRefs: { repo: repoFullName, sha: payload.sha, ...(args.extraRefs ?? {}) },
    actor: { sourceLogin: payload.authorLogin },
    data: payload as unknown as Record<string, unknown>,
  };
}
```

In `github.collector.ts`, replace the body of `private commitEnvelope(...)` with:
```ts
    return buildCommitEnvelope({
      connectionId: connection.id,
      mode,
      repoFullName,
      payload,
      collectedAt: this.nowIso(),
    });
```
Add the import `import { buildCommitEnvelope } from './github-commit-envelope';`, and drop `newId` from the imports if it is no longer used.

In `github-pr-commit-backfill.service.ts`, keep the `payload` construction inside `commitEnvelope`, then replace the returned object literal with:
```ts
    return buildCommitEnvelope({
      connectionId,
      mode: 'backfill',
      repoFullName,
      payload,
    });
```
Import it, and remove the `newId`/`EventTypes`/`CanonicalEnvelope` imports that become unused (keep `CanonicalEnvelope` if it is still the return type).

In `contracts.ts`, add to `CodeCommitPayload`:
```ts
  /**
   * Number of parents (2+ = merge commit). Recorded, not yet acted on: whether
   * merges count as activity is an open product decision (spec §12 Q5), and
   * this keeps the data needed to answer it without re-fetching.
   */
  parentCount?: number;
```
In `event-types.ts`, add `CODE_PUSH_OBSERVED: 'code.push.observed',` after `CODE_COMMIT_PUSHED`.

- [ ] **Step 4: Run every affected spec**

Run: `npx jest src/collectors/sources/github`
Expected: PASS. The existing collector and backfill specs prove the envelope is unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github-commit-envelope.ts backend/src/collectors/sources/github/github-commit-envelope.spec.ts backend/src/collectors/sources/github/github.collector.ts backend/src/collectors/sources/github/github-pr-commit-backfill.service.ts backend/src/common/events/contracts.ts backend/src/common/events/event-types.ts
git commit -m "refactor(collectors): mint every commit envelope through one builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Pure push planner (dedupe, touched repos, tip diff)

**Files:**
- Create: `backend/src/collectors/sources/github/github-audit-push-planner.ts`
- Create: `backend/src/collectors/sources/github/github-audit-push-planner.spec.ts`

**Interfaces:**
- Consumes: `GitPushAuditEvent` (Task 3)
- Produces:
```ts
export type RangeKind = 'moved' | 'new_ref' | 'deleted';
export interface PlannedRange { repoFullName: string; ref: string; baseSha?: string; baseRef?: string; headSha?: string; kind: RangeKind }
export interface TipDiff { ranges: PlannedRange[]; upserts: Array<{ ref: string; sha: string }>; deletes: string[] }
export const DEFAULT_BRANCH_MARKER = 'HEAD';    // GithubRefTip.ref for the cached default branch; sha column holds its NAME
export function dedupePushes(events: GitPushAuditEvent[]): GitPushAuditEvent[];
export function pushesByRepo(events: GitPushAuditEvent[]): Map<string, GitPushAuditEvent[]>;   // chronological within a repo
export function diffTips(repoFullName: string, stored: Map<string, string>, current: Map<string, string>, defaultBranch: string): TipDiff;
export function countRanges(ranges: PlannedRange[]): { compareRequestsPlanned: number; refsMoved: number; refsNew: number; refsDeleted: number };
```

- [ ] **Step 1: Write the failing test**

`github-audit-push-planner.spec.ts`:
```ts
import {
  countRanges,
  dedupePushes,
  diffTips,
  pushesByRepo,
} from './github-audit-push-planner';
import { GitPushAuditEvent } from './github-audit-log.client';

const ev = (id: string, repo: string, ms: number): GitPushAuditEvent => ({
  documentId: id,
  repoFullName: repo,
  timestamp: new Date(ms),
});

describe('dedupePushes', () => {
  it('keeps one event per _document_id (overlapping windows)', () => {
    const out = dedupePushes([ev('a', 'acme/ehr', 2), ev('a', 'acme/ehr', 2), ev('b', 'acme/ehr', 1)]);
    expect(out.map((e) => e.documentId).sort()).toEqual(['a', 'b']);
  });
});

describe('pushesByRepo', () => {
  it('groups by repo and sorts each group chronologically', () => {
    const g = pushesByRepo([ev('c', 'acme/ehr', 3), ev('x', 'acme/amma', 5), ev('a', 'acme/ehr', 1)]);
    expect([...g.keys()].sort()).toEqual(['acme/amma', 'acme/ehr']);
    expect(g.get('acme/ehr')!.map((e) => e.documentId)).toEqual(['a', 'c']);
  });
});

describe('diffTips', () => {
  const stored = new Map([
    ['master', 'm1'],
    ['feature-A', 'A'],
    ['feature-B', 'X'],
    ['old', 'o1'],
    ['same', 's1'],
  ]);

  it('plans one Compare per moved ref (A→B→C→D collapses to A...D)', () => {
    const current = new Map([
      ['master', 'm1'],
      ['feature-A', 'D'],
      ['feature-B', 'Z'],
      ['same', 's1'],
      ['old', 'o1'],
    ]);
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([
      { repoFullName: 'acme/ehr', ref: 'feature-A', baseSha: 'A', headSha: 'D', kind: 'moved' },
      { repoFullName: 'acme/ehr', ref: 'feature-B', baseSha: 'X', headSha: 'Z', kind: 'moved' },
    ]);
    expect(d.upserts).toEqual([
      { ref: 'feature-A', sha: 'D' },
      { ref: 'feature-B', sha: 'Z' },
    ]);
    expect(d.deletes).toEqual([]);
  });

  it('compares a new ref against the default branch (the zero-before case)', () => {
    const current = new Map([...stored, ['ACT-92441-aot-induction', '50b124b05b']]);
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([
      {
        repoFullName: 'acme/ehr',
        ref: 'ACT-92441-aot-induction',
        baseRef: 'master',
        headSha: '50b124b05b',
        kind: 'new_ref',
      },
    ]);
  });

  it('records a deleted ref without planning a Compare (the zero-after case)', () => {
    const current = new Map(stored);
    current.delete('old');
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([{ repoFullName: 'acme/ehr', ref: 'old', baseSha: 'o1', kind: 'deleted' }]);
    expect(d.deletes).toEqual(['old']);
  });

  it('plans nothing when no tip moved', () => {
    expect(diffTips('acme/ehr', stored, new Map(stored), 'master').ranges).toEqual([]);
  });

  it('never compares the default branch against itself when it is new', () => {
    const d = diffTips('acme/new', new Map(), new Map([['main', 'h1']]), 'main');
    expect(d.ranges).toEqual([]);
    expect(d.upserts).toEqual([{ ref: 'main', sha: 'h1' }]);
  });
});

describe('countRanges', () => {
  it('counts only Compare-bearing ranges as requests', () => {
    expect(
      countRanges([
        { repoFullName: 'r', ref: 'a', kind: 'moved', baseSha: '1', headSha: '2' },
        { repoFullName: 'r', ref: 'b', kind: 'new_ref', baseRef: 'm', headSha: '3' },
        { repoFullName: 'r', ref: 'c', kind: 'deleted', baseSha: '4' },
      ]),
    ).toEqual({ compareRequestsPlanned: 2, refsMoved: 1, refsNew: 1, refsDeleted: 1 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-audit-push-planner.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`github-audit-push-planner.ts`:
```ts
import { GitPushAuditEvent } from './github-audit-log.client';

/**
 * Pure planning for the audit-log route (spec §4.3). No I/O.
 *
 * `git.push` audit events name the repo but not the ref or SHAs, so the plan
 * comes from diffing branch tips: the tip stored last run against the tip now.
 * That diff IS the consolidated range the brief asks for — however many pushes
 * moved `feature-A` from A to D between runs, it costs one Compare A...D — and
 * unrelated branches can never be merged into one range, because each ref is
 * diffed only against itself.
 */
export type RangeKind = 'moved' | 'new_ref' | 'deleted';

export interface PlannedRange {
  repoFullName: string;
  ref: string;
  baseSha?: string;
  /** Set for `new_ref`: compare against this branch NAME (the default branch). */
  baseRef?: string;
  headSha?: string;
  kind: RangeKind;
}

export interface TipDiff {
  ranges: PlannedRange[];
  upserts: Array<{ ref: string; sha: string }>;
  deletes: string[];
}

/** `GithubRefTip.ref` of the row caching a repo's default branch; its `sha` column holds the branch NAME. */
export const DEFAULT_BRANCH_MARKER = 'HEAD';

export function dedupePushes(events: GitPushAuditEvent[]): GitPushAuditEvent[] {
  const byId = new Map<string, GitPushAuditEvent>();
  for (const e of events) {
    if (!byId.has(e.documentId)) byId.set(e.documentId, e);
  }
  return [...byId.values()];
}

export function pushesByRepo(events: GitPushAuditEvent[]): Map<string, GitPushAuditEvent[]> {
  const groups = new Map<string, GitPushAuditEvent[]>();
  for (const e of events) {
    const list = groups.get(e.repoFullName) ?? [];
    list.push(e);
    groups.set(e.repoFullName, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return groups;
}

export function diffTips(
  repoFullName: string,
  stored: Map<string, string>,
  current: Map<string, string>,
  defaultBranch: string,
): TipDiff {
  const ranges: PlannedRange[] = [];
  const upserts: Array<{ ref: string; sha: string }> = [];
  const deletes: string[] = [];

  for (const [ref, sha] of current) {
    const before = stored.get(ref);
    if (before === sha) continue;
    upserts.push({ ref, sha });
    if (before) {
      // Fast-forward or force-push alike: Compare returns what `sha` has that
      // `before` lacks, which on a diverged history is exactly the new work.
      ranges.push({ repoFullName, ref, baseSha: before, headSha: sha, kind: 'moved' });
    } else if (ref !== defaultBranch) {
      // A ref we have never seen (the "before = 0000…" push): its new work is
      // whatever it carries that the default branch does not.
      ranges.push({ repoFullName, ref, baseRef: defaultBranch, headSha: sha, kind: 'new_ref' });
    }
  }
  for (const [ref, sha] of stored) {
    if (!current.has(ref)) {
      // The "after = 0000…" push. Nothing to fetch: its commits were collected
      // when the tip was last seen, or were never observable (spec §10).
      deletes.push(ref);
      ranges.push({ repoFullName, ref, baseSha: sha, kind: 'deleted' });
    }
  }
  return { ranges, upserts, deletes };
}

export function countRanges(ranges: PlannedRange[]) {
  return {
    compareRequestsPlanned: ranges.filter((r) => r.kind !== 'deleted').length,
    refsMoved: ranges.filter((r) => r.kind === 'moved').length,
    refsNew: ranges.filter((r) => r.kind === 'new_ref').length,
    refsDeleted: ranges.filter((r) => r.kind === 'deleted').length,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/collectors/sources/github/github-audit-push-planner.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit-push-planner.ts backend/src/collectors/sources/github/github-audit-push-planner.spec.ts
git commit -m "feat(collectors): plan Compare ranges from branch-tip diffs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Schema and migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (append after the `RawEvent` model, inside the BC-1 section)
- Create: `backend/prisma/migrations/20261006120000_add_github_audit_sync/migration.sql`

**Interfaces:**
- Produces Prisma delegates: `prisma.githubAuditCheckpoint`, `prisma.githubAuditRun`, `prisma.githubPushRange`, `prisma.githubRefTip`. Compound unique inputs: `tenantId` (checkpoint) and `tenantId_repoFullName_ref` (ref tip).

- [ ] **Step 1: Add the models**

```prisma
// ---------------------------------------------------------------------------
// BC-1 GitHub audit-log push discovery (ADR-0010). Collector-owned state only;
// commits still reach code_commit exclusively through the ingestion pipeline.
// ---------------------------------------------------------------------------

/// Per-tenant position in the org audit log. `checkpointAt` advances only
/// after a window's complete audit set has been fetched AND its work queued
/// as GithubPushRange rows (spec §4.5). `seededAt` marks the one-off pass that
/// stored every repo's branch tips; audit discovery covers pushes after it.
model GithubAuditCheckpoint {
  id           String    @id
  tenantId     String    @unique
  organization String
  seededAt     DateTime?
  checkpointAt DateTime?
  lastRunAt    DateTime?
  lastStatus   String?
  lastError    String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@map("collectors_github_audit_checkpoint")
}

/// One sync run: its window, outcome and every counter (spec §7).
model GithubAuditRun {
  id         String    @id
  tenantId   String
  mode       String // off | shadow | ingest
  startedAt  DateTime
  finishedAt DateTime?
  windowFrom DateTime?
  windowTo   DateTime?
  status     String // running | seeded | success | partial | failed
  counters   Json
  error      String?

  @@index([tenantId, startedAt])
  @@map("collectors_github_audit_run")
}

/// One planned Compare (or a recorded deletion) for a repo+ref, and the
/// durable retry queue for it. `auditDocumentIds` ties it to the pushes that
/// prompted it — per repo and run, because audit events carry no ref (F2).
model GithubPushRange {
  id               String   @id
  tenantId         String
  runId            String
  connectionId     String
  repoFullName     String
  ref              String
  baseSha          String?
  baseRef          String?
  headSha          String?
  kind             String // moved | new_ref | deleted
  auditDocumentIds Json
  status           String   @default("pending") // pending | shadowed | done | failed
  attempts         Int      @default(0)
  commitsFound     Int      @default(0)
  alreadyPresent   Int      @default(0)
  ingested         Int      @default(0)
  truncated        Boolean  @default(false)
  lastError        String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([tenantId, status])
  @@index([tenantId, createdAt])
  @@map("collectors_github_push_range")
}

/// The branch tip last observed per repo+ref. The diff against the current
/// tips is the Compare plan. `ref = 'HEAD'` caches the default branch NAME in `sha`.
model GithubRefTip {
  id           String   @id
  tenantId     String
  repoFullName String
  ref          String
  sha          String
  seenAt       DateTime

  @@unique([tenantId, repoFullName, ref])
  @@map("collectors_github_ref_tip")
}
```

- [ ] **Step 2: Write the migration by hand.** Never run `migrate dev` against an unknown `DATABASE_URL`; migrations are applied manually on the host.

`migration.sql`:
```sql
-- GitHub audit-log push discovery (ADR-0010). Collector-owned state for the
-- third commit-discovery route: the per-tenant audit checkpoint, run reports,
-- the Compare plan / retry queue, and last-seen branch tips. No commit data is
-- stored here — commits still flow through collectors_raw_event → code_commit.

CREATE TABLE "collectors_github_audit_checkpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "seededAt" TIMESTAMP(3),
    "checkpointAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_audit_checkpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collectors_github_audit_checkpoint_tenantId_key" ON "collectors_github_audit_checkpoint"("tenantId");

CREATE TABLE "collectors_github_audit_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "counters" JSONB NOT NULL,
    "error" TEXT,
    CONSTRAINT "collectors_github_audit_run_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collectors_github_audit_run_tenantId_startedAt_idx" ON "collectors_github_audit_run"("tenantId", "startedAt");

CREATE TABLE "collectors_github_push_range" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "baseSha" TEXT,
    "baseRef" TEXT,
    "headSha" TEXT,
    "kind" TEXT NOT NULL,
    "auditDocumentIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "commitsFound" INTEGER NOT NULL DEFAULT 0,
    "alreadyPresent" INTEGER NOT NULL DEFAULT 0,
    "ingested" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_push_range_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collectors_github_push_range_tenantId_status_idx" ON "collectors_github_push_range"("tenantId", "status");
CREATE INDEX "collectors_github_push_range_tenantId_createdAt_idx" ON "collectors_github_push_range"("tenantId", "createdAt");

CREATE TABLE "collectors_github_ref_tip" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_ref_tip_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collectors_github_ref_tip_tenantId_repoFullName_ref_key" ON "collectors_github_ref_tip"("tenantId", "repoFullName", "ref");
```

- [ ] **Step 3: Validate the schema and regenerate the client**

Run: `npx prisma validate` (no DB needed). Expected: "The schema at prisma/schema.prisma is valid".

Then run `npx prisma generate`. If it fails with EPERM on `query_engine-windows.dll.node`, a running backend holds the DLL. **Stop and ask the user to stop the local backend**; never kill it yourself. Expected: "Generated Prisma Client".

Then run `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"` **only if** the user supplies a disposable shadow DB URL. Otherwise skip it and say the SQL was hand-checked against the model.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20261006120000_add_github_audit_sync/migration.sql
git commit -m "feat(db): add audit-sync checkpoint, run, push-range and ref-tip tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Audit sync service: seeding, complete window, plan, checkpoint

**Files:**
- Create: `backend/src/collectors/sources/github/github-audit-sync.fakes.ts` (test-only in-memory Prisma and ingestion fakes; not a `.spec`, so Jest does not run it)
- Create: `backend/src/collectors/sources/github/github-audit-sync.service.ts`
- Create: `backend/src/collectors/sources/github/github-audit-sync.service.spec.ts`

**Interfaces:**
- Consumes: `GithubAuditLogClient.listGitPushes` (T3); `GithubClient.listHeadRefs`/`getDefaultBranch` (T4); `dedupePushes`, `pushesByRepo`, `diffTips`, `countRanges`, `DEFAULT_BRANCH_MARKER` (T6); `forEachBounded` (T1); `readGithubAuditConfig`, `GithubAuditConfig` (T2); `EventTypes.CODE_PUSH_OBSERVED` (T5); Prisma delegates (T7)
- Produces:
```ts
export interface AuditRunCounters { reposSeeded: number; auditPages: number; auditNextTraversals: number; auditEvents: number; uniquePushes: number;
  reposTouched: number; reposUnregistered: number; refsMoved: number; refsNew: number; refsDeleted: number;
  compareCandidatesNaive: number; compareRequestsPlanned: number; compareRequestsSaved: number; compareRequestsExecuted: number; comparePages: number;
  commitsDiscovered: number; alreadyPresent: number; ingested: number; wouldIngest: number; commitsWithoutLogin: number;
  truncatedRanges: number; failedRanges: number; pendingRanges: number; auditRateRemaining?: number; coreRateRemaining?: number }
export interface AuditRunSummary { tenantId: string; runId?: string; status: 'skipped' | 'seeded' | 'success' | 'partial' | 'failed'; reason?: string; counters: AuditRunCounters; windowFrom?: Date; checkpointAt?: Date; durationMs: number }
export interface RunContext { tenantId: string; runId: string; cfg: GithubAuditConfig; counters: AuditRunCounters; now: Date; organization: string; auditToken: string; repos: Map<string, Connection>; tokens: Map<string, string>; stopForBudget: boolean }
@Injectable() export class GithubAuditSyncService {
  runTenant(tenantId: string, cfg?: GithubAuditConfig, now?: Date): Promise<AuditRunSummary>;
  listEnabledTenants(): Promise<string[]>;
}
export const RETENTION_RISK_MS = 6 * 86_400_000;
```

- [ ] **Step 1: Write the fakes**

`github-audit-sync.fakes.ts`:
```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory stand-ins for the Prisma delegates and the ingestion pipeline the
 * audit sync touches. Test-only. `calls` records every where/data so a test
 * can assert tenant scoping on EVERY access, not just the ones it thought of.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('gte' in v) return row[k] >= v.gte;
      if ('lte' in v) return row[k] <= v.lte;
    }
    return row[k] === v;
  });
}

function table(calls: Row[], rows: Row[], uniqueOf: (where: Row) => Row) {
  return {
    rows,
    findUnique: jest.fn(async ({ where }: Row) => {
      calls.push({ where });
      return rows.find((r) => matches(r, uniqueOf(where))) ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => {
      calls.push({ where });
      let out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt === 'asc') out = [...out].sort((a, b) => a.createdAt - b.createdAt);
      return take ? out.slice(0, take) : out;
    }),
    create: jest.fn(async ({ data }: Row) => {
      calls.push({ data });
      const row = { createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    createMany: jest.fn(async ({ data }: Row) => {
      for (const d of data) calls.push({ data: d });
      rows.push(...data.map((d: Row) => ({ createdAt: new Date(), ...d })));
      return { count: data.length };
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      calls.push({ where, data });
      const row = rows.find((r) => matches(r, uniqueOf(where)));
      if (!row) throw new Error('not found');
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (row[k] ?? 0) + (v as Row).increment : v;
      }
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      calls.push({ where, data });
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: Row) => {
      calls.push({ where, create, update });
      const row = rows.find((r) => matches(r, uniqueOf(where)));
      if (row) return Object.assign(row, update);
      const created = { createdAt: new Date(), ...create };
      rows.push(created);
      return created;
    }),
    deleteMany: jest.fn(async ({ where }: Row) => {
      calls.push({ where });
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
  };
}

export function fakePrisma() {
  const calls: Row[] = [];
  const rawKeys = new Set<string>(); // `${tenantId}|${idempotencyKey}`
  const prisma = {
    calls,
    rawKeys,
    tenantConfiguration: table(calls, [], (w) => w.tenantId_namespace_key ?? w),
    connection: table(calls, [], (w) => w),
    githubAuditCheckpoint: table(calls, [], (w) => w),
    githubAuditRun: table(calls, [], (w) => w),
    githubPushRange: table(calls, [], (w) => w),
    githubRefTip: table(calls, [], (w) => w.tenantId_repoFullName_ref ?? w),
    rawEvent: {
      findUnique: jest.fn(async ({ where }: Row) => {
        const { tenantId, idempotencyKey } = where.tenantId_idempotencyKey;
        calls.push({ where: { tenantId } });
        return rawKeys.has(`${tenantId}|${idempotencyKey}`) ? { id: 'raw' } : null;
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return prisma;
}

export function fakeIngestion(prisma: ReturnType<typeof fakePrisma>) {
  return {
    ingest: jest.fn(async (tenantId: string, envelope: Row) => {
      const key = `${tenantId}|${envelope.idempotencyKey}`;
      if (prisma.rawKeys.has(key)) return { status: 'duplicate', eventId: 'raw' };
      prisma.rawKeys.add(key);
      return { status: 'accepted', eventId: 'new' };
    }),
  };
}

export function seedTenant(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  repos: string[],
  opts: { auditRef?: string } = { auditRef: 'GITHUB_AUDIT_TOKEN' },
) {
  prisma.tenantConfiguration.rows.push({
    tenantId,
    namespace: 'github',
    key: 'default',
    status: 'active',
    values: { organization: 'acme' },
    secretRefs: { tokenRef: 'GITHUB_TOKEN', ...(opts.auditRef ? { auditLogTokenRef: opts.auditRef } : {}) },
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
```

- [ ] **Step 2: Write the failing tests**

`github-audit-sync.service.spec.ts`:
```ts
import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import { fakeIngestion, fakePrisma, seedTenant } from './github-audit-sync.fakes';

const NOW = new Date('2026-10-06T10:00:00Z');
const SHADOW = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' });
const push = (id: string, repo: string, ms = NOW.getTime() - 60_000) => ({
  documentId: id,
  repoFullName: repo,
  timestamp: new Date(ms),
  actor: 'dev1',
});

function setup() {
  const prisma = fakePrisma();
  const ingestion = fakeIngestion(prisma);
  const audit = { listGitPushes: jest.fn() };
  const client = {
    listHeadRefs: jest.fn(),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'master' }),
    compareAll: jest.fn(),
    getCommitDetail: jest.fn(),
  };
  const secrets = { resolve: jest.fn(async (_t: string, ref?: string | null) => (ref ? `tok:${ref}` : '')) };
  const svc = new GithubAuditSyncService(
    prisma as never,
    secrets as never,
    ingestion as never,
    audit as never,
    client as never,
  );
  return { prisma, ingestion, audit, client, secrets, svc };
}

/** Seeds tips the way a first run would, so tests can start from "already seeded". */
function seeded(prisma: ReturnType<typeof fakePrisma>, tenantId: string, tips: Record<string, Record<string, string>>) {
  prisma.githubAuditCheckpoint.rows.push({
    id: `cp-${tenantId}`,
    tenantId,
    organization: 'acme',
    seededAt: new Date(NOW.getTime() - 3_600_000),
    checkpointAt: new Date(NOW.getTime() - 300_000),
  });
  for (const [repo, refs] of Object.entries(tips)) {
    prisma.githubRefTip.rows.push({ id: `${repo}-HEAD`, tenantId, repoFullName: repo, ref: 'HEAD', sha: 'master', seenAt: NOW });
    for (const [ref, sha] of Object.entries(refs)) {
      prisma.githubRefTip.rows.push({ id: `${repo}-${ref}`, tenantId, repoFullName: repo, ref, sha, seenAt: NOW });
    }
  }
}

describe('GithubAuditSyncService.runTenant (discovery)', () => {
  it('does nothing at all when the mode is off', async () => {
    const { svc, prisma } = setup();
    const r = await svc.runTenant('t1', readGithubAuditConfig({}), NOW);
    expect(r.status).toBe('skipped');
    expect(prisma.calls).toHaveLength(0);
  });

  it('skips a tenant with no audit-log token ref, saying why', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr'], {});
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r).toMatchObject({ status: 'skipped' });
    expect(r.reason).toMatch(/audit-log token/i);
  });

  it('first run seeds every repo, calls no audit log, and starts the checkpoint at seeding', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['master', 'm1'], ['feat', 'f1']]) });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters.reposSeeded).toBe(2);
    expect(audit.listGitPushes).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0]).toMatchObject({ seededAt: NOW, checkpointAt: NOW });
    expect(prisma.githubRefTip.rows.filter((t) => t.repoFullName === 'acme/ehr').map((t) => t.ref).sort()).toEqual(['HEAD', 'feat', 'master']);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
  });

  it('does not start the checkpoint when seeding fails for any repo', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/gone']);
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/gone' ? { failure: 'not_found' } : { tips: new Map([['master', 'm1']]) },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('partial');
    expect(prisma.githubAuditCheckpoint.rows).toHaveLength(0);
  });

  it('reads the audit window from checkpoint minus overlap with per_page 100', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({ status: 'complete', events: [], pages: 1, nextTraversals: 0 });
    await svc.runTenant('t1', SHADOW, NOW);
    expect(audit.listGitPushes).toHaveBeenCalledWith(
      'acme',
      'tok:GITHUB_AUDIT_TOKEN',
      new Date(NOW.getTime() - 300_000 - 15 * 60_000),
      100,
      200,
    );
  });

  it('keeps the checkpoint and plans nothing when the audit log is incomplete', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue({ status: 'failed', pages: 2, message: 'HTTP 502' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
  });

  it('stores pushes, plans one range per moved ref per repo, skips unregistered repos, advances the checkpoint', async () => {
    const { svc, prisma, audit, client, ingestion } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    seeded(prisma, 't1', {
      'acme/ehr': { master: 'm1', 'feature-A': 'A', 'feature-B': 'X' },
      'acme/amma': { master: 'm2', 'feature-X': 'P' },
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [
        push('e1', 'acme/ehr'), push('e2', 'acme/ehr'), push('e3', 'acme/ehr'),
        push('e4', 'acme/ehr'), push('e5', 'acme/ehr'), push('e6', 'acme/amma'),
        push('e7', 'acme/not-registered'),
      ],
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/ehr'
        ? { tips: new Map([['master', 'm1'], ['feature-A', 'D'], ['feature-B', 'Z']]) }
        : { tips: new Map([['master', 'm2'], ['feature-X', 'Q']]) },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);

    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      auditEvents: 7, uniquePushes: 7, reposTouched: 2, reposUnregistered: 1,
      compareCandidatesNaive: 7, compareRequestsPlanned: 3, compareRequestsSaved: 4, refsMoved: 3,
    });
    const ranges = prisma.githubPushRange.rows.map((x) => `${x.repoFullName}:${x.ref}:${x.baseSha}...${x.headSha}`).sort();
    expect(ranges).toEqual(['acme/amma:feature-X:P...Q', 'acme/ehr:feature-A:A...D', 'acme/ehr:feature-B:X...Z']);
    expect(prisma.githubPushRange.rows.find((x) => x.ref === 'feature-A')!.auditDocumentIds).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    const pushKeys = ingestion.ingest.mock.calls.map((c) => c[1].idempotencyKey);
    expect(pushKeys).toEqual(expect.arrayContaining(['github:audit:e1', 'github:audit:e6']));
    expect(pushKeys).not.toContain('github:audit:e7');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('is idempotent across overlapping windows: the same pushes plan nothing the second time', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1', f: 'A' } });
    audit.listGitPushes.mockResolvedValue({ status: 'complete', pages: 1, nextTraversals: 0, events: [push('e1', 'acme/ehr')] });
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['master', 'm1'], ['f', 'B']]) });
    await svc.runTenant('t1', SHADOW, NOW);
    await svc.runTenant('t1', SHADOW, new Date(NOW.getTime() + 300_000));
    expect(prisma.githubPushRange.rows).toHaveLength(1);
  });

  it('does not advance the checkpoint when a touched repo cannot be listed, but keeps other repos planned', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1', f: 'A' }, 'acme/amma': { master: 'm2' } });
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue({
      status: 'complete', pages: 1, nextTraversals: 0, events: [push('e1', 'acme/ehr'), push('e2', 'acme/amma')],
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/ehr' ? { tips: new Map([['master', 'm1'], ['f', 'B']]) } : { failure: 'failed' },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    expect(prisma.githubPushRange.rows).toHaveLength(1);
  });

  it('seeds (no range) a touched repo it has never seen', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/new']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({ status: 'complete', pages: 1, nextTraversals: 0, events: [push('e1', 'acme/new')] });
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['main', 'n1'], ['b', 'n2']]) });
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.counters.reposSeeded).toBe(1);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
    expect(prisma.githubRefTip.rows.find((t) => t.repoFullName === 'acme/new' && t.ref === 'HEAD')!.sha).toBe('main');
  });

  it('flags a checkpoint older than six days as a retention risk', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(NOW.getTime() - 6.5 * 86_400_000);
    audit.listGitPushes.mockResolvedValue({ status: 'failed', pages: 0, message: 'x' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(prisma.githubAuditRun.rows[0].error).toMatch(/retention/i);
    expect(r.status).toBe('failed');
  });

  it('touches only the running tenant (tenant isolation)', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seedTenant(prisma, 't2', ['other/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1', f: 'A' } });
    seeded(prisma, 't2', { 'other/ehr': { master: 'z1', f: 'Z' } });
    audit.listGitPushes.mockResolvedValue({ status: 'complete', pages: 1, nextTraversals: 0, events: [push('e1', 'acme/ehr'), push('e2', 'other/ehr')] });
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['master', 'm1'], ['f', 'B']]) });
    await svc.runTenant('t1', SHADOW, NOW);
    for (const call of prisma.calls) {
      const blob = JSON.stringify(call);
      expect(blob).not.toContain('"t2"');
    }
    expect(prisma.githubRefTip.rows.find((t) => t.tenantId === 't2' && t.ref === 'f')!.sha).toBe('Z');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-audit-sync.service.spec.ts`
Expected: FAIL with "Cannot find module './github-audit-sync.service'".

- [ ] **Step 4: Implement**

`github-audit-sync.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Connection } from '@prisma/client';
import { forEachBounded } from '../../../common/concurrency';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { IngestionService } from '../../ingestion/ingestion.service';
import { GithubAuditConfig, readGithubAuditConfig } from './github-audit.config';
import { GitPushAuditEvent, GithubAuditLogClient } from './github-audit-log.client';
import {
  countRanges,
  DEFAULT_BRANCH_MARKER,
  dedupePushes,
  diffTips,
  pushesByRepo,
} from './github-audit-push-planner';
import { GithubClient } from './github.client';

export interface AuditRunCounters {
  reposSeeded: number;
  auditPages: number;
  auditNextTraversals: number;
  auditEvents: number;
  uniquePushes: number;
  reposTouched: number;
  reposUnregistered: number;
  refsMoved: number;
  refsNew: number;
  refsDeleted: number;
  compareCandidatesNaive: number;
  compareRequestsPlanned: number;
  compareRequestsSaved: number;
  compareRequestsExecuted: number;
  comparePages: number;
  commitsDiscovered: number;
  alreadyPresent: number;
  ingested: number;
  wouldIngest: number;
  commitsWithoutLogin: number;
  truncatedRanges: number;
  failedRanges: number;
  pendingRanges: number;
  auditRateRemaining?: number;
  coreRateRemaining?: number;
}

export interface AuditRunSummary {
  tenantId: string;
  runId?: string;
  status: 'skipped' | 'seeded' | 'success' | 'partial' | 'failed';
  reason?: string;
  counters: AuditRunCounters;
  windowFrom?: Date;
  checkpointAt?: Date;
  durationMs: number;
}

export interface RunContext {
  tenantId: string;
  runId: string;
  cfg: GithubAuditConfig;
  counters: AuditRunCounters;
  now: Date;
  organization: string;
  auditToken: string;
  repos: Map<string, Connection>;
  tokens: Map<string, string>;
  stopForBudget: boolean;
}

/** Git events live 7 days (spec F6); warn a day before the window is lost. */
export const RETENTION_RISK_MS = 6 * 86_400_000;

export function emptyCounters(): AuditRunCounters {
  return {
    reposSeeded: 0, auditPages: 0, auditNextTraversals: 0, auditEvents: 0, uniquePushes: 0,
    reposTouched: 0, reposUnregistered: 0, refsMoved: 0, refsNew: 0, refsDeleted: 0,
    compareCandidatesNaive: 0, compareRequestsPlanned: 0, compareRequestsSaved: 0,
    compareRequestsExecuted: 0, comparePages: 0, commitsDiscovered: 0, alreadyPresent: 0,
    ingested: 0, wouldIngest: 0, commitsWithoutLogin: 0, truncatedRanges: 0, failedRanges: 0,
    pendingRanges: 0,
  };
}

/**
 * Third commit-discovery route (BC-1, ADR-0010): org audit log → touched repos
 * → branch-tip diff → Compare → the ordinary ingestion pipeline.
 *
 * The audit log is the change DETECTOR (which repos were pushed to, by whom,
 * when); it cannot say which ref or SHAs (spec F2), so the ranges come from
 * diffing branch tips. The checkpoint moves only once a window's complete
 * audit set is fetched AND its work is durably queued, so a failure anywhere
 * before that re-reads the window, and a failure after it is a retry of a
 * persisted range — never lost data (spec §4.5).
 */
@Injectable()
export class GithubAuditSyncService {
  private readonly logger = new Logger(GithubAuditSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly ingestion: IngestionService,
    private readonly auditClient: GithubAuditLogClient,
    private readonly client: GithubClient,
  ) {}

  /** Tenants with an active GitHub configuration that names an audit-log token ref. */
  async listEnabledTenants(): Promise<string[]> {
    const rows = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: 'github', key: 'default', status: 'active' },
      select: { tenantId: true, secretRefs: true },
    });
    return rows
      .filter((r) => typeof (r.secretRefs as Record<string, unknown> | null)?.auditLogTokenRef === 'string')
      .map((r) => r.tenantId);
  }

  async runTenant(
    tenantId: string,
    cfg: GithubAuditConfig = readGithubAuditConfig(),
    now: Date = new Date(),
  ): Promise<AuditRunSummary> {
    const startedMs = Date.now();
    const counters = emptyCounters();
    const skipped = (reason: string): AuditRunSummary => ({
      tenantId, status: 'skipped', reason, counters, durationMs: Date.now() - startedMs,
    });
    if (cfg.mode === 'off') {
      return skipped('GITHUB_AUDIT_SYNC_MODE is off.');
    }
    const settings = await this.loadSettings(tenantId);
    if ('reason' in settings) {
      return skipped(settings.reason);
    }

    const checkpoint = await this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } });
    const run = await this.prisma.githubAuditRun.create({
      data: { id: newId(), tenantId, mode: cfg.mode, startedAt: now, status: 'running', counters: {} },
    });
    const ctx: RunContext = {
      tenantId, runId: run.id, cfg, counters, now,
      organization: settings.organization, auditToken: settings.auditToken,
      repos: await this.registeredRepos(tenantId), tokens: new Map(), stopForBudget: false,
    };

    let status: AuditRunSummary['status'] = 'success';
    let error: string | undefined;
    let windowFrom: Date | undefined;
    let checkpointAt = checkpoint?.checkpointAt ?? undefined;

    try {
      if (!checkpoint?.seededAt) {
        const allSeeded = await this.seedAll(ctx);
        if (allSeeded) {
          await this.prisma.githubAuditCheckpoint.upsert({
            where: { tenantId },
            create: { id: newId(), tenantId, organization: ctx.organization, seededAt: now, checkpointAt: now },
            update: { organization: ctx.organization, seededAt: now, checkpointAt: now },
          });
          checkpointAt = now;
          status = 'seeded';
        } else {
          status = 'partial';
          error = 'Some repositories could not be seeded; they are retried next run before discovery starts.';
        }
      } else {
        const from = checkpoint.checkpointAt ?? checkpoint.seededAt;
        windowFrom = new Date(from.getTime() - cfg.overlapMinutes * 60_000);
        const discovered = await this.discover(ctx, windowFrom);
        if (discovered.ok) {
          await this.prisma.githubAuditCheckpoint.update({ where: { tenantId }, data: { checkpointAt: now } });
          checkpointAt = now;
        } else {
          status = 'failed';
          error = discovered.error;
        }
      }
    } catch (err) {
      status = 'failed';
      error = (err as Error).message.slice(0, 500);
    }

    if (checkpointAt && now.getTime() - checkpointAt.getTime() > RETENTION_RISK_MS) {
      const warning = `Retention risk: the audit checkpoint is ${Math.round((now.getTime() - checkpointAt.getTime()) / 3_600_000)}h old and GitHub keeps git events for 7 days.`;
      this.logger.error(`[tenant ${tenantId}] ${warning}`);
      error = error ? `${warning} ${error}` : warning;
    }

    await this.prisma.githubAuditRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(), status, error: error ?? null,
        windowFrom: windowFrom ?? null, windowTo: windowFrom ? now : null,
        counters: counters as unknown as object,
      },
    });
    await this.prisma.githubAuditCheckpoint.updateMany({
      where: { tenantId },
      data: { lastRunAt: now, lastStatus: status, lastError: error ?? null },
    });

    const durationMs = Date.now() - startedMs;
    this.logger.log(
      `github audit sync tenant=${tenantId} mode=${cfg.mode} status=${status} ` +
        Object.entries(counters).map(([k, v]) => `${k}=${v}`).join(' ') +
        ` durationMs=${durationMs}`,
    );
    return { tenantId, runId: run.id, status, reason: error, counters, windowFrom, checkpointAt, durationMs };
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<{ organization: string; auditToken: string } | { reason: string }> {
    const config = await this.prisma.tenantConfiguration.findUnique({
      where: { tenantId_namespace_key: { tenantId, namespace: 'github', key: 'default' } },
    });
    const values = (config?.values ?? {}) as Record<string, unknown>;
    const refs = (config?.secretRefs ?? {}) as Record<string, unknown>;
    if (!config || config.status !== 'active' || typeof values.organization !== 'string') {
      return { reason: 'GitHub is not configured (organization, saved as active).' };
    }
    if (typeof refs.auditLogTokenRef !== 'string') {
      return { reason: 'No audit-log token secret ref is configured for GitHub.' };
    }
    const auditToken = await this.secrets.resolve(tenantId, refs.auditLogTokenRef);
    if (!auditToken) {
      return { reason: `No value is stored for audit-log token ref "${refs.auditLogTokenRef}".` };
    }
    return { organization: values.organization, auditToken };
  }

  private async registeredRepos(tenantId: string): Promise<Map<string, Connection>> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, sourceSystem: 'github', status: 'active' },
    });
    const byRepo = new Map<string, Connection>();
    for (const c of connections) {
      const repo = (c.config as { repoFullName?: string } | null)?.repoFullName;
      if (repo) byRepo.set(repo, c);
    }
    return byRepo;
  }

  /** The collector's own token for a repo (never the audit token), cached per secret ref for this run. */
  protected async collectorToken(ctx: RunContext, connection: Connection): Promise<string> {
    const ref = connection.secretRef ?? '';
    if (!ctx.tokens.has(ref)) {
      ctx.tokens.set(ref, await this.secrets.resolve(ctx.tenantId, connection.secretRef));
    }
    return ctx.tokens.get(ref) ?? '';
  }

  /** One-off pass storing every repo's tips; repos already seeded are skipped. */
  private async seedAll(ctx: RunContext): Promise<boolean> {
    const markers = await this.prisma.githubRefTip.findMany({
      where: { tenantId: ctx.tenantId, ref: DEFAULT_BRANCH_MARKER },
    });
    const done = new Set(markers.map((m) => m.repoFullName));
    let allOk = true;
    const todo = [...ctx.repos.entries()].filter(([repo]) => !done.has(repo));
    await forEachBounded(todo, ctx.cfg.compareConcurrency, async ([repo, connection]) => {
      const ok = await this.seedRepo(ctx, repo, connection);
      if (ok) ctx.counters.reposSeeded++;
      else allOk = false;
    });
    return allOk;
  }

  private async seedRepo(ctx: RunContext, repo: string, connection: Connection): Promise<boolean> {
    const token = await this.collectorToken(ctx, connection);
    const [branch, refs] = [
      await this.client.getDefaultBranch(repo, token),
      await this.client.listHeadRefs(repo, token),
    ];
    if (!branch.name || !refs.tips) {
      this.logger.warn(`[tenant ${ctx.tenantId}] could not seed ${repo}: ${branch.failure ?? refs.failure ?? 'unknown'}`);
      return false;
    }
    const rows = [
      { ref: DEFAULT_BRANCH_MARKER, sha: branch.name },
      ...[...refs.tips].map(([ref, sha]) => ({ ref, sha })),
    ].map((t) => ({ id: newId(), tenantId: ctx.tenantId, repoFullName: repo, seenAt: ctx.now, ...t }));
    await this.prisma.$transaction(async (tx) => {
      await tx.githubRefTip.deleteMany({ where: { tenantId: ctx.tenantId, repoFullName: repo } });
      await tx.githubRefTip.createMany({ data: rows });
    });
    return true;
  }

  private async discover(ctx: RunContext, windowFrom: Date): Promise<{ ok: true } | { ok: false; error: string }> {
    const { counters } = ctx;
    const audit = await this.auditClient.listGitPushes(
      ctx.organization, ctx.auditToken, windowFrom, ctx.cfg.pageSize, ctx.cfg.maxPages,
    );
    counters.auditPages = audit.pages;
    if (audit.status !== 'complete') {
      return { ok: false, error: `Audit log ${audit.status}: ${audit.message}` };
    }
    counters.auditNextTraversals = audit.nextTraversals;
    counters.auditEvents = audit.events.length;
    counters.auditRateRemaining = audit.rateLimitRemaining;

    const pushes = dedupePushes(audit.events);
    counters.uniquePushes = pushes.length;
    counters.compareCandidatesNaive = pushes.length;

    const touched = [...pushesByRepo(pushes).entries()].filter(([repo]) => {
      if (ctx.repos.has(repo)) return true;
      counters.reposUnregistered++;
      return false;
    });
    counters.reposTouched = touched.length;

    const failures: string[] = [];
    await forEachBounded(touched, ctx.cfg.compareConcurrency, async ([repo, events]) => {
      const connection = ctx.repos.get(repo) as Connection;
      for (const e of events) {
        await this.ingestion.ingest(ctx.tenantId, pushEnvelope(connection.id, e, ctx.now));
      }
      const planned = await this.planRepo(ctx, repo, connection, events.map((e) => e.documentId));
      if (!planned.ok) failures.push(`${repo}: ${planned.error}`);
    });
    counters.compareRequestsSaved = Math.max(0, counters.compareCandidatesNaive - counters.compareRequestsPlanned);

    return failures.length === 0
      ? { ok: true }
      : { ok: false, error: `Could not list branches for ${failures.length} repo(s): ${failures.slice(0, 5).join('; ')}` };
  }

  private async planRepo(
    ctx: RunContext,
    repo: string,
    connection: Connection,
    documentIds: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const stored = await this.prisma.githubRefTip.findMany({ where: { tenantId: ctx.tenantId, repoFullName: repo } });
    const marker = stored.find((t) => t.ref === DEFAULT_BRANCH_MARKER);
    if (!marker) {
      // Never seen: seed only. Its first push stays with the existing routes (spec §10).
      const ok = await this.seedRepo(ctx, repo, connection);
      if (ok) ctx.counters.reposSeeded++;
      return ok ? { ok: true } : { ok: false, error: 'seed failed' };
    }
    const token = await this.collectorToken(ctx, connection);
    const refs = await this.client.listHeadRefs(repo, token);
    if (!refs.tips) {
      return { ok: false, error: refs.failure ?? 'failed' };
    }
    ctx.counters.coreRateRemaining = refs.rateLimit?.remaining ?? ctx.counters.coreRateRemaining;

    const diff = diffTips(
      repo,
      new Map(stored.filter((t) => t.ref !== DEFAULT_BRANCH_MARKER).map((t) => [t.ref, t.sha])),
      refs.tips,
      marker.sha,
    );
    const c = countRanges(diff.ranges);
    ctx.counters.compareRequestsPlanned += c.compareRequestsPlanned;
    ctx.counters.refsMoved += c.refsMoved;
    ctx.counters.refsNew += c.refsNew;
    ctx.counters.refsDeleted += c.refsDeleted;

    await this.prisma.$transaction(async (tx) => {
      for (const r of diff.ranges) {
        await tx.githubPushRange.create({
          data: {
            id: newId(), tenantId: ctx.tenantId, runId: ctx.runId, connectionId: connection.id,
            repoFullName: repo, ref: r.ref, baseSha: r.baseSha ?? null, baseRef: r.baseRef ?? null,
            headSha: r.headSha ?? null, kind: r.kind, auditDocumentIds: documentIds,
            status: r.kind === 'deleted' ? 'done' : 'pending',
          },
        });
      }
      for (const u of diff.upserts) {
        await tx.githubRefTip.upsert({
          where: { tenantId_repoFullName_ref: { tenantId: ctx.tenantId, repoFullName: repo, ref: u.ref } },
          create: { id: newId(), tenantId: ctx.tenantId, repoFullName: repo, ref: u.ref, sha: u.sha, seenAt: ctx.now },
          update: { sha: u.sha, seenAt: ctx.now },
        });
      }
      if (diff.deletes.length > 0) {
        await tx.githubRefTip.deleteMany({
          where: { tenantId: ctx.tenantId, repoFullName: repo, ref: { in: diff.deletes } },
        });
      }
    });
    return { ok: true };
  }
}

/**
 * One observed push, kept in the raw-event store (not a second store) so the
 * audit evidence outlives GitHub's 7-day retention. No subscriber projects it;
 * it is lineage. Network/token fields were already dropped by the client.
 */
export function pushEnvelope(connectionId: string, e: GitPushAuditEvent, now: Date): CanonicalEnvelope {
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: `github:audit:${e.documentId}`,
    sourceSystem: 'github',
    connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_PUSH_OBSERVED,
    occurredAt: e.timestamp.toISOString(),
    collectedAt: now.toISOString(),
    externalRefs: { repo: e.repoFullName, auditDocumentId: e.documentId },
    actor: { sourceLogin: e.actor },
    data: {
      repoFullName: e.repoFullName,
      pushedAt: e.timestamp.toISOString(),
      actor: e.actor,
      externalIdentityUsername: e.externalIdentityUsername,
      programmaticAccessType: e.programmaticAccessType,
      transportProtocolName: e.transportProtocolName,
    },
  };
}
```

Check that `EventBus.publish` tolerates an event type with no subscriber (`backend/src/common/events/event-bus.ts`). If it throws on unknown types, stop and report; do not add a dummy subscriber.

- [ ] **Step 5: Run the test**

Run: `npx jest src/collectors/sources/github/github-audit-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint the new files**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/collectors/sources/github/github-audit-sync.* 2>&1 | grep -v 'Delete \`␍\`'`
Expected: no type errors and no lint errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit-sync.service.ts backend/src/collectors/sources/github/github-audit-sync.service.spec.ts backend/src/collectors/sources/github/github-audit-sync.fakes.ts
git commit -m "feat(collectors): discover pushes from the audit log and plan ranges by tip diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Execute ranges: Compare, stats for new commits, ingest, retry

**Files:**
- Modify: `backend/src/collectors/sources/github/github-audit-sync.service.ts`
- Create: `backend/src/collectors/sources/github/github-audit-execute.spec.ts`

**Interfaces:**
- Consumes: `GithubClient.compareAll`/`getCommitDetail` (T4, existing); `buildCommitEnvelope`, `commitIdempotencyKey` (T5); `evaluateBudget` (existing `github-rate-budget.ts`); `RunContext` (T8)
- Produces: `executePending(ctx: RunContext): Promise<void>` (private, called from `runTenant` for every seeded tenant); range statuses `pending | shadowed | done | failed`; `SHADOW_REPLAY_MS = 7 * 86_400_000`

Rules (spec §4.4–4.5):
- The work set is ranges with `status in ['pending']`, plus `'shadowed'` when the mode is `ingest`, with `createdAt >= now - 7 days`, in `createdAt asc` order. Running in ingest mode therefore replays the shadow period.
- `deleted` ranges are already `done` at plan time and are never executed.
- Base is `baseSha ?? baseRef`. If a `moved` range gets `not_found` (e.g. a garbage-collected base), retry once against the repo's default branch.
- On `rate_limited`, leave the range as it is (attempts unchanged) and set `ctx.stopForBudget`.
- On any other failure, `attempts + 1`. The range becomes `failed` at `maxRangeAttempts`, otherwise stays `pending`. `lastError` is set.
- Per commit: if the raw key exists, count `alreadyPresent` (no detail call). Otherwise, in shadow mode count `wouldIngest`; in ingest mode call `getCommitDetail` and then `ingest`. If the detail call reports `rateLimitedUntil` without stats, stop, leave the range `pending`, and set `stopForBudget`.
- A range ends as `done` in ingest mode and `shadowed` in shadow mode.
- An exception from ingestion counts as a failure of that range (attempts + 1) and never aborts the run.
- After each Compare, `evaluateBudget({ rateLimit })` below the reserve sets `stopForBudget`.
- `counters.pendingRanges` = count still pending after execution. `counters.failedRanges` = ranges that became `failed` this run.

- [ ] **Step 1: Write the failing tests**

`github-audit-execute.spec.ts`:
```ts
import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import { fakeIngestion, fakePrisma, seedTenant } from './github-audit-sync.fakes';

const NOW = new Date('2026-10-06T10:00:00Z');
const SHADOW = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' });
const INGEST = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' });

const commit = (sha: string, login?: string, parentCount = 1) => ({
  sha,
  message: `m ${sha}`,
  authorLogin: login,
  authorName: 'Arun Balaji M',
  authorEmail: 'arun@narayanahealth.org',
  authoredAt: '2026-09-25T09:00:00Z',
  committedAt: '2026-09-25T09:01:00Z',
  parentCount,
});

function setup() {
  const prisma = fakePrisma();
  const ingestion = fakeIngestion(prisma);
  const audit = { listGitPushes: jest.fn().mockResolvedValue({ status: 'complete', events: [], pages: 1, nextTraversals: 0 }) };
  const client = {
    listHeadRefs: jest.fn(),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'master' }),
    compareAll: jest.fn(),
    getCommitDetail: jest.fn().mockResolvedValue({ additions: 10, deletions: 2, filesChanged: 3, committedAt: '2026-09-25T09:01:00Z' }),
  };
  const secrets = { resolve: jest.fn(async (_t: string, ref?: string | null) => (ref ? `tok:${ref}` : '')) };
  const svc = new GithubAuditSyncService(prisma as never, secrets as never, ingestion as never, audit as never, client as never);
  seedTenant(prisma, 't1', ['athmahealth/ehr']);
  prisma.githubAuditCheckpoint.rows.push({
    id: 'cp', tenantId: 't1', organization: 'acme', seededAt: new Date(NOW.getTime() - 3_600_000), checkpointAt: new Date(NOW.getTime() - 300_000),
  });
  prisma.githubRefTip.rows.push({ id: 'h', tenantId: 't1', repoFullName: 'athmahealth/ehr', ref: 'HEAD', sha: 'master', seenAt: NOW });
  return { prisma, ingestion, client, svc };
}

function addRange(prisma: ReturnType<typeof fakePrisma>, over: Record<string, unknown> = {}) {
  const row = {
    id: `r${prisma.githubPushRange.rows.length + 1}`,
    tenantId: 't1', runId: 'old', connectionId: 't1-conn-0', repoFullName: 'athmahealth/ehr',
    ref: 'ACT-92441-aot-induction', baseSha: null, baseRef: 'master', headSha: '50b124b05b', kind: 'new_ref',
    auditDocumentIds: ['d1'], status: 'pending', attempts: 0, commitsFound: 0, alreadyPresent: 0, ingested: 0,
    truncated: false, lastError: null, createdAt: new Date(NOW.getTime() - 60_000), ...over,
  };
  prisma.githubPushRange.rows.push(row);
  return row;
}

describe('executePending', () => {
  it('25 Sep fixture: recovers branch-only ehr commits with lineage, then ingests nothing on a rerun', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('0defa5a6e4', 'arun-athma'), commit('50b124b05b', 'arun-athma')],
      status: 'ahead', totalCommits: 2, pages: 1, truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);

    expect(client.compareAll).toHaveBeenCalledWith('athmahealth/ehr', 'tok:GITHUB_TOKEN', 'master', '50b124b05b');
    const commitCalls = ingestion.ingest.mock.calls.filter((c) => c[1].eventType === 'code.commit.pushed');
    expect(commitCalls.map((c) => c[1].idempotencyKey)).toEqual([
      'github:athmahealth/ehr:commit:0defa5a6e4',
      'github:athmahealth/ehr:commit:50b124b05b',
    ]);
    expect(commitCalls[0][1].externalRefs).toMatchObject({
      ref: 'ACT-92441-aot-induction', discoveredBy: 'github-audit-compare', pushRangeId: 'r1',
    });
    expect(commitCalls[0][1].data).toMatchObject({ additions: 10, deletions: 2, filesChanged: 3, parentCount: 1, authorLogin: 'arun-athma' });
    expect(r.counters).toMatchObject({ ingested: 2, alreadyPresent: 0, commitsDiscovered: 2, compareRequestsExecuted: 1 });
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ status: 'done', ingested: 2 });

    addRange(prisma); // the same range discovered again (overlap / second push)
    const again = await svc.runTenant('t1', INGEST, new Date(NOW.getTime() + 300_000));
    expect(again.counters).toMatchObject({ ingested: 0, alreadyPresent: 2 });
    expect(client.getCommitDetail).toHaveBeenCalledTimes(2);
  });

  it('counts a commit the existing collector already ingested as alreadyPresent, with no detail call', async () => {
    const { prisma, client, svc } = setup();
    prisma.rawKeys.add('t1|github:athmahealth/ehr:commit:aaa');
    addRange(prisma);
    client.compareAll.mockResolvedValue({ commits: [commit('aaa', 'x')], pages: 1, truncated: false });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters).toMatchObject({ alreadyPresent: 1, ingested: 0 });
    expect(client.getCommitDetail).not.toHaveBeenCalled();
  });

  it('shadow mode reports wouldIngest, writes no commit, and ingest mode replays it later', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({ commits: [commit('bbb')], pages: 1, truncated: false });
    const s = await svc.runTenant('t1', SHADOW, NOW);
    expect(s.counters).toMatchObject({ wouldIngest: 1, ingested: 0, commitsWithoutLogin: 1 });
    expect(ingestion.ingest.mock.calls.some((c) => c[1].eventType === 'code.commit.pushed')).toBe(false);
    expect(prisma.githubPushRange.rows[0].status).toBe('shadowed');

    const i = await svc.runTenant('t1', INGEST, new Date(NOW.getTime() + 300_000));
    expect(i.counters.ingested).toBe(1);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  it('keeps an email-only author unattributed: no login is invented', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({ commits: [commit('ccc', undefined)], pages: 1, truncated: false });
    const r = await svc.runTenant('t1', INGEST, NOW);
    const env = ingestion.ingest.mock.calls.find((c) => c[1].eventType === 'code.commit.pushed')![1];
    expect(env.data.authorLogin).toBeUndefined();
    expect(env.data.authorEmail).toBe('arun@narayanahealth.org');
    expect(r.counters.commitsWithoutLogin).toBe(1);
  });

  it('dedupes a commit reachable from two ranges in one run', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    addRange(prisma, { ref: 'other', headSha: 'zzz' });
    client.compareAll.mockResolvedValue({ commits: [commit('same', 'x')], pages: 1, truncated: false });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters).toMatchObject({ ingested: 1, alreadyPresent: 1 });
  });

  it('retries a moved range against the default branch when its base is gone', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, { kind: 'moved', baseSha: 'gone', baseRef: null });
    client.compareAll
      .mockResolvedValueOnce({ commits: [], pages: 0, truncated: false, failure: 'not_found' })
      .mockResolvedValueOnce({ commits: [commit('ddd', 'x')], pages: 1, truncated: false, status: 'diverged' });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.compareAll.mock.calls[1]).toEqual(['athmahealth/ehr', 'tok:GITHUB_TOKEN', 'master', '50b124b05b']);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  it('a failed Compare stays pending with attempts+1, and becomes failed at the cap', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, { attempts: 3 });
    client.compareAll.mockResolvedValue({ commits: [], pages: 0, truncated: false, failure: 'failed' });
    const cfg = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest', GITHUB_AUDIT_MAX_RANGE_ATTEMPTS: '5' });
    await svc.runTenant('t1', cfg, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ status: 'pending', attempts: 4 });
    const r = await svc.runTenant('t1', cfg, new Date(NOW.getTime() + 300_000));
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(r.counters.failedRanges).toBe(1);
  });

  it('a rate limit stops the run without burning an attempt', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    addRange(prisma, { ref: 'second' });
    client.compareAll.mockResolvedValue({ commits: [], pages: 0, truncated: false, failure: 'rate_limited', resumeAt: NOW });
    const r = await svc.runTenant('t1', readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest', GITHUB_AUDIT_COMPARE_CONCURRENCY: '1' }), NOW);
    expect(prisma.githubPushRange.rows.every((x) => x.status === 'pending' && x.attempts === 0)).toBe(true);
    expect(client.compareAll).toHaveBeenCalledTimes(1);
    expect(r.counters.pendingRanges).toBe(2);
  });

  it('an ingestion error fails that range only', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({ commits: [commit('eee', 'x')], pages: 1, truncated: false });
    ingestion.ingest.mockRejectedValueOnce(new Error('db down'));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(prisma.githubPushRange.rows[0].lastError).toMatch(/db down/);
    expect(r.status).toBe('success'); // discovery succeeded; the range is queued for retry
  });

  it('marks truncated Compares and still ingests what was returned', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({ commits: [commit('fff', 'x')], pages: 3, truncated: true, totalCommits: 400 });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ truncated: true, status: 'done' });
    expect(r.counters).toMatchObject({ truncatedRanges: 1, comparePages: 3 });
  });

  it('ignores ranges older than the replay window and other tenants\' ranges', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, { createdAt: new Date(NOW.getTime() - 8 * 86_400_000) });
    addRange(prisma, { tenantId: 't2' });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.compareAll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-audit-execute.spec.ts`
Expected: FAIL. No commit is ingested yet because `executePending` does not exist.

- [ ] **Step 3: Implement**

In `github-audit-sync.service.ts`, add these imports:
```ts
import { CodeCommitPayload } from '../../../common/events/contracts';
import { evaluateBudget } from './github-rate-budget';
import { buildCommitEnvelope, commitIdempotencyKey } from './github-commit-envelope';
import { GithubCompareResult } from './github.client';
import { GithubPushRange } from '@prisma/client';
```
Add the constant:
```ts
/** Shadow-mode ranges younger than this are replayed when the mode becomes `ingest`. */
export const SHADOW_REPLAY_MS = 7 * 86_400_000;
```
In `runTenant`, directly **after** the `if (!checkpoint?.seededAt) { … } else { … }` block and still inside the `try`, insert:
```ts
      // Independent of whether THIS window's discovery succeeded: ranges
      // queued by earlier runs are retried regardless.
      if (checkpoint?.seededAt) {
        await this.executePending(ctx);
      }
```
Add these methods to the class:
```ts
  private async executePending(ctx: RunContext): Promise<void> {
    const statuses = ctx.cfg.mode === 'ingest' ? ['pending', 'shadowed'] : ['pending'];
    const ranges = await this.prisma.githubPushRange.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: { in: statuses },
        createdAt: { gte: new Date(ctx.now.getTime() - SHADOW_REPLAY_MS) },
      },
      orderBy: { createdAt: 'asc' },
    });
    await forEachBounded(ranges, ctx.cfg.compareConcurrency, async (range) => {
      if (ctx.stopForBudget) return;
      await this.executeRange(ctx, range);
    });
    ctx.counters.pendingRanges = (
      await this.prisma.githubPushRange.findMany({ where: { tenantId: ctx.tenantId, status: { in: ['pending'] } } })
    ).length;
  }

  private async executeRange(ctx: RunContext, range: GithubPushRange): Promise<void> {
    const connection = [...ctx.repos.values()].find((c) => c.id === range.connectionId);
    const fail = async (message: string) => {
      const attempts = range.attempts + 1;
      const failed = attempts >= ctx.cfg.maxRangeAttempts;
      if (failed) ctx.counters.failedRanges++;
      await this.prisma.githubPushRange.update({
        where: { id: range.id },
        data: { attempts, status: failed ? 'failed' : 'pending', lastError: message.slice(0, 500) },
      });
    };
    if (!connection || !range.headSha) {
      await fail(connection ? 'Range has no head SHA.' : 'Connection is no longer active.');
      return;
    }
    try {
      const token = await this.collectorToken(ctx, connection);
      const compared = await this.compareRange(ctx, range, token);
      if (compared.failure === 'rate_limited') {
        ctx.stopForBudget = true;
        return;
      }
      if (compared.failure) {
        await fail(`Compare ${compared.failure}`);
        return;
      }
      ctx.counters.compareRequestsExecuted++;
      ctx.counters.comparePages += compared.pages;
      ctx.counters.commitsDiscovered += compared.commits.length;
      if (compared.truncated) ctx.counters.truncatedRanges++;
      ctx.counters.coreRateRemaining = compared.rateLimit?.remaining ?? ctx.counters.coreRateRemaining;

      let alreadyPresent = 0;
      let ingested = 0;
      for (const c of compared.commits) {
        if (!c.authorLogin) ctx.counters.commitsWithoutLogin++;
        const key = commitIdempotencyKey(range.repoFullName, c.sha);
        const existing = await this.prisma.rawEvent.findUnique({
          where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId, idempotencyKey: key } },
          select: { id: true },
        });
        if (existing) {
          alreadyPresent++;
          continue;
        }
        if (ctx.cfg.mode === 'shadow') {
          ctx.counters.wouldIngest++;
          continue;
        }
        const detail = await this.client.getCommitDetail(range.repoFullName, token, c.sha);
        if (detail.rateLimitedUntil && detail.additions === undefined) {
          // No stats to write and quota gone: leave the range pending. Commits
          // already ingested above are dropped as duplicates on the retry.
          ctx.stopForBudget = true;
          ctx.counters.alreadyPresent += alreadyPresent;
          ctx.counters.ingested += ingested;
          return;
        }
        const payload: CodeCommitPayload = {
          repoFullName: range.repoFullName,
          sha: c.sha,
          message: c.message,
          authorLogin: c.authorLogin,
          authorName: c.authorName,
          authorEmail: c.authorEmail,
          authoredAt: c.authoredAt ?? ctx.now.toISOString(),
          committedAt: detail.committedAt ?? c.committedAt,
          additions: detail.additions,
          deletions: detail.deletions,
          filesChanged: detail.filesChanged,
          parentCount: c.parentCount,
        };
        const result = await this.ingestion.ingest(
          ctx.tenantId,
          buildCommitEnvelope({
            connectionId: connection.id,
            mode: 'poll',
            repoFullName: range.repoFullName,
            payload,
            extraRefs: { ref: range.ref, discoveredBy: 'github-audit-compare', pushRangeId: range.id },
          }),
        );
        if (result.status === 'accepted') ingested++;
        else alreadyPresent++;
        if (detail.rateLimitedUntil) ctx.stopForBudget = true;
      }
      ctx.counters.alreadyPresent += alreadyPresent;
      ctx.counters.ingested += ingested;
      await this.prisma.githubPushRange.update({
        where: { id: range.id },
        data: {
          status: ctx.cfg.mode === 'shadow' ? 'shadowed' : 'done',
          commitsFound: compared.commits.length,
          alreadyPresent,
          ingested,
          truncated: compared.truncated,
          lastError: null,
        },
      });
      if (evaluateBudget({ rateLimit: compared.rateLimit }).exhausted) {
        ctx.stopForBudget = true;
      }
    } catch (err) {
      await fail((err as Error).message);
    }
  }

  /** Compare base...head; a `moved` range whose base is gone falls back to the default branch. */
  private async compareRange(ctx: RunContext, range: GithubPushRange, token: string): Promise<GithubCompareResult> {
    const base = range.baseSha ?? range.baseRef;
    const head = range.headSha as string;
    if (!base) {
      return { commits: [], pages: 0, truncated: false, failure: 'failed' };
    }
    const first = await this.client.compareAll(range.repoFullName, token, base, head);
    if (first.failure !== 'not_found' || range.kind !== 'moved') {
      return first;
    }
    const marker = await this.prisma.githubRefTip.findUnique({
      where: {
        tenantId_repoFullName_ref: { tenantId: ctx.tenantId, repoFullName: range.repoFullName, ref: DEFAULT_BRANCH_MARKER },
      },
    });
    return marker ? this.client.compareAll(range.repoFullName, token, marker.sha, head) : first;
  }
```

- [ ] **Step 4: Run both sync specs**

Run: `npx jest src/collectors/sources/github/github-audit-execute.spec.ts src/collectors/sources/github/github-audit-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/collectors/sources/github/github-audit-* 2>&1 | grep -v 'Delete \`␍\`'`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit-sync.service.ts backend/src/collectors/sources/github/github-audit-execute.spec.ts
git commit -m "feat(collectors): execute audit ranges through Compare into the ingestion pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Scheduler and module wiring

**Files:**
- Create: `backend/src/collectors/scheduler/github-audit-scheduler.service.ts`
- Create: `backend/src/collectors/scheduler/github-audit-scheduler.service.spec.ts`
- Modify: `backend/src/collectors/collectors.module.ts` (register `GithubAuditLogClient`, `GithubAuditSyncService`, `GithubAuditReportService` (Task 11), and `GithubAuditSchedulerService`; export `GithubAuditSyncService` and `GithubAuditReportService`)

**Interfaces:**
- Consumes: `GithubAuditSyncService.runTenant`/`listEnabledTenants` (T8); `readGithubAuditConfig`, `auditCronExpression` (T2); `TenantContextService.runWithTenant` (existing)
- Produces: `GithubAuditSchedulerService.tick(): Promise<void>`; `AUDIT_SWEEP_KEY = 'github-audit'`; `AUDIT_CRON` (module-load constant)

The guard reuses the `SchedulerTick` row keyed `github-audit`. `ConnectionsService.getSyncStatus` looks ticks up by source name, so the extra row is ignored there. Stale-after is 2× the interval (minimum 10 min), so a killed process unblocks quickly.

- [ ] **Step 1: Write the failing test**

`github-audit-scheduler.service.spec.ts`:
```ts
import { GithubAuditSchedulerService } from './github-audit-scheduler.service';

function setup(tick: Record<string, unknown> | null = null) {
  const prisma = {
    schedulerTick: {
      findUnique: jest.fn().mockResolvedValue(tick),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sync = {
    listEnabledTenants: jest.fn().mockResolvedValue(['t1', 't2']),
    runTenant: jest.fn().mockResolvedValue({ status: 'success' }),
  };
  const tenantContext = { runWithTenant: jest.fn(async (_t: string, fn: () => Promise<unknown>) => fn()) };
  const svc = new GithubAuditSchedulerService(prisma as never, sync as never, tenantContext as never);
  return { prisma, sync, tenantContext, svc };
}

describe('GithubAuditSchedulerService', () => {
  const env = process.env;
  afterEach(() => { process.env = env; });

  it('does nothing when the mode is off (the default)', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: '' };
    const { svc, sync, prisma } = setup();
    await svc.tick();
    expect(sync.listEnabledTenants).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.upsert).not.toHaveBeenCalled();
  });

  it('runs every enabled tenant inside its own tenant context and closes the sweep', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, tenantContext, prisma } = setup();
    await svc.tick();
    expect(tenantContext.runWithTenant.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
    expect(prisma.schedulerTick.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { sourceSystem: 'github-audit' }, data: expect.objectContaining({ finishedAt: expect.any(Date) }) }),
    );
  });

  it('skips the tick while a recent sweep is still open', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync } = setup({ startedAt: new Date(Date.now() - 60_000), finishedAt: null });
    await svc.tick();
    expect(sync.runTenant).not.toHaveBeenCalled();
  });

  it('one tenant failing does not stop the others, and the sweep still closes', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, prisma } = setup();
    sync.runTenant.mockRejectedValueOnce(new Error('boom'));
    await svc.tick();
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
    expect(prisma.schedulerTick.update).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/scheduler/github-audit-scheduler.service.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`github-audit-scheduler.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import {
  auditCronExpression,
  readGithubAuditConfig,
} from '../sources/github/github-audit.config';
import { GithubAuditSyncService } from '../sources/github/github-audit-sync.service';

export const AUDIT_SWEEP_KEY = 'github-audit';

/**
 * The decorator needs its expression at module load. `validateEnv` has already
 * rejected an invalid interval before Nest instantiates anything; the fallback
 * only keeps an import in a test or script from throwing.
 */
const AUDIT_CRON = (() => {
  try {
    return auditCronExpression(readGithubAuditConfig().intervalMinutes);
  } catch {
    return auditCronExpression(5);
  }
})();

/**
 * Drives the GitHub audit-log sync (ADR-0010) on its own cadence
 * (`GITHUB_AUDIT_SYNC_INTERVAL_MINUTES`, default 5), independent of the
 * per-connection collector sweep. Tenants run one after another: the audit
 * bucket is per token and each tenant's run already bounds its own Compare
 * concurrency.
 */
@Injectable()
export class GithubAuditSchedulerService {
  private readonly logger = new Logger(GithubAuditSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GithubAuditSyncService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Cron(AUDIT_CRON)
  async tick(): Promise<void> {
    const cfg = readGithubAuditConfig();
    if (cfg.mode === 'off') {
      return;
    }
    const staleAfterMs = Math.max(10, cfg.intervalMinutes * 2) * 60_000;
    const open = await this.prisma.schedulerTick.findUnique({ where: { sourceSystem: AUDIT_SWEEP_KEY } });
    if (open?.startedAt && !open.finishedAt && Date.now() - open.startedAt.getTime() < staleAfterMs) {
      this.logger.log('GitHub audit sync still running — skipping this tick.');
      return;
    }

    const tenants = await this.sync.listEnabledTenants();
    await this.prisma.schedulerTick.upsert({
      where: { sourceSystem: AUDIT_SWEEP_KEY },
      create: { sourceSystem: AUDIT_SWEEP_KEY, startedAt: new Date(), finishedAt: null, totalConnections: tenants.length, connectionsProcessed: 0 },
      update: { startedAt: new Date(), finishedAt: null, totalConnections: tenants.length, connectionsProcessed: 0 },
    });
    try {
      for (const tenantId of tenants) {
        try {
          await this.tenantContext.runWithTenant(tenantId, () => this.sync.runTenant(tenantId, cfg));
        } catch (err) {
          this.logger.error(`GitHub audit sync failed for tenant ${tenantId}: ${(err as Error).message}`);
        }
      }
    } finally {
      await this.prisma.schedulerTick.update({
        where: { sourceSystem: AUDIT_SWEEP_KEY },
        data: { finishedAt: new Date() },
      });
    }
  }
}
```

In `collectors.module.ts`, import the four classes and add them to `providers`:
```ts
    GithubAuditLogClient,
    GithubAuditSyncService,
    GithubAuditReportService,
    GithubAuditSchedulerService,
```
Add `GithubAuditSyncService` and `GithubAuditReportService` to `exports`. (`GithubAuditReportService` is created in Task 11. If you run Task 10 alone first, add it in Task 11 instead.)

Check whether `runWithTenant`'s callback signature is `() => Promise<T>`. If it takes no return value, wrap the call: `async () => { await this.sync.runTenant(tenantId, cfg); }`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx jest src/collectors/scheduler/github-audit-scheduler.service.spec.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/scheduler/github-audit-scheduler.service.ts backend/src/collectors/scheduler/github-audit-scheduler.service.spec.ts backend/src/collectors/collectors.module.ts
git commit -m "feat(collectors): schedule the GitHub audit sync on a configurable interval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: IST-day report, admin endpoints, audit-token secret ref

**Files:**
- Create: `backend/src/collectors/sources/github/github-audit-report.service.ts`
- Create: `backend/src/collectors/sources/github/github-audit-report.service.spec.ts`
- Modify: `backend/src/modules/configurations/configuration-catalog.ts` (adds the `auditLogTokenRef` field to the `github` section, after `tokenRef`)
- Modify: `backend/src/modules/configurations/configurations.controller.ts` (2 endpoints + constructor injection)
- Modify: `backend/src/modules/configurations/configurations.controller.spec.ts` if it exists. Otherwise, cover the endpoints through the report spec plus the typecheck.

**Interfaces:**
- Consumes: `istDayStart`, `istDayEnd` (`common/time`); `AuditRunCounters`, `emptyCounters` (T8); `GithubAuditSyncService.runTenant` (T8); `DeveloperIdentityService.attributionIndex(tenantId)` (existing; returns `byLogin`, `byEmail`, `displayNames`, `excluded`)
- Produces:
```ts
export interface AuditDayReport {
  day: string; runs: number; failedRuns: number; totals: AuditRunCounters;
  ranges: { pending: number; shadowed: number; done: number; failed: number; truncated: number };
  repositoriesAffected: number; branchesAffected: number;
  auditCommits: Array<{ repoFullName: string; sha: string; authorLogin?: string; authorEmail?: string; ref?: string }>;
  checkpoint: { checkpointAt: Date | null; seededAt: Date | null; lastStatus: string | null; lastError: string | null } | null;
}
@Injectable() export class GithubAuditReportService { dayReport(tenantId: string, day: string): Promise<AuditDayReport> }
// controller:
POST /admin/configurations/github/audit-sync/run          → AuditRunSummary (ADMIN, audit-logged)
GET  /admin/configurations/github/audit-commit-report?day=YYYY-MM-DD → AuditDayReport & { unattributedCommits: number }
```

`auditCommits` are the raw commit events this route **ingested** (`envelope.externalRefs.discoveredBy = 'github-audit-compare'`) whose `occurredAt` (authored time) falls on IST day `day`. They are read from `collectors_raw_event`, the collector's own table. `unattributedCommits` is computed in the controller, which already depends on the correlation context: a commit is unattributed when it has no login and its lowercased email is not in `attributionIndex.byEmail`. The collector never decides identity.

- [ ] **Step 1: Write the failing test**

`github-audit-report.service.spec.ts`:
```ts
import { GithubAuditReportService } from './github-audit-report.service';

describe('GithubAuditReportService.dayReport', () => {
  it('sums run counters for the IST day, counts ranges, and lists audit-ingested commits — tenant-scoped', async () => {
    const calls: unknown[] = [];
    const rec = (result: unknown) => jest.fn(async (args: unknown) => { calls.push(args); return result; });
    const prisma = {
      githubAuditRun: {
        findMany: rec([
          { status: 'success', counters: { auditEvents: 10, uniquePushes: 9, compareCandidatesNaive: 9, compareRequestsPlanned: 3, ingested: 2 } },
          { status: 'failed', counters: { auditEvents: 0 } },
        ]),
      },
      githubPushRange: {
        findMany: rec([
          { status: 'done', truncated: false, repoFullName: 'a/ehr', ref: 'x' },
          { status: 'pending', truncated: true, repoFullName: 'a/ehr', ref: 'y' },
          { status: 'failed', truncated: false, repoFullName: 'a/amma', ref: 'x' },
        ]),
      },
      rawEvent: {
        findMany: rec([
          { envelope: { externalRefs: { repo: 'a/ehr', sha: '0defa5a6e4', ref: 'ACT-92441-aot-induction' }, data: { authorLogin: 'arun', authorEmail: 'a@x' } } },
        ]),
      },
      githubAuditCheckpoint: { findUnique: rec({ checkpointAt: new Date('2026-10-06T04:00:00Z'), seededAt: null, lastStatus: 'success', lastError: null }) },
    };
    const svc = new GithubAuditReportService(prisma as never);
    const r = await svc.dayReport('t1', '2026-10-05');

    expect(r.runs).toBe(2);
    expect(r.failedRuns).toBe(1);
    expect(r.totals).toMatchObject({ auditEvents: 10, compareCandidatesNaive: 9, compareRequestsPlanned: 3, ingested: 2 });
    expect(r.ranges).toEqual({ pending: 1, shadowed: 0, done: 1, failed: 1, truncated: 1 });
    expect(r.repositoriesAffected).toBe(2);
    expect(r.branchesAffected).toBe(3);
    expect(r.auditCommits).toEqual([
      { repoFullName: 'a/ehr', sha: '0defa5a6e4', ref: 'ACT-92441-aot-induction', authorLogin: 'arun', authorEmail: 'a@x' },
    ]);
    for (const c of calls) expect(JSON.stringify(c)).toContain('"tenantId":"t1"');
    const runWhere = (prisma.githubAuditRun.findMany.mock.calls[0][0] as { where: { startedAt: { gte: Date; lte: Date } } }).where;
    expect(runWhere.startedAt.gte.toISOString()).toBe('2026-10-04T18:30:00.000Z');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/collectors/sources/github/github-audit-report.service.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the report service**

`github-audit-report.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { istDayEnd, istDayStart } from '../../../common/time';
import { PrismaService } from '../../../database/prisma.service';
import { AuditRunCounters, emptyCounters } from './github-audit-sync.service';

export interface AuditDayReport {
  day: string;
  runs: number;
  failedRuns: number;
  totals: AuditRunCounters;
  ranges: { pending: number; shadowed: number; done: number; failed: number; truncated: number };
  repositoriesAffected: number;
  branchesAffected: number;
  auditCommits: Array<{ repoFullName: string; sha: string; authorLogin?: string; authorEmail?: string; ref?: string }>;
  checkpoint: { checkpointAt: Date | null; seededAt: Date | null; lastStatus: string | null; lastError: string | null } | null;
}

/**
 * "Did the audit route find the commits the other routes missed?" for one IST
 * day (spec §7). Reads only BC-1's own tables; identity attribution is added
 * by the admin controller, which owns that cross-context read.
 */
@Injectable()
export class GithubAuditReportService {
  constructor(private readonly prisma: PrismaService) {}

  async dayReport(tenantId: string, day: string): Promise<AuditDayReport> {
    const from = istDayStart(day);
    const to = istDayEnd(day);
    const [runs, ranges, raw, checkpoint] = await Promise.all([
      this.prisma.githubAuditRun.findMany({ where: { tenantId, startedAt: { gte: from, lte: to } } }),
      this.prisma.githubPushRange.findMany({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
      this.prisma.rawEvent.findMany({
        where: {
          tenantId,
          eventType: 'code.commit.pushed',
          occurredAt: { gte: from, lte: to },
          envelope: { path: ['externalRefs', 'discoveredBy'], equals: 'github-audit-compare' },
        },
        select: { envelope: true },
      }),
      this.prisma.githubAuditCheckpoint.findUnique({ where: { tenantId } }),
    ]);

    const totals = emptyCounters();
    for (const run of runs) {
      const c = (run.counters ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(totals) as (keyof AuditRunCounters)[]) {
        if (typeof c[key] === 'number' && !key.endsWith('RateRemaining')) {
          (totals[key] as number) += c[key] as number;
        }
      }
    }
    const count = (status: string) => ranges.filter((r) => r.status === status).length;

    return {
      day,
      runs: runs.length,
      failedRuns: runs.filter((r) => r.status === 'failed').length,
      totals,
      ranges: {
        pending: count('pending'),
        shadowed: count('shadowed'),
        done: count('done'),
        failed: count('failed'),
        truncated: ranges.filter((r) => r.truncated).length,
      },
      repositoriesAffected: new Set(ranges.map((r) => r.repoFullName)).size,
      branchesAffected: new Set(ranges.map((r) => `${r.repoFullName}:${r.ref}`)).size,
      auditCommits: raw.map((r) => {
        const env = r.envelope as { externalRefs?: Record<string, string>; data?: Record<string, string | undefined> };
        return {
          repoFullName: env.externalRefs?.repo ?? '',
          sha: env.externalRefs?.sha ?? '',
          ref: env.externalRefs?.ref,
          authorLogin: env.data?.authorLogin,
          authorEmail: env.data?.authorEmail,
        };
      }),
      checkpoint: checkpoint
        ? { checkpointAt: checkpoint.checkpointAt, seededAt: checkpoint.seededAt, lastStatus: checkpoint.lastStatus, lastError: checkpoint.lastError }
        : null,
    };
  }
}
```

- [ ] **Step 4: Add the catalog field and the endpoints**

In `configuration-catalog.ts`, add to the `github` section's `fields`, right after the `tokenRef` entry:
```ts
      {
        key: 'auditLogTokenRef',
        label: 'Audit-log token secret ref',
        kind: 'secret-ref',
        helper:
          'Org-owner classic PAT with read:audit_log, SSO-authorized for the org. Used ONLY to read git.push events from the org audit log (ADR-0010); every other GitHub call keeps using the token above. Env var name only (e.g. GITHUB_AUDIT_TOKEN).',
      },
```
Confirm that the configurations service stores `secret-ref` fields in `secretRefs` by key, exactly as it does for `tokenRef`: grep `kind === 'secret-ref'` in `configurations.service.ts`. The sync reads `secretRefs.auditLogTokenRef`.

In `configurations.controller.ts`:
- Add `Query` to the `@nestjs/common` import.
- Import `GithubAuditSyncService` and `GithubAuditReportService` from `../../collectors/sources/github/...`.
- Inject both in the constructor before the `@Optional() audit` parameter: `private readonly auditSync: GithubAuditSyncService, private readonly auditReport: GithubAuditReportService,`.
- Add these endpoints next to `backfill-pr-commits`:
```ts
  /**
   * Run the GitHub audit-log sync once for this tenant, now (ADR-0010). Uses
   * the deployment's GITHUB_AUDIT_SYNC_MODE — a `shadow` deployment cannot be
   * talked into ingesting from here.
   */
  @Roles(Role.ADMIN)
  @Post('github/audit-sync/run')
  async runAuditSync(@CurrentUser() user: AuthUser) {
    const summary = await this.auditSync.runTenant(user.tenantId);
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'collectors.github_audit_sync.run',
      targetType: 'github_audit_run',
      targetId: summary.runId,
      metadata: { status: summary.status, counters: summary.counters },
    });
    return summary;
  }

  /**
   * One IST day of the audit route: what it saw, planned, fetched and ingested,
   * and how many of its commits nobody can be attributed to. Unattributed is
   * reported as unattributed — never as anyone being idle.
   */
  @Roles(Role.ADMIN)
  @Get('github/audit-commit-report')
  async auditCommitReport(@CurrentUser() user: AuthUser, @Query('day') day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
      throw new BadRequestException('day must be YYYY-MM-DD (IST).');
    }
    const [report, index] = await Promise.all([
      this.auditReport.dayReport(user.tenantId, day),
      this.identities.attributionIndex(user.tenantId),
    ]);
    const unattributedCommits = report.auditCommits.filter(
      (c) => !c.authorLogin && !(c.authorEmail && index.byEmail.has(c.authorEmail.toLowerCase())),
    ).length;
    return { ...report, unattributedCommits };
  }
```
Use the `AuthUser` property the existing code uses for the user id: grep `actorId:` in this controller. If it is `user.sub` or `user.id`, use that.

If `configurations.controller.spec.ts` constructs the controller positionally, add two `{} as never` arguments in the right positions so it still compiles.

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `npx jest src/collectors/sources/github/github-audit-report.service.spec.ts src/modules/configurations && npx tsc --noEmit -p tsconfig.json && npx eslint src/collectors/sources/github/github-audit-report.service.ts src/modules/configurations/configurations.controller.ts src/modules/configurations/configuration-catalog.ts 2>&1 | grep -v 'Delete \`␍\`'`
Expected: PASS, zero errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/collectors/sources/github/github-audit-report.service.ts backend/src/collectors/sources/github/github-audit-report.service.spec.ts backend/src/modules/configurations backend/src/collectors/collectors.module.ts
git commit -m "feat(admin): add audit-sync run and IST-day report endpoints and the audit token ref

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation (same change set; CLAUDE.md "Documentation First")

**Files:**
- Create: `docs/ADR/0010-github-audit-log-commit-discovery.md`
- Modify: `docs/ADR/README.md` (index row after line 32, the 0009 row)
- Modify: `docs/api/README.md` (§3 bullet, §9 endpoints, gap #51 row ~line 378, new gap rows 55–57 at the top of the §12 table)
- Modify: `docs/architecture/PRODUCT-ARCHITECTURE.md` (BC-1 section: a third commit-discovery route) and `docs/architecture/DATA-MODEL.md` (4 tables)
- Modify: `docs/deployment/README.md` (§5 env vars and secrets; a new §6.5 rollout)
- Modify: `docs/features/NOTIFICATIONS.md` (§4, one paragraph)

There is no test cycle for docs. The gate is a consistency read: every env var, endpoint and table name in the docs must match the code from Tasks 2–11 exactly.

- [ ] **Step 1: Write ADR-0010**

`docs/ADR/0010-github-audit-log-commit-discovery.md`:
```markdown
# ADR-0010: Discover branch-only commits from the GitHub org audit log

- **Status:** Accepted — Phase 1 implemented 2026-10-06 (shadow mode first)
- **Date:** 2026-10-06
- **Deciders:** Product owner, engineering
- **Related:** [ADR-0008](0008-github-graphql-over-webhooks.md), [ADR-0009](0009-attributed-commit-digest.md), [api/README.md §3, §12 #51](../api/README.md), [design spec](../superpowers/specs/2026-10-06-github-audit-log-commit-discovery-design.md), [handover](../superpowers/specs/2026-09-29-commit-completeness-handover.md)

## Context

Commits reached `code_commit` by two routes: the default-branch walk and the PR commit harvest. A commit pushed to a non-default branch and never in a PR was invisible to both (gap #51). On 25 Sep 2026 the daily digest (ADR-0009) named at least 6 of 27 developers who had committed that day. The handover proposed a git mirror. Before building infrastructure, the cheaper option was to use GitHub's own record of every push: the Organization Audit Log.

Verified on 2026-10-06:
- `git.push` entries carry **no ref and no before/after SHA**. They give the repo, actor, `@timestamp` and `_document_id`.
- Git events are kept **7 days**, are REST-only, and **exclude pushes made through the web UI or API**.
- The audit log needs an org-owner token with `read:audit_log`. The collector token is refused. It has its own 1,750/h bucket.
- `git/matching-refs/heads/` returns every branch tip of a repo in one call (`ehr`: 1,474).

## Decision

Add a third discovery route inside BC-1 that feeds the existing ingestion pipeline:

1. **Detect.** Every `GITHUB_AUDIT_SYNC_INTERVAL_MINUTES` (default 5; 5/10/15/20/30/60), read `git.push` events since `checkpoint − overlap`, following `Link rel="next"` verbatim until it is absent. Only a complete window is used.
2. **Record.** Each push becomes a raw `code.push.observed` event (`github:audit:{_document_id}`). This is lineage that outlives GitHub's retention.
3. **Plan.** For each registered repo pushed to, diff current branch tips against the tips stored last run. Each moved ref yields one Compare `old...new`. A new ref compares against the default branch. A deleted ref is recorded only. This is the consolidated range: N pushes to one ref cost one Compare.
4. **Queue, then checkpoint.** Ranges are persisted (`collectors_github_push_range`) before the checkpoint advances.
5. **Fetch.** Compare is consumed to its last page with bounded concurrency. For commits not already collected, line stats come from `GET /commits/{sha}`. Commits are ingested with the same envelope and `github:{repo}:commit:{sha}` key as every other route.
6. **Modes.** `off` (default) | `shadow` (counts `wouldIngest`, writes no commit) | `ingest` (also replays the last 7 days of shadow ranges).

The existing walk and PR harvest are unchanged and keep running.

## Consequences

- Branch-only commits are collected for every push observed after the one-off **seeding pass**. Nothing before seeding is recovered by this route.
- **Known blind spots, documented rather than hidden:** web/API pushes (F6); refs created and deleted, or history force-pushed away, between two runs; Compare's 250-commit cap (flagged as `truncated`); outages longer than 7 days. Push lineage is per repo, not per ref.
- **Historical figures move** once ingest is enabled. That is a restatement, and it must be announced.
- New secret: an org-owner token, used only for the audit call. New tables: 4 (DATA-MODEL.md). Expected `core` spend is one `matching-refs` call per touched repo plus one Compare per moved ref plus one detail call per new commit, all under the rate reserve.
- The digest's gate 1 is unchanged. `dailyDigestEnabled` stays off until acceptance (spec §9) passes.

## Alternatives considered

- **Compare per audit event:** impossible, because the events carry no SHAs.
- **Events API `PushEvent`:** carries `before`/`head` but is per repo, capped at 300 events and lossy on busy repos. It is used only to build acceptance ground truth.
- **Webhooks:** deferred (ADR-0008).
- **Git mirror (Phase 2):** a complete enumeration of refs, but it needs `git`, disk and a fleet clone. Build it if acceptance or operation shows unexplained misses, misses from refs deleted or force-pushed between runs, a retention overrun, or tip-diff `core` spend that threatens the collectors.
```

Add to `docs/ADR/README.md` after the 0009 row:
```markdown
| [0010](0010-github-audit-log-commit-discovery.md) | Discover branch-only commits from the GitHub org audit log | Accepted |
```

- [ ] **Step 2: Update `docs/api/README.md`**

- In §3, after the bullet that begins "Commits are collected from two sources", add this bullet:
```markdown
- **A third commit source: the org audit log (ADR-0010).** `GithubAuditSyncService` reads `git.push` events from `GET /orgs/{org}/audit-log?include=git&phrase=action:git.push created:>=…&order=desc&per_page=100`, following `Link rel="next"` verbatim until it is absent (a partial window is never used). It records each push as `code.push.observed` (`github:audit:{_document_id}`), diffs the touched repos' branch tips (`git/matching-refs/heads/`, one call) against `collectors_github_ref_tip`, queues one Compare per moved ref in `collectors_github_push_range`, advances the checkpoint, and then consumes each Compare to its last page. Commits ingest under the shared `github:{repo}:commit:{sha}` key, with `externalRefs.discoveredBy = github-audit-compare`, `ref` and `pushRangeId` as lineage. Modes are `off`/`shadow`/`ingest` (`GITHUB_AUDIT_SYNC_MODE`). The audit call uses its own token (`auditLogTokenRef`) and its own `audit_log` rate bucket. Compare, refs and detail calls use the collector token and respect the rate reserve.
```
- In §9, next to `backfill-pr-commits`, add `POST /admin/configurations/github/audit-sync/run` (ADMIN, audit-logged; returns run counters) and `GET /admin/configurations/github/audit-commit-report?day=YYYY-MM-DD` (ADMIN; IST-day counters, ranges, audit-ingested commits, `unattributedCommits`).
- In gap #51, change the status cell to `**Partly done** 2026-09-11; PR-harvest truncation **fixed** 2026-09-29; branch-only commits **addressed** 2026-10-06 (shadow)`. Replace the sentence beginning "**Still open:** commits never in any PR (direct pushes to a non-default branch) need the ref-aware walk;" with:
```markdown
**Branch-only commits, 2026-10-06:** addressed by the audit-log route (ADR-0010, §3), behind `GITHUB_AUDIT_SYNC_MODE`, which ships in `shadow` until acceptance (design spec §9) passes; see #55–#57 for its documented blind spots. **Still open:** PRs over 250 commits under REST (use GraphQL), and over ~520 under GraphQL, lose their oldest commits beyond the cap (logged by repo).
```
- Add three rows at the top of the §12 table (above #54):
```markdown
| 57 | Audit-log route: Compare returns at most 250 commits per range | GitHub | **Open — flagged** 2026-10-06 | A moved ref with more new commits than GitHub's Compare cap (typically a new branch cut from an old release branch, compared against the default branch) is ingested up to the cap and marked `truncated` on `collectors_github_push_range` and in the day report. Never presented as complete. The commits are still reachable by the walk or PR harvest if they land on the default branch or in a PR. |
| 56 | Audit-log route: git events exclude web/API pushes and are kept 7 days | GitHub | **Open — by design** 2026-10-06 | GitHub's audit log omits pushes made through the browser or REST/GraphQL API (PR merges, web-editor commits), and keeps git events for 7 days. PR merges stay covered by the walk and PR harvest. A web-editor commit to a branch is caught only when a later git push to the same repo makes the tip diff see the moved ref. A sync outage over 7 days loses that window: runs flag `Retention risk` from 6 days. |
| 55 | Audit-log route: refs created and deleted, or force-pushed away, between two runs are never seen | GitHub | **Open — by design** 2026-10-06 | The route learns what moved by diffing branch tips each run (`git.push` events carry no ref or SHA). Commits that exist only on a ref born and deleted between two runs (default 5 min apart), or that were force-pushed away between runs, are never at any observed tip. This is a Phase 2 (git mirror) trigger if acceptance measures it at a rate that matters. Also: a repo's first push before it was seeded is left to the other routes. |
```

- [ ] **Step 3: Update the architecture and data-model docs**

- `PRODUCT-ARCHITECTURE.md`: in the BC-1 Collectors section, add one paragraph naming the three commit-discovery routes (default-branch walk, PR harvest, audit-log push discovery), stating that all three converge on one key through the single ingestion pipeline, and linking ADR-0010.
- `DATA-MODEL.md`: add a "BC-1 GitHub audit sync" subsection listing `collectors_github_audit_checkpoint`, `collectors_github_audit_run`, `collectors_github_push_range` and `collectors_github_ref_tip`, with their purpose, key columns and the tenant-scoping note (copy the model doc comments from Task 7), and note that `code.push.observed` raw events live in `collectors_raw_event`.

- [ ] **Step 4: Update `docs/deployment/README.md`**

- §5: add a table of the `GITHUB_AUDIT_*` variables (names, defaults and ranges exactly as in Task 2) plus `GITHUB_AUDIT_TOKEN`, described as an org-owner **classic** PAT with `read:audit_log`, SSO-authorized for the org. Note that it is referenced via the GitHub configuration's "Audit-log token secret ref" and is never the collector token.
- A new §6.5 "GitHub audit-log commit discovery rollout (ADR-0010)", with this content:
  1. Apply migration `20261006120000_add_github_audit_sync`. On the host: `npx prisma migrate status`, then `npx prisma migrate deploy`, stopping the backend before `prisma generate`.
  2. Set `GITHUB_AUDIT_TOKEN` in `backend/.env` and save `auditLogTokenRef = GITHUB_AUDIT_TOKEN` in Admin → Configuration → GitHub.
  3. Set `GITHUB_AUDIT_SYNC_MODE=shadow` and restart (`rm -rf dist`, then build and restart). The first run is the **seeding pass**: about 198 `matching-refs` calls, no Compare.
  4. Check `GET …/github/audit-commit-report?day=` daily against ground truth (spec §9) for several days.
  5. Set `ingest` and restart. Ranges shadowed in the last 7 days are replayed, and historical figures move, so **announce it**.
  6. Rollback: set `off`. Ingested commits remain (idempotent keys, full lineage).
  7. Signals to watch: run `status` and `Retention risk` in logs, `failedRanges`, `pendingRanges` growth, `truncatedRanges`, `coreRateRemaining`/`auditRateRemaining`, run duration.
  8. Keep `dailyDigestEnabled` off until acceptance passes.

- [ ] **Step 5: Update `docs/features/NOTIFICATIONS.md` §4**

Append one paragraph: the audit-log route (ADR-0010) adds commits, and does not change any gate. Gate 1 still reads only connection freshness. The digest stays disabled until the route's acceptance (design spec §9) has passed. Commits the route ingests are attributed by the same `attributionIndex` and, if unresolved, are counted in `unattributedCommits`, never treated as anyone being idle.

- [ ] **Step 6: Consistency read**

Run: `grep -rn "GITHUB_AUDIT_\|audit-sync/run\|audit-commit-report\|collectors_github_" docs backend/.env.example | sort`
Expected: every name matches the code from Tasks 2, 7 and 11, with no stray spellings.

- [ ] **Step 7: Commit**

```bash
git add docs/ADR/0010-github-audit-log-commit-discovery.md docs/ADR/README.md docs/api/README.md docs/architecture docs/deployment/README.md docs/features/NOTIFICATIONS.md
git commit -m "docs: record the audit-log commit discovery route (ADR-0010, gap #51, #55-57)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Full verification, live shadow check, PR

**Files:** none new.

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && npx jest`
Expected: all suites pass. Compare the count against the baseline on `fix/pr-commit-truncation` (run once first). There must be no new failures.

- [ ] **Step 2: Typecheck, lint, build**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint "src/collectors/**/*.ts" "src/common/concurrency.ts" "src/config/env.validation.ts" "src/modules/configurations/*.ts" 2>&1 | grep -v 'Delete `␍`'
rm -rf dist && npx nest build
```
Expected: no type errors; zero lint errors (the baseline 3 `no-explicit-any` warnings may remain, plus the one disabled in the fakes file); the build succeeds. If `rm -rf dist` fails with EPERM (OneDrive or a running server), stop and tell the user. Do not build over a running server.

- [ ] **Step 3: Secrets check**

Run: `git diff fix/pr-commit-truncation --stat && git diff fix/pr-commit-truncation | grep -nE "ghp_|github_pat_|Authorization: Bearer [A-Za-z0-9]" || echo clean`
Expected: `clean`. No token in the code, tests or docs. `.env` stays git-ignored.

- [ ] **Step 4: Live shadow smoke test (local, read-only against GitHub). Requires the user's go-ahead.**

Only if the user confirms the local DB may receive the migration: apply it locally (`npx prisma migrate deploy` against the local `DATABASE_URL` the user confirms), set `GITHUB_AUDIT_SYNC_MODE=shadow`, add the GitHub configuration's `auditLogTokenRef=GITHUB_AUDIT_TOKEN`, and start the backend. Then call `POST /api/admin/configurations/github/audit-sync/run` twice, with the admin login per DEVELOPER-ONBOARDING:
- Run 1 is expected as `status: seeded`, `reposSeeded` ≈ the active connection count, and no audit call.
- Run 2 is expected as `status: success`, `auditPages ≥ 1`, `compareRequestsPlanned < compareCandidatesNaive` (or both 0 on a quiet window), and `wouldIngest`/`alreadyPresent` populated.

Record the numbers in the PR description. **Do not** switch to `ingest`, and do not touch the host. Host rollout follows deployment §6.5 and belongs to the user.

- [ ] **Step 5: Re-check PR #39, push, open the PR**

```bash
gh pr view 39 --json state -q .state
git push -u origin feat/github-audit-commit-discovery
gh pr create --base fix/pr-commit-truncation --title "feat(collectors): discover branch-only commits from the GitHub org audit log" --body "<summary of ADR-0010; test/lint/build results; shadow smoke numbers; what is unverified (host rollout, live acceptance day); reminder to rotate the token pasted in chat>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
If PR #39 has merged by then, rebase onto `main` (`git rebase --onto origin/main fix/pr-commit-truncation`) and target `main` instead. Ask the user before any push.
