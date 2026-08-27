# Custom Activity Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Developer Activity section be read over an arbitrary past date range (`from`/`to`), alongside the five existing presets.

**Architecture:** The range is expressed as additive query params (`?window=custom&from=&to=`) on four endpoints, resolved server-side by one pure function; the frontend replaces the section's `ActivityWindow` with an `ActivityRange` discriminated union and adds a sixth "Custom" segment that reveals two date fields. Ranges are inclusive whole IST calendar days at both ends, so a hand-picked seven-day range equals the "7 days" preset exactly. Watchlist recency is measured **as of the range end**, and the three figures that cannot be time-travelled (Jira assignment, the open-PR queue, live exclusions) stay current and say so on screen.

**Tech Stack:** NestJS + Prisma + Jest (backend); React + TypeScript + Tailwind tokens + react-query + Vitest (frontend, Vitest added by this plan).

**Spec:** [docs/superpowers/specs/2026-08-27-custom-activity-range-design.md](../specs/2026-08-27-custom-activity-range-design.md)

## Global Constraints

- **One definition of "when".** Every window and bucket routes through the IST helpers in `backend/src/common/time.ts`, mirrored in `frontend/src/lib/utils.ts`. Never write another date expression inline (DASHBOARDS.md §4.1.1).
- **Ranges are inclusive at both ends,** whole IST calendar days. `istWindowFloor(7)` includes today; a custom `2026-04-01 → 2026-06-30` is 91 days.
- **Preset behaviour must not change.** Every preset request stays byte-identical on the wire and in its result. This is asserted by tests, not assumed.
- **Design tokens only.** Use `text-fg-subtle`, `border-border`, `bg-subtle`, `text-warning-fg`, etc. Never raw Tailwind palette classes (`slate-*`, `emerald-*`) — CLAUDE.md frontend rules.
- **No new data paths.** Every query touched is already `tenantId`-filtered; keep every existing `tenantId` filter intact and add none that is unscoped.
- **No leaderboards.** Nothing in this work may order people by volume. Existing alphabetical orderings stay.
- **Docs in the same session.** Each task that changes behaviour updates its canonical doc in that task's commit — never as a follow-up.
- **Commit message style:** descriptive sentence subjects matching this repo's history (e.g. "Let the activity boards reach past 30 days, and say so when they find nothing"), not `feat:` prefixes. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Backend commands** run from `backend/`: `npm test`, `npm run build`. **Frontend commands** run from `frontend/`: `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

### Task 1: IST calendar-date helpers (backend)

A custom range arrives as two `YYYY-MM-DD` keys. Turning those into instants is a date expression, and §4.1.1 forbids writing one inline — so it becomes three helpers next to `istWindowFloor`, tested in the same spec that already pins the "when" definition.

**Files:**
- Modify: `backend/src/common/time.ts` (append after `istWindowFloor`, line 32)
- Test: `backend/src/common/time.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `istDayStart(key: string): Date`, `istDayEnd(key: string): Date`, `istDaySpan(fromKey: string, toKey: string): number` — all exported from `backend/src/common/time.ts`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/common/time.spec.ts`, and add the three names to the existing `import` on line 1 so it reads
`import { istDateKey, istDayEnd, istDaySpan, istDayStart, istWeekKey, istWindowFloor } from './time';`

```ts
/**
 * The custom-range half of the same definition: a user-picked range arrives as
 * two IST calendar-date keys and must resolve to the same instants a preset
 * would. If these drift from `istWindowFloor`, a hand-picked week and the
 * "7 days" preset return different numbers for the same seven days.
 */
describe('IST calendar-date range helpers', () => {
  it('starts a day at IST midnight, which is 18:30Z the day before', () => {
    expect(istDayStart('2026-04-01').toISOString()).toBe(
      '2026-03-31T18:30:00.000Z',
    );
  });

  it('ends a day at its last instant, not at the next midnight', () => {
    // Inclusive: a commit at 23:59 IST on the To date is inside the range.
    expect(istDayEnd('2026-06-30').toISOString()).toBe(
      '2026-06-30T18:29:59.999Z',
    );
  });

  it('counts a span inclusively at both ends', () => {
    // Apr 30 + May 31 + Jun 30.
    expect(istDaySpan('2026-04-01', '2026-06-30')).toBe(91);
    // A single day is one day, not zero.
    expect(istDaySpan('2026-08-25', '2026-08-25')).toBe(1);
    expect(istDaySpan('2026-08-19', '2026-08-25')).toBe(7);
  });

  it('agrees with the preset floor: 7 hand-picked days === the 7-day window', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const todayKey = istDateKey(now);
    const startKey = istDateKey(istWindowFloor(7, now));

    expect(istDayStart(startKey).toISOString()).toBe(
      istWindowFloor(7, now).toISOString(),
    );
    expect(istDaySpan(startKey, todayKey)).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/common/time.spec.ts`
Expected: FAIL — TypeScript cannot resolve `istDayStart`, `istDayEnd`, `istDaySpan` from `./time`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/common/time.ts`:

```ts
/**
 * The UTC instant at which an IST calendar date (`YYYY-MM-DD`) begins.
 *
 * The offset is written into the string rather than added afterwards so this
 * cannot drift from `istMidnightUtc` — both mean "00:00 in IST", and IST has no
 * DST, so the literal is exact for every date.
 */
export function istDayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000+05:30`);
}

/**
 * The LAST instant of an IST calendar date — the inclusive upper bound of a
 * range ending on that day.
 *
 * Inclusive because a user picking "to 30 June" means the whole of 30 June;
 * bounding at the next midnight instead would silently swallow the first
 * moment of 1 July.
 */
export function istDayEnd(key: string): Date {
  return new Date(istDayStart(key).getTime() + 86_400_000 - 1);
}

/**
 * Days covered by an IST date range, counting BOTH ends — the same convention
 * as `istWindowFloor`, where a 7-day window covers today plus the six before
 * it. A range's `windowDays` is computed here so the presets and a hand-picked
 * range of the same length report the same number.
 */
export function istDaySpan(fromKey: string, toKey: string): number {
  const days =
    (istDayStart(toKey).getTime() - istDayStart(fromKey).getTime()) /
    86_400_000;
  return Math.round(days) + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/common/time.spec.ts`
Expected: PASS — all suites in the file green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/common/time.ts backend/src/common/time.spec.ts
git commit -m "Teach the IST helpers to speak calendar-date ranges

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The range resolver

One pure function turns `(window, from, to)` into `{ from, to, windowDays }` for every activity endpoint. It lives in its own module rather than inside the controller so its rules — especially the deliberate asymmetry between a tolerated unknown preset and a rejected broken custom range — are testable without booting Nest.

`ACTIVITY_WINDOWS` moves here from `insights.controller.ts` (lines 177-183) so there is one copy.

**Files:**
- Create: `backend/src/modules/dashboards/activity-range.ts`
- Test: `backend/src/modules/dashboards/activity-range.spec.ts`

**Interfaces:**
- Consumes: `istDayStart`, `istDayEnd`, `istDaySpan` from `backend/src/common/time.ts` (Task 1); `istWindowFloor` (existing).
- Produces:
  - `ACTIVITY_WINDOWS: Record<string, number>`
  - `interface ResolvedRange { from: Date; to: Date; windowDays: number }`
  - `resolveActivityRange(window: string, from?: string, to?: string, now?: Date): ResolvedRange`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/dashboards/activity-range.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { istWindowFloor } from '../../common/time';
import { resolveActivityRange } from './activity-range';

const NOW = new Date('2026-08-25T09:00:00.000Z');

describe('resolveActivityRange', () => {
  describe('presets', () => {
    it('resolves a known preset exactly as the boards always have', () => {
      const range = resolveActivityRange('week', undefined, undefined, NOW);

      expect(range.windowDays).toBe(7);
      expect(range.from.toISOString()).toBe(
        istWindowFloor(7, NOW).toISOString(),
      );
      expect(range.to).toBe(NOW);
    });

    it('falls back to 30 days for a window it does not know', () => {
      // Deliberate tolerance, not sloppiness: it lets a frontend ship ahead of
      // this backend and name a range it has not learned yet. The 30 is
      // echoed as `windowDays`, so the board labels what was measured.
      const range = resolveActivityRange('fortnight', undefined, undefined, NOW);
      expect(range.windowDays).toBe(30);
    });

    it('ignores from/to when the window is a preset', () => {
      const range = resolveActivityRange('day', '2026-01-01', '2026-01-31', NOW);
      expect(range.windowDays).toBe(1);
    });
  });

  describe('custom', () => {
    it('covers both endpoint days in full', () => {
      const range = resolveActivityRange(
        'custom',
        '2026-04-01',
        '2026-06-30',
        NOW,
      );

      expect(range.from.toISOString()).toBe('2026-03-31T18:30:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-30T18:29:59.999Z');
      expect(range.windowDays).toBe(91);
    });

    it('accepts a single day', () => {
      const range = resolveActivityRange(
        'custom',
        '2026-06-30',
        '2026-06-30',
        NOW,
      );
      expect(range.windowDays).toBe(1);
    });

    it('clamps an end in the future to now rather than rejecting it', () => {
      // "Through today" is a well-defined request. What it must never do is
      // claim data for hours that have not happened.
      const range = resolveActivityRange(
        'custom',
        '2026-08-01',
        '2026-12-31',
        NOW,
      );
      expect(range.to).toBe(NOW);
    });

    it('rejects a missing endpoint', () => {
      expect(() =>
        resolveActivityRange('custom', '2026-04-01', undefined, NOW),
      ).toThrow(BadRequestException);
      expect(() =>
        resolveActivityRange('custom', undefined, '2026-06-30', NOW),
      ).toThrow(BadRequestException);
    });

    it('rejects a malformed date', () => {
      // 400 rather than the preset fallback: a broken range is not a newer
      // vocabulary, and answering it with a silent 30 days is exactly the
      // mislabelling the fallback exists to prevent.
      expect(() =>
        resolveActivityRange('custom', '01/04/2026', '2026-06-30', NOW),
      ).toThrow(BadRequestException);
      expect(() =>
        resolveActivityRange('custom', '2026-13-45', '2026-06-30', NOW),
      ).toThrow(BadRequestException);
    });

    it('rejects a range that runs backwards', () => {
      expect(() =>
        resolveActivityRange('custom', '2026-06-30', '2026-04-01', NOW),
      ).toThrow(BadRequestException);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/dashboards/activity-range.spec.ts`
Expected: FAIL — `Cannot find module './activity-range'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/modules/dashboards/activity-range.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import {
  istDayEnd,
  istDaySpan,
  istDayStart,
  istWindowFloor,
} from '../../common/time';

/**
 * Selectable ranges for the activity boards, in **IST calendar days including
 * today** (`istWindowFloor`), not rolling hours.
 *
 * The 30-day ceiling these had was a floor on what the boards could show, not a
 * cost control: a repository whose whole history predates it is unreachable at
 * any setting. `athmahealth/nh-website` is the case that surfaced it — 12
 * commits between 20 Jun and 21 Jul, dormant since, so every developer on it
 * read as "0 commits" on every available window. Reviewers then proposed
 * removing those developers as inactive, which is the failure mode a missing
 * range turns into: absence of a window presenting as absence of work.
 *
 * Widening the presets made that repository reachable; it did not make it
 * readable in isolation, since every range containing its active June also
 * contains the dormant months that dilute it. That is what `custom` is for.
 */
export const ACTIVITY_WINDOWS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

/** The window key that means "read from/to instead of a preset length". */
export const CUSTOM_WINDOW = 'custom';

export interface ResolvedRange {
  from: Date;
  /** Inclusive upper bound: the last instant of the To day, or now. */
  to: Date;
  /** Days actually measured, inclusive of both ends — echoed to the client. */
  windowDays: number;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one place a request's range is decided, for every activity endpoint.
 *
 * Note the deliberate asymmetry in how the two failure modes are treated. An
 * **unknown preset** falls back to 30 days, because that tolerance is what lets
 * a frontend deploy ahead of this backend and name a range it has not learned
 * yet — the client labels its board from the echoed `windowDays`, so it states
 * what was measured. A **broken custom range** is rejected, because it is not a
 * newer vocabulary; it is a malformed request, and answering it with a silent
 * 30 days would be the exact mislabelling the fallback exists to prevent.
 */
export function resolveActivityRange(
  window: string,
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedRange {
  if (window !== CUSTOM_WINDOW) {
    const days = ACTIVITY_WINDOWS[window] ?? 30;
    return { from: istWindowFloor(days, now), to: now, windowDays: days };
  }

  const fromKey = requireDateKey(from, 'from');
  const toKey = requireDateKey(to, 'to');
  if (fromKey > toKey) {
    throw new BadRequestException(
      'Query param "from" must not be later than "to".',
    );
  }

  const end = istDayEnd(toKey);
  return {
    from: istDayStart(fromKey),
    // A range reaching today or beyond means "through now". Clamped rather
    // than rejected — it is a well-defined request — but never left in the
    // future, which would claim data for hours that have not happened.
    to: end > now ? now : end,
    windowDays: istDaySpan(fromKey, toKey),
  };
}

function requireDateKey(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestException(
      `Query param "${name}" is required when window=${CUSTOM_WINDOW}.`,
    );
  }
  if (!DATE_KEY.test(value) || Number.isNaN(istDayStart(value).getTime())) {
    throw new BadRequestException(
      `Query param "${name}" must be an IST calendar date (YYYY-MM-DD).`,
    );
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/dashboards/activity-range.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/dashboards/activity-range.ts backend/src/modules/dashboards/activity-range.spec.ts
git commit -m "Resolve an activity range in one place, presets and custom alike

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the four section endpoints

The endpoints stop computing their own `istWindowFloor(days)` and delegate to the resolver, gaining `from`/`to`. `project-activity` and `developer-activity/daily` keep today's behaviour and simply import `ACTIVITY_WINDOWS` from its new home.

**Files:**
- Modify: `backend/src/modules/dashboards/insights.controller.ts` (delete local `ACTIVITY_WINDOWS` at lines 164-183; rewrite the four handlers at lines 413-484)
- Modify: `docs/api/README.md` (the section-endpoint bullets, lines 299-304)

**Interfaces:**
- Consumes: `resolveActivityRange`, `ACTIVITY_WINDOWS` from `./activity-range` (Task 2).
- Produces: the four endpoints accept `?window=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` and return `windowDays` = the inclusive day count.

- [ ] **Step 1: Replace the local window map with the shared one**

In `backend/src/modules/dashboards/insights.controller.ts`, delete the whole `ACTIVITY_WINDOWS` block (the two doc comments plus the const, lines 164-183) and add to the imports at the top:

```ts
import { ACTIVITY_WINDOWS, resolveActivityRange } from './activity-range';
```

`istWindowFloor` stays imported — `projectActivity` and `dailyDeveloperActivity` still use it.

- [ ] **Step 2: Rewrite the four handlers**

Replace `developerActivityOverview`, `developerActivityWatchlist`, `developerActivityPrStatus` and `developerActivity` with these. Keep every doc comment above them exactly as it is.

```ts
  @Get('developer-activity/overview')
  async developerActivityOverview(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.overview(
      [],
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  @Get('developer-activity/watchlist')
  async developerActivityWatchlist(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.watchlist(
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  @Get('developer-activity/pr-status')
  async developerActivityPrStatus(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.prStatus(
      [],
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  @Get('developer-activity')
  async developerActivity(
    @Query('developer') developer?: string,
    @Query('window') window = 'month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const who = requireParam(developer, 'developer');
    // Fetched alongside rather than folded into `developerActivity`: reviews
    // given and assigned Jira work are BC-5/BC-6 facts about the person, not
    // commit-history facts, and keeping them separate leaves the older read
    // model untouched for every other caller.
    const [view, context] = await Promise.all([
      // `range.to` was previously left to default to now. A range that ends in
      // the past has to pass it, or the profile answers for a wider range than
      // the one its own heading states.
      this.insights.developerActivity(who, range.from, range.to),
      this.devActivity.developerContext(who, range.from, range.to),
    ]);
    return {
      windowDays: range.windowDays,
      ...view,
      ...context,
      computedAt: new Date().toISOString(),
    };
  }
```

- [ ] **Step 3: Verify the backend builds and every existing test still passes**

Run: `cd backend && npm run build && npm test`
Expected: build clean; all suites PASS. The preset path is unchanged by construction — `resolveActivityRange('week')` returns exactly what `istWindowFloor(7)` + `new Date()` returned before.

- [ ] **Step 4: Update the API contract doc**

In `docs/api/README.md`, replace the lead-in of the "Developer Activity section reads" bullet (line 301) — currently "Three endpoints behind the four subpages, all taking `?window=` from the same `ACTIVITY_WINDOWS` map and all returning the `windowDays` actually measured:" — with:

```markdown
- **Developer Activity section reads** (DASHBOARDS.md §4.4). Three endpoints behind the four subpages, all taking `?window=` from the same `ACTIVITY_WINDOWS` map and all returning the `windowDays` actually measured. All three, plus `GET /api/dashboards/developer-activity?developer=`, additionally accept **`?window=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`** — an arbitrary range of **inclusive whole IST calendar days**, so `from=2026-04-01&to=2026-06-30` is 91 days and a hand-picked seven days equals the `week` preset exactly. A custom range with a missing, malformed, or backwards date pair is a **400**, deliberately unlike an unrecognised *preset*, which still falls back to 30 days so a frontend can ship ahead of its backend: a broken range is not a newer vocabulary, and answering it with a silent 30 days is the mislabelling that fallback exists to prevent. A `to` in the future is clamped to now. `GET /api/dashboards/project-activity` and `/developer-activity/daily` take presets only.
```

Then check §12 (line 345, "Jira + GitHub MVP implementation status") for an open gap entry about fixed activity windows or unreachable historical ranges; if one exists, mark it resolved in the same commit.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/dashboards/insights.controller.ts docs/api/README.md
git commit -m "Let the Developer Activity endpoints answer for an arbitrary range

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Watchlist recency measured as of the range end

The Watchlist buckets people against `now`, on purpose — the recency lens looks further back than the window. With a range ending in the past that puts two timeframes on one page: April's commits beside "quiet as of today". The fix threads an `asOf` instant through the signal scan and the bucketing, and it is a no-op for every preset, where `asOf` **is** now.

**Files:**
- Modify: `backend/src/metrics/developer-activity.service.ts` (`watchlist` lines 339-372; `lastSignalPerDeveloper` lines 694-736)
- Test: `backend/src/metrics/developer-activity.service.spec.ts`
- Modify: `docs/features/DASHBOARDS.md` (§4.4.2, line 183)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `signalScanRange(asOf: Date): { gte: Date; lte: Date }`, exported from `backend/src/metrics/developer-activity.service.ts`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/metrics/developer-activity.service.spec.ts`, adding `signalScanRange` to the existing import block at the top of the file:

```ts
describe('signalScanRange', () => {
  it('scans back one quiet-threshold from the reference moment', () => {
    const asOf = new Date('2026-08-25T10:00:00Z');
    const range = signalScanRange(asOf);

    expect(range.gte.toISOString()).toBe(
      workingDaysAgo(asOf, WATCHLIST_QUIET_WITHIN_WORKING_DAYS).toISOString(),
    );
  });

  it('bounds the scan ABOVE at the reference moment', () => {
    // The half that makes a historical range honest. Without an upper bound,
    // someone who went quiet in May and came back in August reads as "active"
    // on an April–June view — a signal from outside the range deciding a
    // bucket inside it.
    const asOf = new Date('2026-06-30T18:29:59.999Z');
    const range = signalScanRange(asOf);
    const august = new Date('2026-08-10T05:00:00.000Z');

    expect(range.lte).toEqual(asOf);
    expect(august > range.lte).toBe(true);
  });

  it('buckets against the range end, so a June view answers for June', () => {
    const asOf = new Date('2026-06-30T18:29:59.999Z');
    const juneCommit = new Date('2026-06-29T10:00:00.000Z');

    // Active as of 30 June — which is the question an April–June board asks.
    expect(bucketFor(juneCommit, asOf)).toBe('active');
    // The same commit, judged from today, is ancient. Both are true; the page
    // must pick one moment and say which.
    expect(bucketFor(juneCommit, new Date('2026-08-25T10:00:00Z'))).toBe(
      'no_signal',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/metrics/developer-activity.service.spec.ts`
Expected: FAIL — `signalScanRange` is not exported from `./developer-activity.service`.

- [ ] **Step 3: Add the helper and thread `asOf`**

3a. Add the exported helper next to `workingDaysAgo` (near line 928) in `backend/src/metrics/developer-activity.service.ts`:

```ts
/**
 * The window scanned for "newest signal per developer", as of a moment.
 *
 * Both bounds matter. The lower one keeps the scan cheap — someone whose last
 * commit was two years ago and someone who never committed are the same answer
 * to this page. The upper one is what makes a historical range truthful: a
 * signal from AFTER the range must not decide a bucket inside it, or a
 * developer who returned in August reads as active on an April–June board.
 *
 * Written as one helper rather than inline in each of the four `groupBy` calls
 * so the upper bound cannot be forgotten from one of them.
 */
export function signalScanRange(asOf: Date): { gte: Date; lte: Date } {
  return {
    gte: workingDaysAgo(asOf, WATCHLIST_QUIET_WITHIN_WORKING_DAYS),
    lte: asOf,
  };
}
```

3b. Change `lastSignalPerDeveloper` (line 694) to take the moment and use the helper. Its signature becomes:

```ts
  private async lastSignalPerDeveloper(
    tenantId: string,
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
    asOf: Date,
  ): Promise<Map<string, { type: SignalType; at: Date }>> {
    const scan = signalScanRange(asOf);
```

then replace the `floor` reference in each of the four queries — `committedAt: { gte: floor }` → `committedAt: scan`, `openedAt: { gte: floor }` → `openedAt: scan`, `mergedAt: { gte: floor }` → `mergedAt: scan`, `submittedAt: { gte: floor }` → `submittedAt: scan` — and delete the now-unused `const floor = workingDaysAgo(new Date(), WATCHLIST_QUIET_WITHIN_WORKING_DAYS);`.

Update its doc comment's second paragraph to add: `Bounded above by `asOf` as well, so a range ending in the past is judged by what was known then.`

3c. In `watchlist` (line 339), compute the moment and use it in both places. Replace lines 354-357 and 372:

```ts
    // Everything on this page describes ONE moment. For a preset that moment
    // is now; for a range ending in the past it is the range's end, or the
    // recency buckets would answer "who is quiet today" beside commits from
    // April and present the pair as one finding.
    const now = new Date();
    const asOf = to < now ? to : now;

    const [lastSignals, openAssigned] = await Promise.all([
      this.lastSignalPerDeveloper(tenantId, index, asOf),
      this.openAssignedByDeveloper(tenantId, assignees.byDeveloper),
    ]);
```

and delete the standalone `const now = new Date();` at line 372, then change the bucket call at line 398:

```ts
        bucket: bucketFor(lastSignal?.at ?? null, asOf),
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx jest src/metrics/developer-activity.service.spec.ts && npm run build && npm test`
Expected: PASS for the new suite; build clean; whole backend suite green.

- [ ] **Step 5: Update DASHBOARDS.md §4.4.2**

Append this paragraph to §4.4.2 (the Watchlist section beginning at line 183):

```markdown
**Recency is measured as of the range end, not as of today.** With a preset those are the same instant. With a custom range ending in the past they are not, and measuring against today would put two timeframes on one page — April's commits beside "quiet as of this morning". So the whole page answers for one moment: the signal scan is bounded above at the range end (`signalScanRange`) as well as below, and `bucketFor` is given that same moment. A developer who went quiet in May and returned in August therefore reads as quiet on an April–June board, which is what was true then.
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/metrics/developer-activity.service.ts backend/src/metrics/developer-activity.service.spec.ts docs/features/DASHBOARDS.md
git commit -m "Bucket the Watchlist as of the range end, not as of today

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Vitest, and the IST helpers the frontend needs

The frontend has no test runner, so the range model would ship verified only by the compiler. This task adds Vitest and, with it, the mirrored IST helpers. `istDayAxis` also learns to end on a day other than today — without that, a chart for an April–June range draws an axis ending today and renders every bar at zero.

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/src/lib/utils.ts`
- Modify: `frontend/src/modules/dashboards/CommitChart.tsx` (lines 18-24 and 142-148)
- Test: `frontend/src/lib/utils.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `frontend/src/lib/utils.ts`: `istTodayKey(): string`, `istDayStart(key: string): Date`, `istDaySpan(fromKey: string, toKey: string): number`, `istDayKeyOffset(key: string, deltaDays: number): string`, and `istDayAxis(windowDays: number, endKey?: string): string[]`. `CommitChart` gains an optional `endKey` prop.

- [ ] **Step 1: Install Vitest and add the script**

Run: `cd frontend && npm install --save-dev vitest@^2.1.0`

Then add to the `scripts` block in `frontend/package.json`, after `"lint"`:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 2: Add the Vitest config**

Create `frontend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic behind the dashboards — ranges, day maths,
 * label formatting. Node environment on purpose: these are the parts that can
 * be asserted without a DOM, and they are the parts where being wrong is
 * silent (a range off by one day still renders).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `frontend/src/lib/utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  istDayAxis,
  istDayKeyOffset,
  istDaySpan,
  istDayStart,
  istTodayKey,
  istWindowFloor,
} from './utils';

/**
 * These mirror `backend/src/common/time.ts`. They are tested separately, on
 * both sides, because a mirror that has drifted looks exactly like a mirror
 * that has not — until a board and its API disagree about which day a commit
 * belongs to.
 */
describe('IST calendar-date helpers', () => {
  it('starts an IST day at 18:30Z the previous day', () => {
    expect(istDayStart('2026-04-01').toISOString()).toBe(
      '2026-03-31T18:30:00.000Z',
    );
  });

  it('counts a span inclusively, matching the backend', () => {
    expect(istDaySpan('2026-04-01', '2026-06-30')).toBe(91);
    expect(istDaySpan('2026-08-25', '2026-08-25')).toBe(1);
  });

  it('offsets a date key by whole days, across a month boundary', () => {
    expect(istDayKeyOffset('2026-08-25', -6)).toBe('2026-08-19');
    expect(istDayKeyOffset('2026-07-01', -1)).toBe('2026-06-30');
    expect(istDayKeyOffset('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('agrees with the preset floor: the 7-day window starts 6 days back', () => {
    // Derived from today on both sides, so this pins the agreement rather than
    // a calendar date that stops being true tomorrow.
    const today = istTodayKey();
    const startKey = istDayKeyOffset(today, -6);

    expect(istDaySpan(startKey, today)).toBe(7);
    expect(istDayStart(startKey).getTime()).toBe(istWindowFloor(7).getTime());
  });
});

describe('istDayAxis', () => {
  it('ends on the given day rather than always on today', () => {
    // The bug this prevents: a chart for a closed past range drew an axis
    // ending today, so every April commit fell outside it and the whole
    // window rendered as zeros.
    const axis = istDayAxis(3, '2026-06-30');
    expect(axis).toEqual(['2026-06-28', '2026-06-29', '2026-06-30']);
  });

  it('spans a month boundary correctly', () => {
    expect(istDayAxis(2, '2026-07-01')).toEqual(['2026-06-30', '2026-07-01']);
  });

  it('returns windowDays entries, oldest first', () => {
    const axis = istDayAxis(7, '2026-08-25');
    expect(axis).toHaveLength(7);
    expect(axis[0]).toBe('2026-08-19');
    expect(axis[6]).toBe('2026-08-25');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — `istDayStart`, `istDaySpan`, `istDayKeyOffset` are not exported, and `istDayAxis` takes one argument.

- [ ] **Step 5: Write the implementation**

In `frontend/src/lib/utils.ts`, add after `istWindowFloor` (line 46):

```ts
/** Today's IST calendar-date key (YYYY-MM-DD). */
export function istTodayKey(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The UTC instant at which an IST calendar date begins. Mirrors the backend's
 * `istDayStart` — the offset is in the string so it cannot drift from
 * `istWindowFloor`, and IST has no DST, so the literal is exact for every date.
 */
export function istDayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000+05:30`);
}

/**
 * Days covered by an IST date range, counting BOTH ends — the same convention
 * as `istWindowFloor`, where 7 days is today plus the six before it. Mirrors
 * the backend's `istDaySpan`, which computes the `windowDays` the API echoes.
 */
export function istDaySpan(fromKey: string, toKey: string): number {
  const days =
    (istDayStart(toKey).getTime() - istDayStart(fromKey).getTime()) /
    86_400_000;
  return Math.round(days) + 1;
}

/**
 * A date key moved by whole days. Key arithmetic is anchored on UTC midnight
 * rather than IST, because shifting both ends by the same offset cannot change
 * a difference in days — and the UTC anchor keeps the arithmetic exact.
 */
export function istDayKeyOffset(key: string, deltaDays: number): string {
  const anchor = new Date(`${key}T00:00:00.000Z`).getTime();
  return new Date(anchor + deltaDays * 86_400_000).toISOString().slice(0, 10);
}
```

Then replace `istDayAxis` (lines 48-58) with:

```ts
/**
 * `windowDays` contiguous IST date keys ending on `endKey` (today by default),
 * oldest first — the axis a chart zero-fills a sparse series against. Must stay
 * in sync with the backend's `istDateKey` bucketing, or the axis and the data
 * disagree about what a day is.
 *
 * The end is a parameter because a custom range can end in the past. An axis
 * hardcoded to today drew a closed April–June range as an unbroken row of
 * zeros, every real commit having fallen off the left of a window ending now.
 */
export function istDayAxis(
  windowDays: number,
  endKey: string = istTodayKey(),
): string[] {
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(istDayKeyOffset(endKey, -i));
  }
  return out;
}
```

- [ ] **Step 6: Give CommitChart an end day**

In `frontend/src/modules/dashboards/CommitChart.tsx`, change the component signature (lines 18-24) to:

```tsx
export function CommitChart({
  series,
  windowDays,
  endKey,
}: {
  series: DayPoint[]; // sparse: only days with commits
  windowDays: number;
  /** Last day the chart covers. Defaults to today; a past range passes its end. */
  endKey?: string;
}) {
  const days = buildFullWindow(series, windowDays, endKey);
```

and `buildFullWindow` (lines 142-148) to:

```tsx
/** Fill the sparse series into a contiguous [end-windowDays+1 … end] range. */
function buildFullWindow(
  series: DayPoint[],
  windowDays: number,
  endKey?: string,
): DayPoint[] {
  const byDate = new Map(series.map((d) => [d.date, d]));
  return istDayAxis(windowDays, endKey).map(
    (date) => byDate.get(date) ?? { date, commits: 0, locChanged: 0 },
  );
}
```

- [ ] **Step 7: Run everything**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint && npm run build`
Expected: tests PASS; typecheck, lint and build all clean. `ProjectActivityChart` is untouched and keeps the default end day.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/lib/utils.ts frontend/src/lib/utils.test.ts frontend/src/modules/dashboards/CommitChart.tsx
git commit -m "Add Vitest, and let a day axis end somewhere other than today

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The frontend range model

A pure module: the union, URL parse/serialise, day counts, labels, validation. Nothing imports it yet, so this task is additive and cannot break the app.

**Files:**
- Create: `frontend/src/modules/dashboards/activity-range.ts`
- Test: `frontend/src/modules/dashboards/activity-range.test.ts`

**Interfaces:**
- Consumes: `istDayKeyOffset`, `istDaySpan`, `istDayStart`, `istTodayKey`, `istWindowFloor` from `frontend/src/lib/utils.ts` (Task 5); `WINDOW_DAYS`, `windowLabel`, `widerWindow` from `./activity-window`; `ActivityWindow` from `./useInsights`.
- Produces, from `frontend/src/modules/dashboards/activity-range.ts`:
  - `type ActivityRange = { kind: 'preset'; window: ActivityWindow } | { kind: 'custom'; from: string; to: string }`
  - `DEFAULT_RANGE: ActivityRange`
  - `rangeParams(range): URLSearchParams`, `parseRange(params: URLSearchParams): ActivityRange`
  - `rangeDays(range): number`, `rangeEndKey(range): string`, `rangeFrom(range): string`, `rangeTo(range): string | undefined`
  - `rangeEndsInPast(range): boolean`, `rangeLabel(range): string`, `formatDateKey(key): string`
  - `isValidCustom(from, to): boolean`, `presetDateKeys(window: ActivityWindow): { from: string; to: string }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/modules/dashboards/activity-range.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { istTodayKey } from '../../lib/utils';
import {
  DEFAULT_RANGE,
  formatDateKey,
  isValidCustom,
  parseRange,
  presetDateKeys,
  rangeDays,
  rangeEndKey,
  rangeEndsInPast,
  rangeLabel,
  rangeParams,
  rangeTo,
} from './activity-range';

const CUSTOM = { kind: 'custom', from: '2026-04-01', to: '2026-06-30' } as const;
const WEEK = { kind: 'preset', window: 'week' } as const;

describe('rangeParams', () => {
  it('sends a preset exactly as the boards always have', () => {
    expect(rangeParams(WEEK).toString()).toBe('window=week');
  });

  it('sends a custom range as window=custom plus both dates', () => {
    expect(rangeParams(CUSTOM).toString()).toBe(
      'window=custom&from=2026-04-01&to=2026-06-30',
    );
  });
});

describe('parseRange', () => {
  it('round-trips a custom range through the URL', () => {
    expect(parseRange(rangeParams(CUSTOM))).toEqual(CUSTOM);
  });

  it('round-trips a preset', () => {
    expect(parseRange(rangeParams(WEEK))).toEqual(WEEK);
  });

  it('falls back to the default rather than rendering nothing', () => {
    // A hand-edited or truncated URL must not blank the section.
    expect(parseRange(new URLSearchParams('window=custom'))).toEqual(
      DEFAULT_RANGE,
    );
    expect(
      parseRange(new URLSearchParams('window=custom&from=nope&to=2026-06-30')),
    ).toEqual(DEFAULT_RANGE);
    expect(
      parseRange(
        new URLSearchParams('window=custom&from=2026-06-30&to=2026-04-01'),
      ),
    ).toEqual(DEFAULT_RANGE);
    expect(parseRange(new URLSearchParams('window=fortnight'))).toEqual(
      DEFAULT_RANGE,
    );
    expect(parseRange(new URLSearchParams())).toEqual(DEFAULT_RANGE);
  });
});

describe('rangeDays', () => {
  it('counts a custom range inclusively, like the backend', () => {
    expect(rangeDays(CUSTOM)).toBe(91);
    expect(rangeDays({ kind: 'custom', from: '2026-06-30', to: '2026-06-30' })).toBe(1);
  });

  it('reads a preset from the shared window map', () => {
    expect(rangeDays(WEEK)).toBe(7);
  });
});

describe('presetDateKeys', () => {
  it('seeds the custom fields with the preset you were already reading', () => {
    const seeded = presetDateKeys('week');
    expect(seeded.to).toBe(istTodayKey());
    expect(rangeDays({ kind: 'custom', ...seeded })).toBe(7);
  });
});

describe('isValidCustom', () => {
  it('accepts a well-formed past range', () => {
    expect(isValidCustom('2026-04-01', '2026-06-30')).toBe(true);
  });

  it('rejects a backwards range, a malformed date, and a future end', () => {
    expect(isValidCustom('2026-06-30', '2026-04-01')).toBe(false);
    expect(isValidCustom('01/04/2026', '2026-06-30')).toBe(false);
    expect(isValidCustom('2026-13-45', '2026-06-30')).toBe(false);
    expect(isValidCustom('2026-04-01', '2099-01-01')).toBe(false);
  });

  it('accepts a range ending today', () => {
    expect(isValidCustom(istTodayKey(), istTodayKey())).toBe(true);
  });
});

describe('labels and ends', () => {
  it('formats a date key without depending on the machine locale', () => {
    // Built from a fixed month table rather than toLocaleDateString: a label
    // that reads differently on the CI box than in the browser is a label
    // nobody can pin in a test.
    expect(formatDateKey('2026-04-01')).toBe('1 Apr 2026');
    expect(formatDateKey('2026-12-25')).toBe('25 Dec 2026');
  });

  it('names a custom range by its interval and a preset by its word', () => {
    expect(rangeLabel(CUSTOM)).toBe('1 Apr 2026 – 30 Jun 2026');
    expect(rangeLabel(WEEK)).toBe('7 days');
  });

  it('ends a custom range on its To day and a preset on today', () => {
    expect(rangeEndKey(CUSTOM)).toBe('2026-06-30');
    expect(rangeEndKey(WEEK)).toBe(istTodayKey());
  });

  it('reports a past-ending range, which presets never are', () => {
    expect(rangeEndsInPast(CUSTOM)).toBe(true);
    expect(rangeEndsInPast(WEEK)).toBe(false);
    expect(
      rangeEndsInPast({ kind: 'custom', from: '2026-01-01', to: istTodayKey() }),
    ).toBe(false);
  });

  it('gives a custom range an end instant, and a preset none', () => {
    expect(rangeTo(CUSTOM)).toBe('2026-06-30T18:29:59.999Z');
    expect(rangeTo(WEEK)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — `Cannot find module './activity-range'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/modules/dashboards/activity-range.ts`:

```ts
import {
  istDayKeyOffset,
  istDaySpan,
  istDayStart,
  istTodayKey,
  istWindowFloor,
} from '../../lib/utils';
import { WINDOW_DAYS, windowLabel } from './activity-window';
import type { ActivityWindow } from './useInsights';

/**
 * What the Developer Activity section is reading: one of the five shared
 * presets, or an arbitrary interval.
 *
 * The presets deliberately keep their own type. `ActivityWindow` is the
 * vocabulary shared with Project Activity, which does NOT offer a custom range;
 * widening that union would have made every one of its consumers handle a case
 * it can never receive.
 *
 * A custom range is two IST calendar-date keys, INCLUSIVE at both ends — the
 * same convention as `istWindowFloor`, which is what makes a hand-picked seven
 * days and the "7 days" preset return identical numbers.
 */
export type ActivityRange =
  | { kind: 'preset'; window: ActivityWindow }
  | { kind: 'custom'; from: string; to: string };

export const DEFAULT_RANGE: ActivityRange = { kind: 'preset', window: 'week' };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The query params every Developer Activity endpoint takes. */
export function rangeParams(range: ActivityRange): URLSearchParams {
  const params = new URLSearchParams();
  if (range.kind === 'preset') {
    params.set('window', range.window);
    return params;
  }
  params.set('window', 'custom');
  params.set('from', range.from);
  params.set('to', range.to);
  return params;
}

/**
 * The range a URL is asking for.
 *
 * Anything unreadable falls back to the default rather than throwing: a
 * hand-edited or truncated link must not blank the section, and the control
 * shows what was actually applied.
 */
export function parseRange(params: URLSearchParams): ActivityRange {
  const window = params.get('window');
  if (window === 'custom') {
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    return isValidCustom(from, to) ? { kind: 'custom', from, to } : DEFAULT_RANGE;
  }
  return window && window in WINDOW_DAYS
    ? { kind: 'preset', window: window as ActivityWindow }
    : DEFAULT_RANGE;
}

function isDateKey(value: string): boolean {
  return (
    DATE_KEY.test(value) && !Number.isNaN(istDayStart(value).getTime())
  );
}

/** Both dates readable, in order, and not reaching into the future. */
export function isValidCustom(from: string, to: string): boolean {
  return (
    isDateKey(from) && isDateKey(to) && from <= to && to <= istTodayKey()
  );
}

/** Days the range covers, inclusive — matches the API's `windowDays`. */
export function rangeDays(range: ActivityRange): number {
  return range.kind === 'preset'
    ? WINDOW_DAYS[range.window]
    : istDaySpan(range.from, range.to);
}

/** Last IST day the range covers — the day a chart axis must end on. */
export function rangeEndKey(range: ActivityRange): string {
  return range.kind === 'preset' ? istTodayKey() : range.to;
}

/** First instant of the range, for `FreshnessNote`. */
export function rangeFrom(range: ActivityRange): string {
  return (
    range.kind === 'preset'
      ? istWindowFloor(WINDOW_DAYS[range.window])
      : istDayStart(range.from)
  ).toISOString();
}

/**
 * Last instant of the range, or undefined for a preset — which ends now, and
 * so has no bound worth stating.
 */
export function rangeTo(range: ActivityRange): string | undefined {
  if (range.kind === 'preset') {
    return undefined;
  }
  return new Date(
    istDayStart(range.to).getTime() + 86_400_000 - 1,
  ).toISOString();
}

/**
 * True when the range stops before today. The trigger for every "this lens is
 * current, not as-of" caveat: those figures have no collected history, so on a
 * past range they describe a different moment than the rest of the page.
 */
export function rangeEndsInPast(range: ActivityRange): boolean {
  return range.kind === 'custom' && range.to < istTodayKey();
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * "1 Apr 2026" from a date key.
 *
 * Built from a fixed table rather than `toLocaleDateString` for two reasons: a
 * custom range can cross a year boundary, so the year is never noise here the
 * way it is in `shortDate`; and a locale-dependent label cannot be pinned in a
 * test, which is most of what this module's tests are for.
 */
export function formatDateKey(key: string): string {
  const [year, month, day] = key.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** What to call this range on screen. */
export function rangeLabel(range: ActivityRange): string {
  return range.kind === 'preset'
    ? windowLabel(range.window)
    : `${formatDateKey(range.from)} – ${formatDateKey(range.to)}`;
}

/**
 * The date pair equivalent to a preset — what the custom fields are seeded
 * with, so choosing Custom never blanks the board: you start on the range you
 * were already reading.
 */
export function presetDateKeys(window: ActivityWindow): {
  from: string;
  to: string;
} {
  const to = istTodayKey();
  return { from: istDayKeyOffset(to, -(WINDOW_DAYS[window] - 1)), to };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint`
Expected: all tests PASS; typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modules/dashboards/activity-range.ts frontend/src/modules/dashboards/activity-range.test.ts
git commit -m "Model an activity range that can be a preset or an interval

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The section speaks ranges

The shell, the context, the four hooks, the four pages and the empty-state note all move from `ActivityWindow` to `ActivityRange` together — they are one compile unit and cannot be split without leaving the build broken. No custom range can be selected yet (Task 8 adds the control), so every request this task produces is still a preset, byte-identical to today's.

**Files:**
- Modify: `frontend/src/modules/dashboards/useInsights.ts` (`useDeveloperActivity` 601-613, `useDeveloperOverview` 760-769, `useWatchlist` 771-780, `usePrStatus` 782-791)
- Modify: `frontend/src/modules/dashboards/developer-activity/window.tsx`
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx`
- Modify: `frontend/src/modules/dashboards/activity-window.tsx` (`EmptyWindowNote`, lines 115-163)
- Modify: `frontend/src/modules/dashboards/developer-activity/OverviewPage.tsx` (lines 23-24, 70-78)
- Modify: `frontend/src/modules/dashboards/developer-activity/WatchlistPage.tsx` (lines 55-56)
- Modify: `frontend/src/modules/dashboards/developer-activity/PrStatusPage.tsx` (lines 34-35)
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperPage.tsx` (lines 15, 35, 42, 183)

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: `useSectionRange(): { range: ActivityRange; setRange: (r: ActivityRange) => void }`; the four hooks take an `ActivityRange`; `EmptyWindowNote` takes `{ range, measuredDays?, onChange, noun? }`.

- [ ] **Step 1: Re-key the four hooks on the range**

In `frontend/src/modules/dashboards/useInsights.ts`, add to the imports at the top:

```ts
import { rangeParams, type ActivityRange } from './activity-range';
```

Then replace the four hooks:

```ts
export function useDeveloperActivity(
  developer: string | null,
  range: ActivityRange,
) {
  const params = rangeParams(range);
  params.set('developer', developer ?? '');
  return useQuery({
    queryKey: ['developer-activity', params.toString()],
    queryFn: () =>
      api.get<DeveloperActivityView & { computedAt: string }>(
        `/api/dashboards/developer-activity?${params}`,
      ),
    enabled: Boolean(developer),
  });
}

export function useDeveloperOverview(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-overview', params.toString()],
    queryFn: () =>
      api.get<DeveloperOverviewView>(
        `/api/dashboards/developer-activity/overview?${params}`,
      ),
    staleTime: 60_000,
  });
}

export function useWatchlist(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-watchlist', params.toString()],
    queryFn: () =>
      api.get<WatchlistView>(
        `/api/dashboards/developer-activity/watchlist?${params}`,
      ),
    staleTime: 60_000,
  });
}

export function usePrStatus(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-pr-status', params.toString()],
    queryFn: () =>
      api.get<PrStatusView>(
        `/api/dashboards/developer-activity/pr-status?${params}`,
      ),
    staleTime: 60_000,
  });
}
```

`URLSearchParams` encodes the developer id, which the old template string did with `encodeURIComponent` — the behaviour is preserved.

- [ ] **Step 2: Update the section context**

Replace the body of `frontend/src/modules/dashboards/developer-activity/window.tsx` below its existing doc comment:

```tsx
import { useOutletContext } from 'react-router-dom';
import type { ActivityRange } from '../activity-range';

export * from '../activity-window';
export * from '../activity-range';

/** What the shell hands every subpage. */
export interface SectionContext {
  range: ActivityRange;
  setRange: (r: ActivityRange) => void;
}

export function useSectionRange(): SectionContext {
  return useOutletContext<SectionContext>();
}
```

- [ ] **Step 3: Put the range in the URL**

In `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx`, replace the import on line 5-6 and the state block on lines 47-56:

```tsx
import {
  WindowToggle,
  parseRange,
  rangeFrom,
  rangeParams,
  type ActivityRange,
} from './window';
```

(`WindowToggle` is only needed for the temporary block in this task; Task 8 removes it from this import.)

```tsx
export function DeveloperActivitySection() {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params);

  const setRange = (next: ActivityRange) => {
    const updated = new URLSearchParams(params);
    for (const [key, value] of rangeParams(next)) {
      updated.set(key, value);
    }
    if (next.kind === 'preset') {
      // Or a stale from/to would ride along in the URL, describing a range
      // nothing on screen is showing.
      updated.delete('from');
      updated.delete('to');
    }
    // `replace` so paging through ranges doesn't bury the previous page under
    // a dozen history entries the reader has to press Back through.
    setParams(updated, { replace: true });
  };
```

Then the tab links (line 75) — carrying only `window` would silently drop a custom range on tab switch:

```tsx
              to={{ pathname: tab.to, search: `?${rangeParams(range)}` }}
```

and the FilterBar (lines 92-97):

```tsx
      <FilterBar>
        <WindowToggle value={range} onChange={setRange} />
        {/* One freshness signal for the whole section. Mounted here rather
            than per page: it judges the window, and the window is the shell's. */}
        <FreshnessNote windowFrom={rangeFrom(range)} />
      </FilterBar>

      <Outlet context={{ range, setRange }} />
```

`WindowToggle` does not accept a range yet — Task 8 replaces this line with `RangeToggle`. To keep this task compiling, temporarily render the preset toggle only when one is selected:

```tsx
        {range.kind === 'preset' && (
          <WindowToggle value={range.window} onChange={(w) => setRange({ kind: 'preset', window: w })} />
        )}
```

- [ ] **Step 4: Make the empty-state note range-aware**

In `frontend/src/modules/dashboards/activity-window.tsx`, replace `EmptyWindowNote` (lines 115-163), keeping its doc comment above unchanged and adding this paragraph to the end of that comment:

```
 * A custom range names its own interval and offers no wider one: there is no
 * defined "next range up" from an arbitrary interval, and inventing one would
 * be guessing at what the reader meant.
```

```tsx
export function EmptyWindowNote({
  range,
  measuredDays,
  onChange,
  noun = 'commits',
}: {
  range: ActivityRange;
  /** Days the server measured; falls back to the selection if it didn't say. */
  measuredDays?: number;
  onChange: (r: ActivityRange) => void;
  noun?: string;
}) {
  const custom = range.kind === 'custom';
  const days =
    measuredDays ??
    (custom ? istDaySpan(range.from, range.to) : WINDOW_DAYS[range.window]);
  const end = custom ? istDayStart(range.to) : new Date();
  const start = custom
    ? istDayStart(range.from)
    : new Date(
        windowStart(range.window).getTime() +
          (WINDOW_DAYS[range.window] - days) * 86_400_000,
      );
  const wider = custom ? undefined : widerWindow(range.window);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-subtle p-2.5">
      <p className="text-xs text-fg-subtle">
        No {noun}{' '}
        {days === 1 && !custom ? (
          <>
            today (
            <span className="font-mono tabular-nums">{shortDate(end)}</span>)
          </>
        ) : (
          <>
            between{' '}
            <span className="font-mono tabular-nums">{shortDate(start)}</span>
            {' and '}
            <span className="font-mono tabular-nums">{shortDate(end)}</span>
          </>
        )}
        .{' '}
        {custom
          ? 'Work outside this range is not counted here.'
          : wider
            ? 'Work older than this range is not counted here.'
            : 'This is the widest range available.'}
      </p>
      {wider && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ kind: 'preset', window: wider })}
        >
          Try {windowLabel(wider)}
        </Button>
      )}
    </div>
  );
}
```

Add to that file's imports:

```tsx
import { istDaySpan, istDayStart, istWindowFloor } from '../../lib/utils';
import type { ActivityRange } from './activity-range';
```

merging the names into the one existing import from `'../../lib/utils'` rather than adding a second line.

**The `ActivityRange` import must stay `import type`, and this file must not import a *value* from `activity-range`.** `activity-range.ts` imports `WINDOW_DAYS` and `windowLabel` from here, so a value import back would close a runtime cycle between the two modules. A type import is erased at compile time and closes nothing — which is why the day count above is computed from `istDaySpan` and `WINDOW_DAYS` directly instead of calling `rangeDays`.

- [ ] **Step 5: Move the four pages onto the range**

`OverviewPage.tsx` — line 12 import, lines 23-24, and the empty state at 70-78:

```tsx
import { EmptyWindowNote, formatDayKey, useSectionRange } from './window';
```
```tsx
  const { range, setRange } = useSectionRange();
  const query = useDeveloperOverview(range);
```
```tsx
          <EmptyWindowNote
            range={range}
            measuredDays={d.windowDays}
            onChange={setRange}
          />
```

`WatchlistPage.tsx` — line 17 import and lines 55-56:

```tsx
import { useSectionRange } from './window';
```
```tsx
  const { range } = useSectionRange();
  const query = useWatchlist(range);
```

`PrStatusPage.tsx` — line 11 import and lines 34-35:

```tsx
import { useSectionRange } from './window';
```
```tsx
  const { range } = useSectionRange();
  const query = usePrStatus(range);
```

`DeveloperPage.tsx` — line 15 import, lines 35 and 42, and the chart at 181-184:

```tsx
import { rangeDays, rangeEndKey, useSectionRange } from './window';
```
```tsx
  const { range } = useSectionRange();
```
```tsx
  const query = useDeveloperActivity(developer, range);
```
```tsx
              <CommitChart
                series={d.dailySeries}
                windowDays={rangeDays(range)}
                endKey={rangeEndKey(range)}
              />
```

- [ ] **Step 6: Verify**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint && npm run build`
Expected: all clean. No `useSectionWindow` references remain — confirm with `grep -rn "useSectionWindow" frontend/src` returning nothing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/modules/dashboards/useInsights.ts frontend/src/modules/dashboards/activity-window.tsx frontend/src/modules/dashboards/developer-activity/
git commit -m "Carry a range, not a window, through the Developer Activity section

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The Custom control

The sixth segment and the two date fields. Built from `SegmentedControl`, `Field` and `Input` — no popover, no new primitive.

**Files:**
- Create: `frontend/src/modules/dashboards/developer-activity/RangeToggle.tsx`
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx` (the FilterBar block from Task 7 Step 3)

**Interfaces:**
- Consumes: `ActivityRange`, `isValidCustom`, `presetDateKeys` (Task 6); `WINDOWS` from `../activity-window`; `istTodayKey` from `../../../lib/utils`.
- Produces: `RangeToggle({ value, onChange })`.

- [ ] **Step 1: Write the control**

Create `frontend/src/modules/dashboards/developer-activity/RangeToggle.tsx`:

```tsx
import { useState } from 'react';
import { Field, Input, SegmentedControl } from '../../../components/ui';
import { istTodayKey } from '../../../lib/utils';
import { WINDOWS } from '../activity-window';
import {
  isValidCustom,
  presetDateKeys,
  type ActivityRange,
} from '../activity-range';
import type { ActivityWindow } from '../useInsights';

/**
 * The section's range: five presets, or an interval of your own.
 *
 * A sixth segment rather than a popover, because the presets stay one click
 * away instead of two and the whole thing is keyboard-reachable without a
 * focus trap. The date fields appear only when Custom is selected — four tabs
 * carrying two permanently-empty inputs would be paying for the rare case on
 * every visit.
 */
export function RangeToggle({
  value,
  onChange,
}: {
  value: ActivityRange;
  onChange: (range: ActivityRange) => void;
}) {
  const today = istTodayKey();
  // Seeded from the preset you were reading, so choosing Custom never blanks
  // the board: you land on the range you were already looking at.
  const [draft, setDraft] = useState(() =>
    value.kind === 'custom'
      ? { from: value.from, to: value.to }
      : presetDateKeys(value.window),
  );

  const select = (key: string) => {
    if (key !== 'custom') {
      onChange({ kind: 'preset', window: key as ActivityWindow });
      return;
    }
    const seeded =
      value.kind === 'custom'
        ? { from: value.from, to: value.to }
        : presetDateKeys(value.window);
    setDraft(seeded);
    onChange({ kind: 'custom', ...seeded });
  };

  const edit = (patch: { from?: string; to?: string }) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // Only a valid pair re-keys the query. An invalid one leaves the boards on
    // the last range they actually fetched — whose interval their own headings
    // still state, so nothing on screen is ever mislabelled.
    if (isValidCustom(next.from, next.to)) {
      onChange({ kind: 'custom', ...next });
    }
  };

  const invalid = value.kind === 'custom' && !isValidCustom(draft.from, draft.to);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <SegmentedControl
        label="Window"
        value={value.kind === 'custom' ? 'custom' : value.window}
        onChange={select}
        options={[
          ...WINDOWS.map((w) => ({ value: w.key as string, label: w.label })),
          { value: 'custom', label: 'Custom' },
        ]}
      />

      {value.kind === 'custom' && (
        <>
          <Field label="From">
            <Input
              type="date"
              className="w-40"
              value={draft.from}
              max={draft.to || today}
              onChange={(e) => edit({ from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              className="w-40"
              value={draft.to}
              min={draft.from}
              max={today}
              onChange={(e) => edit({ to: e.target.value })}
            />
          </Field>
          {invalid && (
            <p className="pb-2 text-xs text-warning-fg">
              Pick a start on or before the end, and an end no later than
              today. Still showing the last valid range.
            </p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the shell**

In `DeveloperActivitySection.tsx`, replace the temporary preset-only block from Task 7 Step 3 with:

```tsx
      <FilterBar>
        <RangeToggle value={range} onChange={setRange} />
        {/* One freshness signal for the whole section. Mounted here rather
            than per page: it judges the window, and the window is the shell's. */}
        <FreshnessNote windowFrom={rangeFrom(range)} />
      </FilterBar>
```

and fix the imports: drop `WindowToggle` from the `./window` import (it stays exported for Project Activity's use) and add `import { RangeToggle } from './RangeToggle';`.

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modules/dashboards/developer-activity/RangeToggle.tsx frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx
git commit -m "Offer a range of your own beside the five presets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Say which moment each figure describes

Three figures cannot be time-travelled, and one warning stops applying. Without this task the section quietly joins April's commits to today's Jira board and presents the pair as one finding — the inversion DASHBOARDS.md §4.4.5 exists to forbid.

**Files:**
- Create: `frontend/src/modules/dashboards/developer-activity/CurrentLensNote.tsx`
- Modify: `frontend/src/modules/dashboards/FreshnessNote.tsx`
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx`
- Modify: `OverviewPage.tsx`, `WatchlistPage.tsx`, `PrStatusPage.tsx`, `DeveloperPage.tsx`
- Modify: `docs/features/DASHBOARDS.md` (§4.1.1 line 79, §4.4 line 157, §4.4.4 line 203, §4.4.5 line 215)

**Interfaces:**
- Consumes: `rangeEndsInPast`, `rangeLabel`, `formatDateKey`, `rangeTo` (Task 6).
- Produces: `CurrentLensNote({ range, lens })`; `FreshnessNote` gains an optional `windowTo` prop.

- [ ] **Step 1: Write the note**

Create `frontend/src/modules/dashboards/developer-activity/CurrentLensNote.tsx`:

```tsx
import { formatDateKey, rangeEndsInPast, type ActivityRange } from '../activity-range';

/**
 * "This panel describes today, not the range you picked."
 *
 * Some figures here are current state with no collected history behind them —
 * today's Jira assignment, the open-PR queue, live exclusions. On a range
 * ending in the past they cannot answer for that past, and the honest move is
 * to say so rather than to omit them or to let them pass as historical.
 *
 * It matters most for "committing, nothing assigned", which would otherwise
 * join April's commits to today's Jira board and present the pair as one
 * finding — the same inversion §4.4.5 forbids in its other direction.
 *
 * Renders nothing for a preset, where every lens already shares one moment.
 */
export function CurrentLensNote({
  range,
  lens,
}: {
  range: ActivityRange;
  lens: string;
}) {
  if (range.kind !== 'custom' || !rangeEndsInPast(range)) {
    return null;
  }
  return (
    <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-subtle">
      {lens} is current, not as of {formatDateKey(range.to)} — we keep no
      history for it, so this reads as of today while the rest of the range
      reads to {formatDateKey(range.to)}.
    </p>
  );
}
```

- [ ] **Step 2: Stop warning about staleness that cannot affect a closed range**

In `frontend/src/modules/dashboards/FreshnessNote.tsx`, change the signature (line 31) and the `behind` computation (line 48):

```tsx
export function FreshnessNote({
  windowFrom,
  windowTo,
}: {
  windowFrom?: string;
  windowTo?: string;
}) {
```

```tsx
  // A range that has already ended cannot be affected by collection being
  // hours behind — those hours are after everything it covers. Warning anyway
  // is the unnecessary warning this file exists to avoid: it teaches people to
  // ignore the real ones.
  const rangeEnded = windowTo != null && new Date(windowTo) < new Date();
  const behind =
    !rangeEnded && behindSeconds !== null && behindSeconds > BEHIND_WARN_SECONDS;
```

Add to the doc comment's bullet list (after the "Is the recent end behind?" bullet):

```
 *  - **Has the range already ended?** Then being behind is irrelevant to it,
 *    and the warning is suppressed.
```

Then pass it from the shell — in `DeveloperActivitySection.tsx`, add `rangeTo` to the `./window` import and:

```tsx
        <FreshnessNote windowFrom={rangeFrom(range)} windowTo={rangeTo(range)} />
```

- [ ] **Step 3: Place the four disclosures**

`OverviewPage.tsx` — after the closing `</div>` of the stat grid (around line 67), before `<CommitTimeline`:

```tsx
      <CurrentLensNote
        range={range}
        lens="The Jira assignment behind “Committing, nothing assigned”"
      />
```

`WatchlistPage.tsx` — immediately before `<PlanningGap view={d} />` (line 101):

```tsx
      <CurrentLensNote
        range={range}
        lens="Assigned Jira work, the planning gap and exclusions"
      />
```

`PrStatusPage.tsx` — between the closing `</div>` of the stat grid (line 65) and the `<Card className="space-y-3">` that opens "Waiting on review" (line 67):

```tsx
      <CurrentLensNote range={range} lens="The review queue (open PRs and how long they have waited)" />
```

`DeveloperPage.tsx` — immediately before `<AssignedWork view={d} />` (line 188):

```tsx
          <CurrentLensNote range={range} lens="Assigned Jira work" />
```

Each file needs `import { CurrentLensNote } from './CurrentLensNote';`, and `PrStatusPage.tsx` / `DeveloperPage.tsx` already destructure `range` from `useSectionRange()` (Task 7).

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 5: Update DASHBOARDS.md**

5a. Append to §4.1.1 (after its existing paragraph, line 81):

```markdown
The Developer Activity section additionally accepts a **custom range**: two IST calendar dates, inclusive at both ends, resolved by `istDayStart` / `istDayEnd` / `istDaySpan` (backend `common/time.ts`, mirrored in `frontend/src/lib/utils.ts`). Inclusive at both ends is what keeps it the same definition — a hand-picked seven days and the "7 days" preset resolve to the same instants and return the same numbers. The same reason `istDayAxis` takes the day to end on: a chart hardcoded to today drew a closed April–June range as an unbroken row of zeros.
```

5b. Append to §4.4 (after its intro, around line 160):

```markdown
**The window is a range.** Alongside the five presets the section offers a **custom** interval — any two IST dates — because every preset ends today, so a closed past period cannot be looked at in isolation: the range containing a repository's active June also contains the dormant months that dilute it. Presets remain unchanged on the wire (`?window=week`); a custom range travels as `?window=custom&from=&to=` and is carried across tab switches like the preset is.
```

5c. Append to §4.4.4 (the PR Status section, line 203):

```markdown
On a custom range ending in the past, the queue is still today's — open PRs are current state with no collected history — and the page says so rather than letting an as-of-today queue pass as historical.
```

5d. Append to §4.4.5 (line 215):

```markdown
The same caveat governs a range that ends in the past. Jira assignment is read as it stands **now**; we keep no assignment history. So on a historical range the planning gap would be comparing that range's commits against today's Jira board — two moments, one figure. The affected panels carry a note saying which moment they describe, on the same principle as the coverage figure itself: the number is shown, and what it can support is stated with it.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/modules/dashboards/ docs/features/DASHBOARDS.md
git commit -m "Say which moment each figure describes when the range has ended

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd backend && npm test && npm run build` — all suites pass, build clean.
- [ ] `cd frontend && npm run test && npm run typecheck && npm run lint && npm run build` — all pass.
- [ ] `git diff main --stat` — no file outside `backend/src/common/time*`, `backend/src/modules/dashboards/`, `backend/src/metrics/developer-activity.service*`, `frontend/src/lib/utils*`, `frontend/src/modules/dashboards/`, `frontend/package*.json`, `frontend/vitest.config.ts`, `docs/`.
- [ ] Confirm Project Activity is untouched in behaviour: `grep -n "WindowToggle\|WINDOW_DAYS" frontend/src/modules/dashboards/activity-boards.tsx` still resolves, and `/api/dashboards/project-activity` still rejects an unknown window exactly as before.
- [ ] **State plainly what was not verified:** the React components were never driven in a browser (no browser tooling available in this environment). Verified by unit tests over the pure logic, plus typecheck, lint and build. The rendered control, the date pickers' behaviour in the real browser, and the four pages' layout with the new notes are unverified by test.
