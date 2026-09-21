import { resolveAppRole } from './app-role';
import { parseTriStateFlag } from './env-flags';

/**
 * Typed configuration loaded once at boot. Consumed via ConfigService.
 * Secrets in production are resolved by reference (SECRETS_PROVIDER), not from
 * plaintext env — see docs/security/AUTH-AND-RBAC.md §7 and ADR-0004.
 */
export const configuration = () => ({
  appRole: resolveAppRole(process.env.APP_ROLE),
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  logLevel: process.env.LOG_LEVEL ?? 'debug',

  database: {
    // Single connection string consumed by Prisma (schema reads DATABASE_URL).
    url:
      process.env.DATABASE_URL ??
      'postgresql://sprintiq:sprintiq@localhost:5432/sprintiq?schema=public',
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-prod',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '3600s',
    // Platform bootstrap token for tenant provisioning (no tenant/user exists yet).
    provisioningToken: process.env.PROVISIONING_TOKEN ?? '',
  },

  collectors: {
    publicWebhookBaseUrl:
      process.env.PUBLIC_WEBHOOK_BASE_URL ?? 'http://localhost:3000',
    secretsProvider: process.env.SECRETS_PROVIDER ?? 'env',
  },

  secrets: {
    // Master key for the DB-backed encrypted secret store (SecretsService):
    // AES-256-GCM, so this must base64-decode to exactly 32 bytes.
    // Generate with: openssl rand -base64 32
    encryptionKey: process.env.SECRETS_ENCRYPTION_KEY ?? '',
  },

  ai: {
    apiKey: process.env.LLM_API_KEY ?? '',
    defaultModel: process.env.LLM_DEFAULT_MODEL ?? 'claude-opus-4-8',
  },

  notifications: {
    /**
     * Deployment-wide kill switch for the daily commit digest cron
     * (`NotificationSchedulerService`), layered ON TOP of the per-tenant
     * `dailyDigestEnabled` flag `NotificationsService.tenantsToDigest()`
     * reads from the DB — never a replacement for it. Tri-state
     * (`boolean | undefined`), NOT collapsed to `false` when unset: doing
     * that would silently disarm the cron for every existing deployment the
     * moment this field shipped, with no env change on their part.
     *
     * - **unset / empty** → `undefined`. Current behaviour, unchanged. The
     *   per-tenant flag alone decides who gets swept.
     * - **falsey** (`false`, `0`, `off`, case-insensitive) → `false`. The
     *   cron sweep does not run at all, for any tenant, regardless of what
     *   the database says — a deployment-wide disarm (incident, maintenance
     *   window).
     * - **truthy** (`true`, `1`, `on`, case-insensitive) → `true`. Still
     *   defers to the per-tenant flag. It does **not** force-enable every
     *   tenant — it means "this deployment permits the cron to run", not
     *   "every tenant is on".
     *
     * DO NOT "simplify" this into a symmetric switch that also force-enables
     * on truthy. SprintIQ is multi-tenant (CLAUDE.md: "Everything is
     * tenant-scoped... No cross-tenant reads, ever" and the ethics-first
     * anti-surveillance rule); `dailyDigestEnabled` is a per-tenant,
     * admin-opted-in DB flag because this digest names real people in a
     * Teams channel. A symmetric env var would let one process-wide env edit
     * start naming people in channels belonging to tenants who never opted
     * in — exactly the cross-tenant blast radius those rules exist to
     * prevent. The asymmetry (falsey overrides every tenant; truthy overrides
     * none) is deliberate and load-bearing, not an oversight to "fix" later.
     */
    digestCronEnabled: parseTriStateFlag(
      'DIGEST_CRON_ENABLED',
      process.env.DIGEST_CRON_ENABLED,
    ),
  },
});

export type AppConfig = ReturnType<typeof configuration>;

export default configuration;
