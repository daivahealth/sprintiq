# Authentication, RBAC & Multi-Tenancy

Authoritative reference for how SprintIQ authenticates callers, authorizes actions, isolates tenants, and audits everything — for both **human users** and **AI agents**.

> See [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md) (BC-2 Identity/Tenancy, BC-16 Audit) and [api/README.md](../api/README.md) (ingestion auth). This document is the security contract; it does not restate architecture.

---

## 1. Identity planes

SprintIQ has three distinct authentication planes — keep them separate:

| Plane | Who | Mechanism | Resolves to |
|---|---|---|---|
| **Application** | Human users (dashboards, chat) | JWT (login or SSO/SAML/OIDC) | `tenant_id` + `user_id` + roles |
| **Inbound webhooks** | Source systems (machine) | Per-provider signature verification on `/webhooks/{source}` ([api](../api/README.md) §2.2) | `tenant_id` + `connection_id` |
| **Source API access** | SprintIQ collectors → source systems | OAuth app / GitHub App install / PAT (secret by reference) | per-connection source authZ |
| **Outbound delivery** | SprintIQ → Slack/Teams/email | Provider tokens/incoming webhooks (secret by reference) | channel delivery |

A credential on one plane grants nothing on another. A source's webhook secret cannot read dashboards; a user JWT cannot drive a collector; outbound delivery tokens cannot call ingestion.

---

## 2. Application authentication

- **AuthN:** JWT (short-lived access token + refresh). Enterprise tenants use **SSO via SAML/OIDC**; the IdP subject maps to a `user.sso_subject`.
- **Login is email + password only — no tenant id.** Email is globally unique; a user belongs to exactly one tenant, so the server resolves the tenant from the user and mints a token carrying it (ADR-0006). `GET /api/auth/me` returns the current user + active tenant for the SPA to validate the session on load.
- **Token claims:** `sub` (user_id), `tenant_id`, `roles`, `exp`. Tenant and roles come from the **signed token** and are re-validated server-side — **never** trusted from request bodies or client-supplied headers (e.g. `X-Tenant-Id` is not honored; that would be spoofable and enable cross-tenant reads). The token is the secure carrier of "which tenant / which user" on every request.
- **Password auth** (non-SSO tenants): bcrypt hashing; standard lockout/rate-limit on login.
- **Session/audit:** every login, refresh, and logout is audit-logged (BC-16).

---

## 3. RBAC model

Authorization is **role-based**, evaluated per request against `tenant_id` + scope.

### Roles

| Role | Sees | Can do |
|---|---|---|
| `developer` | Own flow + team-level metrics | Personal dashboard, ask agent, act on own recommendations |
| `team_lead` | Their team(s) | Team dashboards, manage team recommendations, trigger notifications |
| `scrum_master` | Their team(s)/sprints | Sprint dashboards, generate standup/retro, flag risk |
| `eng_manager` | Their org/teams | EM dashboards, accept/assign recommendations, set thresholds/goals |
| `product_owner` | Their products/epics | PO dashboards, forecasts |
| `cto` | Org-wide | CTO dashboards, all teams, exec briefings |
| `exec` | Portfolio (read) | Executive dashboard & briefings (read-mostly) |
| `admin` | Tenant config | Connections, users/roles, budgets, audit; **no** elevated cross-tenant access |

### Enforcement
- **Permission checks** at the controller/resolver layer (guards), plus **scope checks** (does this role have access to *this team/repo/project*?).
- **Default deny.** New endpoints declare required role + scope explicitly.
- Roles are tenant-local; there is **no super-role that crosses tenants** in the application plane. Platform operations use separate, audited, break-glass tooling outside normal RBAC.
- Tenant admins manage application roles through the tenant-scoped admin API/UI. `GET /api/admin/users` lists only users in the caller's tenant, `GET /api/admin/roles` exposes the allowed role catalog, and `PATCH /api/admin/users/{id}/roles` updates a tenant user's role set. The API rejects cross-tenant user ids and prevents removing the tenant's last `admin`.

---

## 4. Multi-tenancy & isolation

The central guarantee: **no cross-tenant read, ever.**

- **`tenant_id` on every row, event, query, metric, embedding, memory, and agent action.** Composite indexes lead with `tenant_id`.
- **Tenant context is injected centrally** (middleware/guard) from the authenticated credential and threaded through the request; the repository layer applies the `tenant_id` filter so individual queries can't forget it.
- **Isolation is tested, not assumed.** Every new data path ships with a test asserting a tenant cannot read another tenant's data.
- **AI isolation:** RAG retrieval, embeddings, and agent memory are tenant-partitioned. Prompts never include cross-tenant data; per-tenant cost/rate budgets are enforced (BC-11 guardrails).
- **Enterprise option:** single-tenant / regional deployment for data-residency needs (architecture §17).

---

## 5. Metric-access ethics (RBAC-enforced)

SprintIQ is not a surveillance tool — and RBAC enforces it:

- **Individual-level metrics default to team/aggregate presentation.** Drill-into-individual is gated by role and framed for *support*, not ranking.
- **No leaderboards or individual performance scores** are exposed via any role.
- A developer sees their *own* detail; managers see team aggregates and supportive (not punitive) individual context where role-appropriate.
- Anti-vanity by design: e.g., LOC is never surfaced as a productivity score.

---

## 6. Agent authorization & governance

AI agents are first-class actors with their own constraints:

- **Read-mostly.** Agents read the delivery graph/metrics via tools; they do not mutate domain data.
- **Governed actions.** Any state-changing or outbound action (e.g., create a recommendation, post a notification) requires **human-in-the-loop approval** and is **audit-logged** with inputs, tools called, output, and cost (`agent_run`).
- **Grounding.** Agents cannot originate quantitative facts; numbers come from the Metrics Engine and are cited.
- **Untrusted input.** Ingested text (PR/commit/comment bodies) is treated as untrusted — prompt-injection defenses apply; tool outputs are validated.
- **Cost governance.** Per-tenant model tier + token budgets; overages throttled.

---

## 7. Collector (ingestion & outbound) security

Summarized here; full contract in [api/README.md](../api/README.md):

- **Inbound webhooks:** per-provider signature verification on `/webhooks/{source}` (GitHub `X-Hub-Signature-256` HMAC, GitLab token, Jira/ADO secret/JWT, Sonar HMAC, Jenkins token); replay/timestamp guard where supported; resolve `tenant_id`/`connection_id` from the connection registry; idempotency key; default-deny on failure (`401`/`404`/`409`); rate-limit/abuse controls. Public endpoints are a real attack surface — treat unverified payloads as hostile.
- **Source API access (pollers/clients):** OAuth app / GitHub App installation / PAT per connection; least-privilege scopes; automatic token refresh; rate-limit backoff.
- **Outbound delivery:** native delivery to Slack/Teams/email via provider tokens/incoming-webhooks. SprintIQ decides *whether* to notify (preferences/throttle/quiet-hours); the delivery client decides only *how*. Delivery results are audit-logged.
- **Secrets:** all source credentials and webhook secrets stored via a secret reference (vault/KMS), never in plaintext columns, never logged; rotation supported.
- **Tenant configuration:** admin-managed GitHub, Jira, LLM, notification, metric, and security settings are stored in `tenant_configuration`. Plain settings go in JSON `values`; secret material is never stored directly and must be represented as `secretRefs` pointing to the secret store.

---

## 8. Audit logging

- **All user and agent actions are audit-logged** (BC-16): login/logout, view, query, recommendation decisions, agent runs, outbound notifications, admin/config changes, connection changes.
- Audit records carry `tenant_id`, actor type/id, action, target, metadata, timestamp.
- Audit logs are **append-only** and tenant-scoped; admins see only their tenant's audit trail.
- Secrets and full PII payloads are never written to audit logs.

---

## 9. Change policy

Any change to authentication, RBAC roles/permissions, tenancy enforcement, agent governance, or audit behavior **must** update this document in the same change and add/extend isolation tests (per Documentation-First in `CLAUDE.md` / `AGENTS.md`). Boundary-level changes also warrant an [ADR](../ADR/README.md).
