# Runbook: Run SprintIQ locally & exercise the vertical slice

Bring the backend up against a real Postgres and push a pull request through the
whole pipeline — collector → ingestion → correlation (delivery graph) → PR
cycle-time metric → dashboard. This is the end-to-end proof of the architecture.

> Prereqs: Docker, Node 20+. See [deployment/README.md](../deployment/README.md) for topology and [api/README.md](../api/README.md) for the collector contract.

## 1. Start datastores

```bash
docker compose up -d postgres redis      # from repo root
```

> Port conflict? If `5432`/`6379` are taken on your machine, run Postgres on a free
> port instead, e.g. `docker run -d --name sprintiq-pg -e POSTGRES_USER=sprintiq \
> -e POSTGRES_PASSWORD=sprintiq -e POSTGRES_DB=sprintiq -p 5434:5432 pgvector/pgvector:pg16`
> and set `DATABASE_URL=…@localhost:5434/…`. (Redis isn't exercised by the slice yet.)

## 2. Configure & install

```bash
cd backend
cp .env.example .env          # DATABASE_URL, JWT_SECRET, PROVISIONING_TOKEN, GITHUB_WEBHOOK_SECRET
npm install                   # runs prisma generate
```

## 3. Migrate & seed

```bash
npm run prisma:deploy         # applies prisma/migrations
npm run seed                  # tenant_seed + admin@seed.test/password123 + github connection (acme/payments)
```

## 4. Run the API

```bash
npm run start:dev             # APP_ROLE defaults to api → http://localhost:3000
curl -s localhost:3000/health
```

## 5. Exercise the slice

```bash
# a) login → JWT
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"tenantId":"tenant_seed","email":"admin@seed.test","password":"password123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# b) (optional) create the story so the PR LINKS instead of orphaning
#    via the API once a Jira collector/seed exists; for now insert directly:
#    INSERT INTO planning_story (...) VALUES ('...','tenant_seed',...,'PAY-2231','PAY',...);

# c) send a signed GitHub PR-merged webhook
BODY='{"action":"closed","number":4521,"pull_request":{"title":"PAY-2231 fix capture","state":"closed","merged":true,"created_at":"2026-06-29T14:00:00Z","merged_at":"2026-06-30T10:00:00Z","additions":142,"deletions":38,"changed_files":6,"head":{"ref":"feature/PAY-2231"},"base":{"ref":"main"},"user":{"login":"jdoe"}},"repository":{"full_name":"acme/payments"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "dev-webhook-secret" | sed 's/^.*= //')"
curl -s -X POST localhost:3000/webhooks/github \
  -H 'x-github-event: pull_request' -H 'x-sprintiq-connection: conn_seed_github' \
  -H "X-Hub-Signature-256: $SIG" -H 'Content-Type: application/json' --data "$BODY"
# → {"status":"accepted","source":"github","connectionId":"conn_seed_github","ingested":1}

# d) read the metric
curl -s "localhost:3000/api/dashboards/pr-cycle-time?repo=acme/payments" -H "Authorization: Bearer $TOKEN"
# → {"metric":"pr_cycle_time","repo":"acme/payments","sampleSize":1,"p50Hours":20,"p85Hours":20,...}
```

## What to expect (verified)

- Wrong/missing `X-Hub-Signature-256` → **401** (per-provider signature verification).
- A PR whose title/branch/commits contain a known Jira key → a `pr_implements_story`
  edge in `correlation_link` with a confidence score; a PR with **no** key → a row in
  `correlation_orphan` (surfaced, never guessed).
- Webhook + poller of the same event de-dupe on `(tenantId, idempotencyKey)` in `collectors_raw_event`.

## Admin/onboarding (no raw SQL)

```bash
# provision a tenant + admin (bootstrap token, no JWT yet)
curl -s -X POST localhost:3000/api/admin/tenants -H 'Content-Type: application/json' \
  -H 'x-provisioning-token: dev-provision-token' \
  -d '{"name":"Acme","adminEmail":"eng@acme.io","adminPassword":"password123","adminName":"Eng Admin"}'

# then (as an admin JWT) create a connection
curl -s -X POST localhost:3000/api/admin/connections -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sourceSystem":"github","name":"acme/api","webhookSecretRef":"GITHUB_WEBHOOK_SECRET","config":{"repoFullName":"acme/api"}}'
```

## Teardown

```bash
docker compose down            # keep volume, or: docker compose down -v to wipe data
```
