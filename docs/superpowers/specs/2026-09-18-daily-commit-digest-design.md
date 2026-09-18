# Daily commit digest: tracked-roster inactivity notification to Teams

**Date:** 2026-09-18
**Status:** Approved design, not yet implemented
**Scope:** Two new tables (`notification_tracked_developer`, `notification_no_commit_run`); one new detection service in BC-8; BC-15 `NotificationsService` filled in from stub; new outbound Teams delivery client in BC-1; one IST-pinned cron; two admin endpoints; one seed script.

This is a working design document. The durable rules it settles belong in the
canonical docs — a new `docs/features/NOTIFICATIONS.md`, `docs/api/README.md`,
`docs/security/AUTH-AND-RBAC.md`, `docs/deployment/` — and must be written
there as part of the implementation, not left here. The ethics decision in §3
belongs in `docs/ADR/0009-*.md`.

## 1. Problem

A named roster of developers (66 at seeding, all GitHub EMU logins in the
`athmahealth` org) must be checked daily for delivery activity. Anyone with no
tracked signal in the preceding working day is named in a list posted to a
Microsoft Teams group at 10:30 IST the following morning. The roster must be
editable by an admin so that developers joining later are covered without a
deploy.

The request was phrased as "no commit in the last 24 hours". Two refinements
were settled during design: the window is the previous **working** day, so
Monday reports Friday rather than naming the roster for a quiet Sunday; and
"active" is whatever the Activity Overview board already counts — commits plus
pull requests opened — so the notification and the dashboard can never
disagree about the same person on the same day (§5.3).

The data is read from the delivery graph on the hosted deployment, not from a
local workspace.

## 2. What already exists

Verified against the code before designing.

| Element | Where |
|---|---|
| Commit attribution through resolved identity | `attributeCommit()`, `attributionIndex()` — `metrics/developer-activity.service.ts`, `correlation/developer-identity.service.ts` |
| "Who committed in this window" | `DeveloperActivityService.committersBetween()` (private, tenant-explicit) |
| Suppression predicates | `isBotDeveloper`, `isAnonymizedAccount`, `AttributionIndex.excluded`, `WatchlistExclusion` |
| Leave / temporary absence, with required expiry | `watchlist_exclusion` + `modules/dashboards/watchlist-exclusions.controller.ts` |
| Admin-stated tenant data precedent | `DeveloperRole`, `IdentityOverride`, `WatchlistExclusion` |
| IST calendar primitives | `common/time.ts` — `istDateKey`, `istDayStart`, `istDayEnd` |
| Working-day arithmetic (Sat/Sun non-working) | `workingDaysAgo()` — `metrics/developer-activity.service.ts` |
| IST-pinned cron precedent | `collector-scheduler.service.ts` — `@Cron(..., { timeZone: IST_TIMEZONE })` |
| Collection freshness ("is today's data in?") | `Connection.collectedThroughAt` |
| Teams webhook secret reference | `notifications.teamsWebhookRef`, already declared in `configuration-catalog.ts` |
| Secret resolution | `SecretsService.resolve(tenantId, ref)` |
| Outbound HTTP idiom | native `fetch` (no axios, no `HttpService`) |
| Audit sink | `AUDIT_SINK` / `AuditSink`, `audit_log` |

BC-15 `NotificationsService` is a bare stub. No outbound notification delivery
client of any kind exists yet. This design adds the first one.

## 3. Governance decision (requires ADR 0009)

CLAUDE.md's "Metrics are ethics-first" rule forbids individual ranking or
surveillance features without an explicit, documented product decision. Today
one such exception exists, for the Sprint Health board (decided 2026-09-07).

This feature is inside that rule: it attributes an absence to named
individuals and broadcasts it to a group channel. It was requested and
confirmed as a product decision on 2026-09-18, and ships under the same
conditions the existing exception carries — **the rule the list is computed
from ships with it and is displayed in the message itself** (§6).

The decision does not extend to any other notification. A second attributed
notification requires its own decision.

Two honesty constraints follow from the rule and are load-bearing in the
design rather than advisory:

1. **The message states what it measured.** "No tracked signal yesterday" is
   not "did no work": a reviewer, a developer mid-branch, someone pairing,
   someone on Jira-only or design work, someone merging work opened last
   week, and anyone whose commits are not yet collected all read as inactive.

   The active set is deliberately narrow — exact parity with the Overview
   board (§5.3) — so this constraint carries more weight than it otherwise
   would: the card must enumerate what it counted **and** name reviewing
   explicitly as uncounted. That text is what makes the message defensible to
   the person named in it, and it is not optional decoration.
2. **The list is never ordered by volume.** Alphabetical by display name,
   always — the same constraint the Watchlist enforces, for the same stated
   reason: a volume ordering converts a prompt-to-check-in into the
   leaderboard the rule forbids.

## 4. Data model

```prisma
/// The editable roster of developers whose daily commit activity is tracked.
/// Data rather than a code constant for the same reason DeveloperRole is:
/// an admin adds a new joiner without a deploy, and the entry carries a name.
model TrackedDeveloper {
  id                   String   @id
  tenantId             String
  /// Who this tracks, as DeveloperIdentity.canonicalDeveloperId.
  canonicalDeveloperId String
  /// The string the entry was ADDED as, kept verbatim. An entry whose
  /// identity never resolved is still displayable and diagnosable instead of
  /// silently reading as a developer who committed nothing.
  addedAs              String
  /// Soft, so taking someone off the roster is a recorded act, not a gap.
  active               Boolean  @default(true)
  note                 String?
  createdByUserId      String
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([tenantId, canonicalDeveloperId])
  @@index([tenantId, active])
  @@map("notification_tracked_developer")
}

/// One row per reported day: what was evaluated, who was flagged, what was
/// delivered. Lineage for a message that names people — "why was I on
/// Tuesday's list?" must be answerable after the fact.
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
  /// The exact list sent; the roster entries whose identity did not resolve;
  /// and those withheld because their commit data for the day was incomplete
  /// (§5.4). The latter two are reported, never counted as inactive.
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

`@@unique([tenantId, reportedDay])` is the idempotency key. A restart, a
redeploy at 10:30, or an overlapping fire cannot double-post one day's list:
the second insert loses. This is the "at-least-once delivery, effectively-once
persistence" rule applied to outbound delivery.

Migration: `backend/prisma/migrations/20260918120000_add_commit_tracking_roster/`.
Applied by hand on the host (§8).

Configuration: one enable flag added to the existing `notifications` namespace
in `configuration-catalog.ts`, beside the `teamsWebhookRef` already declared
there, so the job can be turned off without a deploy.

## 5. Detection

**The rule, in one sentence:** take the set of developers active on the
reported day, subtract it from the editable roster, and the remainder is the
list. Everything below is that subtraction plus the guards that stop it
naming someone unfairly.

New file `backend/src/metrics/no-commit-detection.service.ts`. Takes
`tenantId` explicitly and returns a plain result object; it has no knowledge
of Teams and is unit testable without a webhook URL.

**Why not call `overview()` directly.** It resolves tenancy through
`TenantContextService.requireTenantId()`, which is request-scoped and
unavailable in a cron. The service therefore performs the *same* reads the
Overview performs internally — `CodeService.listCommitsPage` plus the exported
`attributeCommit()` — with `tenantId` passed explicitly. Same query, same
attribution primitive, so the commit component reconciles with the board
rather than becoming a second competing definition. The codebase has already
paid for that mistake once: the comment above `planningGapDevelopers` records
Overview and Watchlist disagreeing on real data (3 versus 0) because two
places computed one number differently.

The pass, in order:

1. **Resolve the reported day.** The previous working day in IST — Monday's
   run reports Friday. New `previousWorkingDay()` helper in `common/time.ts`
   beside the existing primitives; the window is
   `[istDayStart(key), istDayEnd(key)]`, a pure function of the run instant.

2. **Freshness gate, before any other work.** Every active GitHub connection
   for the tenant must have `collectedThroughAt` covering the day's end.
   Otherwise: no named list, outcome `withheld_stale_data`, lagging
   connections named in `detail`.

   Ingest is poll-based (no webhooks). A stalled collector or an expired token
   makes *every* roster member read as inactive, and the automation would then
   confidently name all 66 people in a channel. This gate exists for that case
   specifically.

   Requiring *all* connections to be fresh is strict, and on an org-scale
   tenant (one connection per repo) it may withhold often at first. Strict is
   the correct starting point; if it proves too noisy the adjustment is a
   coverage threshold, not removal of the gate.

3. **Build the active set for the day** — exactly the Overview's `withSignal`,
   no wider and no narrower:

   | Signal | Read | Window field |
   |---|---|---|
   | Commit | `listCommitsPage` + `attributeCommit` | `committedAt` |
   | PR opened | `pullRequest` | `openedAt` |

   **Exact parity with the board is the requirement here** (decided
   2026-09-18), and it is the reason the set stops at these two. The digest
   must never be arguable against the dashboard someone opens to check it:
   one definition, one number, no explaining why two SprintIQ surfaces
   disagree about the same person on the same day.

   What parity costs, recorded so it is not rediscovered as a bug:

   - **A reviewer reads as inactive.** `prReview` is not in the Overview's
     set, so someone who spent the day reviewing is flagged. The card must
     say so (§3.1, §6) — this is the single largest source of a
     justified objection to being named, and the text is what answers it.
   - **A PR merged but opened earlier does not count.** The Overview's PR read
     filters `openedAt`; `mergedAt` is used only for counting, never for
     window membership. So finishing and merging week-old work is not a
     signal.

   Widening the set later is a real improvement to both surfaces, but it must
   be made **in the Overview first** and inherited here — never added here
   alone, which is exactly how the two would drift apart again.

4. **Refuse to flag on an incomplete read.**

   `listCommitsPage` windows on `committedAt`, which is nullable, and
   `github-commit-reconciler.service.ts` — the only thing that backfills it —
   is *one-off maintenance* triggered from an admin endpoint, not a scheduled
   job. Its docblock names an ongoing cause, not merely a historical one:
   commits "that outran the enrichment's bounded per-tick budget". So a commit
   can land today with a null `committedAt` and stay that way indefinitely,
   invisible to the Overview read.

   The digest therefore also checks for commits dated in the window by
   `authoredAt`. A roster member with such a commit whose `committedAt` is
   null is classed **`incomplete`** — left off the list, not named — and
   recorded with that reason in the run row. This is the only place the digest
   knowingly diverges from the board, and it diverges only where the board is
   provably missing a commit.

   (The Overview's own day-bucketing already uses `c.committedAt ??
   c.authoredAt`, so this fallback is the established idiom for this column,
   not a new invention.)

   Separately, if `listCommitsPage` returns `truncated: true`, the commit read
   is short and the active set is unreliable: no named list, outcome
   `withheld_truncated_read`. At `COMMIT_READ_LIMIT` (20,000) a single day
   will not normally reach this, but the flag exists so that hitting the
   ceiling is "reported rather than quietly changing the answer", and a
   silently short set would flag everyone it omitted.

5. **Resolve each roster entry** against `attributionIndex(tenantId)`.
   Unresolvable entries go to the `unresolved` bucket and are never reported
   as inactive.

6. **Subtract existing suppressions** — live `WatchlistExclusion` rows,
   `isBotDeveloper`, `AttributionIndex.excluded`, `isAnonymizedAccount` —
   reusing the predicates the Watchlist applies rather than reimplementing
   them.

7. **Sanity gate on the result.** If the flagged share of the roster exceeds
   `IMPLAUSIBLE_FLAGGED_SHARE` (an exported constant, 0.8), withhold the names
   and send the count with an explanatory note — outcome
   `withheld_implausible`. This covers the public-holiday case, which SprintIQ
   cannot model: the `workingDaysAgo` docblock records that there is no
   per-tenant holiday calendar and that inventing one would be "a guess
   dressed as a fact". A constant rather than tenant config, until there is a
   tenant that needs a different value.

8. **When nobody is flagged, still post** — "all N tracked developers were
   active on <day>", outcome `sent_all_clear`. Silence is indistinguishable
   from a dead cron, and a daily job whose liveness cannot be observed stops
   being trusted.

Three conditions withhold the named list — stale collection, a truncated
commit read, and an implausible share — and all three still post something, so
the channel always distinguishes "nothing to report" from "this job is
broken". Every outcome records its reason in `NoCommitDigestRun`. The design
prefers under-reporting loudly to over-reporting confidently.

## 6. Delivery

**Placement.** `backend/src/collectors/delivery/teams.client.ts` — a sibling
of `sources/`, `webhooks/`, `ingestion/`. The `NotificationsService` docblock
already states that delivery clients live in the Collector context, and
CLAUDE.md's stack table files native outbound notification delivery under
Integration/Collection. `sources/` is inbound; `delivery/` is outbound. No
code outside this folder holds the webhook URL.

**Split of responsibility.** `NotificationsService` decides *whether and
whom*: it calls detection, applies the gates, writes `NoCommitDigestRun`, and
emits the audit entry. `TeamsClient` decides *how*: one method,
`postAdaptiveCard(tenantId, card)`, resolving the URL via
`SecretsService.resolve` and posting with native `fetch`. Detection never
imports the client; the client never imports detection.

**Transport (Power Automate Workflows URL).** The channel target is a Power
Automate "when a Teams webhook request is received" flow, not a retired O365
connector.

- Payload: `{ type: "message", attachments: [{ contentType:
  "application/vnd.microsoft.card.adaptive", content: <card> }] }` — the shape
  the "Post card in a chat or channel" action expects.
- Success is any 2xx. Power Automate typically answers **202 Accepted with an
  empty body**, unlike the old connector's `200`/`"1"`; a strict 200-only
  check would record every successful send as a failure.
- Bounded retry: 3 attempts with exponential backoff, on 429 and 5xx only.
  4xx fails fast — a 403 means the flow was deleted or the URL rotated, and
  retrying only delays the diagnosis.
- `AbortSignal.timeout` on the request, so a hung POST cannot wedge the cron.
- **The URL is never logged, at any level.** A Workflows URL carries its
  credential in the query string (`&sig=…`); logging it grants channel-post
  rights to anyone with log access. Errors log status code and flow response
  body only.

**Card contents.** Alphabetical by display name, never ordered by any
quantity (§3).

- Heading naming the IST day reported on, e.g. *Daily activity check — Fri 18 Sep*.
- The count (`9 of 66 tracked developers`) and the names.
- **The rule, displayed inline:** "Flagged = no commit and no pull request
  opened on this day (IST) — the same reads as the Activity Overview board.
  Code review, merging earlier work, and Jira activity are **not** counted,
  so a day spent reviewing shows here as inactive. Excludes bots,
  admin-excluded accounts, and developers on recorded leave."
- A freshness line: "Data collected through <timestamp>."
- Framed as a prompt to check in, not a verdict, matching the "go ask, don't
  conclude" stance the existing boards are written to.

The rule line is a requirement of §3, not decoration. Without it the message
asserts that the named people did nothing, which the data cannot support.

**Untrusted input.** Display names originate in ingested GitHub/Jira data,
which CLAUDE.md classifies as untrusted, and Adaptive Card `TextBlock` renders
a markdown subset — so a crafted display name could inject a link into a
channel message. Names are markdown-escaped before embedding.

**Audit.** Each send writes an `AuditLog` row through the existing
`AUDIT_SINK` with `actorType: 'system'`, which CLAUDE.md requires for outbound
notifications.

## 7. Scheduling, failure handling, endpoints

**Cron.** `notification-scheduler.service.ts` in the notifications module:
`@Cron('30 10 * * 1-5', { timeZone: IST_TIMEZONE })`. Monday–Friday only:
reporting Sunday's activity on a Monday morning would name nearly the whole
roster, which is the failure the working-day convention exists to prevent.

The scheduler holds no logic. It iterates tenants having both an active roster
and notifications enabled, calling the service per tenant inside its own
try/catch so one tenant's broken webhook cannot abort the sweep.

`IST_TIMEZONE` is currently a file-private const in
`collector-scheduler.service.ts`. It moves to `common/time.ts`, which owns
every other IST primitive, and both schedulers import it — so a second context
does not hardcode `'Asia/Kolkata'`.

**Failure handling.** Outcomes are `sent`, `sent_all_clear`,
`withheld_stale_data`, `withheld_truncated_read`, `withheld_implausible`,
`failed`, each with a reason in
`detail`. A failed day is **not** auto-retried the following morning: a list
of yesterday's names arriving a day late is worse than no list. Recovery is an
explicit manual act, and the run row makes the gap visible rather than silent.

**Endpoints** (both admin-guarded via the `Roles(Role.ADMIN)` pattern, both
documented in `docs/api/README.md`):

- Roster CRUD on `TrackedDeveloper`, following
  `watchlist-exclusions.controller.ts` — `CurrentUser` supplies
  `createdByUserId`, `class-validator` DTOs, `newId()` for ids.
- `POST /admin/notifications/no-commit-digest/run`, taking an optional `day`
  and a `dryRun` flag. `dryRun` computes and returns the whole result —
  flagged names, unresolved entries, freshness state — and posts nothing. It
  is the only way to validate the logic against real hosted data, and the
  recovery path for a failed day. `dryRun` writes no run row at all, so it can
  be called repeatedly for the same day.

  Without `dryRun`, a day whose row is already `sent` or `sent_all_clear` is
  refused; a day whose row is `failed` or withheld may be re-run, updating
  that row in place. `force` overrides the refusal and also updates in place —
  so the unique constraint is never violated and one day never accumulates
  several run records.

## 8. Rollout and verification

Shaped by how the hosted deployment actually operates.

1. Apply the migration by hand — `prisma migrate status`, then
   `migrate deploy`. Migrations do not run on deploy on that host.
2. Clear `dist` before `nest build`. A failed build with `deleteOutDir`
   leaves the running server gutted, which presents as an authentication
   failure rather than a build failure.
3. Run the seed script for the 66 in **report-only mode first**, following the
   `backend/scripts/apply-identity-overrides.ts` precedent. Its real output is
   *which of the 66 logins do not resolve to a `DeveloperIdentity`*. Some are
   expected not to; those need human review before they could ever reach a
   Teams message.
4. Seed for real; set the `teamsWebhookRef` secret and the enable flag.
5. `dryRun` the digest and reconcile the flagged list by hand against the
   activity dashboard for the same IST day. If the two disagree, nothing is
   posted until the disagreement is understood.
6. One deliberate live post to the channel, then enable the cron.

**Testing.** Unit coverage on:

- `previousWorkingDay` — Monday reports Friday.
- The set subtraction itself: a roster member active by **each** of the two
  signals in §5.3 is not flagged (separate cases, since a regression in
  either read silently re-adds people to the list).
- A parity test: for one fixture day, the digest's active set equals the set
  the Overview computes from the same rows. This is the guard on §5.3 — the
  two are required to agree, so something has to fail when they stop.
- The `incomplete` path: a commit dated in the window by `authoredAt` with a
  null `committedAt` leaves that person off the list and records the reason.
- Each suppression path — leave, bot, admin-excluded, anonymized — and an
  unresolved roster entry.
- All three withhold gates: stale collection, `truncated: true`, and the 80%
  share; plus the all-clear case producing a positive message.
- The card builder — alphabetical order, markdown escaping, and rule text
  present that both names the two counted signals and states that reviewing
  is not counted (§3.1 depends on that sentence being there).
- The client — 202 is success, 429 retries, 403 does not, URL absent from
  logs.
- A tenant-isolation test, which CLAUDE.md requires for any new data path,
  asserting tenant A's roster never reaches tenant B's run.

No test posts to Teams; the client is mocked throughout.

**Limits of local verification, stated plainly.** Local checks are `tsc`,
`lint:ci` (not `lint`, which auto-fixes and therefore cannot fail), `build`,
and `jest`. Browser-based verification is unavailable. The real commit data
lives on the hosted deployment, so correctness against actual commits is
established at step 5 via the dry-run endpoint — it cannot be asserted from a
local run.

## 9. Documentation to write during implementation

Per CLAUDE.md's documentation-routing rules:

| Doc | Change |
|---|---|
| `docs/ADR/0009-attributed-commit-digest.md` | The §3 ethics-first decision and its conditions |
| `docs/features/NOTIFICATIONS.md` (new) | Detection rule, suppressions, gates, message contract. A genuinely new topic — BC-15 has no existing doc to absorb it |
| `docs/api/README.md` | Roster CRUD + digest-run endpoints; §12 gap register |
| `docs/security/AUTH-AND-RBAC.md` | Admin guards on the new endpoints; webhook-URL secret handling and the no-logging rule |
| `docs/deployment/` | Manual migration step, secret + enable-flag configuration |
| `docs/architecture/DATA-MODEL.md` | The two new tables |

## 10. Out of scope

- Slack and email delivery. The client interface is shaped so they can be
  added, but neither is built here.
- A frontend surface for the roster. It is managed through the admin API in
  this iteration.
- A holiday calendar. The 80% gate is the mitigation; a real calendar is a
  separate decision with its own per-tenant data.
- Reviews and merge-of-earlier-work as activity signals. Excluded by the
  parity requirement in §5.3, not because they are the wrong signals. If they
  should count, the change belongs in the Overview's `withSignal` and is
  inherited here — never added here alone.
- Extending attributed notifications to any other metric. §3 covers this
  digest only.
