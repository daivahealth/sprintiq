import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { newId } from '../src/common/id';

/**
 * Applies this tenant's admin identity statements — the merges and exclusions
 * that identity resolution cannot reach on evidence alone.
 *
 * Idempotent, and deliberately re-runnable after `prisma migrate reset` or any
 * other clear of the delivery data. The rows it writes live in
 * `correlation_identity_override`, which is policy rather than collected data,
 * so it is the one thing that must be restored BEFORE collection restarts —
 * otherwise the first resolution sweep republishes every split person and every
 * non-developer, and someone has to notice all over again.
 *
 *   npm run identity:overrides
 *
 * WHY A SCRIPT AND NOT A SEED: `prisma/seed.ts` deliberately seeds no
 * tenant-specific content, and these rules name real people on one reference
 * tenant. Keeping them here makes them obviously local operator state rather
 * than something every environment inherits.
 *
 * WHY A SCRIPT AND NOT THE UI: there is no admin screen for identity overrides
 * yet. When one lands, it writes the same rows through the same table and this
 * file becomes redundant — it is not a parallel mechanism, just the only hand
 * currently able to reach the switch.
 *
 * Every rule carries the evidence that justified it, because a merge with no
 * stated reason is indistinguishable from a correlation bug six months later.
 */

const prisma = new PrismaClient();

const TENANT_ID = process.env.IDENTITY_OVERRIDE_TENANT ?? 'tenant_seed';
const SET_BY = process.env.IDENTITY_OVERRIDE_USER ?? 'user_seed_admin';

interface Rule {
  sourceSystem: 'github' | 'jira';
  /** Keyed exactly as `DeveloperIdentity.sourceKey`. */
  sourceKey: string;
  action: 'merge' | 'exclude';
  canonicalDeveloperId?: string;
  reason: string;
}

/**
 * One human, two source identities, no evidential bridge between them.
 *
 * Every rule below is a case the matcher declines CORRECTLY: the second
 * identity carries an address that belongs to no GitHub account (a personal
 * Gmail, an employee number, a laptop hostname) and a name that normalizes onto
 * no known login. There is nothing in the data to merge on, which is exactly
 * why a person has to say so.
 *
 * The target is always the identity the person is known by in Jira, per the
 * roster decision: their work accumulates on that entity.
 */
const MERGES: Rule[] = [
  {
    // Commits from a personal Gmail on a second machine. The corporate account
    // is `Mohammed-Junaid-Haneef_athma`; nothing links the two addresses.
    sourceSystem: 'github',
    sourceKey: 'email:junaid.mumtaz567@gmail.com',
    action: 'merge',
    canonicalDeveloperId: 'Mohammed-Junaid-Haneef_athma',
    reason: 'Junaid Haneef — personal Gmail used on a second machine',
  },
  {
    // `narayanahealth.com`, not `.org`: a one-character difference from the
    // corporate domain, so the email rung finds nothing to match.
    sourceSystem: 'github',
    sourceKey: 'email:nithinn@narayanahealth.com',
    action: 'merge',
    canonicalDeveloperId: 'Nithin-N_athma',
    reason:
      'nithin — git config carries the .com domain, not the corporate .org',
  },
  {
    // Employee number as the local part. Resolves to a real corporate address,
    // just not the one the GitHub account verifies.
    sourceSystem: 'github',
    sourceKey: 'email:357486@narayanahealth.org',
    action: 'merge',
    canonicalDeveloperId: 'Saravanakumar-N_athma',
    reason:
      'saravanakumar — employee-number address in a work laptop git config',
  },
  {
    // The machine's own hostname as the domain, so the address exists nowhere
    // outside that laptop.
    sourceSystem: 'github',
    sourceKey: 'email:a379031@corplpm000257.local',
    action: 'merge',
    canonicalDeveloperId: 'Aayush-Ranjan_athma',
    reason: 'Aayush Ranjan — commits as 379031 from a machine-local address',
  },
  {
    sourceSystem: 'github',
    sourceKey: 'email:343359@narayanahealth.org',
    action: 'merge',
    canonicalDeveloperId: 'Harish-M_athma',
    reason:
      'Harish — employee-number address, distinct from Chetan Harish Bangal',
  },
  {
    sourceSystem: 'github',
    sourceKey: 'email:sureshreddy@corplpw100577.narayanahealth.org',
    action: 'merge',
    canonicalDeveloperId: 'Suresh-Kumar-Reddy-Mopuru_athma',
    reason:
      'Suresh Kumar Reddy — machine-hostname address; distinct from Suresh Sondur and Suresh V',
  },
  {
    sourceSystem: 'github',
    sourceKey: 'email:shibato.arts24@gmail.com',
    action: 'merge',
    canonicalDeveloperId: 'Toshib-Bagde_athma',
    reason: 'Toshib — personal Gmail used on a second machine',
  },
  {
    // 5 commits from a personal Gmail against 449 on the corporate account.
    sourceSystem: 'github',
    sourceKey: 'email:kathirlearner@gmail.com',
    action: 'merge',
    canonicalDeveloperId: 'Kathiresan-Ramasamy_athma',
    reason: 'kathirlearner — personal Gmail used on a second machine',
  },

  {
    // Pavankumar M holds 332 Jira issues and has no GitHub identity collected
    // yet. `366296` is the employee number he commits under; pointing his Jira
    // account at it now means the two become one person the moment those
    // commits arrive, rather than after someone notices the split.
    sourceSystem: 'jira',
    sourceKey: 'login:63a9319448b367d78a161bce',
    action: 'merge',
    canonicalDeveloperId: '366296',
    reason:
      'Pavankumar M — commits under employee number 366296; distinct from Pavan Kumar Reddy Gaddam',
  },
  {
    // Plus-addressed alias of the same corporate mailbox. This merged on
    // evidence before (`email_exact`) and split back out on re-collection,
    // because the commit carrying BOTH the login and this address had not
    // arrived yet — the email index is built from commits GitHub attributed,
    // so it is only ever as complete as the current backfill. An evidence-
    // based merge is not a durable one; stating it is.
    sourceSystem: 'github',
    sourceKey: 'email:nahid.noushathu+athma@narayanahealth.org',
    action: 'merge',
    canonicalDeveloperId: 'Nahid-Noushathu_athma',
    reason:
      'nahid8n — +athma alias of the same corporate address; pinned after it re-split on re-collection',
  },
];

/**
 * Entities that are not developers.
 *
 * Exclusion withholds them from pickers, head-counts, the Watchlist and the
 * Sprint Health table. It does NOT drop their commits: those stay in every repo
 * and LOC total, so no number moves when a rule is added or removed.
 *
 * Note what is NOT here. `Lohith Mallikarjun`, `Shubham Jain`, `kathirlearner`
 * and `nahid8n` were proposed for removal and are merges instead — between them
 * they carry ~645 commits from corporate addresses, and `nahid8n` was already
 * an alias of `Nahid-Noushathu_athma` rather than an entity of its own.
 * Excluding them would have taken real delivery history off the boards.
 */
const EXCLUSIONS: Rule[] = [
  {
    // One commit, personal Gmail, no corporate account on this tenant.
    sourceSystem: 'github',
    sourceKey: 'email:kritikajain0209@gmail.com',
    action: 'exclude',
    reason: 'kritika jain — not a member of this engineering org',
  },
  {
    // Automation. `isBotDeveloper` already keeps both out of head-counts, but
    // the developer picker filters on exclusion rather than on the bot
    // heuristics, so without these rows Copilot remains a selectable
    // "developer" whose board can be opened.
    sourceSystem: 'github',
    sourceKey: 'login:Copilot',
    action: 'exclude',
    reason:
      'Copilot — automation; the login its pull requests are opened under',
  },
  {
    sourceSystem: 'github',
    sourceKey: 'login:copilot-swe-agent',
    action: 'exclude',
    reason:
      'Copilot SWE agent — automation; the login its commits are authored under',
  },
  {
    // Jira-only accounts: issues assigned, no commits, no GitHub entity. They
    // are QA/BA/support staff, and counting them as unmatched developers is
    // what made the bridge look 41% healthy when it was linking 90% of
    // committers (api/README.md §12 #47).
    sourceSystem: 'jira',
    sourceKey: 'login:5c7fb60d625bb11abd843db6',
    action: 'exclude',
    reason:
      'D. Suhasini Reddy — Jira-only account, not a developer on this tenant',
  },
  {
    sourceSystem: 'jira',
    sourceKey: 'login:6135ecc8a4f86e0069383692',
    action: 'exclude',
    reason: 'Deeksha Naik — Jira-only account, not a developer on this tenant',
  },
  {
    sourceSystem: 'jira',
    sourceKey: 'login:614311bc1370f000692d17fd',
    action: 'exclude',
    reason:
      'Dharam Dutt Mishra — Jira-only account, not a developer on this tenant',
  },
  {
    // Two commits, both on one day in 2023. Recorded as Jira-only when the
    // roster was cut from 195 repos; the 299-repo sweep surfaced a GitHub
    // identity as well, which a Jira-keyed rule could never reach.
    sourceSystem: 'github',
    sourceKey: 'email:deeksha.naik@narayanahealth.org',
    action: 'exclude',
    reason:
      'Deeksha Naik — not a developer on this tenant (GitHub side of the Jira-only account)',
  },
  {
    // One commit, the same day in 2023. Same story as above.
    sourceSystem: 'github',
    sourceKey: 'email:suhasini.reddyd01@narayanahealth.org',
    action: 'exclude',
    reason:
      'D. Suhasini Reddy — not a developer on this tenant (GitHub side of the Jira-only account)',
  },
  {
    // The container user, committing from one build host. Belt and braces:
    // isBotDeveloper() keeps `root` out of every head-count, but the developer
    // picker filters on `excluded`, so without this row it stays selectable.
    // Keyed on a machine hostname, so it covers THIS host only — the durable
    // guard is the bot list, which is where the general case belongs.
    sourceSystem: 'github',
    sourceKey: 'email:root@inazlrmmc1013.narayanahealth.org',
    action: 'exclude',
    reason: 'root — CI/container git identity, not a person',
  },
  {
    // Decided 2026-09-16: dropped, not merged. He commits under two git names
    // from one corporate address, so both his GitHub identity and his Jira
    // account are named here — excluding only one would leave the other on
    // the roster under the other spelling.
    sourceSystem: 'github',
    sourceKey: 'email:lohithmallikarjuna.ke@narayanahealth.org',
    action: 'exclude',
    reason: 'Lohith Mallikarjun — not a developer to report on for this tenant',
  },
  {
    sourceSystem: 'jira',
    sourceKey: 'login:712020:462dc2d2-0ad2-4d58-a42d-9f8419277ac1',
    action: 'exclude',
    reason: 'Lohith Mallikarjuna K E — the Jira account for the entity above',
  },
  {
    // Three identities, all three named: two corporate addresses plus the
    // Jira account. Distinct from Shubham-Kumar_athma, who stays.
    sourceSystem: 'github',
    sourceKey: 'email:346044@narayanahealth.org',
    action: 'exclude',
    reason: 'Shubham Jain — not a developer to report on for this tenant',
  },
  {
    sourceSystem: 'github',
    sourceKey: 'email:shubham.jain@narayanahealth.org',
    action: 'exclude',
    reason: 'Shubham Jain — his second corporate address',
  },
  {
    sourceSystem: 'jira',
    sourceKey: 'login:5c3d7553d650366f53179e36',
    action: 'exclude',
    reason: 'Shubham Jain — his Jira account',
  },
];

// `root` also lives in KNOWN_BOT_LOGINS, which is the durable guard: the rule
// above is keyed on one machine hostname and only covers commits from that
// host, whereas the bot list covers the name wherever it appears.

async function main() {
  const rules = [...MERGES, ...EXCLUSIONS];

  for (const rule of rules) {
    const data = {
      action: rule.action,
      canonicalDeveloperId: rule.canonicalDeveloperId ?? null,
      reason: rule.reason,
      setByUserId: SET_BY,
    };
    await prisma.identityOverride.upsert({
      where: {
        tenantId_sourceSystem_sourceKey: {
          tenantId: TENANT_ID,
          sourceSystem: rule.sourceSystem,
          sourceKey: rule.sourceKey,
        },
      },
      create: {
        id: newId(),
        tenantId: TENANT_ID,
        sourceSystem: rule.sourceSystem,
        sourceKey: rule.sourceKey,
        ...data,
      },
      update: data,
    });
  }

  /* eslint-disable no-console */
  console.log(
    `Applied ${rules.length} identity overrides to ${TENANT_ID}: ${MERGES.length} merges, ${EXCLUSIONS.length} exclusions.`,
  );
  console.log(
    '  They take effect on the next identity-resolution sweep, and are re-derived on every sweep after that.',
  );
  /* eslint-enable no-console */
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
