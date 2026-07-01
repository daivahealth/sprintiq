# ADR-0006: Global-unique email identity; tenant resolved from the JWT

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** Chief Software Architect, Founding Engineering, Security
- **Related:** [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md), [DATA-MODEL.md](../architecture/DATA-MODEL.md), [ADR-0005](0005-prisma-single-schema.md)

## Context

The initial login required the caller to supply a `tenantId` alongside email + password (email was unique *per tenant*). That is poor UX and leaks an internal concept to end users. SprintIQ is **always tenant-scoped** — a session shows exactly one tenant's data at a time — so the platform should determine the tenant from *who the user is*, not ask for it.

A related question is how each request conveys tenant/user to the backend. One option is client-supplied headers (e.g. `X-Tenant-Id`, `X-User-Id`). That is **insecure**: a client could set any tenant id and read another tenant's data, violating the platform's first rule (no cross-tenant reads).

## Decision

**A user belongs to exactly one tenant; email is globally unique; login is email + password; the tenant is resolved server-side and carried in the signed JWT — never in a client-supplied header.**

1. **Identity model.** `User.email` is globally unique (was unique per tenant). Each user row carries its `tenantId`. Login looks the user up by email alone, verifies the password, and reads the tenant from the user.
2. **Token is the tenant carrier.** The JWT embeds `sub` (userId), `tenantId`, and `roles`. The server verifies the signature and derives tenant context (`TenantContextService`) from the token. The client cannot forge it. This *is* "tenant id + user id on every request" — done securely.
3. **No trusted inbound tenant/user headers.** The backend never reads tenant/user identity from client headers. (Response-side `X-Tenant-Id`/`X-Request-Id` for tracing is fine; inbound identity is JWT-only.)
4. **`GET /api/auth/me`.** Returns the current user + active tenant so the SPA can validate the token on load and display which tenant is active.
5. **One tenant at a time.** There is no tenant switcher; the session is bound to the user's single tenant.

## Consequences

**Positive**
- Clean login (email + password); tenant is never entered by the user.
- Security: tenant scoping is anchored in a signed token, not spoofable headers; still enforced centrally by `TenantContextService` + tenant-leading indexes.
- Simple mental model matching the product ("one tenant's data at a time").

**Negative / costs**
- A single human who legitimately belongs to two tenants would need two accounts (distinct emails). Acceptable for the current model.
- Global-unique email is a schema change (migration): drop the per-tenant unique, add a global unique on `email`.

**Mitigations / future**
- If multi-tenant-per-user is ever needed, introduce a membership model (user ↔ many tenants) plus a post-login **workspace selector** and a tenant claim chosen at token-issue time — a future ADR. The JWT-carries-tenant mechanism already supports that evolution.

## Alternatives considered

- **Keep `tenantId` at login** — rejected: poor UX, leaks internal concept, and unnecessary given one-tenant-per-user.
- **Client-supplied `X-Tenant-Id` / `X-User-Id` headers** — rejected: spoofable; would let a client read another tenant's data. The signed JWT is the correct carrier.
- **Subdomain/workspace-per-tenant routing** (e.g. `acme.sprintiq.io`) — deferred: reasonable for enterprise later, but not required for email-resolves-tenant; can layer on without changing the identity model.
