# ADR-0007: Frontend stays a Vite SPA (Next.js evaluated and declined)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Product owner, Chief Software Architect
- **Related:** [DASHBOARDS.md](../features/DASHBOARDS.md), [ADR-0005](0005-prisma-single-schema.md) (the org-consistency precedent), [deployment/README.md](../deployment/README.md)

## Context

The org's other project (`athma-edge`) uses **Next.js 15 (App Router)**; SprintIQ's frontend was scaffolded on **Vite + React 18**. With the org-consistency precedent from ADR-0005 (Prisma chosen over TypeORM for cross-project consistency), the question was raised whether SprintIQ should switch to Next.js before more frontend accrues.

We examined athma-edge's actual Next.js usage rather than arguing from theory:

| Next.js capability | Used in athma-edge? |
|---|---|
| `"use client"` components | 25 of 28 tsx files — effectively all client-side |
| Async server components (server data fetching) | 0 |
| API routes / server actions / middleware | 0 / 0 / 0 |
| SSR/SEO | None (auth-gated app; `/` redirects to `/login`) |
| `rewrites()` proxy to the NestJS backend | Yes — the same role Vite's dev proxy plays in SprintIQ |
| Auth | Client Zustand + hydrate from `/auth/me` — the identical pattern SprintIQ already implements |

i.e. athma-edge uses Next.js as an **SPA shell**: it carries Next's Node server runtime and build machinery while exercising none of its differentiating features. The layers that genuinely transfer between the two projects — React Query, Zustand, Tailwind, the `modules/lib/components` structure — are framework-agnostic and already aligned.

SprintIQ's frontend profile: an **authenticated, data-dense, multi-tenant dashboard** on a separate NestJS BFF. No public pages, no SEO, no server-rendered content; heavy client interactivity (URL-synced scope system, virtualized explorers, charts).

## Decision

**SprintIQ's product frontend remains a Vite + React SPA.** Next.js was evaluated and declined for this app.

Why this differs from the Prisma call (ADR-0005): there, capability was equivalent and switching cost ~zero, so consistency won. Here the trade is asymmetric:

1. **Deployment simplicity.** Vite emits a static bundle served by nginx/CDN — no second Node runtime to run, scale, and patch in Kubernetes next to the API (deployment doc §1 stays two-runtime: api + static assets).
2. **No SSR benefit to buy.** Everything behind the login is client-interactive; SSR/hydration would add friction (persisted auth, URL-state scope) for zero rendering gain — as athma-edge's all-client usage demonstrates empirically.
3. **Consistency where it counts is already achieved.** Query/state/styling/module conventions match athma-edge; adopting its Radix-based UI-kit patterns on Vite is compatible and encouraged.

## Consequences

**Positive:** simplest build/deploy (static assets), fastest dev loop, CI stays `npm ci → lint → build`, the F1 scope system's URL-state model works without hydration caveats.

**Negative / accepted:** two frameworks exist across the org's repos (Next.js in athma-edge, Vite here); developers switching projects face a thin routing-layer difference (`react-router` vs App Router). Mitigated by the shared React Query/Zustand/Tailwind/module conventions, which are where day-to-day work happens.

**Revisit trigger:** if SprintIQ needs public, SEO-facing surfaces (marketing site, docs, publicly shareable dashboard links with server rendering), build those as a separate Next.js app rather than migrating the authenticated dashboard — new ADR at that point.

## Alternatives considered

- **Switch to Next.js now** — rejected: adds a Node SSR runtime + heavier CI/deploy to serve what would be (per athma-edge's own usage) an all-`"use client"` SPA; ~8 routing files saved from porting is not the point — the ongoing operational surface is.
- **Vite + adopt athma-edge's UI kit** (Radix primitives, react-hook-form + zod) — not a framework decision; compatible with this ADR and expected to happen organically as forms/dialogs appear.
