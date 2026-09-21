# Notifications (BC-15): the daily commit digest

Authoritative specification for the daily commit digest — the tracked-roster inactivity notification posted to Microsoft Teams — and the first concrete build-out of BC-15 Notifications & Action. A new file rather than an addition to an existing one: BC-15 was a bare stub with nothing in `docs/features/` to absorb this, and it is not naturally a subsection of any of the other three feature docs.

> Context: [ADR-0009](../ADR/0009-attributed-commit-digest.md) (the governance decision this feature ships under — read first), [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md) (BC-15), [DATA-MODEL.md §14](../architecture/DATA-MODEL.md) (`notification_tracked_developer`, `notification_no_commit_run`), [api/README.md §8](../api/README.md) (endpoints), [security/AUTH-AND-RBAC.md §5.2](../security/AUTH-AND-RBAC.md) (RBAC + secret handling), [DASHBOARDS.md §4.4.1](DASHBOARDS.md) (the Activity Overview board this digest stays in parity with).

---

## 1. What it does

A named, editable roster of developers is checked every working morning. Anyone with no tracked delivery signal on the **previous working day** is named in a list posted to a Microsoft Teams channel at **10:30 IST, Monday–Friday**. The roster is admin-managed data (`TrackedDeveloper`), not a code constant, so a new joiner is covered without a deploy.

This is an attributed, individual-naming feature, which CLAUDE.md's "Metrics are ethics-first" rule forbids by default. It ships under [ADR-0009](../ADR/0009-attributed-commit-digest.md), a decision taken specifically for this notification and conditioned on: the rule the list is computed from being displayed in the message itself (§6), suppressions being honoured (§3), and every run being recorded and audited (§7, §8). The decision does not cover any other notification.

---

## 2. The rule

**Roster minus the active set for the reported day, in one sentence.** Everything else in this document is that subtraction plus the guards that stop it naming someone unfairly.

- **Reported day:** the previous working day in IST. `previousWorkingDayKey()` (`backend/src/common/time.ts`) — a Monday run reports Friday, never Sunday, so a quiet weekend does not name the whole roster on a Monday morning.
- **Active set:** exactly what the Activity Overview board's `totals.developersWithSignal` counts (`activeDeveloperSet()`, `backend/src/metrics/developer-activity.service.ts`) — a commit (`committedAt` in the window) or a pull request opened (`openedAt` in the window). Nothing else.

This is **deliberate exact parity**, not a coincidence of shared code. The digest calls the same exported `activeDeveloperSet()` function the Overview board calls internally, over the same reads (`CodeService.listCommitsPage`, `pullRequest.openedAt`), with `tenantId` passed explicitly rather than resolved from request context — the digest runs from a cron, where `TenantContextService.requireTenantId()` (request-scoped) is unavailable. The digest and the dashboard a reader opens to check it can therefore never disagree about the same person on the same day. Widening the active set is a legitimate future improvement, but it must be made in the Overview first and inherited here — never added to the digest alone, which is exactly how the two would drift apart again.

**What this parity costs, and it is a real cost, not a rounding error:**

- **A developer who spent the day reviewing code is named.** Pull-request reviews are not in `developersWithSignal`. This is the single largest source of a justified objection to being on the list, which is why the card states it explicitly (§6) rather than leaving it implied.
- **Merging work opened earlier does not count.** The PR signal keys on `openedAt`, not `mergedAt` — finishing and merging week-old work produces no signal on the day it happened.
- Anyone on Jira-only or design work, mid-branch with nothing yet committed, or pairing without pushing reads the same way: inactive.

---

## 3. Suppressions

Before anyone can be flagged, `evaluateRoster()` (`backend/src/metrics/no-commit-detection.service.ts`) removes:

1. **Unresolved identities.** A roster entry `attributionIndex(tenantId)` cannot place is reported in `unresolved` and never treated as inactive — an entry nobody can resolve is a data problem, not a finding about a person.
2. **Admin exclusions and known non-people**, in one union: live `WatchlistExclusion` rows (not expired), `isBotDeveloper()`, `AttributionIndex.excluded` (admin identity overrides), and `isAnonymizedAccount()` (deprovisioned GitHub EMU logins). These reuse the exact predicates the Watchlist already applies (`DASHBOARDS.md` §4.4.2/§4.4.7) rather than a second implementation that could drift from them.

Resolution is checked before suppression, suppression before activity, activity before incompleteness (§4) — the order `evaluateRoster` applies them in — so the most specific reason a person is absent from the list is the one recorded against them.

---

## 4. The four withhold gates

Four conditions cause `NoCommitDetectionService.detect()` to withhold the **named list** while still posting a card with a reason (§7). All four exist because naming people confidently on data the pipeline cannot stand behind is worse than a visibly withheld morning.

| Gate | Outcome | Condition | Why |
|---|---|---|---|
| 1. Freshness | `withheld_stale_data` | Any active connection's `collectedThroughAt` does not cover the reported day's end | Ingest is poll-based (webhooks stay deferred — [ADR-0008](../ADR/0008-github-graphql-over-webhooks.md)). A stalled collector or an expired token makes every roster member read as inactive; without this gate the job would confidently name all of them. |
| 2. Truncated read | `withheld_truncated_read` | `CodeService.listCommitsPage` returns `truncated: true` | A short commit read makes the active set unreliable — every developer it omitted would be flagged. This surfaces hitting the row ceiling rather than silently changing the answer. |
| 3. Unevaluable roster | `withheld_unevaluable` | Roster is non-empty but every entry is unresolved or suppressed — `evaluated === 0` | Canonical ids can shift after a re-collection ([api/README.md gap #52](../api/README.md)) or a roster can be seeded before identity resolution has run; both leave nothing evaluable. Left unguarded, `evaluated === 0` makes `flagged.length === 0` trivially true and the card would read "All 0 tracked developers had activity" — a confident false all-clear about a roster nothing could actually be said about. |
| 4. Implausible share | `withheld_implausible` | Flagged share of the *evaluated* roster (roster minus unresolved minus suppressed) exceeds `IMPLAUSIBLE_FLAGGED_SHARE` (0.8, exported constant) | Covers the public-holiday case SprintIQ cannot model — there is no per-tenant holiday calendar, and inventing one would be a guess dressed as a fact. Naming most of the roster at once is a finding about the day or the pipeline, not about that many people being idle. A constant rather than tenant config until a tenant needs a different value. |

Gates run in this order: 1 and 2 return before any per-developer evaluation happens (an empty `RosterEvaluation`); gate 3 has computed a real evaluation, but `flagged` is already empty there by construction (nothing evaluable means nothing flagged); gate 4 has already computed a real, non-empty evaluation by the time it decides to withhold, and empties only `flagged` before returning — `unresolved`, `incomplete`, and `suppressed` survive on every gate, because they are lineage the ADR-0009 conditions require be reported even when names are withheld, and none of them can name someone in a channel. This is a documented invariant on `DigestDetection.evaluation`: **`evaluation.flagged` is populated only when `withhold` is `null`.**

Detail messages carry the diagnostic content — gate 4's message states the real flagged count computed *before* it was emptied ("N of M evaluated developers had no signal..."), which is the entire point of the message; reading the count off the already-emptied evaluation would report "0 of M" and hide the thing the gate exists to surface. Gate 3's message states plainly that no roster entry could be evaluated and that the roster likely needs re-seeding or identity resolution to catch up.

---

## 5. The `incomplete` classification

`CodeService.listCommitsPage` windows commits on `committedAt`, which is nullable. The only thing that backfills it, `GithubCommitReconcilerService`, is one-off maintenance behind an admin endpoint, not a scheduled job — its own docblock names an ongoing cause ("commits that outran the enrichment's bounded per-tick budget"), so a commit can land today with a null `committedAt` and stay that way indefinitely, invisible to the day's read and to the Overview board alike.

`NoCommitDetectionService.commitsInvisibleToTheDayRead()` separately checks for commits dated in the window by `authoredAt` with `committedAt` still null. A roster member found only this way is classed **`incomplete`** — left off the list, not named, and recorded with that reason on the run row — rather than flagged. This is the **one place the digest knowingly diverges from the Overview board**, and only in the direction of under-reporting: it stops the digest from naming someone the board itself is provably missing a commit for. (The Overview's own day-bucketing already falls back to `committedAt ?? authoredAt`, so this fallback is the established idiom for the column, not a new invention.)

---

## 6. Outcome vocabulary

Every run — `dryRun` excepted, see §8 — produces exactly one of:

| Outcome | Meaning | `deliveredAt` set? | Names in the card? |
|---|---|---|---|
| `sent` | One or more names flagged, posted | Yes | Yes |
| `sent_all_clear` | Nobody flagged; posted as good news | Yes | No (none to name) |
| `withheld_stale_data` | Gate 1 | Yes — a card is still posted | No |
| `withheld_truncated_read` | Gate 2 | Yes — a card is still posted | No |
| `withheld_unevaluable` | Gate 3 | Yes — a card is still posted | No |
| `withheld_implausible` | Gate 4 | Yes — a card is still posted | No |
| `failed` | Delivery itself failed (webhook ref missing, POST rejected after retries) | **No** | N/A — nothing reached the channel |

**A card is posted for all four `withheld_*` outcomes** — only the names are withheld from it, not the send itself. `NoCommitDigestRun.deliveredAt` therefore answers "did a card reach the channel" (true for `sent`, `sent_all_clear`, and every `withheld_*`), which is a different question from `flaggedCount`/`flagged` ("were names in it," empty for every withheld or failed outcome). It is null only for `failed`. A daily job whose liveness cannot be observed stops being trusted — every outcome except an actual delivery failure produces a visible morning message, so silence in the channel means the job did not run at all, never that it decided quietly not to say anything.

A `failed` day is **not** auto-retried the next morning — a list of yesterday's names arriving a day late is worse than no list. Recovery is the explicit `force` re-run (§8).

---

## 7. Card contract

`buildDigestCard()` (`backend/src/collectors/delivery/digest-card.ts`) builds an Adaptive Card, wrapped as `{ type: 'message', attachments: [...] }` for the Power Automate "Post card in a chat or channel" action. Every card, regardless of outcome, carries:

- A heading naming the IST day reported on.
- Either the withheld detail message, the all-clear line, or the count and alphabetical names (`N of M tracked developers had no activity`) — alphabetical by display name, **never** by any volume figure. This is a direct ADR-0009 condition: a volume ordering turns a prompt-to-check-in into the leaderboard the ethics-first rule forbids.
- When names are shown, a framing line: "This is a prompt to check in, not a conclusion about anyone — ask before assuming."
- **The rule text, on every card, including all-clear and withheld cards:** what counted (commit or PR opened, same as the Overview board), what explicitly did **not** count (review, merging earlier work, Jira activity), and what is excluded (bots, admin-excluded accounts, developers on recorded leave). This is the ADR-0009 condition that makes the message defensible — see §2's cost list for exactly what it is compensating for.
- A freshness line: "Data collected through `<collectedThroughAt>`."
- **An unattributed-commit disclosure line, when `unattributedCommits > 0`.** `attributeCommit` (`backend/src/metrics/developer-activity.service.ts`) returns `undefined` for a commit with no `authorLogin` AND an `authorEmail` not in the attribution index — the ordinary GitHub case (a login is only set for a verified email on the account), not an exotic one; [api/README.md gap #52](../api/README.md) documents ten split-identity pairs on the reference tenant that produce exactly this. Such a commit is invisible to `activeDeveloperSet`, so its author can be named on the list despite genuinely having committed that day. `NoCommitDetectionService.detect()` counts these while it already reads the day's commits (`DigestDetection.unattributedCommits`, no extra query) and the card renders them as counter-evidence — never as a gate. **This is disclosure, not withholding**: the count does not suppress, filter, or change who is named; it only tells a reader there is reason to doubt the list. Rendered only when positive (a zero line every ordinary morning is noise), and placed beside the freshness line, not folded into the rule text. Zero at gates 1 and 2, which return before the commit read runs.

**Untrusted input.** Display names originate in ingested GitHub/Jira data, which CLAUDE.md classifies as untrusted, and an Adaptive Card `TextBlock` renders a markdown subset. `escapeCardText()` escapes backslash, backtick, asterisk, underscore, square brackets/parentheses, and angle brackets before any name is embedded, so a crafted display name cannot inject a link (including a bare `<https://...>` autolink, which needs no brackets or parens at all) or format text in a channel message that posts every morning.

---

## 8. Orchestration, delivery, and endpoints

**Split of responsibility.** `NoCommitDetectionService.detect()` decides the facts (who, withheld or not) and has no knowledge of Teams. `NotificationsService.runNoCommitDigest()` decides *whether and whom to notify* — applies the already-sent refusal, builds the card, records the run row, writes the audit entry. `TeamsClient.postAdaptiveCard()` (`backend/src/collectors/delivery/teams.client.ts`) decides *how* — resolves the webhook URL and posts. Detection never imports the client; the client never imports detection.

The run row (`notification_no_commit_run`, DATA-MODEL.md §14) carries `unattributedCommits` alongside `flagged`/`unresolved`/`incomplete` — `detect()`'s count, unchanged from the value shown on the card for the same run. It is written by the same claim-before-post path as every other field on the row (below); nothing about the disclosure line is computed or persisted separately from the rest of the run's lineage.

**The Teams webhook is a Power Automate Workflows URL**, not the retired O365 connector. Success is any 2xx (Power Automate typically answers 202 with an empty body — a strict 200-only check would misreport every successful send as a failure). Retry is bounded: 3 attempts with exponential backoff on 429 and 5xx only; a 4xx (a deleted flow, a rotated URL) fails fast rather than delaying the diagnosis. `AbortSignal.timeout` bounds each attempt so a hung POST cannot wedge the cron. The URL is never logged at any level — see [security/AUTH-AND-RBAC.md §7](../security/AUTH-AND-RBAC.md).

**Ref resolution is two hops, not one.** The `notifications` configuration namespace's field key `teamsWebhookRef` is only the catalog *slot* — the admin picks an arbitrary secret ref name when they paste the webhook URL, and that chosen name is stored at `secretRefs.teamsWebhookRef` on the tenant's `notifications` configuration row. `NotificationsService.resolveTeamsWebhookRef()` reads that stored ref name and passes it to `TeamsClient.postAdaptiveCard(tenantId, ref, card)`, which then resolves the actual URL via `SecretsService.resolve(tenantId, ref)`. A misconfigured tenant (no ref set) is treated as a failed delivery — it records a `failed` run row rather than throwing past the run-recording step.

**Cron.** `NotificationSchedulerService` (`notification-scheduler.service.ts`): `@Cron('30 10 * * 1-5', { timeZone: IST_TIMEZONE })`. It holds no logic — it lists tenants with both an enabled digest and a non-empty active roster (`NotificationsService.tenantsToDigest()`) and calls `runNoCommitDigest` per tenant inside its own try/catch, so one tenant's broken webhook or misconfiguration cannot cancel the sweep for the others. `IST_TIMEZONE` lives in `common/time.ts`, shared with the collector scheduler, so a second cron cannot hardcode its own copy of `'Asia/Kolkata'`.

### 8.1 Roster CRUD

`GET|PUT|DELETE /dashboards/tracked-developers[/{developer}]` — admin-only. See [api/README.md §8](../api/README.md) for the wire contract. `PUT` upserts (idempotent — one row per developer, re-adding reactivates); `DELETE` deactivates rather than deletes, so removing someone from the roster is a recorded act with an author, not a silent gap.

### 8.2 Manual digest run

`POST /admin/notifications/no-commit-digest/run` — admin-only, body `{ day?, dryRun?, force? }`. See [api/README.md §8](../api/README.md) for the full wire contract, including the already-sent refusal and `force` semantics. `dryRun` is the operationally important flag: it runs the full detection and returns the complete result — flagged names, unresolved entries, incomplete entries, freshness — without posting anything or writing a run row, so it is safe to call repeatedly against real hosted data. It is both how the rule is validated before a single name reaches a channel (rollout step, [docs/deployment/README.md §10](../deployment/README.md)) and the recovery path for inspecting a `failed` day.

---

## 9. Change policy

Any change to the active-set definition, the suppression predicates, a withhold gate's threshold or existence, the outcome vocabulary, the card's rule text, or the roster/run endpoints **must** update this document in the same session (Documentation-First per `CLAUDE.md`/`AGENTS.md`). Widening the active set beyond `developersWithSignal` must be made in the Overview board first (DASHBOARDS.md §4.4.1) and inherited here, per §2. Any change to who this feature notifies, or any new attributed individual-level notification, requires its own ADR under CLAUDE.md's ethics-first rule — it does not inherit ADR-0009.
