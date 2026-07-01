# SprintIQ Frontend

React + TypeScript + Tailwind dashboard for SprintIQ, consuming the dashboard BFF
(see [docs/architecture/PRODUCT-ARCHITECTURE.md](../docs/architecture/PRODUCT-ARCHITECTURE.md) BC-13).

> Scaffold: JWT login + a **Delivery** dashboard rendering the PR cycle-time
> metric with data-freshness / metric-health transparency. Per-persona dashboards
> and more widgets build out from here.

## Stack

- **Vite + React 18 + TypeScript**
- **Tailwind CSS** for styling
- **React Query** (server state) + **Zustand** (persisted auth)
- **React Router** (protected routes)

## Run

```bash
cp .env.example .env       # leave VITE_API_BASE_URL empty to use the dev proxy
npm install
npm run dev                # http://localhost:5173  (proxies /api → backend :3000)
```

Start the backend first (see [../backend/README.md](../backend/README.md)) and seed a
tenant/user (`npm run seed`), then log in with the seeded credentials
(`tenant_seed` / `admin@seed.test` / `password123`).

## Layout (per CLAUDE.md frontend orientation)

```
src/
├── app/           # router + route composition
├── components/    # ui primitives + layout
├── modules/       # domain modules (auth, dashboards)
├── lib/           # api client, stores (auth), utils
└── providers/     # React Query + Router providers
```

## Conventions

- **Never hardcode API paths in features** — use the centralized client in
  `lib/api/client.ts` (injects the JWT, resolves the base URL, clears auth on 401).
- **Always surface trustworthiness** — freshness, sample size, and metric-health
  are shown alongside every number (see `DeliveryDashboard`).
- Build: `npm run build` (`tsc -b && vite build`). Type-check: `npm run typecheck`.
