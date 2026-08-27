# Custom time range for the Developer Activity section

**Date:** 2026-08-27
**Status:** Approved design, not yet implemented
**Scope:** Developer Activity section only (`/developer-activity/*`, four subpages)

This is a working design document. The durable rules it settles belong in the
canonical docs — `docs/api/README.md` for the contract, `docs/features/DASHBOARDS.md`
§4.1.1/§4.4 for the behaviour — and must be written there as part of the
implementation, not left here.

## 1. Problem

The activity surfaces select from five fixed ranges ending today: Today, 7 days,
30 days, 90 days, 12 months (`ACTIVITY_WINDOWS`, `WINDOWS`). Every one of them
ends at the current moment, so a **closed past period cannot be looked at at
all** — a finished quarter, the month a repository was actually alive, the
weeks around an incident.

This is the same class of failure that removing the 30-day ceiling fixed
(DASHBOARDS.md §4.1.3): `athmahealth/nh-website` was dormant since July, so its
developers read as "0 commits" on every available range and a reviewer proposed
removing them as inactive. Widening the presets made that repository *reachable*;
it still cannot be looked at **in isolation**, because every range that contains
June 2026 also contains the two dormant months that dilute it.

## 2. What is being built

A sixth selection, **Custom**, on the Developer Activity section's window
control: two dates, `from` and `to`, both inclusive whole IST calendar days,
applied to all four subpages (Overview, Watchlist, Developer, PR Status).

**Out of scope, decided:** the Project Activity board and its endpoints keep the
five presets and are not touched; Productivity and Efficiency (which already
accept `from`/`to` with no UI) are not touched. Relative expressions
(Grafana's `now/M`), saved ranges, and a range picker popover are not built.

## 3. The range model

`ActivityWindow` is unchanged, so the vocabulary shared with Project Activity in
`frontend/src/modules/dashboards/activity-window.tsx` keeps its exact current
meaning and its consumers keep compiling. A new discriminated union lives beside
it in a new file, `frontend/src/modules/dashboards/activity-range.ts`:

```ts
export type ActivityRange =
  | { kind: 'preset'; window: ActivityWindow }
  | { kind: 'custom'; from: string; to: string }; // IST calendar dates, YYYY-MM-DD
```

A new file rather than growing `activity-window.tsx`: that file is the
vocabulary *shared* with Project Activity, and custom-range logic belongs to the
section that has it. `developer-activity/window.tsx` re-exports both, so the
four subpages see one import as they do today.

### 3.1 Semantics

Both endpoints are **inclusive whole IST days**: `from` is IST midnight of the
from-date, `to` is the last instant of the to-date. This is the convention the
presets already have (`istWindowFloor(7)` includes today), which is what makes a
hand-picked 7-day range and the "7 days" preset return identical numbers.

DASHBOARDS.md §4.1.1 forbids writing another date expression, so this adds two
helpers and mirrors them, as `istWindowFloor` is mirrored:

- `istDayStart(key: string): Date` — IST midnight of a `YYYY-MM-DD` key
- `istDayEnd(key: string): Date` — the last instant of that IST day

in `backend/src/common/time.ts` and `frontend/src/lib/utils.ts`.

`windowDays` for a custom range is the **inclusive** day count
(`(toKey − fromKey) / 86400000 + 1`). Every board already renders its interval
from the server's `windowDays` echo rather than from the selected key, so those
renderings keep working with no change.

### 3.2 URL

`?window=custom&from=2026-04-01&to=2026-06-30`. Presets keep sending
`?window=week`, byte-identical to today. A missing or malformed pair falls back
to the default preset (`week`) rather than rendering nothing.

`DeveloperActivitySection.tsx` currently builds tab links as
`?window=${window}` (line 75); that becomes the full search string, or switching
tabs silently drops the custom range.

## 4. The control

A sixth `Custom` segment on the existing `SegmentedControl`. When it is active,
two `<input type="date">` fields appear in the same `FilterBar` row, built from
the existing `Field` + `Input` primitives — no new UI primitive, no popover, no
focus-trap.

- **Seeding.** The first click on Custom fills the fields from the preset you
  were on (7 days → that exact interval), so the board never blanks and you keep
  seeing the data you were just reading.
- **Validation.** `from ≤ to` and `to ≤ today`, expressed as `min`/`max` on the
  inputs and re-checked before use.
- **Invalid input does not re-key the query.** The fields show an inline
  message; the boards keep rendering the last valid range, whose interval their
  own headings still state — so nothing on screen is ever mislabelled.

### 4.1 What the notes say about an arbitrary interval

- `EmptyWindowNote` names the interval as it does now, but drops the
  "Try 90 days" button: there is no defined next range up from an arbitrary
  interval. It says instead that work outside the range is not counted here.
- `FreshnessNote` needs nothing for the start edge — its "history only goes back
  to X" warning already keys off `windowFrom` and therefore covers a backdated
  `from` for free.
- `FreshnessNote` gains one thing: **suppress the "collection is behind" warning
  when `to` is in the past.** A collector six hours behind says nothing about a
  range that ended in June, and by that file's own reasoning an unnecessary
  warning teaches people to ignore the real ones.

## 5. Backend contract

Four endpoints gain optional `from` and `to`:

| Endpoint | Change |
|---|---|
| `GET /api/dashboards/developer-activity/overview` | `?window=custom&from=&to=` |
| `GET /api/dashboards/developer-activity/watchlist` | `?window=custom&from=&to=` |
| `GET /api/dashboards/developer-activity/pr-status` | `?window=custom&from=&to=` |
| `GET /api/dashboards/developer-activity?developer=` | `?window=custom&from=&to=` |

`GET /api/dashboards/project-activity` and `/developer-activity/daily` are
unchanged.

One shared resolver, in its own module so it is testable as a pure function
(`backend/src/modules/dashboards/activity-range.ts`):

```ts
resolveActivityRange(window: string, from?: string, to?: string):
  { from: Date; to: Date; windowDays: number }
```

- `window !== 'custom'` → exactly today's behaviour:
  `ACTIVITY_WINDOWS[window] ?? 30`, `from = istWindowFloor(days)`, `to = now`.
- `window === 'custom'` → both dates required as `YYYY-MM-DD`;
  **400 BadRequest** on missing, malformed, or `from > to`. A `to` in the future
  is clamped to now rather than rejected — "through today" is what it means. The
  UI prevents a future `to` with `max`; the server clamps rather than rejects
  because it is a well-defined request, not a broken one.

**Why 400 here when an unknown preset falls back to 30 days.** The fallback
exists so a frontend can ship ahead of its backend and name a range this backend
has not learned yet (insights.controller.ts, `/daily`). A malformed custom range
is not a newer vocabulary; it is a broken request. Answering it with a silent
30 days is precisely the mislabelling that fallback's comment exists to prevent.

### 5.1 As-of-range-end recency (Watchlist)

The Watchlist buckets people `active` / `quiet` / `no_signal` against **today**
on purpose — the recency lens deliberately looks further back than the window,
because "no signal in 30 days" is unanswerable from a 7-day read. With a range
that ends in the past, that would put two timeframes on one page.

Decision: **the buckets are measured as of the range end.** A range ending
30 Jun answers "who had shown no signal as of 30 Jun", and the page describes one
moment throughout. `asOf = min(to, now)` threads into two places:

- `lastSignalPerDeveloper(tenantId, index, asOf)` — its four `groupBy` queries
  floor at `workingDaysAgo(asOf, WATCHLIST_QUIET_WITHIN_WORKING_DAYS)` instead of
  `workingDaysAgo(new Date(), …)`, and each gains an upper bound (`lte: asOf`).
  Without the upper bound, a person who returned in August reads as "active" in
  an April–June view.
- `bucketFor(lastSignal, asOf)` instead of `bucketFor(lastSignal, now)`.

Both already take their reference instant as a parameter, so this is threading,
not rewriting. For every preset `asOf` **is** now, so existing behaviour is
unchanged by construction rather than by care — which the spec asserts as a test.

### 5.2 Three figures that cannot be time-travelled

We collect no history for these, so on a past-ending range they remain
statements about **now**:

1. `hasAssignedWork` / `assignedOpenItems` — today's Jira assignment.
2. The PR Status waiting queue — `state: 'open'` right now, deliberately not
   windowed (a change unreviewed for months is the point of the page).
3. Watchlist exclusions — live rows only (`expiresAt > now`).

They are not faked. When a custom range ends before today, the affected panels
carry a line stating that the lens is current, not as-of the range end.

This matters most for **"committing without assigned work"**, which would
otherwise join April's commits to today's Jira board and present the result as
one finding. That is the same inversion DASHBOARDS.md §4.4.5 forbids in its other
direction, and the disclosure is what keeps the figure honest.

## 6. Testing

**Backend (Jest, existing).**

- New spec for `resolveActivityRange`: preset passthrough, inclusive day counts
  (2026-04-01 → 2026-06-30 = 91), IST edges, future `to` clamped, and each 400
  case (missing date, malformed date, `from > to`).
- `developer-activity.service.spec.ts`: signals after `to` excluded from
  bucketing; a past-ending range bucketing as of that date; a preset producing
  results identical to before the change.

**Frontend (Vitest, new).** The repository has no frontend test runner; this adds
`vitest` plus a `test` script and tests the pure parts of `activity-range.ts` —
URL parse/serialise round-trip, inclusive day count, label formatting, and the
validation predicate.

**Not covered, and to be stated as such on delivery:** the React components
themselves. Browser verification is unavailable in this environment, so the
control is verified by `npm run typecheck`, `npm run lint`, `npm run build` and
the unit tests around its logic — not by being driven.

## 7. Documentation to update in the same session

- `docs/api/README.md` — the section-endpoint bullets (currently lines 299-304):
  the `window=custom` + `from`/`to` params, the 400 rules, the `windowDays` echo
  for a custom range.
- `docs/features/DASHBOARDS.md` §4.1.1 — inclusive IST-day custom range as part
  of the one definition of "when", and the two new mirrored helpers.
- `docs/features/DASHBOARDS.md` §4.4.2 — as-of-range-end bucketing.
- `docs/features/DASHBOARDS.md` §4.4.4 / §4.4.5 — the current-state disclosures.

## 8. Risks

- **Skewed deploy.** A frontend with Custom against a backend without it: the
  old backend does not recognise `window=custom`, falls back to 30 days, and
  echoes `windowDays: 30`. The boards render their interval from that echo, so
  the page reads "30 days" — wrong range, honestly labelled. This is the reason
  the design puts the range in additive params rather than in the `window`
  string.
- **Large ranges truncate.** A multi-year custom range can exceed the commit read
  ceiling. Nothing new is needed: `truncated` already flows to the UI and is
  already rendered.
