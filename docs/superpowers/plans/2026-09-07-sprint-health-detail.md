# Sprint Health Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/sprint-health` detail card with five sprint-scoped panels — commit activity, daily check-ins, productivity, quality check, and per-RC scope — fed by one new Jira collector read and three new BFF endpoints.

**Architecture:** Jira project versions enter through the existing collector → ingestion → planning projection path as a new `planning.version.upserted` event; the planned release date is user input stored alongside it. Reads live in a new `SprintHealthDetailService` (BC-8) rather than growing `InsightsService`, which is already ~1,450 lines. The frontend adds a `sprint-health/` module directory beside `developer-activity/`.

**Tech Stack:** NestJS + Prisma + PostgreSQL, Jest for backend tests; React + TanStack Query + Tailwind semantic tokens, Vitest for frontend tests.

**Spec:** [docs/superpowers/specs/2026-09-07-sprint-health-revamp-design.md](../specs/2026-09-07-sprint-health-revamp-design.md)

## Global Constraints

- **Tenant scoping is mandatory.** Every query filters by `tenantId`, taken from `TenantContextService.requireTenantId()`. Every new route gets a tenant-isolation test.
- **Collector boundary.** Only `backend/src/collectors/**` may call Jira. The collector must not read BC-3 tables (`planning_*`) — it answers "which projects" from its own `syncCursors`.
- **Ingestion pipeline.** New source data arrives as a `CanonicalEnvelope` with a deterministic `idempotencyKey`; nothing writes domain tables directly from a collector.
- **No raw Tailwind palette classes** (`slate-*`, `emerald-*`, …). Semantic tokens only, per `docs/development/DESIGN-SYSTEM.md`.
- **Day bucketing uses `istDateKey`** — the helper every other daily series uses. Do not introduce a second day boundary.
- **Null is rendered "—", never 0.** A metric with no data says so; it never borrows the appearance of a real zero.
- **Verify with `npm run lint:ci`, never `npm run lint`** — the latter auto-fixes and therefore cannot fail.
- **Commit messages** end with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## File Structure

**Backend — collection (BC-1):**
- Modify `backend/src/collectors/sources/jira/jira.client.ts` — add `getProjectVersions`
- Modify `backend/src/collectors/sources/jira/jira.collector.ts` — emit version envelopes; add `versions` to the issue field list
- Modify `backend/src/common/events/event-types.ts`, `backend/src/common/events/contracts.ts` — new event type + payload

**Backend — projection (BC-3):**
- Modify `backend/prisma/schema.prisma` + new migration
- Modify `backend/src/modules/planning/planning.service.ts` — handle the version event; carry `affectsReleases`

**Backend — reads (BC-8 / BFF):**
- Create `backend/src/metrics/sprint-health-detail.service.ts` — the three reads
- Create `backend/src/modules/dashboards/release-plan.controller.ts` — planned-date input
- Modify `backend/src/modules/dashboards/insights.controller.ts` — three routes
- Modify `backend/src/metrics/metrics.module.ts`, `backend/src/modules/dashboards/dashboards.module.ts` — wiring

**Frontend:**
- Create `frontend/src/modules/dashboards/sprint-health/` — `CommitActivityTiles.tsx`, `CheckInGrid.tsx`, `ProductivityPanel.tsx`, `QualityCheckPanel.tsx`, `ReleaseCandidateList.tsx`, `PlannedDateField.tsx`
- Modify `frontend/src/modules/dashboards/useInsights.ts` — types + hooks
- Modify `frontend/src/modules/dashboards/boards.tsx` — `SprintHealthBoard` renders the panels

**Docs:** `docs/features/DASHBOARDS.md`, `docs/features/METRICS.md`, `docs/api/README.md` (§9, §12), `docs/architecture/DATA-MODEL.md`, `CLAUDE.md`, `AGENTS.md`.

---

### Task 1: Jira client — read project versions

**Files:**
- Modify: `backend/src/collectors/sources/jira/jira.client.ts`
- Test: `backend/src/collectors/sources/jira/jira.client.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `JiraVersion` interface and
  `JiraClient.getProjectVersions(siteUrl: string, email: string, apiToken: string, projectKey: string): Promise<JiraVersion[] | null>`
  — `null` on failure, `[]` for a project with no versions. Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `jira.client.spec.ts`, inside the existing `describe('JiraClient')`:

```ts
  it('GETs the project versions endpoint with Basic auth', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: [] })) as unknown as typeof fetch;

    await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/project/ACT/versions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    );
  });

  it('returns the versions it was given', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: [
          {
            id: '10042',
            name: 'RC1',
            startDate: '2026-08-14',
            releaseDate: '2026-08-22',
            released: true,
            archived: false,
            overdue: false,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    expect(versions).toEqual([
      {
        id: '10042',
        name: 'RC1',
        startDate: '2026-08-14',
        releaseDate: '2026-08-22',
        released: true,
        archived: false,
        overdue: false,
      },
    ]);
  });

  // Null, not []: the caller must be able to tell "this project has no
  // versions" from "we could not ask". Treating a 401 as an empty list would
  // mark every RC as unknown-dated and look like real data.
  it('returns null (not an empty list) when the request fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 401 }),
      ) as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    expect(versions).toBeNull();
  });

  it('returns null when no API token is available', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      '',
      'ACT',
    );

    expect(versions).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/collectors/sources/jira/jira.client.spec.ts -t "project versions"`
Expected: FAIL — `client.getProjectVersions is not a function`

- [ ] **Step 3: Implement `getProjectVersions`**

Add the interface near the other exported Jira types in `jira.client.ts`:

```ts
/**
 * A Jira project version (`fixVersion`), as returned by
 * `GET /rest/api/3/project/{key}/versions`.
 *
 * Note what is NOT here: an actual release date. Jira carries ONE date
 * (`releaseDate`, "expected to finish") and overwrites it with the release day
 * when the version is released, so the planned date is destroyed at exactly
 * the moment you would want to compare against it. That is why the planned
 * date is user input in SprintIQ (see planning_release.plannedReleaseAt).
 */
export interface JiraVersion {
  id: string;
  name: string;
  startDate?: string;
  releaseDate?: string;
  released?: boolean;
  archived?: boolean;
  overdue?: boolean;
}
```

And the method, following the shape of `getStatusCategories`:

```ts
  /**
   * `GET /rest/api/3/project/{projectIdOrKey}/versions` — the project's
   * fixVersions with their dates and released flag. Not paginated.
   *
   * Returns `null` (NOT `[]`) on failure, so a transient 401/429 is never
   * mistaken for "this project has no releases" — which would blank every RC
   * date on the board while looking like a fact.
   */
  async getProjectVersions(
    siteUrl: string,
    email: string,
    apiToken: string,
    projectKey: string,
  ): Promise<JiraVersion[] | null> {
    if (!apiToken) {
      return null;
    }
    const url = `${siteUrl.replace(/\/$/, '')}/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.warn(
        `Jira version fetch failed (${res.status}) for project ${projectKey}`,
      );
      return null;
    }
    const list = (await res.json()) as JiraVersion[];
    return Array.isArray(list) ? list : [];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/collectors/sources/jira/jira.client.spec.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/jira/jira.client.ts backend/src/collectors/sources/jira/jira.client.spec.ts
git commit -m "$(cat <<'EOF'
feat(collectors): read Jira project versions

Returns null rather than [] on failure so a transient 401 is never cached
as "this project has no releases".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Version event — contract, type, collector emission

**Files:**
- Modify: `backend/src/common/events/event-types.ts`
- Modify: `backend/src/common/events/contracts.ts`
- Modify: `backend/src/collectors/sources/jira/jira.collector.ts`
- Test: `backend/src/collectors/sources/jira/jira.collector.spec.ts`

**Interfaces:**
- Consumes: `JiraClient.getProjectVersions`, `JiraVersion` (Task 1)
- Produces:
  - `EventTypes.PLANNING_VERSION_UPSERTED = 'planning.version.upserted'` and `PLANNING_VERSION_EVENT_TYPES: string[]`
  - `PlanningVersionPayload { externalId: string; projectKey: string; name: string; startDate?: string; releaseDate?: string; released: boolean; archived: boolean }`
  - Envelopes with `idempotencyKey` = `jira:version:v1:{externalId}:{sha256 of the mutable fields, first 12 hex chars}`
  — Task 3 consumes the payload.

- [ ] **Step 1: Write the failing tests**

Add to `jira.collector.spec.ts`. Follow the file's existing harness for building a collector with fake `client`/`secrets`/`connections`; the assertions are what matters:

```ts
  it('emits one version envelope per Jira version, keyed on its mutable content', async () => {
    // Same version, twice, unchanged at the source.
    const first = await collector.sync(connection);
    const second = await collector.sync(connection);

    const keyOf = (envs: CanonicalEnvelope[]) =>
      envs.find((e) => e.eventType === 'planning.version.upserted')
        ?.idempotencyKey;

    expect(keyOf(first.envelopes)).toBeDefined();
    // Unchanged version → identical key → de-duped at the raw-event store.
    expect(keyOf(second.envelopes)).toBe(keyOf(first.envelopes));
  });

  it('changes the idempotency key when a version is released', async () => {
    const before = await collector.sync(connection);
    jiraClient.getProjectVersions.mockResolvedValue([
      { id: '10042', name: 'RC1', releaseDate: '2026-08-22', released: true },
    ]);
    const after = await collector.sync(connection);

    const keyOf = (envs: CanonicalEnvelope[]) =>
      envs.find((e) => e.eventType === 'planning.version.upserted')
        ?.idempotencyKey;

    // A release is the one state change the board exists to show; it MUST NOT
    // de-dupe against the unreleased envelope collected an hour earlier.
    expect(keyOf(after.envelopes)).not.toBe(keyOf(before.envelopes));
  });

  it('carries the version fields into the payload', async () => {
    const { envelopes } = await collector.sync(connection);
    const env = envelopes.find(
      (e) => e.eventType === 'planning.version.upserted',
    );

    expect(env?.data).toEqual({
      externalId: '10042',
      projectKey: 'ACT',
      name: 'RC1',
      startDate: '2026-08-14',
      releaseDate: '2026-08-22',
      released: false,
      archived: false,
    });
  });

  it('asks only for the projects it has itself observed, never the planning tables', async () => {
    // The connection sets no projectKey, and the pass collected an ACT issue.
    await collector.sync(connection);

    expect(jiraClient.getProjectVersions).toHaveBeenCalledWith(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );
  });

  it('does not fail the pass when the version fetch fails', async () => {
    jiraClient.getProjectVersions.mockResolvedValue(null);

    const { envelopes } = await collector.sync(connection);

    // Issues still collected; versions simply absent this pass.
    expect(envelopes.some((e) => e.eventType === 'planning.issue.updated')).toBe(
      true,
    );
    expect(
      envelopes.some((e) => e.eventType === 'planning.version.upserted'),
    ).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/collectors/sources/jira/jira.collector.spec.ts -t version`
Expected: FAIL — no version envelopes are emitted.

- [ ] **Step 3: Add the event type and payload contract**

In `event-types.ts`:

```ts
  PLANNING_STORY_UPDATED: 'planning.issue.updated',
  PLANNING_VERSION_UPSERTED: 'planning.version.upserted',
} as const;

export const PLANNING_VERSION_EVENT_TYPES: string[] = [
  EventTypes.PLANNING_VERSION_UPSERTED,
];
```

In `contracts.ts`:

```ts
/**
 * A Jira project version (fixVersion) as collected — the RC's identity, dates
 * and released flag.
 *
 * `releaseDate` means "expected to finish" while `released` is false, and
 * "the day it was released" once true: Jira reuses the one field for both and
 * overwrites the plan on release. The planned date therefore cannot come from
 * here; it is user input on `planning_release.plannedReleaseAt`.
 */
export interface PlanningVersionPayload {
  externalId: string;
  projectKey: string;
  name: string;
  startDate?: string;
  releaseDate?: string;
  released: boolean;
  archived: boolean;
}
```

- [ ] **Step 4: Emit the envelopes from the collector**

In `jira.collector.ts`, add to the `JiraSyncCursors` interface:

```ts
  /**
   * Project keys this collector has itself seen on collected issues — the
   * input to the per-project version fetch.
   *
   * Held here rather than read from `planning_release` on purpose: that table
   * belongs to BC-3, and a collector querying it would be the cross-context DB
   * coupling the architecture forbids. The collector already sees every key it
   * needs on the issues passing through it.
   */
  versionProjectKeys?: string[];
```

Accumulate keys in the page loop, next to the existing `lastSeenUpdatedAt` assignment:

```ts
        const seenProject = (issue.fields?.project as { key?: string } | undefined)?.key;
        if (seenProject) {
          observedProjectKeys.add(seenProject);
        }
```

After the page loop and before the cursor writes:

```ts
    // Union with what earlier passes saw, newest last, capped: a poll pass
    // touches only recently-updated issues, so this must not forget a project
    // that simply had a quiet week.
    const projectKeys = config.projectKey
      ? [config.projectKey]
      : [
          ...new Set([
            ...(cursors.versionProjectKeys ?? []),
            ...observedProjectKeys,
          ]),
        ].slice(-VERSION_PROJECT_KEY_LIMIT);
    cursors.versionProjectKeys = config.projectKey ? undefined : projectKeys;

    for (const projectKey of projectKeys) {
      const versions = await this.client.getProjectVersions(
        config.siteUrl,
        config.email,
        apiToken,
        projectKey,
      );
      // null = the ask failed. Skip silently rather than emitting nothing-as-fact;
      // the next tick retries, and the issue envelopes above still stand.
      for (const version of versions ?? []) {
        envelopes.push(this.versionEnvelope(connection, mode, projectKey, version));
      }
    }
```

With the constant and the envelope builder:

```ts
/** Bounds the per-tick version fetch: one request per project, per pass. */
const VERSION_PROJECT_KEY_LIMIT = 50;
```

```ts
  private versionEnvelope(
    connection: Connection,
    mode: CollectionMode,
    projectKey: string,
    version: JiraVersion,
  ): CanonicalEnvelope {
    const payload: PlanningVersionPayload = {
      externalId: String(version.id),
      projectKey,
      name: version.name,
      startDate: version.startDate,
      releaseDate: version.releaseDate,
      released: Boolean(version.released),
      archived: Boolean(version.archived),
    };
    // Versions carry no `updated` field, so the key hashes the mutable
    // content instead: an unchanged version re-emits the same key every tick
    // and de-dupes at the raw-event store, while a release or a date edit
    // produces a new one and lands.
    const signature = createHash('sha256')
      .update(
        [
          payload.name,
          payload.startDate ?? '',
          payload.releaseDate ?? '',
          String(payload.released),
          String(payload.archived),
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 12);

    return {
      schemaVersion: '1.0',
      eventId: newId(),
      idempotencyKey: `jira:version:v1:${payload.externalId}:${signature}`,
      sourceSystem: 'jira',
      connectionId: connection.id,
      collectionMode: mode,
      eventType: EventTypes.PLANNING_VERSION_UPSERTED,
      occurredAt: this.nowIso(),
      collectedAt: this.nowIso(),
      externalRefs: { version_id: payload.externalId, project: projectKey },
      data: payload as unknown as Record<string, unknown>,
    };
  }
```

Import `createHash` from `node:crypto` and `JiraVersion` from `./jira.client`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest src/collectors/sources/jira/jira.collector.spec.ts`
Expected: PASS, including the pre-existing issue-collection cases.

- [ ] **Step 6: Commit**

```bash
git add backend/src/common/events backend/src/collectors/sources/jira
git commit -m "$(cat <<'EOF'
feat(collectors): emit Jira project versions as planning.version.upserted

Idempotency hashes the mutable fields because versions carry no `updated`:
an unchanged version de-dupes, a release lands. Project keys come from the
collector's own cursors, never from BC-3 tables.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Schema — release detail, planned date, affects-version

**Files:**
- Modify: `backend/prisma/schema.prisma:379-393` (`Release`), `:235-291` (`Story`)
- Create: `backend/prisma/migrations/<timestamp>_sprint_health_detail/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: `planning_release.externalId | startAt | archived | plannedReleaseAt | plannedSetByUserId | plannedSetAt`, and `planning_story.affectsReleases String[]`. Tasks 4, 5, 8 and 9 consume these columns.

- [ ] **Step 1: Extend the Prisma models**

In `Release`:

```prisma
model Release {
  id           String    @id
  tenantId     String
  connectionId String
  name         String // Jira fixVersion name
  projectKey   String
  /// Jira version id. Null for a release first seen as a bare fixVersion name
  /// on an issue; filled in when the version event arrives.
  externalId   String?
  released     Boolean   @default(false)
  /// Jira's `startDate`.
  startAt      DateTime?
  /// Jira's `releaseDate`: "expected to finish" while unreleased, and the day
  /// it shipped once `released` is true — Jira reuses one field for both.
  releaseDate  DateTime?
  archived     Boolean   @default(false)
  /// The date this release was PLANNED for — user input, because Jira
  /// overwrites `releaseDate` on release and destroys the plan. Null means
  /// nobody has recorded one, and lateness is then not computed at all.
  plannedReleaseAt   DateTime?
  /// Who recorded the planned date. A human judgement carries a name.
  plannedSetByUserId String?
  plannedSetAt       DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@unique([tenantId, projectKey, name])
  @@index([tenantId, projectKey])
  @@map("planning_release")
}
```

In `Story`, after `releases`:

```prisma
  /// Jira's `versions` — Affects Version/s, i.e. where the defect was FOUND.
  /// Distinct from `releases` (fixVersions), which is where it will be fixed.
  /// "Bugs logged against RC1" is this field; using fixVersions would answer a
  /// different question while looking like this one. Empty on items collected
  /// before this field was requested, until they are re-walked.
  affectsReleases  String[]  @default([])
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `cd backend && npx prisma migrate dev --name sprint_health_detail --create-only`
Expected: a new folder under `prisma/migrations/` containing `ALTER TABLE` statements only — no `DROP`. Read the SQL and confirm that: every added column is nullable or has a default, and no existing column is altered.

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `cd backend && npx prisma migrate dev && npx prisma generate`
Expected: "Your database is now in sync with your schema."

- [ ] **Step 4: Verify the schema compiles against the codebase**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors (the new fields are additive; nothing existing referenced them).

- [ ] **Step 5: Commit**

```bash
git add backend/prisma
git commit -m "$(cat <<'EOF'
feat(planning): release dates, planned-date input, and affects-version columns

All additive and nullable: an unmigrated row renders as unknown, which the
board states, rather than as a zero it would present as a fact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Planning projection — consume the version event

**Files:**
- Modify: `backend/src/modules/planning/planning.service.ts:47-53` (`onModuleInit`), `:370-381` (`upsertRelease`)
- Test: `backend/src/modules/planning/planning.service.spec.ts`

**Interfaces:**
- Consumes: `PlanningVersionPayload`, `PLANNING_VERSION_EVENT_TYPES` (Task 2); the columns from Task 3
- Produces: `planning_release` rows carrying Jira's dates. Task 9 reads them.

- [ ] **Step 1: Write the failing tests**

Add to `planning.service.spec.ts`, using the file's existing fake-prisma harness:

```ts
  it('writes the version dates and released flag onto the release row', async () => {
    await service.handleVersion({
      tenantId: 't1',
      connectionId: 'c1',
      payload: {
        externalId: '10042',
        projectKey: 'ACT',
        name: 'RC1',
        startDate: '2026-08-14',
        releaseDate: '2026-08-22',
        released: true,
        archived: false,
      },
    } as DomainEvent<PlanningVersionPayload>);

    const arg = prisma.release.upsert.mock.calls[0][0] as {
      where: unknown;
      update: Record<string, unknown>;
    };
    expect(arg.update).toEqual({
      connectionId: 'c1',
      externalId: '10042',
      startAt: new Date('2026-08-14'),
      releaseDate: new Date('2026-08-22'),
      released: true,
      archived: false,
    });
  });

  // The planned date is a human judgement recorded in SprintIQ. A poll that
  // silently overwrote it would erase the only copy — Jira has no such field
  // to restore it from.
  it('never touches the user-entered planned date', async () => {
    await service.handleVersion({
      tenantId: 't1',
      connectionId: 'c1',
      payload: {
        externalId: '10042',
        projectKey: 'ACT',
        name: 'RC1',
        released: false,
        archived: false,
      },
    } as DomainEvent<PlanningVersionPayload>);

    const arg = prisma.release.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    for (const key of ['plannedReleaseAt', 'plannedSetByUserId', 'plannedSetAt']) {
      expect(arg.update).not.toHaveProperty(key);
      expect(arg.create).not.toHaveProperty(key);
    }
  });

  // A fixVersion name seen on an issue still creates the row; the version
  // event fills in the rest. The name path must not blank the dates.
  it('does not clear collected dates when an issue re-asserts the bare name', async () => {
    await service.handleStory({
      tenantId: 't1',
      connectionId: 'c1',
      payload: {
        externalKey: 'ACT-1',
        projectKey: 'ACT',
        status: 'Done',
        title: 'x',
        releases: ['RC1'],
      },
    } as DomainEvent<PlanningStoryPayload>);

    const call = prisma.release.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(call.update).toEqual({});
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/planning/planning.service.spec.ts -t version`
Expected: FAIL — `service.handleVersion is not a function`

- [ ] **Step 3: Implement the handler**

In `onModuleInit`, alongside the story subscription:

```ts
    for (const type of PLANNING_VERSION_EVENT_TYPES) {
      this.eventBus.subscribe<PlanningVersionPayload>(type, (e) =>
        this.handleVersion(e),
      );
    }
```

Add the handler and the date-carrying upsert. Note the two paths write disjoint
columns on purpose:

```ts
  /**
   * A Jira version (fixVersion) with its dates. Writes only source-owned
   * columns: `plannedReleaseAt` and its provenance are user input and are not
   * in this object at all, so a poll can never overwrite them.
   */
  async handleVersion(
    event: DomainEvent<PlanningVersionPayload>,
  ): Promise<void> {
    const p = event.payload;
    const fields = {
      connectionId: event.connectionId ?? '',
      externalId: p.externalId,
      startAt: p.startDate ? new Date(p.startDate) : null,
      releaseDate: p.releaseDate ? new Date(p.releaseDate) : null,
      released: p.released,
      archived: p.archived,
    };
    await this.prisma.release.upsert({
      where: {
        tenantId_projectKey_name: {
          tenantId: event.tenantId,
          projectKey: p.projectKey,
          name: p.name,
        },
      },
      create: {
        id: newId(),
        tenantId: event.tenantId,
        name: p.name,
        projectKey: p.projectKey,
        ...fields,
      },
      update: fields,
    });
  }
```

`upsertRelease` (the bare-name path) is unchanged: its `update: {}` is what
keeps an issue re-asserting `RC1` from blanking the dates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/planning/planning.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/planning
git commit -m "$(cat <<'EOF'
feat(planning): project Jira version dates onto releases

The source path and the user-input path write disjoint columns, so a poll can
never overwrite a planned date Jira has no way to restore.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Collect Affects Version onto stories

**Files:**
- Modify: `backend/src/collectors/sources/jira/jira.client.ts:74-86` (`BASE_SEARCH_FIELDS`)
- Modify: `backend/src/collectors/sources/jira/jira.collector.ts` (`mapIssueToPayload`)
- Modify: `backend/src/common/events/contracts.ts` (`PlanningStoryPayload`)
- Modify: `backend/src/modules/planning/planning.service.ts` (`handleStory` story upsert)
- Test: `backend/src/collectors/sources/jira/jira.collector.spec.ts`, `backend/src/modules/planning/planning.service.spec.ts`

**Interfaces:**
- Consumes: `planning_story.affectsReleases` (Task 3)
- Produces: `PlanningStoryPayload.affectsReleases?: string[]`, persisted to `Story.affectsReleases`. Task 9 reads it.

- [ ] **Step 1: Write the failing tests**

In `jira.collector.spec.ts`:

```ts
  it('requests Affects Version and carries it onto the payload', async () => {
    // `versions` is Jira's "Affects Version/s" — where a defect was FOUND.
    // fixVersions answers a different question and must not stand in for it.
    const { envelopes } = await collector.sync(connectionWithIssue({
      key: 'ACT-9',
      fields: {
        summary: 'crash on save',
        issuetype: { name: 'Bug' },
        project: { key: 'ACT' },
        versions: [{ name: 'RC1' }],
        fixVersions: [{ name: 'RC2' }],
      },
    }));

    const env = envelopes.find((e) => e.eventType.startsWith('planning.issue'));
    expect(env?.data).toMatchObject({
      affectsReleases: ['RC1'],
      releases: ['RC2'],
    });
  });
```

In `planning.service.spec.ts`:

```ts
  it('persists affectsReleases onto the story', async () => {
    await service.handleStory({
      tenantId: 't1',
      connectionId: 'c1',
      payload: {
        externalKey: 'ACT-9',
        projectKey: 'ACT',
        status: 'Open',
        title: 'crash on save',
        type: 'bug',
        affectsReleases: ['RC1'],
      },
    } as DomainEvent<PlanningStoryPayload>);

    const arg = prisma.story.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(arg.update).toMatchObject({ affectsReleases: ['RC1'] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest -t "Affects Version" && npx jest -t affectsReleases`
Expected: FAIL — the field is absent from both payload and upsert.

- [ ] **Step 3: Implement**

Add `'versions'` to `BASE_SEARCH_FIELDS`, next to `'fixVersions'`, with a comment:

```ts
  'fixVersions',
  // Affects Version/s — where a defect was found, as distinct from where it
  // will be fixed. "Bugs logged against this RC" is this field.
  'versions',
```

In `mapIssueToPayload`, beside the existing `fixVersions` mapping:

```ts
    const affectsVersions = fields.versions;
```
```ts
      affectsReleases: Array.isArray(affectsVersions)
        ? affectsVersions
            .map((v) => (v as { name?: string }).name)
            .filter((n): n is string => Boolean(n))
        : [],
```

Add to `PlanningStoryPayload` in `contracts.ts`:

```ts
  /**
   * Jira's `versions` (Affects Version/s) — where a defect was FOUND, as
   * distinct from `releases` (fixVersions), where it will be fixed.
   */
  affectsReleases?: string[];
```

And carry it in `handleStory`'s story upsert `fields` object:

```ts
      affectsReleases: p.affectsReleases ?? [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/collectors/sources/jira src/modules/planning`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/collectors/sources/jira backend/src/common/events/contracts.ts backend/src/modules/planning
git commit -m "$(cat <<'EOF'
feat(collectors): collect Jira Affects Version onto stories

"Bugs logged against this RC" is Affects Version; fixVersions would answer
"bugs to be fixed in it" while looking identical on the board.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Read service scaffold + commit activity tiles

**Files:**
- Create: `backend/src/metrics/sprint-health-detail.service.ts`
- Create: `backend/src/metrics/sprint-health-detail.service.spec.ts`
- Modify: `backend/src/metrics/metrics.module.ts` (provide + export the service)
- Modify: `backend/src/modules/dashboards/insights.controller.ts`

**Interfaces:**
- Consumes: `PlanningService.listItemsForSprint`, `CodeService.listCommitsPage`, `DeveloperIdentityService.attributionIndex`, the existing `attributeCommit` + `istDateKey` helpers, and `InsightsService.repoToProjects` (promote it from `private` to `public` in this task — one word, and it is the only existing repo→project mapping)
- Also produces `PlanningService.findSprintByExternalId(tenantId, externalId): Promise<Sprint | null>` — see the bug note in Step 3. Tasks 7–10 use it too.
- Produces:

```ts
export interface SprintWindow { from: Date; to: Date; dayKeys: string[]; repos: string[] }
export interface CommitActivityView {
  committers: number;
  assignees: number;
  commits: number;
  commitsPerDay: number | null;
  prsRaised: number;
  prsOpen: number;
  prsMerged: number;
  prsReviewed: number;
  reviewedPct: number | null;
  avgHoursToFirstReview: number | null;
  prsWaitingOver24h: number;
  repos: string[];
}
export class SprintHealthDetailService {
  commitActivity(sprintExternalId: string): Promise<CommitActivityView | null>;
}
```
Tasks 7–10 add methods to this same class; Tasks 12–16 consume the shapes.

- [ ] **Step 1: Write the failing tests**

Create `sprint-health-detail.service.spec.ts`. Build the service with jest-mocked
collaborators (`{ listItemsForSprint: jest.fn(), … }` cast to the service types),
as the neighbouring `insights.service.spec.ts` does:

```ts
describe('SprintHealthDetailService.commitActivity', () => {
  it('returns null for a sprint that does not exist', async () => {
    planning.listSprints.mockResolvedValue([]);
    expect(await service.commitActivity('999')).toBeNull();
  });

  it('counts committers against the sprint assignee roster', async () => {
    // 2 people committed; 3 people are assigned items in the sprint.
    const view = await service.commitActivity('42');
    expect(view).toMatchObject({ committers: 2, assignees: 3 });
  });

  it('windows commits to the sprint and averages over its elapsed days', async () => {
    // Sprint: 2026-08-25 → 2026-09-05, "now" 2026-08-31 → 7 elapsed days.
    const view = await service.commitActivity('42');
    expect(view?.commits).toBe(14);
    expect(view?.commitsPerDay).toBe(2);
  });

  // A sprint with no reviewed PR has no average. Reporting 0 would say
  // "reviewed instantly", the opposite of the truth.
  it('reports a null first-review average when nothing has been reviewed', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      { authorLogin: 'a', openedAt: new Date('2026-08-26'), firstReviewAt: null, mergedAt: null },
    ]);
    const view = await service.commitActivity('42');
    expect(view?.avgHoursToFirstReview).toBeNull();
    expect(view?.prsReviewed).toBe(0);
  });

  it('counts PRs still waiting over 24h for a first review', async () => {
    const view = await service.commitActivity('42');
    expect(view?.prsWaitingOver24h).toBe(1);
  });

  it('scopes commits to repos mapped to the sprint project', async () => {
    insights.repoToProjects.mockResolvedValue(
      new Map([['org/act-api', ['ACT']], ['org/other', ['PAY']]]),
    );
    await service.commitActivity('42');
    expect(code.listCommitsPage).toHaveBeenCalledWith('t1', expect.objectContaining({
      repos: ['org/act-api'],
    }));
  });

  // Isolation is tested, not assumed. Every read on this service resolves its
  // tenant from the request context and passes it down; none takes one from
  // the caller, so a sprint id alone can never reach another tenant's data.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    await service.commitActivity('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith('t-other', '42');
    expect(code.listCommitsPage).toHaveBeenCalledWith('t-other', expect.anything());
  });

  it('returns null for a sprint id belonging to another tenant', async () => {
    planning.findSprintByExternalId.mockResolvedValue(null);
    expect(await service.commitActivity('42')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add a direct sprint lookup (and fix the existing one)**

`InsightsService.findSprint` looks a sprint up by loading `listSprints`, which
carries `take: 100`, and scanning it. On a tenant with more than 100 sprints
that lookup returns `null` for older sprints and the board reports "Sprint not
found" for a sprint that exists. `planning_sprint` already has
`@@unique([tenantId, externalId])`, so the lookup should be a point read.

Add to `PlanningService`:

```ts
  /**
   * One sprint by its source id — a point read on the unique key.
   *
   * NOT `listSprints(...).find(...)`: that read is capped at 100 rows, so
   * scanning it silently reports "not found" for any sprint outside the most
   * recent hundred. This board is opened from links to closed sprints.
   */
  findSprintByExternalId(
    tenantId: string,
    externalId: string,
  ): Promise<Sprint | null> {
    return this.prisma.sprint.findUnique({
      where: { tenantId_externalId: { tenantId, externalId } },
    });
  }
```

Then repoint the existing `InsightsService.findSprint` at it — the same latent
bug affects the pace cards' drill-in today, and this is the one line that fixes
it.

- [ ] **Step 4: Implement the service and the window helper**

```ts
/**
 * BC-8 read model for the Sprint Health detail (DASHBOARDS.md §Sprint Health).
 *
 * Separate from InsightsService, which is already ~1,450 lines and owns the
 * pace ranking. This class owns one question — "what happened inside this
 * sprint" — and is sized to be held in one head.
 */
@Injectable()
export class SprintHealthDetailService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly identities: DeveloperIdentityService,
    private readonly insights: InsightsService,
  ) {}

  /**
   * The sprint's own window, clamped to now: a running sprint is measured over
   * the days it has actually had, not the days it was allotted. Averaging 14
   * days of commits over a 21-day plan understates a team mid-sprint.
   */
  private async window(
    tenantId: string,
    sprintExternalId: string,
  ): Promise<{ sprint: Sprint; win: SprintWindow } | null> {
    const sprint = await this.planning.findSprintByExternalId(
      tenantId,
      sprintExternalId,
    );
    if (!sprint?.startAt) {
      return null;
    }
    const from = sprint.startAt;
    const to = sprint.endAt && sprint.endAt < new Date() ? sprint.endAt : new Date();
    const repoToProjects = await this.insights.repoToProjects(tenantId);
    const repos = [...repoToProjects.entries()]
      .filter(([, projects]) => projects.includes(sprint.projectKey))
      .map(([repo]) => repo);
    return { sprint, win: { from, to, dayKeys: dayKeysBetween(from, to), repos } };
  }
```

`commitActivity` then: fetch items for the sprint (assignee count), commits in
the window on those repos (attributed via `attributeCommit` + `attributionIndex`),
and PRs opened in the window. `commitsPerDay` = `commits / dayKeys.length`
rounded to one decimal, `null` when the window has no days. `prsReviewed` counts
PRs with a non-null `firstReviewAt`; `avgHoursToFirstReview` averages
`firstReviewAt - openedAt` over exactly those, and is `null` when there are none.
`prsWaitingOver24h` counts PRs with `firstReviewAt === null` and
`openedAt < now - 24h`.

- [ ] **Step 5: Wire the route**

In `insights.controller.ts`, extend the existing sprint-health route rather than
adding a second one — the tiles belong to the same sprint selection:

```ts
  @Get('sprint-health')
  async sprintHealth(@Query('sprint') sprint?: string) {
    const id = requireParam(sprint, 'sprint');
    const [view, commitActivity] = await Promise.all([
      this.insights.sprintHealth(id),
      this.detail.commitActivity(id),
    ]);
    if (!view) {
      throw new NotFoundException('Sprint not found.');
    }
    return { ...view, commitActivity, computedAt: new Date().toISOString() };
  }
```

Inject `private readonly detail: SprintHealthDetailService` into the controller,
and provide/export the service from `MetricsModule`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/metrics backend/src/modules/dashboards/insights.controller.ts
git commit -m "$(cat <<'EOF'
feat(metrics): sprint-scoped commit activity for Sprint Health

Window is clamped to now, so a running sprint is averaged over the days it
has had rather than the days it was allotted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Productivity panel read

**Files:**
- Modify: `backend/src/metrics/sprint-health-detail.service.ts`
- Test: `backend/src/metrics/sprint-health-detail.service.spec.ts`

**Interfaces:**
- Consumes: the `window` helper (Task 6)
- Produces:

```ts
export type ProductivityGrade = 'high' | 'medium' | 'low';
export interface ProductivityRow {
  developer: string;        // canonical developer id
  displayName: string;
  additions: number;
  deletions: number;
  ticketsWorked: number;
  commits: number;
  prsRaised: number;
  prsReviewed: number;
  score: number;            // the composite the grade is cut from
  grade: ProductivityGrade;
}
export interface ProductivityView {
  rows: ProductivityRow[];
  highest: { additions: number } | null;
  lowest: { additions: number } | null;
  gradeRule: string;
}
export class SprintHealthDetailService {
  productivity(sprintExternalId: string): Promise<ProductivityView | null>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('SprintHealthDetailService.productivity', () => {
  // The grade must not be a LOC proxy: this is the one rule the board's
  // ethics hang on, and it is invisible in the rendered pill.
  it('grades on tickets + PRs + reviews, never on LOC', async () => {
    // dev-a: 4,000 LOC, 1 ticket, 0 PRs, 0 reviews
    // dev-b:   100 LOC, 9 tickets, 5 PRs, 6 reviews
    const view = await service.productivity('42');
    const byDev = new Map(view!.rows.map((r) => [r.developer, r]));
    expect(byDev.get('dev-b')!.grade).toBe('high');
    expect(byDev.get('dev-a')!.grade).toBe('low');
  });

  it('cuts tertiles across this sprint contributors', async () => {
    const view = await service.productivity('42');
    expect(view!.rows.map((r) => r.grade)).toEqual([
      'high', 'high', 'medium', 'medium', 'low', 'low',
    ]);
  });

  it('publishes the rule it graded by', async () => {
    const view = await service.productivity('42');
    expect(view!.gradeRule).toContain('not lines of code');
  });

  it('reports highest and lowest LOC contributors', async () => {
    const view = await service.productivity('42');
    expect(view!.highest).toEqual({ additions: 4000 });
    expect(view!.lowest).toEqual({ additions: 100 });
  });

  // One contributor cannot be a tertile. Grading them "high" or "low" would
  // be a verdict drawn from a distribution of one.
  it('grades everyone medium when there are too few contributors to rank', async () => {
    const view = await service.productivity('42');
    expect(view!.rows.every((r) => r.grade === 'medium')).toBe(true);
    expect(view!.highest).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts -t productivity`
Expected: FAIL — `service.productivity is not a function`

- [ ] **Step 3: Implement**

Aggregate per canonical developer over the window: LOC and commits from the
commit pass (`attributeCommit`), PRs raised and reviews submitted from
`prisma.pullRequest` / `prisma.prReview`, and `ticketsWorked` as the count of
distinct `externalKey`s that developer transitioned in
`planning_issue_status_history` (matched through the identity index, same as
elsewhere). Then:

```ts
/**
 * The composite the high/medium/low grade is cut from.
 *
 * Deliberately excludes lines of code. LOC measures how much text changed, not
 * how much was delivered, and a grade that tracked it would reward churn and
 * punish the person who deleted 400 lines of dead code. The rule ships to the
 * client in `gradeRule` and is printed under the table, so the reader can
 * check the verdict rather than trust it.
 */
const scoreOf = (r: { ticketsWorked: number; prsRaised: number; prsReviewed: number }) =>
  r.ticketsWorked + r.prsRaised + r.prsReviewed;

const GRADE_RULE =
  "Tertiles of tickets worked + PRs raised + reviews submitted, across this sprint's contributors — not lines of code.";
```

Grade by sorting on `score` descending and cutting at thirds; when fewer than
three contributors have any signal, every row is `medium` and `highest`/`lowest`
are `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/metrics
git commit -m "$(cat <<'EOF'
feat(metrics): per-developer sprint productivity with a published grade rule

The grade is cut from tickets + PRs + reviews, never LOC, and the rule ships
with the data so the verdict is auditable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Quality check read

**Files:**
- Modify: `backend/src/metrics/sprint-health-detail.service.ts`
- Test: `backend/src/metrics/sprint-health-detail.service.spec.ts`

**Interfaces:**
- Consumes: the `window` helper (Task 6)
- Produces:

```ts
export interface QualityCheckView {
  storiesReleased: number;
  rolledBack: number;
  rolledBackPct: number | null;
  bugsByPriority: { priority: string; count: number }[];
  bugsLogged: number;
  bugsPerStoryReleased: number | null;
}
export class SprintHealthDetailService {
  qualityCheck(sprintExternalId: string): Promise<QualityCheckView | null>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('SprintHealthDetailService.qualityCheck', () => {
  it('counts stories that carry a release and reached done in the window', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.storiesReleased).toBe(18);
  });

  // "Rolled back" is a transition OUT of done, which only the status history
  // can show — the story row alone carries the current status and would report
  // a reopened-then-refixed item as if nothing had happened.
  it('counts items that left a done status after entering one', async () => {
    history.findMany.mockResolvedValue([
      { externalKey: 'ACT-1', fromCategory: 'done', toCategory: 'indeterminate', transitionedAt: new Date('2026-08-28') },
      { externalKey: 'ACT-1', fromCategory: 'indeterminate', toCategory: 'done', transitionedAt: new Date('2026-08-29') },
    ]);
    const view = await service.qualityCheck('42');
    expect(view!.rolledBack).toBe(1);
  });

  it('groups bugs by priority, keeping Jira order', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.bugsByPriority).toEqual([
      { priority: 'Highest', count: 4 },
      { priority: 'High', count: 8 },
      { priority: 'Medium', count: 11 },
      { priority: 'Low', count: 6 },
    ]);
  });

  it('reports a null bug ratio when nothing was released', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.storiesReleased).toBe(0);
    expect(view!.bugsPerStoryReleased).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts -t qualityCheck`
Expected: FAIL — `service.qualityCheck is not a function`

- [ ] **Step 3: Implement**

`storiesReleased`: sprint items with a non-empty `releases` whose
`statusCategory === 'done'` and whose latest done transition falls in the window.
`rolledBack`: distinct `externalKey`s in `planning_issue_status_history` with
`fromCategory === 'done'` and `toCategory !== 'done'` inside the window.
`bugsByPriority`: sprint items with `type === 'bug'`, grouped on `priority`
(null → `'Unprioritised'`), ordered `Highest, High, Medium, Low, Lowest,
Unprioritised` with unknown names appended in encounter order.
`bugsPerStoryReleased`: `bugsLogged / storiesReleased`, one decimal, `null` when
the denominator is zero.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/metrics
git commit -m "$(cat <<'EOF'
feat(metrics): sprint quality check — releases, rollbacks, bugs by priority

Rollbacks come from the status history, not the story row: a reopened item
that was fixed again is invisible in its current status.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Daily check-ins read + route

**Files:**
- Modify: `backend/src/metrics/sprint-health-detail.service.ts`
- Modify: `backend/src/modules/dashboards/insights.controller.ts`
- Test: `backend/src/metrics/sprint-health-detail.service.spec.ts`

**Interfaces:**
- Consumes: the `window` helper (Task 6)
- Produces:

```ts
export interface CheckInRow {
  developer: string;
  displayName: string;
  counts: number[];   // one per day in `days`, same order
  total: number;
}
export interface CheckInsView {
  days: string[];          // IST date keys, ascending
  rows: CheckInRow[];
  sprintFrom: string | null;   // ISO — the pager clamps to these
  sprintTo: string | null;
}
export class SprintHealthDetailService {
  checkIns(sprintExternalId: string, from?: Date, to?: Date): Promise<CheckInsView | null>;
}
```
Route: `GET /api/dashboards/sprint-health/check-ins?sprint=&from=&to=`

- [ ] **Step 1: Write the failing tests**

```ts
describe('SprintHealthDetailService.checkIns', () => {
  it('buckets transitions per developer per IST day', async () => {
    history.findMany.mockResolvedValue([
      { authorLogin: 'rahul', authorName: 'Rahul S.', transitionedAt: new Date('2026-08-25T04:00:00Z') },
      { authorLogin: 'rahul', authorName: 'Rahul S.', transitionedAt: new Date('2026-08-25T09:00:00Z') },
      { authorLogin: 'priya', authorName: 'Priya N.', transitionedAt: new Date('2026-08-26T05:00:00Z') },
    ]);
    const view = await service.checkIns('42', new Date('2026-08-25'), new Date('2026-08-26'));

    expect(view!.days).toEqual(['2026-08-25', '2026-08-26']);
    expect(view!.rows).toEqual([
      { developer: 'rahul', displayName: 'Rahul S.', counts: [2, 0], total: 2 },
      { developer: 'priya', displayName: 'Priya N.', counts: [0, 1], total: 1 },
    ]);
  });

  // 18:30 UTC is the next IST day. Bucketing this in UTC would put a Monday
  // evening check-in on Monday for this board and Tuesday on every other one.
  it('uses the IST day boundary, like every other daily series', async () => {
    history.findMany.mockResolvedValue([
      { authorLogin: 'rahul', authorName: 'Rahul S.', transitionedAt: new Date('2026-08-25T19:00:00Z') },
    ]);
    const view = await service.checkIns('42', new Date('2026-08-25'), new Date('2026-08-26'));
    expect(view!.rows[0].counts).toEqual([0, 1]);
  });

  it('clamps the requested range to the sprint own days', async () => {
    // Sprint runs 2026-08-25 → 2026-09-05; caller asks for all of August.
    const view = await service.checkIns('42', new Date('2026-08-01'), new Date('2026-08-31'));
    expect(view!.days[0]).toBe('2026-08-25');
  });

  it('defaults to the first seven sprint days when no range is given', async () => {
    const view = await service.checkIns('42');
    expect(view!.days).toHaveLength(7);
    expect(view!.days[0]).toBe('2026-08-25');
  });

  it('returns an empty row set, not null, for a sprint nobody moved a ticket in', async () => {
    history.findMany.mockResolvedValue([]);
    const view = await service.checkIns('42');
    expect(view!.rows).toEqual([]);
    expect(view!.days).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts -t checkIns`
Expected: FAIL — `service.checkIns is not a function`

- [ ] **Step 3: Implement**

Query `planning_issue_status_history` for the sprint's item keys within the
clamped range, bucket by `istDateKey(transitionedAt)` per `authorLogin`, and sort
rows by `total` descending. Rows are ordered by volume, not alphabetically, so
the grid reads as an activity picture rather than a register.

Clamp helper:

```ts
    // The range the caller asked for, intersected with the sprint's own days:
    // a grid showing days the sprint did not run reports zeros that mean
    // "not a sprint day", indistinguishable from "nobody moved anything".
    const start = maxDate(from ?? win.from, win.from);
    const end = minDate(to ?? addDays(start, CHECK_IN_PAGE_DAYS - 1), win.to);
```

with `const CHECK_IN_PAGE_DAYS = 7;`.

- [ ] **Step 4: Add the route**

```ts
  /**
   * Ticket movement per developer per day. Its own route because the grid
   * pages by date range — folding it into `sprint-health` would re-run every
   * sprint aggregate on each page flip.
   */
  @Get('sprint-health/check-ins')
  async sprintCheckIns(
    @Query('sprint') sprint?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const view = await this.detail.checkIns(
      requireParam(sprint, 'sprint'),
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
    if (!view) {
      throw new NotFoundException('Sprint not found.');
    }
    return { ...view, computedAt: new Date().toISOString() };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/metrics backend/src/modules/dashboards/insights.controller.ts
git commit -m "$(cat <<'EOF'
feat(metrics): daily check-in grid for a sprint

Own route because the grid pages by date; IST day keys so it agrees with
every other daily series on the platform.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Release-candidate read + route

**Files:**
- Modify: `backend/src/metrics/sprint-health-detail.service.ts`
- Modify: `backend/src/modules/dashboards/insights.controller.ts`
- Test: `backend/src/metrics/sprint-health-detail.service.spec.ts`

**Interfaces:**
- Consumes: `planning_release` columns (Task 3), `Story.affectsReleases` (Task 5)
- Produces:

```ts
export interface RcStory { key: string; title: string; delivered: boolean }
export interface ReleaseCandidateView {
  name: string;
  externalId: string | null;
  plannedReleaseAt: string | null;
  actualReleaseAt: string | null;
  released: boolean;
  daysLate: number | null;
  storiesDelivered: number;
  storiesTotal: number;
  stories: RcStory[];
  bugsByPriority: { priority: string; count: number }[];
  bugSource: 'affects-version' | 'fix-version-fallback';
  testExecution: null;
}
export class SprintHealthDetailService {
  releaseCandidates(sprintExternalId: string): Promise<ReleaseCandidateView[] | null>;
}
```
Route: `GET /api/dashboards/sprint-health/release-candidates?sprint=`

- [ ] **Step 1: Write the failing tests**

```ts
describe('SprintHealthDetailService.releaseCandidates', () => {
  it('lists one entry per release carried by the sprint stories', async () => {
    const view = await service.releaseCandidates('42');
    expect(view!.map((r) => r.name)).toEqual(['RC1', 'RC2', 'RC3']);
  });

  it('computes lateness from the planned date against Jira release date', async () => {
    release.findMany.mockResolvedValue([
      { name: 'RC1', projectKey: 'ACT', externalId: '1', released: true,
        releaseDate: new Date('2026-08-22'), plannedReleaseAt: new Date('2026-08-20') },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0]).toMatchObject({ daysLate: 2, actualReleaseAt: '2026-08-22T00:00:00.000Z' });
  });

  // Jira overwrites the planned date on release, so without a recorded plan
  // there is nothing to compare against. Inventing one — from startDate, from
  // the sprint end — would be a fabricated verdict on a real team.
  it('reports null lateness when no planned date was recorded', async () => {
    release.findMany.mockResolvedValue([
      { name: 'RC1', projectKey: 'ACT', released: true,
        releaseDate: new Date('2026-08-22'), plannedReleaseAt: null },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0].daysLate).toBeNull();
  });

  it('reports no actual date for an unreleased RC', async () => {
    const view = await service.releaseCandidates('42');
    expect(view!.at(-1)).toMatchObject({ released: false, actualReleaseAt: null, daysLate: null });
  });

  it('splits stories into delivered and pending', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0]).toMatchObject({ storiesDelivered: 2, storiesTotal: 5 });
    expect(view![0].stories).toContainEqual({
      key: 'ACT-4225', title: 'Appointment reschedule notification', delivered: false,
    });
  });

  it('counts bugs by Affects Version and says so', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0].bugSource).toBe('affects-version');
    expect(view![0].bugsByPriority).toEqual([
      { priority: 'Highest', count: 3 },
      { priority: 'High', count: 6 },
    ]);
  });

  // Stories collected before Affects Version was requested carry none. The
  // fallback keeps the panel useful, and the label keeps it honest about
  // which question the number answers.
  it('falls back to fixVersion and labels the fallback when no story carries an affects version', async () => {
    story.findMany.mockResolvedValue([
      { externalKey: 'ACT-1', type: 'bug', priority: 'High', releases: ['RC1'], affectsReleases: [] },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0].bugSource).toBe('fix-version-fallback');
    expect(view![0].bugsByPriority).toEqual([{ priority: 'High', count: 1 }]);
  });

  it('carries a null test-execution block for the panel placeholder', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0].testExecution).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/metrics/sprint-health-detail.service.spec.ts -t releaseCandidates`
Expected: FAIL — `service.releaseCandidates is not a function`

- [ ] **Step 3: Implement**

Collect the distinct release names across the sprint's items, load the matching
`planning_release` rows for the sprint's project, and build one view each,
ordered by `releaseDate` then name. `actualReleaseAt` is `releaseDate` only when
`released` is true. `daysLate` = whole days between `plannedReleaseAt` and
`actualReleaseAt`, and is `null` unless both exist. `testExecution` is a literal
`null` — the field exists so the client can render the placeholder without
guessing whether the panel is missing or the data is.

- [ ] **Step 4: Add the route**

```ts
  @Get('sprint-health/release-candidates')
  async sprintReleaseCandidates(@Query('sprint') sprint?: string) {
    const rows = await this.detail.releaseCandidates(requireParam(sprint, 'sprint'));
    if (!rows) {
      throw new NotFoundException('Sprint not found.');
    }
    return { rows, computedAt: new Date().toISOString() };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest src/metrics && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/metrics backend/src/modules/dashboards/insights.controller.ts
git commit -m "$(cat <<'EOF'
feat(metrics): per-RC scope and defect counts for a sprint

Lateness is reported only where a planned date was recorded — Jira destroys
its own plan on release, and a guessed plan is a fabricated verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Planned release date — user input

**Files:**
- Create: `backend/src/modules/dashboards/release-plan.controller.ts`
- Create: `backend/src/modules/dashboards/release-plan.controller.spec.ts`
- Modify: `backend/src/modules/dashboards/dashboards.module.ts`

**Interfaces:**
- Consumes: `planning_release.plannedReleaseAt | plannedSetByUserId | plannedSetAt` (Task 3)
- Produces: `PUT /api/dashboards/release-plan` `{ projectKey, name, plannedReleaseAt }` → `{ projectKey, name, plannedReleaseAt, plannedSetByUserId }`; `DELETE /api/dashboards/release-plan?projectKey=&name=` → `{ ok: true }`. Task 15 consumes them.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ReleasePlanController', () => {
  it('records the planned date with the user who entered it', async () => {
    await controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
      projectKey: 'ACT', name: 'RC1', plannedReleaseAt: '2026-08-20',
    });

    const arg = prisma.release.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data).toMatchObject({
      plannedReleaseAt: new Date('2026-08-20'),
      plannedSetByUserId: 'u1',
    });
  });

  it('rejects a release that belongs to another tenant', async () => {
    prisma.release.findFirst.mockResolvedValue(null);
    await expect(
      controller.set({ tenantId: 't2', userId: 'u9' } as AuthUser, {
        projectKey: 'ACT', name: 'RC1', plannedReleaseAt: '2026-08-20',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.release.update).not.toHaveBeenCalled();
  });

  it('scopes the lookup by tenant', async () => {
    await controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
      projectKey: 'ACT', name: 'RC1', plannedReleaseAt: '2026-08-20',
    });
    expect(prisma.release.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1' }) }),
    );
  });

  it('rejects an unparseable date', async () => {
    await expect(
      controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
        projectKey: 'ACT', name: 'RC1', plannedReleaseAt: 'soon',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // A plan years away from the release it describes produces a lateness figure
  // in the hundreds of days on a board people act on.
  it('rejects a planned date more than a year from the release own dates', async () => {
    await expect(
      controller.set({ tenantId: 't1', userId: 'u1' } as AuthUser, {
        projectKey: 'ACT', name: 'RC1', plannedReleaseAt: '2029-01-01',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('clears the planned date and its provenance together', async () => {
    await controller.clear({ tenantId: 't1', userId: 'u1' } as AuthUser, 'ACT', 'RC1');
    const arg = prisma.release.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data).toEqual({
      plannedReleaseAt: null, plannedSetByUserId: null, plannedSetAt: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/dashboards/release-plan.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Model it on `watchlist-exclusions.controller.ts`: `@Controller('dashboards/release-plan')`,
`@Roles(Role.ADMIN)` on both handlers, `@CurrentUser()` for the tenant and user id,
mutations audited by the global `AuditInterceptor` (nothing to wire — it is global).

```ts
/**
 * The planned release date for an RC — user input, because Jira cannot answer
 * it. A Jira version carries ONE date and overwrites it with the release day
 * when released, so by the time you want "planned vs actual", the plan is
 * gone. Rather than infer one (a guess presented as a fact on a board people
 * act on), SprintIQ takes an explicit statement and records who made it.
 */
```

Validation, in order: parse the date (`BadRequestException` on `NaN`); load the
release with `findFirst({ where: { tenantId, projectKey, name } })` and 404 if
absent — this is what stops a cross-tenant write; reject a date more than
`MAX_PLAN_DRIFT_DAYS = 365` from the release's `releaseDate ?? startAt ?? now`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/dashboards && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/dashboards
git commit -m "$(cat <<'EOF'
feat(dashboards): record a planned release date per RC

Admin-only and audited, modelled on watchlist exclusions: a human judgement
Jira cannot supply, stored with the name of whoever made it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Frontend types, hooks, and the check-in pager

**Files:**
- Modify: `frontend/src/modules/dashboards/useInsights.ts`
- Create: `frontend/src/modules/dashboards/sprint-health/pager.ts`
- Create: `frontend/src/modules/dashboards/sprint-health/pager.test.ts`

**Interfaces:**
- Consumes: the response shapes from Tasks 6–11
- Produces:
  - Types `CommitActivityView`, `ProductivityView`, `ProductivityRow`, `QualityCheckView`, `CheckInsView`, `CheckInRow`, `ReleaseCandidateView`, `RcStory` — mirroring the backend field-for-field
  - Hooks `useSprintCheckIns(sprint, from, to)`, `useSprintReleaseCandidates(sprint)`; `useSprintHealth` gains `commitActivity`, `productivity`, `qualityCheck`
  - `checkInPages(sprintFrom: string, sprintTo: string): { from: string; to: string; label: string }[]` — Task 14 consumes it

- [ ] **Step 1: Write the failing test**

`pager.test.ts` (vitest — the repo's frontend tests cover pure logic; components are verified by typecheck, lint and build, since browser testing is unavailable here):

```ts
import { describe, expect, it } from 'vitest';
import { checkInPages } from './pager';

describe('checkInPages', () => {
  it('splits a sprint into seven-day pages', () => {
    const pages = checkInPages('2026-08-25', '2026-09-05');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-31', label: 'Week 1 of 2' },
      { from: '2026-09-01', to: '2026-09-05', label: 'Week 2 of 2' },
    ]);
  });

  // The last page is short when the sprint does not divide by seven. Padding
  // it to a full week would show days the sprint never ran as empty columns —
  // zeros that mean "not a sprint day" and read as "nobody moved anything".
  it('leaves the final page short rather than padding past the sprint end', () => {
    const pages = checkInPages('2026-08-25', '2026-08-27');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-27', label: 'Week 1 of 1' },
    ]);
  });

  it('returns a single page for a one-day sprint', () => {
    expect(checkInPages('2026-08-25', '2026-08-25')).toHaveLength(1);
  });

  it('returns no pages when the sprint has no dates', () => {
    expect(checkInPages('', '')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/modules/dashboards/sprint-health/pager.test.ts`
Expected: FAIL — cannot resolve `./pager`

- [ ] **Step 3: Implement the pager and the hooks**

`pager.ts` builds the pages from the sprint bounds. In `useInsights.ts`, add the
types and the two hooks beside the existing sprint ones:

```ts
export function useSprintCheckIns(
  sprint: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery({
    queryKey: ['sprint-check-ins', sprint, from, to],
    enabled: Boolean(sprint),
    queryFn: () =>
      api.get<CheckInsView & { computedAt: string }>(
        `/api/dashboards/sprint-health/check-ins?sprint=${sprint}` +
          (from ? `&from=${from}` : '') +
          (to ? `&to=${to}` : ''),
      ),
  });
}

export function useSprintReleaseCandidates(sprint: string | null) {
  return useQuery({
    queryKey: ['sprint-release-candidates', sprint],
    enabled: Boolean(sprint),
    queryFn: () =>
      api.get<{ rows: ReleaseCandidateView[]; computedAt: string }>(
        `/api/dashboards/sprint-health/release-candidates?sprint=${sprint}`,
      ),
  });
}
```

Match the `enabled`/`queryKey` conventions of the hooks already in the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modules/dashboards
git commit -m "$(cat <<'EOF'
feat(frontend): sprint-health detail types, hooks and check-in pager

The last page stays short rather than padding past the sprint end: empty
columns for days the sprint never ran read as idleness.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Commit activity tiles + quality check panel

**Files:**
- Create: `frontend/src/modules/dashboards/sprint-health/CommitActivityTiles.tsx`
- Create: `frontend/src/modules/dashboards/sprint-health/QualityCheckPanel.tsx`

**Interfaces:**
- Consumes: `CommitActivityView`, `QualityCheckView` (Task 12)
- Produces: `<CommitActivityTiles data={…} />`, `<QualityCheckPanel data={…} />`

- [ ] **Step 1: Build the tiles**

Five `Stat` tiles in a `grid gap-4 sm:grid-cols-3 lg:grid-cols-5`, reusing the
`Stat` primitive from `widgets.tsx`:

```tsx
      <Stat
        label="Developers who committed"
        value={data.committers}
        hint={`of ${data.assignees} assigned to sprint`}
      />
      <Stat
        label="Commits this sprint"
        value={data.commits}
        hint={data.commitsPerDay === null ? undefined : `${data.commitsPerDay}/day avg`}
      />
      <Stat label="PRs raised" value={data.prsRaised}
        hint={`${data.prsOpen} open, ${data.prsMerged} merged`} />
      <Stat label="PRs reviewed" value={data.prsReviewed}
        hint={data.reviewedPct === null ? undefined : `${data.reviewedPct}% of raised`} />
      <Stat
        label="Avg time to first review"
        value={data.avgHoursToFirstReview === null ? '—' : `${data.avgHoursToFirstReview}h`}
        hint={data.prsWaitingOver24h > 0 ? `${data.prsWaitingOver24h} PRs waiting >24h` : undefined}
      />
```

Below the tiles, state the scope — this is the "surface how trustworthy a
number is" rule, and these two judgements are invisible otherwise:

```tsx
      <p className="mt-2 text-xs text-fg-faint">
        Commits are counted by date across {data.repos.length} repo
        {data.repos.length === 1 ? '' : 's'} linked to this project — Git has no
        sprint field, so a repo that has never carried a linked PR contributes
        nothing here.
      </p>
```

- [ ] **Step 2: Build the quality panel**

Stories released as a large `Stat`, the rollback share as a two-segment bar, and
bugs by priority as a `BarList`. Print the ratio line only when
`bugsPerStoryReleased !== null`; when it is null, say "no stories released yet"
rather than rendering `0.0 bugs per story`.

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run typecheck && npm run lint && npm run build`
Expected: clean. Grep your two new files for raw palette classes — there must be
none: `grep -nE "(slate|emerald|amber|rose|sky)-[0-9]" src/modules/dashboards/sprint-health/*.tsx`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modules/dashboards/sprint-health
git commit -m "$(cat <<'EOF'
feat(frontend): sprint commit-activity tiles and quality-check panel

Both panels state the judgement behind their numbers — the commit window and
the linked-repo scope — rather than presenting a chosen rule as a fact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Daily check-in grid

**Files:**
- Create: `frontend/src/modules/dashboards/sprint-health/CheckInGrid.tsx`

**Interfaces:**
- Consumes: `useSprintCheckIns`, `checkInPages` (Task 12)
- Produces: `<CheckInGrid sprint={sprintExternalId} sprintFrom={…} sprintTo={…} />`

- [ ] **Step 1: Build the grid**

Local `page` state indexes into `checkInPages(sprintFrom, sprintTo)`; the hook is
called with that page's `from`/`to`. Prev/Next buttons are disabled at the ends —
the range never leaves the sprint. Header cells are the day keys formatted
`EEE d`; each cell renders its count with an intensity class chosen from the
count, and zero renders in `text-fg-faint` so a quiet day is visible but recessive.

```tsx
      <p className="mt-3 text-xs text-fg-faint">
        Counts every Jira status change, attributed to whoever made it — which
        is not always the assignee. Range is limited to this sprint's active
        days; totals cover the selected range, not the whole sprint.
      </p>
```

Empty state: when `rows.length === 0`, render one line — "No ticket movement
recorded in this range" — not an empty table with headers, which reads as a
loading failure.

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/modules/dashboards/sprint-health/CheckInGrid.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): daily check-in grid with sprint-clamped paging

Says plainly that it counts whoever moved the ticket, not the assignee.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Productivity panel

**Files:**
- Create: `frontend/src/modules/dashboards/sprint-health/ProductivityPanel.tsx`

**Interfaces:**
- Consumes: `ProductivityView` (Task 12)
- Produces: `<ProductivityPanel data={…} />`

- [ ] **Step 1: Build the panel**

Two summary cards (highest / lowest LOC contributor, names withheld as drawn,
rendered only when `highest !== null`), then the attributed table: developer,
LOC `+added / -removed`, tickets worked, commits, PRs raised, PRs reviewed, and
the grade badge.

The grade rule ships with the data and must be printed — a graded person is
entitled to see the rule they were graded by:

```tsx
      <p className="mt-3 text-xs text-fg-faint">{data.gradeRule}</p>
```

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/modules/dashboards/sprint-health/ProductivityPanel.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): per-developer sprint productivity panel

Prints the grading rule under the table so the pill can be checked rather
than trusted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Release-candidate cards + planned-date field

**Files:**
- Create: `frontend/src/modules/dashboards/sprint-health/ReleaseCandidateList.tsx`
- Create: `frontend/src/modules/dashboards/sprint-health/PlannedDateField.tsx`

**Interfaces:**
- Consumes: `useSprintReleaseCandidates` (Task 12), `PUT`/`DELETE /api/dashboards/release-plan` (Task 11)
- Produces: `<ReleaseCandidateList sprint={…} />`

- [ ] **Step 1: Build the RC card**

Per RC: name, a date pill, a three-up date row (planned / actual / stories
delivered), the story table, bugs by priority, and the test-execution
placeholder.

The date pill is driven strictly by what is known:

```tsx
  // Three states, and the third is not a failure to compute — it is the
  // honest answer. Jira overwrites a version's planned date when it is
  // released, so without a recorded plan there is nothing to compare against.
  const pill =
    rc.daysLate === null
      ? rc.released
        ? { tone: 'neutral' as const, text: 'No planned date recorded' }
        : { tone: 'neutral' as const, text: 'Not yet released' }
      : rc.daysLate > 0
        ? { tone: 'bad' as const, text: `${rc.daysLate} days late` }
        : { tone: 'good' as const, text: 'On time' };
```

The placeholder, in every card:

```tsx
      <div className="mt-4 rounded-lg border border-dashed border-border p-4">
        <p className="text-sm font-medium text-fg-muted">Test execution</p>
        <p className="mt-1 text-xs text-fg-faint">
          Pass/fail/blocked results live in the team's test-management app,
          which SprintIQ does not collect yet. Not shown rather than estimated.
        </p>
      </div>
```

Label the bug source when it is the fallback:

```tsx
      {rc.bugSource === 'fix-version-fallback' && (
        <p className="mt-2 text-xs text-fg-faint">
          Counted by fix version — these stories carry no Affects Version, so
          this is "bugs to be fixed in {rc.name}", not "bugs found in it".
        </p>
      )}
```

- [ ] **Step 2: Build the planned-date field**

An inline date input that `PUT`s on change and `DELETE`s when cleared, shown
only to admins (`useAuthStore` roles, as `RequireRole` does in the router);
everyone else sees the recorded date as text. On success, invalidate
`['sprint-release-candidates', sprint]` so the lateness pill recomputes.

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modules/dashboards/sprint-health
git commit -m "$(cat <<'EOF'
feat(frontend): RC cards with planned-date entry and a test-execution placeholder

Absent test results are named as not-collected rather than omitted, and an
RC with no recorded plan says so instead of claiming it shipped on time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Wire the board

**Files:**
- Modify: `frontend/src/modules/dashboards/boards.tsx:134-292` (`SprintHealthBoard`)

**Interfaces:**
- Consumes: every component from Tasks 13–16
- Produces: the assembled board

- [ ] **Step 1: Replace the detail card**

Keep everything above `{d && (` — the filter bar, the active-sprint pace cards,
the stale-sprint note. Replace the detail `<Card>` with the header row (sprint
name, state badge, pace badge) followed by the five panels in order: commit
activity, check-ins, productivity, quality check, RC list. Keep `ProvenanceNote`
with `computedAt` at the foot, and leave `FreshnessNote` mounted in the
`FilterBar`.

Sections render independently: a panel whose data is still loading shows
`LoadingCard`, and one that errored shows `ErrorCard` — one failed panel must
not blank the other four.

- [ ] **Step 2: Verify the whole frontend**

Run: `cd frontend && npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/modules/dashboards/boards.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): assemble the sprint-health detail from the five panels

Pace cards keep their place at the top; each panel fails on its own so one
error does not blank the board.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Documentation and the policy amendment

**Files:**
- Modify: `docs/features/DASHBOARDS.md`, `docs/features/METRICS.md`, `docs/api/README.md` (§9 and §12), `docs/architecture/DATA-MODEL.md`, `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything built above
- Produces: docs that match the code

- [ ] **Step 1: Update the feature and metric docs**

`DASHBOARDS.md`: rewrite the Sprint Health row in the board table and its
section — pace cards plus the five detail panels, naming each panel's stated
judgement. `METRICS.md`: add the definitions from spec §6 verbatim, including
the null cases (no reviewed PR → no average; no released story → no bug ratio;
no recorded plan → no lateness).

- [ ] **Step 2: Update the API and data-model docs**

`docs/api/README.md` §9: the two new reads, the extended `sprint-health`
response, and the `release-plan` mutation with its admin role and validation.
§12: add a row recording that RC test execution is **not collected** — the data
lives in a separate test-management app — so the placeholder on the board is
documented as a known gap rather than an oversight. `DATA-MODEL.md`: the new
`planning_release` and `planning_story` columns, including why the planned date
is user input.

- [ ] **Step 3: Amend the agent policy in both files**

`CLAUDE.md` and `AGENTS.md` must stay materially aligned — change both, in the
same edit pass. Replace the absolute prohibition with the scoped one:

```markdown
- **Metrics are ethics-first.** Individual-level metrics exist to improve
  delivery, not to rank or punish people, and are team/aggregate by default.
  **Exception, decided 2026-09-07:** the Sprint Health board publishes an
  attributed per-developer table, highest/lowest LOC contributor cards, and a
  high/medium/low grade. This was an explicit product decision. Where such a
  ranking ships, the rule it is computed from must ship with it and be
  displayed — the grade is cut from tickets, PRs and reviews, never from LOC,
  because LOC measures churn rather than delivery. Do not extend ranking to
  other boards without the same decision being taken again.
```

- [ ] **Step 4: Verify the docs say what the code does**

Re-read your own diff against the shipped behaviour: every route documented in
§9 exists, every metric definition matches the implementation, and no doc still
claims individual ranking is forbidden outright.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs: sprint-health detail, and scope the anti-ranking rule

The board now ships an attributed per-developer ranking by explicit product
decision. Recording the exception in both agent files rather than leaving
code and policy in contradiction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Backend**

Run: `cd backend && npm run lint:ci && npx tsc --noEmit && npm test`
Expected: all pass. `lint:ci`, not `lint` — the latter auto-fixes and can never fail.

- [ ] **Step 2: Frontend**

Run: `cd frontend && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all pass.

- [ ] **Step 3: Confirm the migration state**

Run: `cd backend && npx prisma migrate status`
Expected: "Database schema is up to date!" — the host runs `dist` and applies
migrations manually, so a pending migration here is how the board ships against
a schema that does not exist yet.

- [ ] **Step 4: State what was NOT verified**

Browser testing is unavailable in this environment. Say so explicitly in the
final report: the panels are verified by type-check, lint, unit tests and a
production build, and have not been rendered against a live backend.

