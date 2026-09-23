# ADR-0009: Attributed daily commit digest to Microsoft Teams

- **Status:** Accepted — implemented 2026-09-18
- **Date:** 2026-09-18
- **Deciders:** Product owner
- **Related:** [CLAUDE.md](../../CLAUDE.md) ("Metrics are ethics-first"), [features/NOTIFICATIONS.md](../features/NOTIFICATIONS.md), [api/README.md §8](../api/README.md), [security/AUTH-AND-RBAC.md §5](../security/AUTH-AND-RBAC.md), [METRICS.md `sprint_productivity_grade`](../features/METRICS.md) (the first, and until now only, exception to this rule)

## Context

CLAUDE.md's "Metrics are ethics-first" rule is a default-deny: individual-level output is team/aggregate by default, and a feature that names a specific person for something they did or did not do requires an explicit, documented product decision before it ships — not an implementation detail an engineer settles alone. One exception exists to date, decided 2026-09-07 for the Sprint Health board: an attributed per-developer table and a grade, computed from tickets/PRs/reviews and never from LOC, with the rule it is computed from displayed alongside it.

A new request arrived independent of that board: a named roster of tracked developers, checked every working morning, with anyone showing no delivery signal on the previous working day listed by name in a Microsoft Teams channel. This is squarely inside the rule it must clear — it attributes an absence to named individuals and broadcasts it to a group, which is a stronger claim than a dashboard table a manager opens on request. It does not inherit the 2026-09-07 decision; that decision covers one board, not this notification, and CLAUDE.md is explicit that a leaderboard-shaped feature needs its own decision taken again.

## Decision

**Ship the daily commit digest as a second, independent exception to the ethics-first rule, decided 2026-09-18, and conditioned the same way the first one was: the rule the list is computed from ships with it and is displayed in the message itself.**

Three conditions are load-bearing, not advisory, and are enforced in code rather than left to operating discipline:

1. **The rule is displayed in every card, every time.** `buildDigestCard` (`backend/src/collectors/delivery/digest-card.ts`) renders a fixed rule line on every send — including the all-clear and every withheld outcome — stating what counted (a commit or a pull request opened, the same signals as the Activity Overview board), stating explicitly that code review, merging earlier work, and Jira activity do **not** count, and stating what is excluded (bots, admin-excluded accounts, developers on recorded leave). This is the text that makes the message defensible to the person named in it. It is not something a future change can quietly drop from the card without also removing the compliance this ADR records.
2. **Suppressions are honoured, not bypassed.** `evaluateRoster` (`backend/src/metrics/no-commit-detection.service.ts`) subtracts live `WatchlistExclusion` rows, `isBotDeveloper`, `AttributionIndex.excluded`, and `isAnonymizedAccount` before anyone can be named — reusing the same predicates the Watchlist already applies rather than a second implementation that could drift from them. A roster entry identity resolution cannot place is reported as `unresolved` and never named as inactive.
3. **Every run is recorded and audited.** `NoCommitDigestRun` (one row per tenant per reported day) is lineage for a message that names people: outcome, the exact list sent, who was unresolved, who was withheld as `incomplete`, and the reason, so "why was I on Tuesday's list?" is answerable after the fact. Every send additionally writes an `AuditLog` row with `actorType: 'system'` (`NotificationsService.runNoCommitDigest`), which CLAUDE.md requires for outbound notifications independent of this ADR.

The list is never ordered by volume — alphabetical by display name, always, the same constraint the Watchlist enforces and for the same reason: a volume ordering converts a prompt-to-check-in into the leaderboard the ethics-first rule forbids.

**This decision does not extend to any other notification.** It covers this one attributed list, sent to this one channel, computed from this one rule. A second attributed notification — a different channel, a different signal set, a different cadence — requires its own decision under the same rule, taken again, not inherited from this one or from 2026-09-07.

## Consequences

**What parity with the Activity Overview board costs, stated plainly rather than discovered later as a bug.** The active-set definition is deliberately identical to the Overview's `developersWithSignal` — a commit or a pull request opened in the window, nothing else — so the digest and the dashboard a reader opens to check it can never disagree about the same person on the same day. That parity is the point (one definition, one number, no explaining why two SprintIQ surfaces disagree), and it has a real cost: **a developer who spent the day reviewing code is named on the list**, because pull-request reviews are not in the Overview's signal set. So is someone who merged work they opened a week earlier, since the PR-opened window is keyed to `openedAt`, not `mergedAt`. Neither is a defect to be patched quietly here — widening the signal set is a real improvement, but it must be made in the Overview first and inherited by the digest, never added to the digest alone, which is exactly how the two would drift apart again (the codebase has already paid for that mistake once, recorded against `planningGapDevelopers` disagreeing with the Watchlist on real data).

This is why condition 1 is not decoration: "no tracked signal yesterday" is not "did no work," and the card must say so in the same breath it names anyone.

**Four withhold gates exist because a false claim about absence is worse than a late one.** A visibly broken collector pipeline (`withheld_stale_data` — an active connection erroring, never synced, or silent longer than `MAX_COLLECTOR_SILENCE_SECONDS`, 24h), an unevaluable roster (`withheld_unevaluable`), a truncated commit read (`withheld_truncated_read`), and an implausible flagged share above 80% (`withheld_implausible`, covering the public-holiday case SprintIQ has no calendar for) each withhold the named list rather than risk naming people on data the pipeline cannot stand behind. All four still post — a card with a reason, not silence — because a daily job whose liveness cannot be observed stops being trusted, and this ADR's compliance also depends on the digest actually running where it says it will. `withheld_stale_data` deliberately does **not** gate on the collection-completeness watermark (`Connection.collectedThroughAt`/`incomplete`) — that field is null on a healthy tenant for reasons unrelated to whether commits arrived (a connection mid-PR-backfill), which made an earlier version of this gate withhold unconditionally on a real deployment; see [features/NOTIFICATIONS.md](../features/NOTIFICATIONS.md) §4 for the measured evidence and the corrected rule.

**A failed run is not auto-retried.** A list of yesterday's names arriving a day late is worse than no list; recovery is a deliberate re-run (`force`), not an automatic one.

**Roster membership is data, not a statement about a person's employment.** `TrackedDeveloper` is an editable table for the same reason `DeveloperRole` and `WatchlistExclusion` are — an admin adds a joiner without a deploy — but the table's own docblock is explicit that it is not a judgement about whether someone is working; only `WatchlistExclusion` and the suppression predicates say who is exempt from evaluation, and taking someone off the roster entirely is meant to be rare.

## Alternatives considered

**Wait and fold this into the existing Sprint Health exception.** Rejected. The two features name individuals for different reasons, to different audiences, on different cadences, and CLAUDE.md's rule is explicit that a ranking-shaped feature does not inherit an earlier exception's cover. Treating 2026-09-07 as blanket permission for any future attributed feature is exactly the drift the rule exists to prevent.

**Report a count only, no names.** Considered and rejected as not meeting the actual request: a named roster exists specifically so a team lead knows who to check in with, and a bare count without the compliance conditions above would have been a weaker feature achieving nothing the ethics constraint didn't already allow. The three withhold gates apply the "count only" shape automatically for the cases where names cannot be trusted — that is the fallback already built in, not a separate design.

**Widen the active set beyond the Overview's `developersWithSignal` (add reviews) rather than accept the false-positive cost.** Rejected for this feature in isolation. Doing so here, without also changing the Overview, would immediately break the parity guarantee that condition 1's rule text depends on being true, and would need its own decision about whether reviews belong in the Overview at all — out of scope for shipping this digest.
