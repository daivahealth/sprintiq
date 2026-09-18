# Daily Commit Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each working day at 10:30 IST, post to a Teams group the tracked developers who had no delivery activity on the previous working day.

**Architecture:** An admin-editable roster table holds who is tracked. A detection service subtracts the previous working day's active-developer set from that roster, using the *same* set function the Activity Overview board uses, so the two can never disagree. Delivery is an Adaptive Card posted to a Power Automate Workflows URL by a client in the Collector context. Three gates can withhold the names, and every run is recorded.

**Tech Stack:** NestJS 10, Prisma (PostgreSQL), `@nestjs/schedule`, native `fetch`, Jest. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-18-daily-commit-digest-design.md](../specs/2026-09-18-daily-commit-digest-design.md) — read it before Task 1; this plan argues from it.

## Global Constraints

- **Every query filters by `tenantId`.** No exceptions. Cron code passes `tenantId` explicitly — `TenantContextService.requireTenantId()` is request-scoped and unavailable in a scheduled job.
- **Exact parity with the Overview board is a hard requirement.** The active set must come from the shared `activeDeveloperSet()` function (Task 2). Never add a signal to the digest alone; widen the Overview and inherit it.
- **The Teams webhook URL is never logged, at any level.** It carries its credential in the query string (`&sig=…`).
- **The card must always display the rule it was computed from,** and must state that reviewing is not counted. This is a governance requirement (spec §3), not copy.
- **Names are sorted alphabetically by display name, never by any volume.** CLAUDE.md forbids volume ranking.
- **Ingested display names are untrusted** and must be markdown-escaped before embedding in a card.
- **New IDs use `newId()`** from `src/common/id.ts` (ULID), supplied on create.
- Lint verification is `npm run lint:ci`. **Never** use `npm run lint` to verify — it passes `--fix` and cannot fail.
- Migrations are **not** applied automatically on the host. Generate SQL; a human applies it.
- Commit after every task. Branch is `feat/daily-commit-digest`.

---

### Task 1: IST working-day helpers

`common/time.ts` owns every IST primitive but has neither the scheduler timezone constant nor "previous working day". The constant currently lives as a file-private `const IST_TIMEZONE = 'Asia/Kolkata';` at [collector-scheduler.service.ts:47](../../../backend/src/collectors/scheduler/collector-scheduler.service.ts#L47), which a second context cannot import.

Note the existing `workingDaysAgo()` in `developer-activity.service.ts` uses server-local `getDay()`. Do **not** copy that; compute weekday from the IST date key so the answer is correct regardless of server timezone.

**Files:**
- Modify: `backend/src/common/time.ts` (append)
- Modify: `backend/src/collectors/scheduler/collector-scheduler.service.ts:47`
- Test: `backend/src/common/time.spec.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `IST_TIMEZONE: string`, `previousWorkingDayKey(now?: Date): string` — returns a `YYYY-MM-DD` IST date key.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/common/time.spec.ts`:

```ts
import { IST_TIMEZONE, previousWorkingDayKey } from './time';

describe('previousWorkingDayKey', () => {
  // 2026-09-18 is a Friday; 19th Sat, 20th Sun, 21st Mon.
  it('returns the prior calendar day midweek', () => {
    // 10:30 IST on Friday 18 Sep = 05:00 UTC.
    expect(previousWorkingDayKey(new Date('2026-09-18T05:00:00.000Z'))).toBe(
      '2026-09-17',
    );
  });

  it('skips the weekend, so Monday reports Friday', () => {
    // The failure this exists to prevent: reporting Sunday on a Monday
    // morning names nearly the whole roster for a day nobody worked.
    expect(previousWorkingDayKey(new Date('2026-09-21T05:00:00.000Z'))).toBe(
      '2026-09-18',
    );
  });

  it('reports Friday from Saturday and from Sunday', () => {
    expect(previousWorkingDayKey(new Date('2026-09-19T05:00:00.000Z'))).toBe(
      '2026-09-18',
    );
    expect(previousWorkingDayKey(new Date('2026-09-20T05:00:00.000Z'))).toBe(
      '2026-09-18',
    );
  });

  it('is computed in IST, not server-local time', () => {
    // 19:00 UTC on Thursday 17th is already Friday 18th in IST, so the
    // previous working day is Thursday — not Wednesday. A server-local
    // getDay() implementation gets this wrong.
    expect(previousWorkingDayKey(new Date('2026-09-17T19:00:00.000Z'))).toBe(
      '2026-09-17',
    );
  });

  it('exposes the scheduler timezone', () => {
    expect(IST_TIMEZONE).toBe('Asia/Kolkata');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/common/time.spec.ts`
Expected: FAIL — `previousWorkingDayKey is not a function` / `IST_TIMEZONE` undefined.

- [ ] **Step 3: Implement**

Append to `backend/src/common/time.ts`:

```ts
/**
 * The timezone every IST-anchored cron pins itself to.
 *
 * Exported from here, beside the offset the rest of this file uses, so that a
 * second scheduler in a second context cannot hardcode its own copy of the
 * string and drift.
 */
export const IST_TIMEZONE = 'Asia/Kolkata';

/** Day-of-week (0 = Sunday) of an IST date key, independent of server locale. */
function istWeekday(key: string): number {
  return new Date(`${key}T00:00:00.000Z`).getUTCDay();
}

/**
 * The most recent Mon–Fri IST calendar day strictly before `now`.
 *
 * Working days rather than calendar days because the daily digest reports on
 * this window: a Monday run reporting Sunday would name almost the whole
 * roster for a day nobody was expected to work, which is the noise that makes
 * a daily notification ignored.
 *
 * Weekday is derived from the IST date key rather than `Date#getDay()`, which
 * answers in the server's timezone — on a UTC host, 19:00 Thursday UTC is
 * already Friday in IST, and the two implementations disagree.
 */
export function previousWorkingDayKey(now: Date = new Date()): string {
  let cursor = istDayStart(istDateKey(now));
  for (;;) {
    cursor = new Date(cursor.getTime() - 86_400_000);
    const key = istDateKey(cursor);
    const weekday = istWeekday(key);
    if (weekday !== 0 && weekday !== 6) {
      return key;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/common/time.spec.ts`
Expected: PASS.

- [ ] **Step 5: Point the collector scheduler at the shared constant**

In `backend/src/collectors/scheduler/collector-scheduler.service.ts`, delete line 47 (`const IST_TIMEZONE = 'Asia/Kolkata';`) and add `IST_TIMEZONE` to the existing import from `../../common/time`. If that file has no `common/time` import yet, add:

```ts
import { IST_TIMEZONE } from '../../common/time';
```

- [ ] **Step 6: Verify nothing broke**

Run: `cd backend && npx tsc --noEmit && npx jest src/collectors/scheduler && npm run lint:ci`
Expected: all PASS. The existing `@Cron` at line ~113 still resolves `IST_TIMEZONE`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/common/time.ts backend/src/common/time.spec.ts backend/src/collectors/scheduler/collector-scheduler.service.ts
git commit -m "feat(time): add previousWorkingDayKey and share IST_TIMEZONE"
```

---

### Task 2: One shared definition of "active developer"

This task is the parity requirement (spec §5.3). Today `overview()` accumulates `withSignal` inline across two loops. The digest must use the *same* definition, so it is extracted into a pure exported function that both callers use. After this task there is exactly one place that decides whether someone was active.

**Files:**
- Modify: `backend/src/metrics/developer-activity.service.ts` (add function near `attributeCommit` at ~line 1319; edit `overview()` at ~lines 390–445)
- Test: `backend/src/metrics/developer-activity.service.spec.ts` (append)

**Interfaces:**
- Consumes: `attributeCommit()` (already exported from this file).
- Produces:
  ```ts
  export function activeDeveloperSet(
    commits: readonly { authorLogin: string | null; authorEmail: string | null }[],
    prs: readonly { authorLogin: string | null }[],
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
  ): Set<string>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/metrics/developer-activity.service.spec.ts`:

```ts
import { activeDeveloperSet } from './developer-activity.service';

describe('activeDeveloperSet', () => {
  const index = {
    byLogin: new Map([['alice_athma', 'alice_athma']]),
    byEmail: new Map([['bob@example.com', 'bob_athma']]),
  };

  it('is the union of commit authors and PR authors', () => {
    // The Overview's "developers with a signal" tile counts both. A set built
    // from committers alone is a different, quietly narrower definition.
    const set = activeDeveloperSet(
      [{ authorLogin: 'alice_athma', authorEmail: null }],
      [{ authorLogin: 'carol_athma' }],
      index,
    );
    expect([...set].sort()).toEqual(['alice_athma', 'carol_athma']);
  });

  it('attributes a commit with no login through its email', () => {
    // GitHub omits author.login unless the commit email is verified on an
    // account, so this is the ordinary case, not an edge case.
    const set = activeDeveloperSet(
      [{ authorLogin: null, authorEmail: 'BOB@example.com' }],
      [],
      index,
    );
    expect([...set]).toEqual(['bob_athma']);
  });

  it('ignores a commit that cannot be attributed to anyone', () => {
    const set = activeDeveloperSet(
      [{ authorLogin: null, authorEmail: 'nobody@example.com' }],
      [],
      index,
    );
    expect(set.size).toBe(0);
  });

  it('ignores a PR with no author login', () => {
    const set = activeDeveloperSet([], [{ authorLogin: null }], index);
    expect(set.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/developer-activity.service.spec.ts -t activeDeveloperSet`
Expected: FAIL — `activeDeveloperSet is not a function`.

- [ ] **Step 3: Implement the function**

Add to `backend/src/metrics/developer-activity.service.ts`, immediately after `attributeCommit`:

```ts
/**
 * Who had a delivery signal in a window: commit authors ∪ PR authors.
 *
 * **The single definition of "active", used by both the Activity Overview
 * board and the daily digest notification.** It exists as one function
 * because these are the same claim on two surfaces, and the codebase has
 * already paid once for computing one number in two places — see the comment
 * above `planningGapDevelopers`, where Overview and Watchlist disagreed on
 * real data (3 versus 0).
 *
 * That matters more for the digest than for the board: the digest NAMES the
 * people who are absent from this set, so any signal the board counts and the
 * digest does not becomes a person wrongly named in a Teams channel. Widening
 * this set is a legitimate improvement; widening it for only one caller is
 * not, and is impossible while both go through here.
 */
export function activeDeveloperSet(
  commits: readonly {
    authorLogin: string | null;
    authorEmail: string | null;
  }[],
  prs: readonly { authorLogin: string | null }[],
  index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
): Set<string> {
  const active = new Set<string>();
  for (const commit of commits) {
    const person = attributeCommit(commit, index);
    if (person) {
      active.add(person);
    }
  }
  for (const pr of prs) {
    if (pr.authorLogin) {
      // Same fallback `attributeCommit` uses: a login is an identity even
      // before the resolution pass has reached it.
      active.add(index.byLogin.get(pr.authorLogin) ?? pr.authorLogin);
    }
  }
  return active;
}
```

- [ ] **Step 4: Refactor `overview()` to use it**

In `overview()`: delete the `const withSignal = new Set<string>();` declaration (~line 390) and both `withSignal.add(person);` statements (~lines 429 and 444). After the PR `for` loop closes and before the `openAssigned` await, insert:

```ts
    // One definition, shared with the daily digest — see `activeDeveloperSet`.
    const withSignal = activeDeveloperSet(commits, prs, index);
```

- [ ] **Step 5: Verify the refactor changed no behaviour**

Run: `cd backend && npx jest src/metrics && npx tsc --noEmit`
Expected: PASS, including every pre-existing `overview` test. `totals.developersWithSignal` must be unchanged — if a test fails here, the extraction is not equivalent; fix it rather than updating the test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/metrics/developer-activity.service.ts backend/src/metrics/developer-activity.service.spec.ts
git commit -m "refactor(metrics): extract activeDeveloperSet as the one definition of active"
```

---

### Task 3: Roster and run-record tables

**Files:**
- Modify: `backend/prisma/schema.prisma` (append near `WatchlistExclusion`, ~line 746)
- Create: `backend/prisma/migrations/20260918120000_add_commit_tracking_roster/migration.sql`

**Interfaces:**
- Produces: Prisma models `TrackedDeveloper` and `NoCommitDigestRun`; client accessors `prisma.trackedDeveloper` and `prisma.noCommitDigestRun`.

- [ ] **Step 1: Add the models**

Append to `backend/prisma/schema.prisma`:

```prisma
/// The editable roster of developers whose daily activity is tracked by the
/// digest notification.
///
/// Data rather than a code constant, for the same reason `DeveloperRole` and
/// `IdentityOverride` are: an admin adds a new joiner without a deploy, and
/// the entry carries the name of whoever added it.
model TrackedDeveloper {
  id                   String   @id
  tenantId             String
  /// Who this tracks, as `DeveloperIdentity.canonicalDeveloperId`.
  canonicalDeveloperId String
  /// The string the entry was ADDED as, kept verbatim. An entry whose
  /// identity never resolved stays displayable and diagnosable instead of
  /// reading as a developer who did nothing — the two are indistinguishable
  /// without this column, and one of them is a false accusation.
  addedAs              String
  /// Soft, so removing someone from the roster is a recorded act, not a gap.
  active               Boolean  @default(true)
  note                 String?
  createdByUserId      String
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([tenantId, canonicalDeveloperId])
  @@index([tenantId, active])
  @@map("notification_tracked_developer")
}

/// One row per reported day: what was evaluated, who was named, what was
/// delivered.
///
/// Lineage for a message that names people. "Why was I on Tuesday's list?"
/// must be answerable after the fact, and `@@unique([tenantId, reportedDay])`
/// is also the idempotency key — a restart or a redeploy at 10:30 cannot
/// double-post one day's list, because the second insert loses.
model NoCommitDigestRun {
  id           String    @id
  tenantId     String
  /// The IST calendar day reported on (YYYY-MM-DD).
  reportedDay  String
  /// sent | sent_all_clear | withheld_stale_data | withheld_truncated_read
  /// | withheld_implausible | failed
  outcome      String
  rosterCount  Int
  flaggedCount Int
  /// The exact list sent; roster entries whose identity did not resolve; and
  /// those withheld because their commit data for the day was incomplete.
  /// The latter two are reported, never counted as inactive.
  flagged      Json
  unresolved   Json
  incomplete   Json
  detail       String?
  deliveredAt  DateTime?
  createdAt    DateTime  @default(now())

  @@unique([tenantId, reportedDay])
  @@index([tenantId, createdAt])
  @@map("notification_no_commit_run")
}
```

- [ ] **Step 2: Write the migration SQL**

Create `backend/prisma/migrations/20260918120000_add_commit_tracking_roster/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "notification_tracked_developer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT NOT NULL,
    "addedAs" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_tracked_developer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_no_commit_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportedDay" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "rosterCount" INTEGER NOT NULL,
    "flaggedCount" INTEGER NOT NULL,
    "flagged" JSONB NOT NULL,
    "unresolved" JSONB NOT NULL,
    "incomplete" JSONB NOT NULL,
    "detail" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_no_commit_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_tracked_developer_tenantId_canonicalDeveloperId_key" ON "notification_tracked_developer"("tenantId", "canonicalDeveloperId");

-- CreateIndex
CREATE INDEX "notification_tracked_developer_tenantId_active_idx" ON "notification_tracked_developer"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "notification_no_commit_run_tenantId_reportedDay_key" ON "notification_no_commit_run"("tenantId", "reportedDay");

-- CreateIndex
CREATE INDEX "notification_no_commit_run_tenantId_createdAt_idx" ON "notification_no_commit_run"("tenantId", "createdAt");
```

- [ ] **Step 3: Generate the client and confirm the SQL matches the schema**

Run: `cd backend && npx prisma generate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"`

Expected: the diff reports no drift. If `SHADOW_DATABASE_URL` is unset, skip the diff and instead verify by eye that every column, index and unique constraint in Step 1 appears in Step 2. **Do not run `prisma migrate dev`** — it would apply to whatever database `DATABASE_URL` points at.

- [ ] **Step 4: Verify the client compiles with the new models**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260918120000_add_commit_tracking_roster/
git commit -m "feat(db): add tracked-developer roster and digest run tables"
```

---

### Task 4: Roster admin API

Follows [watchlist-exclusions.controller.ts](../../../backend/src/modules/dashboards/watchlist-exclusions.controller.ts) exactly: admin-guarded, `PUT` for idempotent upsert against the unique key, `CurrentUser` supplying who decided. Mutating routes are audited automatically by the global `AuditInterceptor`.

**Files:**
- Create: `backend/src/modules/dashboards/tracked-developers.controller.ts`
- Modify: `backend/src/modules/dashboards/dashboards.module.ts`
- Test: `backend/src/modules/dashboards/tracked-developers.controller.spec.ts`

**Interfaces:**
- Consumes: `prisma.trackedDeveloper` (Task 3).
- Produces: routes `GET|PUT|DELETE /dashboards/tracked-developers[/:developer]`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/dashboards/tracked-developers.controller.spec.ts`:

```ts
import { TrackedDevelopersController } from './tracked-developers.controller';
import { AuthUser } from '../../common/tenancy/tenant-context.service';

const user: AuthUser = {
  userId: 'user_1',
  tenantId: 'tenant_a',
  email: 'admin@example.com',
  roles: ['admin'],
};

function prismaDouble() {
  return {
    trackedDeveloper: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockImplementation(({ create }) => ({
        canonicalDeveloperId: create.canonicalDeveloperId,
        addedAs: create.addedAs,
        active: true,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('TrackedDevelopersController', () => {
  it('scopes the listing to the caller tenant and only active entries', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.list(user);

    expect(prisma.trackedDeveloper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_a', active: true },
      }),
    );
  });

  it('records who added the entry and keeps the added-as string verbatim', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.upsert(user, 'Adarsh-Naik_athma', {});

    const call = prisma.trackedDeveloper.upsert.mock.calls[0][0];
    expect(call.create.createdByUserId).toBe('user_1');
    expect(call.create.tenantId).toBe('tenant_a');
    expect(call.create.addedAs).toBe('Adarsh-Naik_athma');
    expect(call.where.tenantId_canonicalDeveloperId).toEqual({
      tenantId: 'tenant_a',
      canonicalDeveloperId: 'Adarsh-Naik_athma',
    });
  });

  it('deactivates rather than deletes, so the removal stays on the record', async () => {
    const prisma = prismaDouble();
    const controller = new TrackedDevelopersController(prisma as never);

    await controller.remove(user, 'Adarsh-Naik_athma');

    expect(prisma.trackedDeveloper.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_a', canonicalDeveloperId: 'Adarsh-Naik_athma' },
      data: { active: false },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/modules/dashboards/tracked-developers.controller.spec.ts`
Expected: FAIL — cannot find module `./tracked-developers.controller`.

- [ ] **Step 3: Implement the controller**

Create `backend/src/modules/dashboards/tracked-developers.controller.ts`:

```ts
import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { newId } from '../../common/id';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';

class UpsertTrackedDeveloperDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Admin management of the daily digest's tracked roster.
 *
 * The roster is data, not a constant in the code, so that a joiner is covered
 * by tomorrow's digest without a deploy — the same reason `DeveloperRole` and
 * the Watchlist exclusions are tables.
 *
 * Note what this is NOT: a statement that someone is or is not working. It
 * only decides who the digest evaluates. Suppressing a specific person on a
 * specific day is what `WatchlistExclusion` is for, and it expires; taking
 * someone off this roster is indefinite and should be rare.
 *
 * Admin-only, and audited by the global `AuditInterceptor` like every other
 * mutating route.
 */
@Controller('dashboards/tracked-developers')
export class TrackedDevelopersController {
  constructor(private readonly prisma: PrismaService) {}

  /** The live roster, alphabetical. Never ordered by any activity figure. */
  @Roles(Role.ADMIN)
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.trackedDeveloper.findMany({
      where: { tenantId: user.tenantId, active: true },
      orderBy: { canonicalDeveloperId: 'asc' },
    });
    return {
      items: rows.map((row) => ({
        developer: row.canonicalDeveloperId,
        addedAs: row.addedAs,
        note: row.note,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      })),
      count: rows.length,
    };
  }

  /**
   * Add a developer to the roster, or reactivate them.
   *
   * `PUT` rather than `POST`: the unique key is one row per developer, so
   * re-adding someone is idempotent instead of stacking rows nobody can
   * reason about.
   */
  @Roles(Role.ADMIN)
  @Put(':developer')
  async upsert(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
    @Body() dto: UpsertTrackedDeveloperDto,
  ) {
    const row = await this.prisma.trackedDeveloper.upsert({
      where: {
        tenantId_canonicalDeveloperId: {
          tenantId: user.tenantId,
          canonicalDeveloperId: developer,
        },
      },
      create: {
        id: newId(),
        tenantId: user.tenantId,
        canonicalDeveloperId: developer,
        // Kept verbatim: if this never resolves to a known identity, the
        // digest reports it as unresolved rather than as someone idle.
        addedAs: developer,
        note: dto.note ?? null,
        createdByUserId: user.userId,
      },
      update: { active: true, note: dto.note ?? null },
    });
    return {
      developer: row.canonicalDeveloperId,
      addedAs: row.addedAs,
      active: row.active,
    };
  }

  /**
   * Take a developer off the roster.
   *
   * Deactivates rather than deletes: a shrinking roster with no record of who
   * was removed, by whom, and when is exactly the unaccountable filtering
   * that makes the digest's own list untrustworthy.
   */
  @Roles(Role.ADMIN)
  @Delete(':developer')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('developer') developer: string,
  ) {
    await this.prisma.trackedDeveloper.updateMany({
      where: { tenantId: user.tenantId, canonicalDeveloperId: developer },
      data: { active: false },
    });
    return { developer, active: false };
  }
}
```

- [ ] **Step 4: Register the controller**

In `backend/src/modules/dashboards/dashboards.module.ts`, import `TrackedDevelopersController` and add it to the `controllers` array beside `WatchlistExclusionsController`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/dashboards/tracked-developers.controller.spec.ts && npx tsc --noEmit && npm run lint:ci`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/dashboards/tracked-developers.controller.ts backend/src/modules/dashboards/tracked-developers.controller.spec.ts backend/src/modules/dashboards/dashboards.module.ts
git commit -m "feat(dashboards): add admin API for the tracked developer roster"
```

---

### Task 5: Detection — roster minus active set

The heart of the feature. The decision logic is a **pure function** (`evaluateRoster`) so every branch is testable without a database; the service is a thin orchestrator that fetches and calls it. This matches the house test style, where `bucketFor`, `planningGapDevelopers` and `activeDeveloperRoster` are all exported pure functions with direct tests.

**Files:**
- Create: `backend/src/metrics/no-commit-detection.service.ts`
- Create: `backend/src/metrics/no-commit-detection.service.spec.ts`
- Modify: `backend/src/metrics/metrics.module.ts`

**Interfaces:**
- Consumes: `activeDeveloperSet()` (Task 2); `previousWorkingDayKey`, `istDayStart`, `istDayEnd`, `IST_TIMEZONE` (Task 1); `prisma.trackedDeveloper` (Task 3); `DeveloperIdentityService.attributionIndex(tenantId)`; `CodeService.listCommitsPage(tenantId, filters)`; `ConnectionsService.getDataFreshness(tenantId)`; `isBotDeveloper`, `isAnonymizedAccount` from `correlation/developer-identity.util`.
- Produces:
  ```ts
  export const IMPLAUSIBLE_FLAGGED_SHARE = 0.8;
  export type DigestOutcome =
    | 'sent' | 'sent_all_clear'
    | 'withheld_stale_data' | 'withheld_truncated_read'
    | 'withheld_implausible' | 'failed';
  export interface NamedDeveloper { developer: string; displayName: string }
  export interface RosterEvaluation {
    flagged: NamedDeveloper[];
    unresolved: { developer: string; addedAs: string }[];
    incomplete: NamedDeveloper[];
    suppressed: NamedDeveloper[];
  }
  export function evaluateRoster(input: EvaluateRosterInput): RosterEvaluation
  export interface DigestDetection {
    reportedDay: string;
    rosterCount: number;
    evaluation: RosterEvaluation;
    withhold: { outcome: DigestOutcome; detail: string } | null;
    collectedThroughAt: Date | null;
  }
  export class NoCommitDetectionService {
    detect(tenantId: string, reportedDay: string): Promise<DigestDetection>;
  }
  ```

- [ ] **Step 1: Write the failing tests for the pure function**

Create `backend/src/metrics/no-commit-detection.service.spec.ts`:

```ts
import {
  IMPLAUSIBLE_FLAGGED_SHARE,
  evaluateRoster,
  implausible,
} from './no-commit-detection.service';

const displayNames = new Map([
  ['alice_athma', 'Alice Anand'],
  ['bob_athma', 'Bob Bose'],
  ['zara_athma', 'Zara Ahmed'],
  ['dependabot[bot]', 'dependabot[bot]'],
]);

function base(overrides: Partial<Parameters<typeof evaluateRoster>[0]> = {}) {
  return {
    roster: [
      { canonicalDeveloperId: 'alice_athma', addedAs: 'alice_athma' },
      { canonicalDeveloperId: 'bob_athma', addedAs: 'bob_athma' },
    ],
    activeSet: new Set<string>(),
    incompleteSet: new Set<string>(),
    excludedByAdmin: new Set<string>(),
    displayNames,
    known: new Set(displayNames.keys()),
    ...overrides,
  };
}

describe('evaluateRoster', () => {
  it('flags a roster member with no signal', () => {
    const result = evaluateRoster(base());
    expect(result.flagged.map((f) => f.developer)).toEqual([
      'alice_athma',
      'bob_athma',
    ]);
  });

  it('does not flag someone who committed', () => {
    const result = evaluateRoster(
      base({ activeSet: new Set(['alice_athma']) }),
    );
    expect(result.flagged.map((f) => f.developer)).toEqual(['bob_athma']);
  });

  it('does not flag someone who only opened a PR', () => {
    // activeSet is the union of commit and PR authors (activeDeveloperSet),
    // so this is the same path — asserted separately because a regression in
    // the PR half of that union silently re-adds people to the list.
    const result = evaluateRoster(base({ activeSet: new Set(['bob_athma']) }));
    expect(result.flagged.map((f) => f.developer)).toEqual(['alice_athma']);
  });

  it('withholds someone whose commit data for the day is incomplete', () => {
    // A commit dated in the window by authoredAt whose committedAt is null:
    // the board cannot see it, and naming this person would be a false
    // accusation against someone who shipped code.
    const result = evaluateRoster(
      base({ incompleteSet: new Set(['alice_athma']) }),
    );
    expect(result.flagged.map((f) => f.developer)).toEqual(['bob_athma']);
    expect(result.incomplete.map((f) => f.developer)).toEqual(['alice_athma']);
  });

  it('reports an unresolvable roster entry instead of flagging it', () => {
    const result = evaluateRoster(
      base({
        roster: [{ canonicalDeveloperId: 'ghost_athma', addedAs: 'ghost_athma' }],
      }),
    );
    expect(result.flagged).toEqual([]);
    expect(result.unresolved).toEqual([
      { developer: 'ghost_athma', addedAs: 'ghost_athma' },
    ]);
  });

  it('suppresses admin-excluded developers, bots and anonymized accounts', () => {
    const result = evaluateRoster(
      base({
        roster: [
          { canonicalDeveloperId: 'alice_athma', addedAs: 'alice_athma' },
          { canonicalDeveloperId: 'dependabot[bot]', addedAs: 'dependabot[bot]' },
        ],
        excludedByAdmin: new Set(['alice_athma']),
        known: new Set([...displayNames.keys()]),
      }),
    );
    expect(result.flagged).toEqual([]);
    expect(result.suppressed.map((s) => s.developer).sort()).toEqual([
      'alice_athma',
      'dependabot[bot]',
    ]);
  });

  it('orders the flagged list alphabetically by display name, never by volume', () => {
    // CLAUDE.md: any volume ordering turns a prompt-to-check-in into the
    // leaderboard the ethics rule forbids.
    const result = evaluateRoster(
      base({
        roster: [
          { canonicalDeveloperId: 'zara_athma', addedAs: 'zara_athma' },
          { canonicalDeveloperId: 'bob_athma', addedAs: 'bob_athma' },
        ],
      }),
    );
    expect(result.flagged.map((f) => f.displayName)).toEqual([
      'Bob Bose',
      'Zara Ahmed',
    ]);
  });
});

describe('implausible', () => {
  it('is true above the share threshold', () => {
    expect(implausible(9, 10)).toBe(true);
  });

  it('is false at or below it', () => {
    expect(implausible(8, 10)).toBe(false);
    expect(IMPLAUSIBLE_FLAGGED_SHARE).toBe(0.8);
  });

  it('is false for an empty roster rather than dividing by zero', () => {
    expect(implausible(0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/no-commit-detection.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the pure functions and the service**

Create `backend/src/metrics/no-commit-detection.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  isAnonymizedAccount,
  isBotDeveloper,
} from '../correlation/developer-identity.util';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { istDayEnd, istDayStart } from '../common/time';
import { CodeService } from '../modules/code/code.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import { PrismaService } from '../database/prisma.service';
import { activeDeveloperSet } from './developer-activity.service';

/**
 * The share of the roster above which a named list is withheld.
 *
 * SprintIQ models no holiday calendar — `workingDaysAgo` records that
 * inventing one per tenant "would be a guess dressed as a fact" — so a public
 * holiday arrives here as the whole roster reading idle. Naming 60 people at
 * once is never a finding about 60 people; it is a finding about the day or
 * about the pipeline.
 *
 * A constant rather than tenant configuration until some tenant needs a
 * different value.
 */
export const IMPLAUSIBLE_FLAGGED_SHARE = 0.8;

export type DigestOutcome =
  | 'sent'
  | 'sent_all_clear'
  | 'withheld_stale_data'
  | 'withheld_truncated_read'
  | 'withheld_implausible'
  | 'failed';

export interface NamedDeveloper {
  developer: string;
  displayName: string;
}

export interface RosterEvaluation {
  /** The list that goes out. Alphabetical by display name. */
  flagged: NamedDeveloper[];
  /** Roster entries identity resolution does not know. Reported, never named. */
  unresolved: { developer: string; addedAs: string }[];
  /** Withheld because their commit data for the day is incomplete. */
  incomplete: NamedDeveloper[];
  /** Bots, anonymized accounts, and people an admin has excluded. */
  suppressed: NamedDeveloper[];
}

export interface EvaluateRosterInput {
  roster: readonly { canonicalDeveloperId: string; addedAs: string }[];
  /** Who had a signal on the day — from `activeDeveloperSet`. */
  activeSet: ReadonlySet<string>;
  /** Who has a commit dated in the window that the day's read cannot see. */
  incompleteSet: ReadonlySet<string>;
  /** Live Watchlist exclusions plus identity-override exclusions, unioned. */
  excludedByAdmin: ReadonlySet<string>;
  displayNames: ReadonlyMap<string, string>;
  /** Every developer identity resolution knows about. */
  known: ReadonlySet<string>;
}

/**
 * Roster minus active set, with the four reasons a name is withheld.
 *
 * Pure, and ordered deliberately. Resolution is checked before anything else
 * because an entry nobody can resolve is a data problem, not a person, and
 * must never fall through to the flagged list. Suppression comes next, then
 * activity, then incompleteness — so the most specific reason a person is
 * absent from the list is the one recorded against them.
 */
export function evaluateRoster(input: EvaluateRosterInput): RosterEvaluation {
  const flagged: NamedDeveloper[] = [];
  const unresolved: { developer: string; addedAs: string }[] = [];
  const incomplete: NamedDeveloper[] = [];
  const suppressed: NamedDeveloper[] = [];

  for (const entry of input.roster) {
    const developer = entry.canonicalDeveloperId;
    const named = {
      developer,
      displayName: input.displayNames.get(developer) ?? developer,
    };

    if (!input.known.has(developer)) {
      unresolved.push({ developer, addedAs: entry.addedAs });
      continue;
    }
    if (
      input.excludedByAdmin.has(developer) ||
      isBotDeveloper(developer) ||
      isAnonymizedAccount(developer)
    ) {
      suppressed.push(named);
      continue;
    }
    if (input.activeSet.has(developer)) {
      continue;
    }
    if (input.incompleteSet.has(developer)) {
      incomplete.push(named);
      continue;
    }
    flagged.push(named);
  }

  // Alphabetical, always. These are people, and any volume ordering would
  // turn a prompt-to-check-in into the leaderboard CLAUDE.md forbids.
  flagged.sort((a, b) => a.displayName.localeCompare(b.displayName));
  incomplete.sort((a, b) => a.displayName.localeCompare(b.displayName));
  unresolved.sort((a, b) => a.developer.localeCompare(b.developer));
  suppressed.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { flagged, unresolved, incomplete, suppressed };
}

/** Whether the flagged share is too high to be a finding about people. */
export function implausible(flaggedCount: number, evaluated: number): boolean {
  if (evaluated === 0) {
    return false;
  }
  return flaggedCount / evaluated > IMPLAUSIBLE_FLAGGED_SHARE;
}

export interface DigestDetection {
  reportedDay: string;
  rosterCount: number;
  evaluation: RosterEvaluation;
  /** Non-null when the names must not be sent, with the reason to record. */
  withhold: { outcome: DigestOutcome; detail: string } | null;
  collectedThroughAt: Date | null;
}

/**
 * Computes the daily digest: the tracked roster minus the developers active on
 * the reported day.
 *
 * Tenant-explicit throughout. `TenantContextService.requireTenantId()` is
 * request-scoped and this runs from a cron, which is also why it cannot simply
 * call `DeveloperActivityService.overview()` — it performs the same reads
 * instead, through the shared `activeDeveloperSet`, so the digest and the
 * Overview board cannot disagree about the same person on the same day.
 */
@Injectable()
export class NoCommitDetectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: DeveloperIdentityService,
    private readonly code: CodeService,
    private readonly connections: ConnectionsService,
  ) {}

  async detect(
    tenantId: string,
    reportedDay: string,
  ): Promise<DigestDetection> {
    const from = istDayStart(reportedDay);
    const to = istDayEnd(reportedDay);

    const [roster, freshness, index, exclusionRows] = await Promise.all([
      this.prisma.trackedDeveloper.findMany({
        where: { tenantId, active: true },
        select: { canonicalDeveloperId: true, addedAs: true },
      }),
      this.connections.getDataFreshness(tenantId),
      this.identities.attributionIndex(tenantId),
      this.prisma.watchlistExclusion.findMany({
        // Live exclusions only — a lapsed one is not a statement about today.
        where: { tenantId, expiresAt: { gt: new Date() } },
        select: { canonicalDeveloperId: true },
      }),
    ]);

    const empty: RosterEvaluation = {
      flagged: [],
      unresolved: [],
      incomplete: [],
      suppressed: [],
    };

    // Gate 1: is the day's data actually in? `collectedThroughAt` is null
    // whenever ANY active connection has no watermark, and is the oldest
    // watermark otherwise — so this is genuinely "the whole tenant is
    // collected through here", which is what the question needs.
    //
    // Ingest is poll-based. A stalled collector or an expired token makes the
    // entire roster read as inactive, and without this gate the job would
    // name every one of them in a channel.
    if (!freshness.collectedThroughAt || freshness.collectedThroughAt < to) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation: empty,
        withhold: {
          outcome: 'withheld_stale_data',
          detail: `Collection reaches ${
            freshness.collectedThroughAt?.toISOString() ?? 'nothing'
          }, which does not cover ${reportedDay}. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    const [{ commits, truncated }, prs] = await Promise.all([
      this.code.listCommitsPage(tenantId, { from, to }),
      this.prisma.pullRequest.findMany({
        where: { tenantId, openedAt: { gte: from, lte: to } },
        select: { authorLogin: true },
      }),
    ]);

    // Gate 2: a short commit read makes the active set unreliable, and every
    // developer it omitted would be flagged. The flag exists precisely so
    // that hitting the ceiling is reported rather than quietly changing the
    // answer.
    if (truncated) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation: empty,
        withhold: {
          outcome: 'withheld_truncated_read',
          detail: `The commit read for ${reportedDay} hit its row ceiling, so the active set is incomplete. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    const activeSet = activeDeveloperSet(commits, prs, index);
    const incompleteSet = await this.commitsInvisibleToTheDayRead(
      tenantId,
      index,
      from,
      to,
    );

    const excludedByAdmin = new Set<string>([
      ...exclusionRows.map((row) => row.canonicalDeveloperId),
      ...index.excluded,
    ]);

    const evaluation = evaluateRoster({
      roster,
      activeSet,
      incompleteSet,
      excludedByAdmin,
      displayNames: index.displayNames,
      known: new Set(index.displayNames.keys()),
    });

    const evaluated =
      roster.length -
      evaluation.unresolved.length -
      evaluation.suppressed.length;

    // Gate 3: too many to be a finding about people.
    if (implausible(evaluation.flagged.length, evaluated)) {
      return {
        reportedDay,
        rosterCount: roster.length,
        evaluation,
        withhold: {
          outcome: 'withheld_implausible',
          detail: `${evaluation.flagged.length} of ${evaluated} evaluated developers had no signal on ${reportedDay} — more likely a holiday or a collection problem than that many idle developers. Names withheld.`,
        },
        collectedThroughAt: freshness.collectedThroughAt,
      };
    }

    return {
      reportedDay,
      rosterCount: roster.length,
      evaluation,
      withhold: null,
      collectedThroughAt: freshness.collectedThroughAt,
    };
  }

  /**
   * Developers with a commit dated inside the window that the day's read
   * cannot see, because its `committedAt` is null.
   *
   * `CodeService.listCommitsPage` windows on `committedAt`, which is nullable.
   * The only thing that backfills it — `GithubCommitReconcilerService` — is
   * one-off maintenance behind an admin endpoint, not a scheduled job, and one
   * of its stated causes is ongoing: commits "that outran the enrichment's
   * bounded per-tick budget". So a commit can land today with a null
   * `committedAt` and stay invisible indefinitely.
   *
   * Everyone found here is withheld from the list rather than named. It is the
   * one place the digest departs from the Overview board, and it departs only
   * where the board is provably missing a commit. (The board's own day
   * bucketing already falls back to `committedAt ?? authoredAt`, so the
   * fallback is this codebase's established idiom for the column.)
   */
  private async commitsInvisibleToTheDayRead(
    tenantId: string,
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
    from: Date,
    to: Date,
  ): Promise<Set<string>> {
    const rows = await this.prisma.commit.groupBy({
      by: ['authorLogin', 'authorEmail'],
      where: {
        tenantId,
        committedAt: null,
        authoredAt: { gte: from, lte: to },
      },
    });
    // Same attribution as the active set, with no PRs to consider — so a
    // developer identified here is identified by exactly the rules that would
    // have recognised them had the column been populated.
    return activeDeveloperSet(rows, [], index);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics/no-commit-detection.service.spec.ts`
Expected: PASS — all nine assertions.

- [ ] **Step 5: Register the service**

In `backend/src/metrics/metrics.module.ts`, import `NoCommitDetectionService` and add it to both `providers` and `exports`. No new module imports are needed: `CodeModule`, `ConnectionsModule` and `CorrelationModule` are already imported there.

- [ ] **Step 6: Verify**

Run: `cd backend && npx tsc --noEmit && npx jest src/metrics && npm run lint:ci`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/metrics/no-commit-detection.service.ts backend/src/metrics/no-commit-detection.service.spec.ts backend/src/metrics/metrics.module.ts
git commit -m "feat(metrics): detect tracked developers with no signal on a day"
```

---

### Task 6: Teams delivery client and card

Outbound delivery lives in the Collector context — the `NotificationsService` docblock states that delivery clients belong there, and CLAUDE.md's stack table files native outbound notification delivery under Integration/Collection. `sources/` is inbound; this is a new `delivery/` sibling.

The card builder is a pure function, tested directly.

**Files:**
- Create: `backend/src/collectors/delivery/digest-card.ts`
- Create: `backend/src/collectors/delivery/digest-card.spec.ts`
- Create: `backend/src/collectors/delivery/teams.client.ts`
- Create: `backend/src/collectors/delivery/teams.client.spec.ts`
- Modify: `backend/src/collectors/collectors.module.ts`

**Interfaces:**
- Consumes: `SecretsService.resolve(tenantId, ref)`. **Nothing from `metrics/`** — this context declares its own recipient type so the Collector context stays free of a domain dependency.
- Produces:
  ```ts
  export interface DigestRecipient { developer: string; displayName: string }
  export interface DigestCardInput {
    reportedDay: string;
    flagged: DigestRecipient[];
    evaluatedCount: number;
    collectedThroughAt: Date | null;
    withheldDetail?: string;
  }
  export function buildDigestCard(input: DigestCardInput): Record<string, unknown>
  export function escapeCardText(value: string): string
  export class TeamsClient {
    postAdaptiveCard(tenantId: string, ref: string, card: Record<string, unknown>): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing card tests**

Create `backend/src/collectors/delivery/digest-card.spec.ts`:

```ts
import { buildDigestCard, escapeCardText } from './digest-card';

function textOf(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

describe('escapeCardText', () => {
  it('neutralises markdown a display name could smuggle in', () => {
    // Display names come from ingested GitHub/Jira data, which CLAUDE.md
    // treats as untrusted, and Adaptive Card TextBlock renders a markdown
    // subset — so a crafted name could post a link into the channel.
    expect(escapeCardText('[click](http://evil.example)')).toBe(
      '\\[click\\]\\(http://evil.example\\)',
    );
  });

  it('leaves an ordinary name untouched', () => {
    expect(escapeCardText('Alice Anand')).toBe('Alice Anand');
  });
});

describe('buildDigestCard', () => {
  const input = {
    reportedDay: '2026-09-17',
    flagged: [
      { developer: 'bob_athma', displayName: 'Bob Bose' },
      { developer: 'zara_athma', displayName: 'Zara Ahmed' },
    ],
    evaluatedCount: 66,
    collectedThroughAt: new Date('2026-09-18T04:00:00.000Z'),
  };

  it('states the rule it was computed from', () => {
    // Governance requirement (spec §3): the rule ships with the list and is
    // displayed. Without it the message asserts these people did no work,
    // which the data cannot support.
    const body = textOf(buildDigestCard(input));
    expect(body).toContain('no commit and no pull request opened');
  });

  it('says outright that reviewing is not counted', () => {
    // The largest source of a justified objection to being named: prReview is
    // not in the Overview's set, so a day spent reviewing appears here.
    expect(textOf(buildDigestCard(input))).toContain('review');
  });

  it('reports the count against the number evaluated', () => {
    expect(textOf(buildDigestCard(input))).toContain('2 of 66');
  });

  it('lists names alphabetically and never by volume', () => {
    const body = textOf(buildDigestCard(input));
    expect(body.indexOf('Bob Bose')).toBeLessThan(body.indexOf('Zara Ahmed'));
  });

  it('carries the collection freshness', () => {
    expect(textOf(buildDigestCard(input))).toContain('2026-09-18');
  });

  it('renders an all-clear card when nobody is flagged', () => {
    const body = textOf(buildDigestCard({ ...input, flagged: [] }));
    expect(body).toContain('All 66');
  });

  it('renders the withheld reason instead of names when given one', () => {
    const body = textOf(
      buildDigestCard({ ...input, flagged: [], withheldDetail: 'Names withheld: collection is behind.' }),
    );
    expect(body).toContain('Names withheld');
    expect(body).not.toContain('Bob Bose');
  });

  it('is a message-wrapped adaptive card, as the Workflows action expects', () => {
    const card = buildDigestCard(input) as {
      type: string;
      attachments: { contentType: string }[];
    };
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/collectors/delivery/digest-card.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the card builder**

Create `backend/src/collectors/delivery/digest-card.ts`:

```ts
/**
 * Who to name on the card.
 *
 * Declared here rather than imported from `metrics/` on purpose: the Collector
 * context must not depend on a domain context, or the boundary that keeps
 * delivery extractable stops meaning anything. Structurally compatible with
 * the detection service's `NamedDeveloper`, so callers pass those rows
 * directly with no mapping.
 */
export interface DigestRecipient {
  developer: string;
  displayName: string;
}

export interface DigestCardInput {
  /** The IST calendar day reported on (YYYY-MM-DD). */
  reportedDay: string;
  /** Already alphabetical by display name — this function does not reorder. */
  flagged: DigestRecipient[];
  /** Roster size after unresolved and suppressed entries are removed. */
  evaluatedCount: number;
  collectedThroughAt: Date | null;
  /** When set, the reason names were withheld; names are not rendered. */
  withheldDetail?: string;
}

/**
 * The rule the list was computed from, displayed in every card.
 *
 * Required by the ethics-first exception this feature ships under (CLAUDE.md;
 * spec §3): where an attributed ranking or list ships, the rule it is computed
 * from ships with it and is displayed. It names what was counted AND states
 * that reviewing was not, because the narrow definition is the honest
 * explanation for most objections to being on this list.
 */
const RULE_TEXT =
  'Flagged = no commit and no pull request opened on this day (IST) — the same reads as the Activity Overview board. ' +
  'Code review, merging work opened earlier, and Jira activity are **not** counted, so a day spent reviewing shows here as inactive. ' +
  'Excludes bots, admin-excluded accounts, and developers on recorded leave.';

/**
 * Neutralise the markdown subset an Adaptive Card `TextBlock` renders.
 *
 * Display names arrive from ingested GitHub and Jira data, which CLAUDE.md
 * classifies as untrusted. Unescaped, a crafted name posts a live link into a
 * channel every morning.
 */
export function escapeCardText(value: string): string {
  return value.replace(/[\\`*_[\]()#+\-!>|]/g, (ch) => `\\${ch}`);
}

function block(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'TextBlock', wrap: true, text, ...extra };
}

/**
 * The daily digest as a Teams message payload.
 *
 * Wrapped as `{ type: 'message', attachments: [...] }` because that is what
 * the Power Automate "Post card in a chat or channel" action expects; a bare
 * adaptive card is accepted by the HTTP trigger and then posts nothing.
 */
export function buildDigestCard(
  input: DigestCardInput,
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    block(`Daily activity check — ${input.reportedDay}`, {
      size: 'Medium',
      weight: 'Bolder',
    }),
  ];

  if (input.withheldDetail) {
    body.push(block(input.withheldDetail, { weight: 'Bolder' }));
  } else if (input.flagged.length === 0) {
    body.push(
      block(
        `All ${input.evaluatedCount} tracked developers had activity on ${input.reportedDay}.`,
      ),
    );
  } else {
    body.push(
      block(
        `${input.flagged.length} of ${input.evaluatedCount} tracked developers had no activity:`,
      ),
    );
    // Alphabetical order is the caller's guarantee; rendering must not sort.
    body.push(
      block(
        input.flagged
          .map((person) => `• ${escapeCardText(person.displayName)}`)
          .join('\n'),
      ),
    );
    body.push(
      block(
        'This is a prompt to check in, not a conclusion about anyone — ask before assuming.',
        { isSubtle: true },
      ),
    );
  }

  body.push(block(RULE_TEXT, { isSubtle: true, size: 'Small' }));
  body.push(
    block(
      `Data collected through ${
        input.collectedThroughAt?.toISOString() ?? 'unknown'
      }.`,
      { isSubtle: true, size: 'Small' },
    ),
  );

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run the card tests to verify they pass**

Run: `cd backend && npx jest src/collectors/delivery/digest-card.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing client tests**

Create `backend/src/collectors/delivery/teams.client.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { TeamsClient } from './teams.client';

const URL_WITH_CREDENTIAL =
  'https://prod-11.centralindia.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SUPERSECRET';

function clientWith(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl as unknown as typeof fetch;
  const secrets = { resolve: jest.fn().mockResolvedValue(URL_WITH_CREDENTIAL) };
  return { client: new TeamsClient(secrets as never), secrets };
}

describe('TeamsClient', () => {
  const card = { type: 'message', attachments: [] };

  afterEach(() => jest.restoreAllMocks());

  it('treats 202 with an empty body as success', async () => {
    // Power Automate answers 202 Accepted with no body, unlike the retired
    // O365 connector's 200/"1". A strict 200-only check logs every
    // successful send as a failure.
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 202, text: async () => '' });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => '' });
    const { client } = clientWith(fetchMock);

    await client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403 — the flow is gone or the URL rotated', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never writes the webhook URL to the log', async () => {
    // The URL carries its credential in the query string; logging it hands
    // channel-post rights to anyone with log access.
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      logged.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      logged.push(String(message));
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const { client } = clientWith(fetchMock);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow();

    expect(logged.join('\n')).not.toContain('SUPERSECRET');
    expect(logged.join('\n')).not.toContain('logic.azure.com');
  });

  it('fails clearly when no webhook is configured', async () => {
    const fetchMock = jest.fn();
    const { client, secrets } = clientWith(fetchMock);
    secrets.resolve.mockResolvedValue(null);

    await expect(
      client.postAdaptiveCard('tenant_a', 'teamsWebhookRef', card),
    ).rejects.toThrow(/teamsWebhookRef/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run the client tests to verify they fail**

Run: `cd backend && npx jest src/collectors/delivery/teams.client.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 7: Implement the client**

Create `backend/src/collectors/delivery/teams.client.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../common/secrets/secrets.service';

/** Attempts per send, including the first. */
const MAX_ATTEMPTS = 3;
/** Base backoff; attempt N waits BASE * 2^(N-1). */
const BACKOFF_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * Outbound delivery to a Microsoft Teams channel via a Power Automate
 * Workflows URL.
 *
 * In the Collector context because that is where this codebase puts clients
 * that talk to the outside world — `NotificationsService` decides *whether and
 * whom*, this decides *how*. The URL never leaves this file.
 *
 * Targets Power Automate ("Post card in a chat or channel") rather than the
 * retired O365 connector webhook. Two consequences are load-bearing: success
 * is 202 with an empty body, not 200/"1"; and the URL carries its credential
 * in the query string, so it is never logged at any level.
 */
@Injectable()
export class TeamsClient {
  private readonly logger = new Logger(TeamsClient.name);

  constructor(private readonly secrets: SecretsService) {}

  async postAdaptiveCard(
    tenantId: string,
    ref: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const url = await this.secrets.resolve(tenantId, ref);
    if (!url) {
      throw new Error(
        `No Teams webhook resolved for secret ref "${ref}" — set it in admin/configuration or as an environment variable.`,
      );
    }

    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
        // A hung POST must not wedge the cron that called it.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Any 2xx. Power Automate returns 202 Accepted with an empty body.
      if (response.ok) {
        return;
      }

      lastStatus = response.status;
      lastBody = (await response.text()).slice(0, 500);

      if (!RETRYABLE(response.status)) {
        // A 403 means the flow was deleted or the URL rotated. Retrying only
        // delays the diagnosis.
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        this.logger.warn(
          `Teams delivery attempt ${attempt} returned ${response.status}; retrying.`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, BACKOFF_BASE_MS * 2 ** (attempt - 1)),
        );
      }
    }

    // Status and response body only — never the URL, which is a credential.
    this.logger.error(
      `Teams delivery failed with ${lastStatus}: ${lastBody || '(empty body)'}`,
    );
    throw new Error(`Teams delivery failed with status ${lastStatus}`);
  }
}
```

- [ ] **Step 8: Register the providers**

In `backend/src/collectors/collectors.module.ts`, import `TeamsClient` and add it to both `providers` and `exports`. `SecretsModule` is already available to this module (the GitHub and Jira collectors inject `SecretsService`); if the import is not present, add it.

- [ ] **Step 9: Verify**

Run: `cd backend && npx jest src/collectors/delivery && npx tsc --noEmit && npm run lint:ci`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/collectors/delivery/ backend/src/collectors/collectors.module.ts
git commit -m "feat(collectors): add Teams delivery client and digest card builder"
```

---

### Task 7: Orchestration, run record and audit

Fills in the `NotificationsService` stub. It decides whether and whom, records the run, and emits the audit entry CLAUDE.md requires for outbound notifications.

**Files:**
- Modify: `backend/src/modules/notifications/notifications.service.ts`
- Modify: `backend/src/modules/notifications/notifications.module.ts`
- Test: `backend/src/modules/notifications/notifications.service.spec.ts`

**Interfaces:**
- Consumes: `NoCommitDetectionService.detect` (Task 5); `buildDigestCard` and `TeamsClient.postAdaptiveCard` (Task 6); `previousWorkingDayKey` (Task 1); `AUDIT_SINK`/`AuditSink`.
- Produces:
  ```ts
  export interface RunDigestOptions { day?: string; dryRun?: boolean; force?: boolean }
  export interface RunDigestResult {
    reportedDay: string;
    outcome: DigestOutcome;
    flagged: NamedDeveloper[];
    unresolved: { developer: string; addedAs: string }[];
    incomplete: NamedDeveloper[];
    detail: string | null;
    dryRun: boolean;
  }
  class NotificationsService {
    runNoCommitDigest(tenantId: string, options?: RunDigestOptions): Promise<RunDigestResult>;
    tenantsToDigest(): Promise<string[]>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `backend/src/modules/notifications/notifications.service.spec.ts`:

```ts
import { NotificationsService } from './notifications.service';

const detection = {
  reportedDay: '2026-09-17',
  rosterCount: 66,
  evaluation: {
    flagged: [{ developer: 'bob_athma', displayName: 'Bob Bose' }],
    unresolved: [],
    incomplete: [],
    suppressed: [],
  },
  withhold: null,
  collectedThroughAt: new Date('2026-09-18T04:00:00.000Z'),
};

function build(overrides: { detect?: unknown; existing?: unknown } = {}) {
  const detector = {
    detect: jest.fn().mockResolvedValue(overrides.detect ?? detection),
  };
  const teams = { postAdaptiveCard: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    noCommitDigestRun: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    tenantConfiguration: {
      findUnique: jest.fn().mockResolvedValue({
        values: { dailyDigestEnabled: true },
        secretRefs: { teamsWebhookRef: 'teamsWebhookRef' },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    trackedDeveloper: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new NotificationsService(
    prisma as never,
    detector as never,
    teams as never,
    audit as never,
  );
  return { service, detector, teams, audit, prisma };
}

describe('NotificationsService.runNoCommitDigest', () => {
  it('posts the card and records the run as sent', async () => {
    const { service, teams, prisma } = build();

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent');
    expect(prisma.noCommitDigestRun.upsert).toHaveBeenCalled();
  });

  it('writes an audit entry for the outbound notification', async () => {
    // CLAUDE.md requires every outbound notification to be audit-logged.
    const { service, audit } = build();

    await service.runNoCommitDigest('tenant_a');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_a',
        actorType: 'system',
        action: 'notification.no_commit_digest.sent',
      }),
    );
  });

  it('posts an all-clear when nobody is flagged', async () => {
    // Silence cannot be distinguished from a dead cron.
    const { service, teams } = build({
      detect: {
        ...detection,
        evaluation: { ...detection.evaluation, flagged: [] },
      },
    });

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent_all_clear');
  });

  it('posts the withheld reason and names nobody when a gate fires', async () => {
    const { service, teams, audit } = build({
      detect: {
        ...detection,
        withhold: {
          outcome: 'withheld_stale_data',
          detail: 'Collection is behind. Names withheld.',
        },
      },
    });

    const result = await service.runNoCommitDigest('tenant_a');

    expect(result.outcome).toBe('withheld_stale_data');
    const card = JSON.stringify(teams.postAdaptiveCard.mock.calls[0][2]);
    expect(card).toContain('Names withheld');
    expect(card).not.toContain('Bob Bose');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.no_commit_digest.withheld_stale_data',
      }),
    );
  });

  it('posts nothing and writes nothing on a dry run', async () => {
    const { service, teams, prisma } = build();

    const result = await service.runNoCommitDigest('tenant_a', {
      dryRun: true,
    });

    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.upsert).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.flagged).toHaveLength(1);
  });

  it('refuses to re-send a day already sent', async () => {
    // The unique key on (tenantId, reportedDay) is the idempotency guard; a
    // restart or redeploy at 10:30 must not double-post.
    const { service, teams } = build({ existing: { outcome: 'sent' } });

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow(
      /already sent/i,
    );
    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
  });

  it('re-sends a day already sent when forced', async () => {
    const { service, teams } = build({ existing: { outcome: 'sent' } });

    await service.runNoCommitDigest('tenant_a', { force: true });

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
  });

  it('records a failed run when delivery throws, and rethrows', async () => {
    const { service, teams, prisma } = build();
    teams.postAdaptiveCard.mockRejectedValue(new Error('403'));

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow('403');

    const call = prisma.noCommitDigestRun.upsert.mock.calls[0][0];
    expect(call.create.outcome).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/notifications`
Expected: FAIL — `NotificationsService` takes no constructor arguments.

- [ ] **Step 3: Implement the service**

Replace `backend/src/modules/notifications/notifications.service.ts`:

```ts
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { newId } from '../../common/id';
import { previousWorkingDayKey } from '../../common/time';
import { buildDigestCard } from '../../collectors/delivery/digest-card';
import { TeamsClient } from '../../collectors/delivery/teams.client';
import {
  DigestOutcome,
  NamedDeveloper,
  NoCommitDetectionService,
} from '../../metrics/no-commit-detection.service';
import { PrismaService } from '../../database/prisma.service';

const NOTIFICATIONS_NAMESPACE = 'notifications';
const CONFIG_KEY = 'default';
const TEAMS_WEBHOOK_REF = 'teamsWebhookRef';

/** Outcomes that mean a card went out with a list, or with an all-clear. */
const DELIVERED: ReadonlySet<DigestOutcome> = new Set([
  'sent',
  'sent_all_clear',
]);

export interface RunDigestOptions {
  /** IST day key to report on. Defaults to the previous working day. */
  day?: string;
  /** Compute and return without posting or recording anything. */
  dryRun?: boolean;
  /** Re-run a day whose run already succeeded. */
  force?: boolean;
}

export interface RunDigestResult {
  reportedDay: string;
  outcome: DigestOutcome;
  flagged: NamedDeveloper[];
  unresolved: { developer: string; addedAs: string }[];
  incomplete: NamedDeveloper[];
  detail: string | null;
  dryRun: boolean;
}

/**
 * BC-15 Notifications & Action. Decides *whether* to notify and *whom*;
 * `TeamsClient` decides *how*.
 *
 * The daily digest names people, so three things here are not optional: every
 * run is recorded with its outcome and reason (lineage — "why was I on
 * Tuesday's list?" must be answerable), every send is audit-logged, and a day
 * that already sent cannot send again without `force`.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly detection: NoCommitDetectionService,
    private readonly teams: TeamsClient,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  /** Tenants with both an enabled digest and a roster to evaluate. */
  async tenantsToDigest(): Promise<string[]> {
    const configs = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: NOTIFICATIONS_NAMESPACE, status: 'active' },
      select: { tenantId: true, values: true, secretRefs: true },
    });
    const enabled = configs
      .filter((row) => {
        const values = (row.values ?? {}) as Record<string, unknown>;
        const refs = (row.secretRefs ?? {}) as Record<string, unknown>;
        return (
          values.dailyDigestEnabled === true && Boolean(refs[TEAMS_WEBHOOK_REF])
        );
      })
      .map((row) => row.tenantId);

    const withRoster = await Promise.all(
      enabled.map(async (tenantId) => {
        const count = await this.prisma.trackedDeveloper.count({
          where: { tenantId, active: true },
        });
        return count > 0 ? tenantId : null;
      }),
    );
    return withRoster.filter((id): id is string => id !== null);
  }

  async runNoCommitDigest(
    tenantId: string,
    options: RunDigestOptions = {},
  ): Promise<RunDigestResult> {
    const reportedDay = options.day ?? previousWorkingDayKey();
    const dryRun = options.dryRun === true;

    if (!dryRun) {
      const existing = await this.prisma.noCommitDigestRun.findUnique({
        where: {
          tenantId_reportedDay: { tenantId, reportedDay },
        },
        select: { outcome: true },
      });
      if (
        existing &&
        DELIVERED.has(existing.outcome as DigestOutcome) &&
        options.force !== true
      ) {
        throw new BadRequestException(
          `${reportedDay} was already sent for this tenant. Re-sending would post the same names twice; pass force to override.`,
        );
      }
    }

    const detected = await this.detection.detect(tenantId, reportedDay);
    const { evaluation } = detected;
    const evaluatedCount =
      detected.rosterCount -
      evaluation.unresolved.length -
      evaluation.suppressed.length;

    const outcome: DigestOutcome = detected.withhold
      ? detected.withhold.outcome
      : evaluation.flagged.length === 0
        ? 'sent_all_clear'
        : 'sent';
    const detail = detected.withhold?.detail ?? null;

    const result: RunDigestResult = {
      reportedDay,
      outcome,
      flagged: detected.withhold ? [] : evaluation.flagged,
      unresolved: evaluation.unresolved,
      incomplete: evaluation.incomplete,
      detail,
      dryRun,
    };

    if (dryRun) {
      // Deliberately writes no run row: a dry run is a question, not an
      // event, and must be repeatable for the same day.
      return result;
    }

    const card = buildDigestCard({
      reportedDay,
      flagged: result.flagged,
      evaluatedCount,
      collectedThroughAt: detected.collectedThroughAt,
      ...(detail ? { withheldDetail: detail } : {}),
    });

    try {
      await this.teams.postAdaptiveCard(tenantId, TEAMS_WEBHOOK_REF, card);
    } catch (error) {
      await this.recordRun(tenantId, detected, 'failed', errorDetail(error));
      throw error;
    }

    await this.recordRun(tenantId, detected, outcome, detail);
    await this.audit?.record({
      tenantId,
      actorType: 'system',
      action: `notification.no_commit_digest.${outcome}`,
      targetType: 'no_commit_digest_run',
      targetId: reportedDay,
      metadata: {
        reportedDay,
        rosterCount: detected.rosterCount,
        flaggedCount: result.flagged.length,
        unresolvedCount: evaluation.unresolved.length,
        incompleteCount: evaluation.incomplete.length,
      },
    });

    return result;
  }

  private async recordRun(
    tenantId: string,
    detected: { reportedDay: string; rosterCount: number; evaluation: { flagged: NamedDeveloper[]; unresolved: { developer: string; addedAs: string }[]; incomplete: NamedDeveloper[] } },
    outcome: DigestOutcome,
    detail: string | null,
  ): Promise<void> {
    const flagged = DELIVERED.has(outcome) ? detected.evaluation.flagged : [];
    const data = {
      outcome,
      rosterCount: detected.rosterCount,
      flaggedCount: flagged.length,
      flagged,
      unresolved: detected.evaluation.unresolved,
      incomplete: detected.evaluation.incomplete,
      detail,
      deliveredAt: DELIVERED.has(outcome) ? new Date() : null,
    };
    await this.prisma.noCommitDigestRun.upsert({
      where: {
        tenantId_reportedDay: {
          tenantId,
          reportedDay: detected.reportedDay,
        },
      },
      create: {
        id: newId(),
        tenantId,
        reportedDay: detected.reportedDay,
        ...data,
      },
      update: data,
    });
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Wire the module**

Replace `backend/src/modules/notifications/notifications.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CollectorsModule } from '../../collectors/collectors.module';
import { MetricsModule } from '../../metrics/metrics.module';
import { NotificationsService } from './notifications.service';

/** BC-15 Notifications & Action (native delivery). */
@Module({
  // MetricsModule: the digest's detection is a metrics read.
  // CollectorsModule: outbound delivery clients live in the Collector context.
  imports: [MetricsModule, CollectorsModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/notifications && npx tsc --noEmit`
Expected: PASS. If Nest reports a circular import between `CollectorsModule` and `MetricsModule`, break it by moving `TeamsClient` into its own `DeliveryModule` under `collectors/delivery/` and importing that instead — the client depends only on `SecretsService`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/notifications/
git commit -m "feat(notifications): orchestrate the daily digest with run record and audit"
```

---

### Task 8: Cron and admin run endpoint

**Files:**
- Create: `backend/src/modules/notifications/notification-scheduler.service.ts`
- Create: `backend/src/modules/notifications/notification-scheduler.service.spec.ts`
- Create: `backend/src/modules/notifications/digest-admin.controller.ts`
- Modify: `backend/src/modules/notifications/notifications.module.ts`
- Modify: `backend/src/modules/configurations/configuration-catalog.ts`

**Interfaces:**
- Consumes: `NotificationsService.runNoCommitDigest`, `tenantsToDigest` (Task 7); `IST_TIMEZONE` (Task 1).
- Produces: cron `30 10 * * 1-5`; route `POST /admin/notifications/no-commit-digest/run`.

- [ ] **Step 1: Write the failing scheduler test**

Create `backend/src/modules/notifications/notification-scheduler.service.spec.ts`:

```ts
import { NotificationSchedulerService } from './notification-scheduler.service';

describe('NotificationSchedulerService', () => {
  it('runs the digest once per configured tenant', async () => {
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    const scheduler = new NotificationSchedulerService(notifications as never);

    await scheduler.sendDailyDigest();

    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });

  it('continues to the next tenant when one fails', async () => {
    // One tenant's broken webhook must not cancel everyone else's digest.
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest
        .fn()
        .mockRejectedValueOnce(new Error('403'))
        .mockResolvedValueOnce({ outcome: 'sent' }),
    };
    const scheduler = new NotificationSchedulerService(notifications as never);

    await expect(scheduler.sendDailyDigest()).resolves.toBeUndefined();
    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/modules/notifications/notification-scheduler.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the scheduler**

Create `backend/src/modules/notifications/notification-scheduler.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IST_TIMEZONE } from '../../common/time';
import { NotificationsService } from './notifications.service';

/**
 * Fires the daily digest at 10:30 IST, Monday to Friday.
 *
 * Mon–Fri, not daily: a Monday run reporting Sunday would name nearly the
 * whole roster for a day nobody was expected to work, and a notification that
 * is mostly noise stops being read. `previousWorkingDayKey` makes Monday
 * report Friday.
 *
 * 10:30 rather than at the day's close also buys the poll-based collectors
 * roughly ten hours to bring in late commits before anyone is named.
 *
 * This class holds no logic deliberately — it decides only *when*.
 */
@Injectable()
export class NotificationSchedulerService {
  private readonly logger = new Logger(NotificationSchedulerService.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Cron('30 10 * * 1-5', { timeZone: IST_TIMEZONE })
  async sendDailyDigest(): Promise<void> {
    const tenants = await this.notifications.tenantsToDigest();
    for (const tenantId of tenants) {
      // Per-tenant isolation: one tenant's rotated webhook or empty roster
      // must not cancel the sweep for the others.
      try {
        const result = await this.notifications.runNoCommitDigest(tenantId);
        this.logger.log(
          `Daily digest for ${tenantId} (${result.reportedDay}): ${result.outcome}, ${result.flagged.length} named.`,
        );
      } catch (error) {
        this.logger.error(
          `Daily digest failed for ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Implement the admin endpoint**

Create `backend/src/modules/notifications/digest-admin.controller.ts`:

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, Matches } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { NotificationsService } from './notifications.service';

class RunDigestDto {
  /** IST day key. Defaults to the previous working day. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'day must be an IST date key, YYYY-MM-DD',
  })
  day?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * Manual control over the daily digest.
 *
 * `dryRun` is the important one: it returns the full computation — who would
 * be named, which roster entries did not resolve, whose data is incomplete,
 * and the collection freshness — and posts nothing. It is how the rule is
 * validated against real data before a single name reaches a channel, and how
 * a failed morning is inspected afterwards.
 */
@Controller('admin/notifications/no-commit-digest')
export class DigestAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  @Roles(Role.ADMIN)
  @Post('run')
  async run(@CurrentUser() user: AuthUser, @Body() dto: RunDigestDto) {
    return this.notifications.runNoCommitDigest(user.tenantId, {
      ...(dto.day ? { day: dto.day } : {}),
      ...(dto.dryRun === undefined ? {} : { dryRun: dto.dryRun }),
      ...(dto.force === undefined ? {} : { force: dto.force }),
    });
  }
}
```

- [ ] **Step 5: Register both, and add the enable flag to the catalog**

In `notifications.module.ts`, add `NotificationSchedulerService` to `providers` and `DigestAdminController` to a `controllers` array.

In `backend/src/modules/configurations/configuration-catalog.ts`, add this field to the `notifications` namespace's `fields` array, after `teamsWebhookRef`:

```ts
      {
        key: 'dailyDigestEnabled',
        label: 'Daily activity digest enabled',
        kind: 'boolean',
      },
```

- [ ] **Step 6: Verify**

Run: `cd backend && npx jest src/modules/notifications && npx tsc --noEmit && npm run lint:ci`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/notifications/ backend/src/modules/configurations/configuration-catalog.ts
git commit -m "feat(notifications): schedule the digest at 10:30 IST with an admin run endpoint"
```

---

### Task 9: Tenant isolation test

CLAUDE.md requires an isolation test for every new data path. This asserts the roster and run rows of one tenant never reach another.

**Files:**
- Test: `backend/src/modules/notifications/digest-tenant-isolation.spec.ts`

**Interfaces:**
- Consumes: `NotificationsService`, `NoCommitDetectionService`.

- [ ] **Step 1: Write the test**

Create `backend/src/modules/notifications/digest-tenant-isolation.spec.ts`:

```ts
import { NoCommitDetectionService } from '../../metrics/no-commit-detection.service';

describe('daily digest tenant isolation', () => {
  it('reads only the calling tenant roster, exclusions and commits', async () => {
    const calls: Record<string, unknown>[] = [];
    const capture = (result: unknown) =>
      jest.fn().mockImplementation((args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve(result);
      });

    const prisma = {
      trackedDeveloper: { findMany: capture([]) },
      watchlistExclusion: { findMany: capture([]) },
      pullRequest: { findMany: capture([]) },
      commit: { groupBy: capture([]) },
    };
    const identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map(),
        byEmail: new Map(),
        displayNames: new Map(),
        excluded: new Set(),
      }),
    };
    const code = {
      listCommitsPage: jest
        .fn()
        .mockResolvedValue({ commits: [], truncated: false }),
    };
    const connections = {
      getDataFreshness: jest.fn().mockResolvedValue({
        collectedThroughAt: new Date('2026-09-30T00:00:00.000Z'),
      }),
    };

    const service = new NoCommitDetectionService(
      prisma as never,
      identities as never,
      code as never,
      connections as never,
    );

    await service.detect('tenant_a', '2026-09-17');

    // Every Prisma read this service issues must be tenant-scoped. A missing
    // filter here is a cross-tenant read, which CLAUDE.md forbids outright.
    expect(calls).not.toHaveLength(0);
    for (const args of calls) {
      const where = args.where as Record<string, unknown> | undefined;
      expect(where?.tenantId).toBe('tenant_a');
    }
    expect(identities.attributionIndex).toHaveBeenCalledWith('tenant_a');
    expect(code.listCommitsPage).toHaveBeenCalledWith(
      'tenant_a',
      expect.anything(),
    );
    expect(connections.getDataFreshness).toHaveBeenCalledWith('tenant_a');
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx jest src/modules/notifications/digest-tenant-isolation.spec.ts`
Expected: PASS. If it fails, a read is missing its `tenantId` filter — fix the service, never the test.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/notifications/digest-tenant-isolation.spec.ts
git commit -m "test(notifications): assert the digest reads are tenant-scoped"
```

---

### Task 10: Seed script for the 66 tracked developers

Report-only by default. Its real output is which logins do **not** resolve to a `DeveloperIdentity` — those need human review before they could reach a Teams message.

**Files:**
- Create: `backend/scripts/seed-tracked-developers.ts`
- Modify: `backend/package.json` (scripts)

**Interfaces:**
- Consumes: `prisma.trackedDeveloper`, `prisma.developerIdentity`.
- Produces: `npm run digest:roster` (report) and `npm run digest:roster -- --apply`.

- [ ] **Step 1: Write the script**

Create `backend/scripts/seed-tracked-developers.ts`:

```ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { newId } from '../src/common/id';

/**
 * Seeds the daily digest's tracked roster for this deployment's tenant.
 *
 * Report-only unless `--apply` is passed, and the report is the point: it
 * says which of these logins identity resolution actually knows. A login it
 * does not know cannot be evaluated, and an unresolved roster entry reads
 * identically to a developer who did nothing — one of those is a false
 * accusation, so they are separated here, before anything is written.
 *
 *   npm run digest:roster            # report only
 *   npm run digest:roster -- --apply # write the rows
 *
 * WHY A SCRIPT AND NOT A SEED: `prisma/seed.ts` deliberately seeds no
 * tenant-specific content, and these are real people on one reference tenant.
 * Same reasoning as `apply-identity-overrides.ts`.
 *
 * Idempotent: re-running upserts, so it is safe after a migrate reset.
 */

const prisma = new PrismaClient();

const TENANT_ID = process.env.DIGEST_ROSTER_TENANT ?? 'tenant_seed';
const ADDED_BY = process.env.DIGEST_ROSTER_USER ?? 'user_seed_admin';

const LOGINS = [
  'Adarsh-Naik_athma',
  'Amaljith-Thomas_athma',
  'Animesh-Khatua_athma',
  'Apoorva-S_athma',
  'Archana_athma',
  'Arjun-Shaji_athma',
  'Arun-Balaji-M_athma',
  'Arvind-Pandey_athma',
  'Avinash-C_athma',
  'Bukka-Himadhar-Kumar-Reddy_athma',
  'Damodhar-Rao_athma',
  'Dinesh-Kumar-K_athma',
  'Gnanesh-Gowda-NS_athma',
  'Guhan-R-P_athma',
  'Hari-Krishnan-P-C_athma',
  'Harish-M_athma',
  'Harshitha-Kumar-Shetty_athma',
  'Harshit-Jaiswal_athma',
  'Jalakuri-Siva-Rama-Krishna_athma',
  'Jana-M_athma',
  'Kumarakalva-Uday-Saisuma_athma',
  'Lokesha-CS_athma',
  'Lucky-Jain_athma',
  'Manu-Mohan-M_athma',
  'Mithun-Gowda-P_athma',
  'Modi-Jigar_athma',
  'Mohammad-Sonu_athma',
  'Mohammedali-S-Hanabaratti_athma',
  'M-Padma_athma',
  'Nallajodu-Chandra-Mohan_athma',
  'Navajeevan-B_athma',
  'Navin-Patel_athma',
  'Nithin-N_athma',
  'Pandiyan-E_athma',
  'Pavan-Kumar-Reddy-Gaddam_athma',
  'Prabhata-Kumar-Sahu_athma',
  'Pradeep-Kumar_athma',
  'Pradeep-S_athma',
  'Prasanta-Kumar-Padhan_athma',
  'Priyanka-Adhikary_athma',
  'Rajendra-Kumar_athma',
  'Rakesh-Kumar-Sahu_athma',
  'Rakesh-R_athma',
  'Ram-Kumar_athma',
  'Rounak-Singh_athma',
  'Sakthimai-A-R_athma',
  'Sangeetha-S_athma',
  'Sanjay-Kumar-Yadav_athma',
  'Santhosh-Kumar-C_athma',
  'Saravanakumar-N_athma',
  'Satyam-Kumar_athma',
  'Shivam_athma',
  'Shivani-Karri_athma',
  'Shubham-Kumar_athma',
  'Siddhant-Saraf_athma',
  'Siva-Ganesh-Sagar-Yedumalla_athma',
  'Srinathareddy-Isukapalli_athma',
  'Srinivasarao-Ganipisetty_athma',
  'Thayakotli-Krishna_athma',
  'Umesha-C-S_athma',
  'Valleti-Vinay-Kumar_athma',
  'Vijay-Kumar-Yadav_athma',
  'Vinayak-Dhalabanjan_athma',
  'Vineela-Gumireddy_athma',
  'Vishnu-K-R_athma',
  'Zaheer-Abass_athma',
] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const known = await prisma.developerIdentity.findMany({
    where: { tenantId: TENANT_ID, canonicalDeveloperId: { in: [...LOGINS] } },
    select: { canonicalDeveloperId: true },
    distinct: ['canonicalDeveloperId'],
  });
  const resolved = new Set(known.map((row) => row.canonicalDeveloperId));
  const unresolved = LOGINS.filter((login) => !resolved.has(login));

  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Roster size: ${LOGINS.length}`);
  console.log(`Resolved to a known developer: ${resolved.size}`);
  console.log(`NOT resolved: ${unresolved.length}`);
  for (const login of unresolved) {
    console.log(`  unresolved: ${login}`);
  }
  if (unresolved.length > 0) {
    console.log(
      '\nUnresolved entries will be reported by the digest as unresolved, never\n' +
        'named as inactive. Review them before enabling the notification: the\n' +
        'usual causes are a renamed account, a login that never committed, or a\n' +
        'person whose identities need an IdentityOverride merge.',
    );
  }

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to write these rows.');
    return;
  }

  for (const login of LOGINS) {
    await prisma.trackedDeveloper.upsert({
      where: {
        tenantId_canonicalDeveloperId: {
          tenantId: TENANT_ID,
          canonicalDeveloperId: login,
        },
      },
      create: {
        id: newId(),
        tenantId: TENANT_ID,
        canonicalDeveloperId: login,
        addedAs: login,
        createdByUserId: ADDED_BY,
      },
      update: { active: true },
    });
  }
  console.log(`\nApplied: ${LOGINS.length} roster rows upserted.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
```

- [ ] **Step 2: Add the npm script**

In `backend/package.json`, add to `scripts` (matching however `identity:overrides` is defined there):

```json
    "digest:roster": "ts-node scripts/seed-tracked-developers.ts",
```

- [ ] **Step 3: Verify it compiles**

Run: `cd backend && npx tsc --noEmit && npm run lint:ci`
Expected: PASS. Do **not** run the script here — it needs the hosted database. It runs in the rollout (spec §8 step 3).

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/seed-tracked-developers.ts backend/package.json
git commit -m "feat(scripts): seed the tracked developer roster, report-only by default"
```

---

### Task 11: Documentation and ADR

CLAUDE.md treats docs as part of the implementation. This task is not optional, and the ADR is a governance requirement of the feature (spec §3), not a formality.

**Files:**
- Create: `docs/ADR/0009-attributed-commit-digest.md`
- Create: `docs/features/NOTIFICATIONS.md`
- Modify: `docs/api/README.md` (endpoints + §12 gap register)
- Modify: `docs/security/AUTH-AND-RBAC.md`
- Modify: `docs/architecture/DATA-MODEL.md`
- Modify: `docs/deployment/` (the runbook covering migrations/config)
- Modify: `docs/ADR/README.md` (index)

- [ ] **Step 1: Write ADR 0009**

Follow the structure of an existing ADR (read `docs/ADR/0008-github-graphql-over-webhooks.md` first). It must record: that CLAUDE.md's ethics-first rule forbids attributed individual output without an explicit decision; that this decision was taken on 2026-09-18; the conditions it ships under (the rule displayed in the message; suppressions honoured; every run recorded and audited); that it does **not** extend to any other notification; and what parity with the Overview costs (a reviewer reads as inactive).

- [ ] **Step 2: Write `docs/features/NOTIFICATIONS.md`**

A new file is justified: BC-15 has no existing doc to absorb this. Cover the rule (roster minus `activeDeveloperSet`, previous working day), the suppressions, the three withhold gates, the `incomplete` classification and why it exists, the outcome vocabulary, the card contract including the mandatory rule line, and the admin endpoints. Link the ADR.

- [ ] **Step 3: Update `docs/api/README.md`**

Document `GET|PUT|DELETE /dashboards/tracked-developers` and `POST /admin/notifications/no-commit-digest/run` (including `dryRun` and `force` semantics and the already-sent refusal). Add the §12 gap-register entry for the one known limitation: a reviewer with no commit or PR reads as inactive, inherited deliberately from the Overview's signal set.

- [ ] **Step 4: Update the security and data-model docs**

`AUTH-AND-RBAC.md`: the new admin-only routes, and the Teams webhook URL as a secret ref that is never logged because it carries its credential in the query string. `DATA-MODEL.md`: the two new tables.

- [ ] **Step 5: Update the deployment runbook**

The manual migration step, setting the `teamsWebhookRef` secret, the `dailyDigestEnabled` flag, and the §8 rollout order — report-only seed, then dry run, then one deliberate live post, then the cron.

- [ ] **Step 6: Full verification**

Run: `cd backend && rm -rf dist && npm run build && npx jest && npm run lint:ci`

Expected: all PASS. `rm -rf dist` first is deliberate — a failed `nest build` with `deleteOutDir` leaves a running server with a gutted `dist`, which presents as an authentication failure rather than a build failure.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(notifications): document the daily digest and record ADR 0009"
```

---

## Verification checklist before opening a PR

- [ ] `cd backend && rm -rf dist && npm run build` passes.
- [ ] `npx jest` passes, including every pre-existing `overview` test (Task 2 must not change `developersWithSignal`).
- [ ] `npm run lint:ci` passes — not `npm run lint`.
- [ ] `npx tsc --noEmit` passes.
- [ ] No test posts to Teams; `fetch` is mocked everywhere.
- [ ] The webhook URL appears in no log statement anywhere in the diff.
- [ ] Every new Prisma query filters on `tenantId`.
- [ ] The migration is committed but **not** applied — a human applies it on the host.

## Known limits of local verification

State these plainly when reporting completion rather than implying full verification:

- The 66 logins are **unverified** against real data. Whether each resolves to a `DeveloperIdentity` is only knowable by running Task 10's report against the hosted database.
- No real commit counts have been checked. Correctness against actual activity is established by the `dryRun` endpoint on the host and reconciling its output against the Activity Overview board for the same IST day (spec §8 step 5).
- Browser-based verification is unavailable in this environment.
- No Teams message has been delivered; the transport is exercised only against a mocked `fetch`.
