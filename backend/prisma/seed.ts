import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/modules/identity/password.util';

/**
 * Idempotent local seed: one tenant, an admin user, and a GitHub connection so
 * the vertical slice can be exercised end to end. Fixed ids make re-runs safe.
 *
 *   npm run prisma:deploy && npm run seed
 */
const prisma = new PrismaClient();

const TENANT_ID = 'tenant_seed';
const CONNECTION_ID = 'conn_seed_github';
const ADMIN_EMAIL = 'admin@seed.test';
const ADMIN_PASSWORD = 'password123';
const REPO = 'acme/payments';

async function main() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    create: { id: TENANT_ID, name: 'Seed Tenant', plan: 'trial' },
    update: {},
  });

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: TENANT_ID, email: ADMIN_EMAIL } },
    create: {
      id: 'user_seed_admin',
      tenantId: TENANT_ID,
      email: ADMIN_EMAIL,
      displayName: 'Seed Admin',
      passwordHash,
      roles: ['admin', 'eng_manager'],
    },
    update: { passwordHash },
  });

  await prisma.connection.upsert({
    where: { id: CONNECTION_ID },
    create: {
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      sourceSystem: 'github',
      name: REPO,
      config: { repoFullName: REPO },
      // Secret resolved from env by name (SECRETS_PROVIDER=env) — see webhook flow.
      webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
      syncCursors: {},
      rateLimitState: {},
      status: 'active',
    },
    update: {},
  });

  /* eslint-disable no-console */
  console.log('Seeded:');
  console.log(`  tenantId     = ${TENANT_ID}`);
  console.log(`  admin login  = ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  connectionId = ${CONNECTION_ID} (github, ${REPO})`);
  console.log('  webhook secret env var = GITHUB_WEBHOOK_SECRET');
  /* eslint-enable no-console */
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
