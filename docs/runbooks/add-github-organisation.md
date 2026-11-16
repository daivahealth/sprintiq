# Runbook: Add a GitHub organisation

Add a second (or later) GitHub organisation to a tenant that already collects from one. Background and rules: [ADR-0013](../ADR/0013-multiple-github-organisations.md). Token and env reference: [deployment/README.md §5.4](../deployment/README.md). API: [api/README.md §9](../api/README.md).

Adding an organisation does not change the organisations already configured. Their connections, audit checkpoint, swept repos and Copilot sync are untouched. The one cross-organisation effect is the daily digest, which covers every *included* organisation (see step 4).

## Before the first rollout of multi-organisation support

Do this once, on the host, before deploying the build that contains ADR-0013. After it, a repo whose owner is not a configured organisation is no longer swept, refusal-counted or executed by the audit route. Before, the route covered every active GitHub connection in the tenant.

1. **Check connection owners.** Every GitHub connection's `config.repoFullName` owner must equal the configured organisation, case-insensitively. A connection owned by another organisation will stop being covered by the audit route.
2. **Check push ranges.** There must be no `pending` or `failed` push ranges for repos outside the configured organisation. Retry or dismiss them first (Sync Status panel, or `POST .../audit-sync/ranges/:id/retry|dismiss`).
3. **Apply the migration by hand.** Stop the backend, then run `npx prisma migrate deploy` (`20261116100000_multi_github_org`) *before* starting the new build. Run `prisma migrate status` first, as for every migration. The migration is additive; the previous build still runs against the new schema.

Locally, all 208 connections are `athmahealth/*`, so the checks pass.

## Add the organisation

1. **Create and authorize tokens, set env vars, restart.**
   - **Collector token.** A fine-grained PAT is bound to one organisation, so create one with the new organisation as resource owner and store it under its own ref, for example `GITHUB_TOKEN_NHWEBSITE`. Alternatively, use one classic PAT SSO-authorized for every organisation under `GITHUB_TOKEN`.
   - **Audit-log token.** `GITHUB_AUDIT_TOKEN` must belong to an owner of the new organisation and be SSO-authorized for it. Without that, the organisation's audit run reports a refused token.
   - **Copilot token** (only if Copilot usage is on). The same rules as the audit token: an owner's token, SSO-authorized for the organisation.
   - Restart the backend so it reads the new env vars.
2. **Add the row.** Admin → Configurations → GitHub → Additional organisations → **Add organisation**. Type the login once (it cannot be changed afterwards), fill the token refs or leave them blank to inherit the first organisation's, and **Save**. There is no Default repository field on additional organisations.
3. **Sync org.** Press **Sync org** on the new organisation's entry. It creates a connection for every repo GitHub lists for that organisation, with that row's token ref.
4. **Watch Sync Status until the organisation shows `included`.** A new organisation shows `collecting` until its first seeding and full sweep complete, then joins the digest. Until then it is left out of the digest gate and the card, so it cannot withhold the digest or name anyone. A refused token or a rate limit shows as that organisation's last status and error; athmahealth is unaffected.
5. **Update Tracked Developers.** Add newly visible developers to Tracked Developers only after their GitHub identities appear. Merge any Jira or email identities that did not auto-link.

## Check

- The Sync Status page shows the new organisation's status row, and the first organisation's status is unchanged.
- `GET /api/admin/configurations/github/organizations` lists the row with `digest: included`.
- After the next digest, the Teams card lead-in names every included organisation.

## Roll back

Untick **Enabled** on the organisation's entry and save. Its org-wide jobs stop, and the digest returns to single-organisation wording. Its collected data stays. A row cannot be deleted or re-pointed at another organisation. The migration stays applied; redeploying the previous build is safe.
