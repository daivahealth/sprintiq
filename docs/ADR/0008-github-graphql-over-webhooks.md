# ADR-0008: GitHub collection moves to GraphQL; webhooks stay deferred

- **Status:** Accepted — implemented behind a flag 2026-08-20, pending the parity check below
- **Date:** 2026-08-19
- **Deciders:** Product owner, Chief Software Architect
- **Related:** [ADR-0003](0003-native-collectors-replace-n8n.md) (collectors own all source I/O), [api/README.md §3](../api/README.md) (poller contract), [api/README.md §12 #2](../api/README.md) (webhooks deferred), [METRICS.md §9](../features/METRICS.md)

## Context

Collection had to deliver three things at once: changes visible on dashboards quickly, historical backfill running continuously, and a 195-repository fleet — against GitHub's fixed 5,000 requests/hour.

The REST path cannot do this, and the arithmetic is not a tuning problem. GitHub's list endpoints carry none of the data the metrics need, so every item requires enrichment:

| Call | Cost |
|---|---|
| `GET /pulls/{n}` (stats, `merged_by`) | 1 **per PR** |
| `GET /pulls/{n}/commits` (Jira keys) | 1 **per PR** |
| `GET /pulls/{n}/reviews` | 1 **per PR** |
| `GET /pulls/{n}/comments` (per-review counts) | 1 **per PR** |
| `GET /commits/{sha}` (line stats) | 1 **per commit** |

At the deployed per-connection budget that is ~127 calls per repo per tick, so one fleet pass demanded **~24,765 calls — five times the entire hourly quota**. Measured on the reference tenant mid-backfill: **158 of 196 connections rate-limited**, 2,015 events collected, a 12-month backfill projected at 2–3 days.

The fleet budget introduced in §12 #35 divides that ~10×, but bounds spend *per sweep* while sweeps can fire ~7×/hour — an improvement, not a fix.

Two candidates were considered for "changes reflected immediately": webhooks (true push) and GraphQL (cheap enough to poll frequently). The decision was made by **measurement against the real `athmahealth` org**, not from documentation.

## Decision

**Move GitHub collection to the GraphQL API. Keep webhooks deferred. Leave Jira on REST unchanged.**

Measured costs, using the free `rateLimit { cost }` field:

| Query | Returned | REST equivalent | GraphQL cost |
|---|---|---|---|
| 25 PRs, fully enriched | stats, `mergedBy`, author + `__typename`, commit messages, review timeline, per-review comment counts | 100 calls | **1 point** |
| 100 commits | `additions`/`deletions`/`changedFilesIfAvailable` inline | 29 calls | **1 point** |
| **5 repos batched in one query** | 50 PRs + 169 commits, all enriched | ~635 calls | **1 point**, 9s |

Repositories batch by alias, and `comments { totalCount }` yields per-review counts at no node cost — retiring the fourth per-PR call outright.

For the 195-repo fleet:

```
195 repos ÷ 5 per query  =  39 queries  =  39 points per full pass
Full pass every 5 min    =  468 points/hour  =  9.4% of the 5,000-point quota
```

**The entire fleet can refresh every five minutes on under 10% of quota**, leaving ~90% for backfill running concurrently. GraphQL also draws on its **own** 5,000-point bucket, separate from REST's 5,000 requests, so collection stops competing with the §3.2 reconcilers.

Jira is untouched: one `/search/jql` returns 100 whole issues with `expand=changelog` inline, ~20 requests per tick regardless of volume. It is already efficient; its problems are credential- and cursor-related, not protocol-related.

## Consequences

**The binding constraint inverts.** Under REST, points-equivalent (request count) was scarce and latency was free. Under GraphQL, points are nearly free and **query complexity and latency are the limits**. A 6-repo batch at 25 PRs × 50 nested commits/reviews returned **502 Bad Gateway**; 5 repos at 10 PRs × 20 nested succeeded in 9s. Batch sizing must therefore be tuned empirically and carry a fallback that halves the batch on 502. Budget logic written around request counting does not transfer.

**Partial errors become the correctness risk.** GraphQL returns HTTP 200 with an `errors` array and partial `data`. A field nulled by an error is indistinguishable from a genuinely absent one, which directly attacks the "failed ≠ empty" discipline the collectors are built on (§12 #29). The client must treat any path named in `errors[].path` as failed and must never map a null under an errored path to an empty collection.

**Nested pagination truncates silently.** `commits(first: N)` on a larger PR returns N with `hasNextPage`. This needs the explicit `truncated` flag `GithubReviewComments` already carries.

**Field semantics must be verified, not assumed.** Specifically `author { user { login } }` versus REST's verified-email linkage, on which the identity resolution of §12 #22 depends — it recovered 15 of 19 identities on real data, and a silent semantic difference would regress that. Bot classification also moves from `user.type == "Bot"` to `__typename`. A parity harness diffing GraphQL against REST-collected data is required before cutover; the reference tenant's existing REST data is what makes that check possible.

**Near-realtime, not realtime.** ~5 minutes, not seconds.

## Implementation status (2026-08-20)

Built and merged behind `GITHUB_COLLECTION_MODE` (`rest` | `graphql`), **default `rest`**. See [api/README.md §3](../api/README.md) for the operating contract and §12 #40/#41 for the register entries.

What shipped, and the two places it departs from what this ADR assumed:

- **The GraphQL client keeps REST's method signatures** rather than exposing a "fetch one enriched page" API. Reshaping the interface around GraphQL would have meant rewriting the collector's mid-page resume offset, backfill-floor comparison and per-item rate-limit suspension — the logic §12 #37 and #29 exist to protect, and which took live bugs to get right. Instead `listPullRequestsPage` fetches every per-PR field inline and answers the four follow-up calls from a short-lived per-repo prefetch cache. Same cost saving, no change to the loop it feeds. A cache miss falls through to a real single-PR query and never returns an empty-but-successful result.
- **Cross-repo batching is deferred to a Phase 2** (§12 #41). Batching cuts across `SourceCollector.poll(connection)`, which is per-connection by contract while org sync registers one connection per repo — so the 5-repos-per-query figure needs a new contract *and* scheduler grouping. Phase 1 issues one query per repo: ~195 points per fleet pass, ~47% of quota at 5-minute cadence rather than the ~9% quoted above. Still ~100× cheaper than REST, and it leaves the contract redesign to be validated separately from the transport.

All three hazards named under Consequences have explicit handling and tests: partial errors (`errors[].path`, including errored ancestors and unlocalisable errors), silent nested truncation, and complexity 502s (halve-and-retry, then `failed` — never an empty page). Bot classification moved to `__typename` through the same shared helper.

**The parity harness is the remaining gate.** `backend/scripts/github-graphql-parity.ts` diffs both transports over the same repos and exits non-zero on any critical difference — `authorLogin` on commits above all, since REST populates it only for verified commit emails and §12 #22's identity resolution is built on exactly that. The default does not flip until it runs clean against the reference org.

## Alternatives considered

**Webhooks for true push.** Rejected *for now*, on three grounds found by measurement rather than assumed. Five-minute freshness is already adequate for delivery dashboards, so webhooks buy seconds over minutes — a real but far smaller gain than expected before the numbers came in. They require a publicly reachable HTTPS endpoint, which the current private-network deployment is not, making this an infrastructure project rather than a code change. And webhooks are lossy, so reconciliation polling is needed regardless — they are additive work, not a replacement. Critically, **they do nothing for the backfill**, which is the problem actually degrading the system today.

The routing blocker recorded in §12 #2 does appear overstated: GitHub payloads carry `repository.full_name` and Jira payloads carry the site URL, either of which resolves a connection from the body without a provider-set header. Webhooks therefore remain viable as a later refinement for seconds-level latency; they are not the first move.

**Tuning the REST budgets further.** Rejected. The cost is structural — four calls per PR and one per commit — so no budget value serves both a 2-repo and a 195-repo tenant. §12 #14 already tried tunability and #35 already tried fleet division; both help and neither removes the ceiling.

**Repo-level REST endpoints.** `GET /repos/{owner}/{repo}/pulls/comments` would retire the fourth per-PR call. Rejected as insufficient on its own: it helps incremental mode but is a net loss during backfill, and leaves the other three calls untouched.
