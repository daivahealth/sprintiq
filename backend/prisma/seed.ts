import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/modules/identity/password.util';

/**
 * Idempotent local seed: creates the bare minimum needed to log in and start
 * configuring integrations — a tenant and an admin user. Nothing else.
 *
 * It deliberately seeds NO domain data (projects, sprints, releases, stories,
 * PRs, commits, correlation edges). Delivery data must come from real
 * configured collectors, so that anything a dashboard shows is traceable back
 * to source events (the lineage rule in CLAUDE.md). Fabricated rows sitting
 * in the same tables as collected ones are indistinguishable once queried:
 * they silently inflate metrics, and — because they carry project/repo keys —
 * they appear in catalog pickers and dashboard scopes right alongside real
 * projects, with nothing marking them as fake.
 *
 * It also seeds no Connection. A previous version created an `active` GitHub
 * connection with no credentials, which the scheduler then polled on every
 * tick forever, recording an endless trail of successful zero-result syncs and
 * showing a permanent phantom repo on the Sync Status screen.
 *
 * To get data in: log in, then configure GitHub/Jira under /admin/configuration.
 *
 *   npm run prisma:deploy && npm run seed
 */
const prisma = new PrismaClient();

const TENANT_ID = 'tenant_seed';
const ADMIN_EMAIL = 'admin@seed.test';
const ADMIN_PASSWORD = 'password123';

async function main() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    create: { id: TENANT_ID, name: 'Seed Tenant', plan: 'trial' },
    update: {},
  });

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
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

  /* eslint-disable no-console */
  console.log('Seeded local tenant + admin:');
  console.log(`  login = ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(
    '  no domain data seeded — configure GitHub/Jira at /admin/configuration to collect real delivery data.',
  );
  /* eslint-enable no-console */
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
