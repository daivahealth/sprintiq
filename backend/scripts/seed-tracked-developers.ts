import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { newId } from '../src/common/id';

/**
 * Seeds the daily digest's tracked roster for this deployment's tenant.
 *
 * Report-only unless `--apply` is passed, and the report is the point: it
 * says which of these logins identity resolution actually knows. A login it
 * does not know cannot be evaluated, and an unresolved roster entry reads
 * identically to a developer who did nothing — one of those is a false
 * accusation, so they are separated here, before anything is written.
 *
 *   npm run digest:roster            # report only
 *   npm run digest:roster -- --apply # write the rows
 *
 * WHY A SCRIPT AND NOT A SEED: `prisma/seed.ts` deliberately seeds no
 * tenant-specific content, and these are real people on one reference tenant.
 * Same reasoning as `apply-identity-overrides.ts`.
 *
 * Idempotent: re-running upserts, so it is safe after a migrate reset.
 */

const prisma = new PrismaClient();

const TENANT_ID = process.env.DIGEST_ROSTER_TENANT ?? 'tenant_seed';
const ADDED_BY = process.env.DIGEST_ROSTER_USER ?? 'user_seed_admin';

const LOGINS = [
  'Adarsh-Naik_athma',
  'Amaljith-Thomas_athma',
  'Animesh-Khatua_athma',
  'Apoorva-S_athma',
  'Archana_athma',
  'Arjun-Shaji_athma',
  'Arun-Balaji-M_athma',
  'Arvind-Pandey_athma',
  'Avinash-C_athma',
  'Bukka-Himadhar-Kumar-Reddy_athma',
  'Damodhar-Rao_athma',
  'Dinesh-Kumar-K_athma',
  'Gnanesh-Gowda-NS_athma',
  'Guhan-R-P_athma',
  'Hari-Krishnan-P-C_athma',
  'Harish-M_athma',
  'Harshitha-Kumar-Shetty_athma',
  'Harshit-Jaiswal_athma',
  'Jalakuri-Siva-Rama-Krishna_athma',
  'Jana-M_athma',
  'Kumarakalva-Uday-Saisuma_athma',
  'Lokesha-CS_athma',
  'Lucky-Jain_athma',
  'Manu-Mohan-M_athma',
  'Mithun-Gowda-P_athma',
  'Modi-Jigar_athma',
  'Mohammad-Sonu_athma',
  'Mohammedali-S-Hanabaratti_athma',
  'M-Padma_athma',
  'Nallajodu-Chandra-Mohan_athma',
  'Navajeevan-B_athma',
  'Navin-Patel_athma',
  'Nithin-N_athma',
  'Pandiyan-E_athma',
  'Pavan-Kumar-Reddy-Gaddam_athma',
  'Prabhata-Kumar-Sahu_athma',
  'Pradeep-Kumar_athma',
  'Pradeep-S_athma',
  'Prasanta-Kumar-Padhan_athma',
  'Priyanka-Adhikary_athma',
  'Rajendra-Kumar_athma',
  'Rakesh-Kumar-Sahu_athma',
  'Rakesh-R_athma',
  'Ram-Kumar_athma',
  'Rounak-Singh_athma',
  'Sakthimai-A-R_athma',
  'Sangeetha-S_athma',
  'Sanjay-Kumar-Yadav_athma',
  'Santhosh-Kumar-C_athma',
  'Saravanakumar-N_athma',
  'Satyam-Kumar_athma',
  'Shivam_athma',
  'Shivani-Karri_athma',
  'Shubham-Kumar_athma',
  'Siddhant-Saraf_athma',
  'Siva-Ganesh-Sagar-Yedumalla_athma',
  'Srinathareddy-Isukapalli_athma',
  'Srinivasarao-Ganipisetty_athma',
  'Thayakotli-Krishna_athma',
  'Umesha-C-S_athma',
  'Valleti-Vinay-Kumar_athma',
  'Vijay-Kumar-Yadav_athma',
  'Vinayak-Dhalabanjan_athma',
  'Vineela-Gumireddy_athma',
  'Vishnu-K-R_athma',
  'Zaheer-Abass_athma',
] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const known = await prisma.developerIdentity.findMany({
    where: { tenantId: TENANT_ID, canonicalDeveloperId: { in: [...LOGINS] } },
    select: { canonicalDeveloperId: true },
    distinct: ['canonicalDeveloperId'],
  });
  const resolved = new Set(known.map((row) => row.canonicalDeveloperId));
  const unresolved = LOGINS.filter((login) => !resolved.has(login));

  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Roster size: ${LOGINS.length}`);
  console.log(`Resolved to a known developer: ${resolved.size}`);
  console.log(`NOT resolved: ${unresolved.length}`);
  for (const login of unresolved) {
    console.log(`  unresolved: ${login}`);
  }
  if (unresolved.length > 0) {
    console.log(
      '\nUnresolved entries will be reported by the digest as unresolved, never\n' +
        'named as inactive. Review them before enabling the notification: the\n' +
        'usual causes are a renamed account, a login that never committed, or a\n' +
        'person whose identities need an IdentityOverride merge.',
    );
  }

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to write these rows.');
    return;
  }

  for (const login of LOGINS) {
    await prisma.trackedDeveloper.upsert({
      where: {
        tenantId_canonicalDeveloperId: {
          tenantId: TENANT_ID,
          canonicalDeveloperId: login,
        },
      },
      create: {
        id: newId(),
        tenantId: TENANT_ID,
        canonicalDeveloperId: login,
        addedAs: login,
        createdByUserId: ADDED_BY,
      },
      update: { active: true },
    });
  }
  console.log(`\nApplied: ${LOGINS.length} roster rows upserted.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
