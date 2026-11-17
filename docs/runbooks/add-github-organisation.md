# Runbook: Add a GitHub organisation

Add a second (or later) GitHub organisation to a tenant that already collects from one. Background and rules: [ADR-0013](../ADR/0013-multiple-github-organisations.md). Token and env reference: [deployment/README.md §5.4](../deployment/README.md). API: [api/README.md §9](../api/README.md).

Adding an organisation does not change the organisations already configured. Their connections, audit checkpoint, swept repos and Copilot sync are untouched. The one cross-organisation effect is the daily digest, which covers every *included* organisation (see step 4).

## Before the first rollout of multi-organisation support

Do this once, on the host, before deploying the build that contains ADR-0013. After it, a repo whose owner is not a configured organisation is no longer swept, refusal-counted or executed by the audit route. Before, the route covered every active GitHub connection in the tenant.

1. **Check connection owners.** Every GitHub connection's `config.repoFullName` owner must equal the configured organisation, case-insensitively. A connection owned by another organisation will stop being covered by the audit route. On the host database:

   ```sql
   SELECT split_part(config->>'repoFullName', '/', 1) AS owner, count(*)
   FROM connections_connection
   WHERE "sourceSystem" = 'github' AND status = 'active'
   GROUP BY 1;
   ```

   Any owner other than the configured organisation (compare lowercased) needs a decision before deploying.
2. **Check push ranges.** There must be no `pending` or `failed` push ranges for repos outside the configured organisation. List them with `GET /api/admin/configurations/github/audit-sync/ranges?status=pending` and `?status=failed`, and retry or dismiss them first (Sync Status panel, or `POST .../audit-sync/ranges/:id/retry|dismiss`).
3. **Apply the migration by hand.** Stop the backend, then run `npx prisma migrate deploy` (`20261116100000_multi_github_org`) *before* starting the new build. Run `prisma migrate status` first, as for every migration. The migration adds a column and backfills it, but it also drops the unique index on the checkpoint's `tenantId` — see Roll back before you need it.

## Add the organisation

1. **Create and authorize tokens, set env vars, restart.**
   - **Collector token.** A fine-grained PAT is bound to one organisation, so create one with the new organisation as resource owner and store it under its own ref, for example `GITHUB_TOKEN_NHWEBSITE`. Alternatively, use one classic PAT SSO-authorized for every organisation under `GITHUB_TOKEN`.
   - **Audit-log token.** `GITHUB_AUDIT_TOKEN` must belong to an owner of the new organisation and be SSO-authorized for it. Without that, the organisation's audit run reports a refused token.
   - **Copilot token** (only if Copilot usage is on). See the Copilot token row in [deployment/README.md §5.2](../deployment/README.md).
   - Restart the backend so it reads the new env vars.
2. **Add the row.** Admin → Configurations → GitHub → Additional organisations → **Add organisation**. Type the login once (it cannot be changed afterwards), fill the token refs or leave them blank to inherit the first organisation's, and **Save**. There is no Default repository field on additional organisations.
3. **Sync org.** Press **Sync org** on the new organisation's entry. It creates a connection for every repo GitHub lists for that organisation, with that row's token ref.
4. **Watch Sync Status until the organisation shows `included`.** A new organisation shows `collecting` until its first seeding and full sweep complete, then joins the digest. Until then it is left out of the digest gate and the card, so it cannot withhold the digest or name anyone. A refused token or a rate limit shows as that organisation's last status and error; athmahealth is unaffected.
5. **Branch history is read automatically.** An added organisation's first seeding pass stores each repo's branch tips **and** plans a read of every non-default branch's existing commits, so work pushed before the organisation was added is collected. It is controlled by two settings on the organisation's card: **Branch history lookback (days)** (1–90, blank = `GITHUB_AUDIT_NEW_BRANCH_LOOKBACK_DAYS`, default 30) and **Max branches to read** (0–500, blank = 200). A repo with more branches than the maximum is seeded without its branch history, and the run's note names it — raise the maximum and press **Read branch history** to read it. The repos' default-branch history comes from the regular backfill (**Backfill window (days)**); a blank backfill window or sync interval **inherits the first organisation's**, and the card shows the inherited value as its placeholder.
   To re-read later (for example after raising the lookback or the maximum), save the new values, then press **Read branch history** on the organisation's card. It re-reads only that organisation's repos, at the next hourly full branch sweep (two minutes past the hour, server local time; with `GITHUB_AUDIT_FULL_SWEEP_MINUTES=0` there is no sweep and each repo is read when next pushed to). The API call remains as a fallback: `POST /api/admin/configurations/github/audit-sync/reread-branch-history` with body `{ "organization": "<Org>" }` (or `{ "repos": ["<Org>/<repo>", …] }`).
6. **Update Tracked Developers.** Add developers who are active only in the new organisation **after** it shows `included` — while it is `collecting`, its partial data could name a newly tracked developer. Add them only once their GitHub identities appear. Merge any Jira or email identities that did not auto-link.

## Check

- The Sync Status page shows the new organisation's status row, and the first organisation's status is unchanged.
- `GET /api/admin/configurations/github/organizations` lists the row with `digest: included`.
- After the next digest, the Teams card lead-in names every included organisation.

## Roll back

Untick **Enabled** on the organisation's entry and save. Its org-wide jobs stop, and the digest returns to single-organisation wording. Its collected data stays. A row cannot be deleted or re-pointed at another organisation. The migration stays applied. This is the preferred rollback and needs no code change.

Rolling back the **build** is not a plain redeploy: the migration dropped the unique index `collectors_github_audit_checkpoint_tenantId_key`, and the previous build's checkpoint upsert (`ON CONFLICT ("tenantId")`) needs it. Restore it first:

```sql
CREATE UNIQUE INDEX "collectors_github_audit_checkpoint_tenantId_key" ON "collectors_github_audit_checkpoint"("tenantId");
```

This only succeeds while each tenant has exactly one checkpoint row. Otherwise delete the additional organisations' checkpoint rows first:

```sql
DELETE FROM "collectors_github_audit_checkpoint" WHERE "organization" <> '<default org login>';
```

Runs written by the old build after a rollback carry a NULL `organization` and do not appear in per-organisation status after re-deploying.
