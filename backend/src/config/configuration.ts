import { resolveAppRole } from './app-role';

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

  ai: {
    apiKey: process.env.LLM_API_KEY ?? '',
    defaultModel: process.env.LLM_DEFAULT_MODEL ?? 'claude-opus-4-8',
  },
});

export type AppConfig = ReturnType<typeof configuration>;

export default configuration;
