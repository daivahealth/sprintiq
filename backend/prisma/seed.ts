import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/modules/identity/password.util';

/**
 * Idempotent local seed exercising every detailing dimension the dashboards
 * cover: epics, sprints (closed + active), releases, stories/bugs/tasks/
 * subtasks with points/assignees/resolution, and PRs both linked (via
 * correlation edges) and orphaned. Fixed ids make re-runs safe.
 *
 *   npm run prisma:deploy && npm run seed
 */
const prisma = new PrismaClient();

const TENANT_ID = 'tenant_seed';
const CONNECTION_ID = 'conn_seed_github';
const ADMIN_EMAIL = 'admin@seed.test';
const ADMIN_PASSWORD = 'password123';
const REPO_PAY = 'acme/payments';
const REPO_WEB = 'acme/web';

const now = Date.now();
const days = (n: number) => new Date(now + n * 86_400_000);

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

  await prisma.connection.upsert({
    where: { id: CONNECTION_ID },
    create: {
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      sourceSystem: 'github',
      name: REPO_PAY,
      config: { repoFullName: REPO_PAY },
      webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
      syncCursors: {},
      rateLimitState: {},
      status: 'active',
    },
    update: {},
  });

  // ---- Sprints: one closed (velocity history), one active (health/risk) ----
  const sprints = [
    {
      id: 'sprint_pay_1',
      externalId: '101',
      name: 'PAY Sprint 1',
      state: 'closed',
      projectKey: 'PAY',
      startAt: days(-28),
      endAt: days(-14),
    },
    {
      id: 'sprint_pay_2',
      externalId: '102',
      name: 'PAY Sprint 2',
      state: 'active',
      projectKey: 'PAY',
      startAt: days(-7),
      endAt: days(7),
    },
    {
      id: 'sprint_ops_1',
      externalId: '201',
      name: 'OPS Sprint A',
      state: 'active',
      projectKey: 'OPS',
      startAt: days(-5),
      endAt: days(9),
    },
  ];
  for (const s of sprints) {
    await prisma.sprint.upsert({
      where: { tenantId_externalId: { tenantId: TENANT_ID, externalId: s.externalId } },
      create: { ...s, tenantId: TENANT_ID, connectionId: CONNECTION_ID },
      update: { state: s.state, startAt: s.startAt, endAt: s.endAt },
    });
  }

  // ---- Releases (fixVersions) ----
  for (const r of [
    { id: 'rel_pay_12', name: 'payments-v1.2', projectKey: 'PAY', released: true, releaseDate: days(-10) },
    { id: 'rel_pay_13', name: 'payments-v1.3', projectKey: 'PAY', released: false, releaseDate: days(14) },
  ]) {
    await prisma.release.upsert({
      where: { tenantId_projectKey_name: { tenantId: TENANT_ID, projectKey: r.projectKey, name: r.name } },
      create: { ...r, tenantId: TENANT_ID, connectionId: CONNECTION_ID },
      update: { released: r.released, releaseDate: r.releaseDate },
    });
  }

  // ---- Work items: epic → stories/bugs/tasks → subtask, across sprints ----
  type Item = {
    id: string;
    externalKey: string;
    projectKey: string;
    type: string;
    status: string;
    title: string;
    storyPoints?: number;
    epicKey?: string;
    parentKey?: string;
    sprintExternalId?: string;
    releases?: string[];
    assigneeLogin?: string;
    assigneeName?: string;
    resolvedAt?: Date;
    createdAt?: Date;
  };
  const items: Item[] = [
    // Epic
    { id: 'st_pay_100', externalKey: 'PAY-100', projectKey: 'PAY', type: 'epic', status: 'In Progress', title: 'Payments revamp' },
    // Closed sprint (velocity history): 13 of 16 pts done
    { id: 'st_pay_2210', externalKey: 'PAY-2210', projectKey: 'PAY', type: 'story', status: 'Done', title: 'Capture retries', storyPoints: 5, epicKey: 'PAY-100', sprintExternalId: '101', releases: ['payments-v1.2'], assigneeLogin: 'jdoe', assigneeName: 'Jane Doe', resolvedAt: days(-16), createdAt: days(-27) },
    { id: 'st_pay_2211', externalKey: 'PAY-2211', projectKey: 'PAY', type: 'story', status: 'Done', title: 'Refund API', storyPoints: 8, epicKey: 'PAY-100', sprintExternalId: '101', releases: ['payments-v1.2'], assigneeLogin: 'asmith', assigneeName: 'Alex Smith', resolvedAt: days(-15), createdAt: days(-26) },
    { id: 'st_pay_2212', externalKey: 'PAY-2212', projectKey: 'PAY', type: 'bug', status: 'Done', title: 'Fix double charge', storyPoints: 3, epicKey: 'PAY-100', sprintExternalId: '101', releases: ['payments-v1.2'], assigneeLogin: 'jdoe', assigneeName: 'Jane Doe', resolvedAt: days(-14), createdAt: days(-20) },
    { id: 'st_pay_2213', externalKey: 'PAY-2213', projectKey: 'PAY', type: 'task', status: 'To Do', title: 'Spillover: docs', storyPoints: 3, epicKey: 'PAY-100', sprintExternalId: '102', createdAt: days(-25) },
    // Active sprint: mixed progress
    { id: 'st_pay_2231', externalKey: 'PAY-2231', projectKey: 'PAY', type: 'story', status: 'In Progress', title: 'Idempotent capture', storyPoints: 5, epicKey: 'PAY-100', sprintExternalId: '102', releases: ['payments-v1.3'], assigneeLogin: 'jdoe', assigneeName: 'Jane Doe', createdAt: days(-6) },
    { id: 'st_pay_2232', externalKey: 'PAY-2232', projectKey: 'PAY', type: 'story', status: 'Done', title: 'Webhook receipts', storyPoints: 3, epicKey: 'PAY-100', sprintExternalId: '102', releases: ['payments-v1.3'], assigneeLogin: 'asmith', assigneeName: 'Alex Smith', resolvedAt: days(-1), createdAt: days(-6) },
    { id: 'st_pay_2233', externalKey: 'PAY-2233', projectKey: 'PAY', type: 'bug', status: 'To Do', title: 'Currency rounding off-by-one', storyPoints: 2, epicKey: 'PAY-100', sprintExternalId: '102', assigneeLogin: 'jdoe', assigneeName: 'Jane Doe', createdAt: days(-3) },
    { id: 'st_pay_2234', externalKey: 'PAY-2234', projectKey: 'PAY', type: 'subtask', status: 'In Progress', title: 'Retry unit tests', parentKey: 'PAY-2231', epicKey: 'PAY-100', sprintExternalId: '102', assigneeLogin: 'asmith', assigneeName: 'Alex Smith', createdAt: days(-4) },
    { id: 'st_pay_2235', externalKey: 'PAY-2235', projectKey: 'PAY', type: 'story', status: 'To Do', title: 'Unestimated: settlement report', sprintExternalId: '102', epicKey: 'PAY-100', createdAt: days(-2) },
    // OPS project (active sprint + backlog)
    { id: 'st_ops_1', externalKey: 'OPS-1', projectKey: 'OPS', type: 'story', status: 'Done', title: 'Deploy tool', storyPoints: 5, sprintExternalId: '201', assigneeLogin: 'kchan', assigneeName: 'Ken Chan', resolvedAt: days(-1), createdAt: days(-5) },
    { id: 'st_ops_2', externalKey: 'OPS-2', projectKey: 'OPS', type: 'story', status: 'In Progress', title: 'Alert routing', storyPoints: 8, sprintExternalId: '201', assigneeLogin: 'kchan', assigneeName: 'Ken Chan', createdAt: days(-4) },
    // Backlog (forecast input)
    { id: 'st_pay_2301', externalKey: 'PAY-2301', projectKey: 'PAY', type: 'story', status: 'To Do', title: 'Backlog: 3DS support', storyPoints: 8, epicKey: 'PAY-100', createdAt: days(-9) },
    { id: 'st_pay_2302', externalKey: 'PAY-2302', projectKey: 'PAY', type: 'story', status: 'To Do', title: 'Backlog: payout batching', storyPoints: 5, epicKey: 'PAY-100', createdAt: days(-9) },
  ];
  for (const i of items) {
    const { id, externalKey, createdAt, ...fields } = i;
    await prisma.story.upsert({
      where: { tenantId_externalKey: { tenantId: TENANT_ID, externalKey } },
      create: {
        id,
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        externalKey,
        releases: [],
        ...fields,
        ...(createdAt ? { createdAt } : {}),
      },
      update: { ...fields },
    });
  }

  // ---- PRs: linked (per story) + one orphan; open + merged states ----
  type Pr = {
    id: string;
    repo: string;
    number: string;
    title: string;
    state: 'open' | 'merged';
    openedAt: Date;
    mergedAt?: Date;
    author: string;
    storyId?: string; // creates a correlation edge when set
  };
  const prs: Pr[] = [
    { id: 'pr_4501', repo: REPO_PAY, number: '4501', title: 'PAY-2210 capture retries', state: 'merged', openedAt: days(-18), mergedAt: days(-17), author: 'jdoe', storyId: 'st_pay_2210' },
    { id: 'pr_4502', repo: REPO_PAY, number: '4502', title: 'PAY-2211 refund api', state: 'merged', openedAt: days(-17), mergedAt: days(-15), author: 'asmith', storyId: 'st_pay_2211' },
    { id: 'pr_4503', repo: REPO_PAY, number: '4503', title: 'PAY-2212 fix double charge', state: 'merged', openedAt: days(-15), mergedAt: days(-14), author: 'jdoe', storyId: 'st_pay_2212' },
    { id: 'pr_4521', repo: REPO_PAY, number: '4521', title: 'PAY-2231 idempotent capture', state: 'open', openedAt: days(-2), author: 'jdoe', storyId: 'st_pay_2231' },
    { id: 'pr_4522', repo: REPO_PAY, number: '4522', title: 'PAY-2232 webhook receipts', state: 'merged', openedAt: days(-3), mergedAt: days(-1), author: 'asmith', storyId: 'st_pay_2232' },
    { id: 'pr_88', repo: REPO_WEB, number: '88', title: 'OPS-1 deploy tool', state: 'merged', openedAt: days(-3), mergedAt: days(-1), author: 'kchan', storyId: 'st_ops_1' },
    // Orphan: no Jira key → GitHub→Jira traceability gap
    { id: 'pr_90', repo: REPO_WEB, number: '90', title: 'chore: tidy logging', state: 'merged', openedAt: days(-2), mergedAt: days(-1), author: 'kchan' },
  ];
  for (const pr of prs) {
    await prisma.pullRequest.upsert({
      where: {
        tenantId_repoFullName_externalNumber: {
          tenantId: TENANT_ID,
          repoFullName: pr.repo,
          externalNumber: pr.number,
        },
      },
      create: {
        id: pr.id,
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        repoFullName: pr.repo,
        externalNumber: pr.number,
        title: pr.title,
        branch: `f/${pr.title.split(' ')[0]}`,
        baseBranch: 'main',
        state: pr.state,
        authorLogin: pr.author,
        additions: 120,
        deletions: 30,
        changedFiles: 4,
        commitMessages: [pr.title],
        openedAt: pr.openedAt,
        mergedAt: pr.mergedAt ?? null,
      },
      update: { state: pr.state, mergedAt: pr.mergedAt ?? null },
    });
    if (pr.storyId) {
      const linkId = `link_${pr.id}`;
      await prisma.correlationLink.upsert({
        where: { id: linkId },
        create: {
          id: linkId,
          tenantId: TENANT_ID,
          edgeType: 'pr_implements_story',
          fromType: 'pull_request',
          fromId: `${pr.repo}#${pr.number}`,
          toType: 'story',
          toId: pr.storyId,
          confidence: 0.95,
          method: 'regex',
          evidence: { seed: true },
        },
        update: {},
      });
    }
  }

  // ---- Commits: GitHub-style activity (today / this week / this month) ----
  const hours = (n: number) => new Date(now - n * 3_600_000);
  type C = {
    sha: string;
    repo: string;
    msg: string;
    author: string;
    name: string;
    at: Date;
    add: number;
    del: number;
    files: number;
  };
  const commits: C[] = [
    // Today — payments hot
    { sha: 'a1f2c3d4e5f60789a1f2c3d4e5f60789a1f2c3d4', repo: REPO_PAY, msg: 'PAY-2231 idempotency guard', author: 'jdoe', name: 'Jane Doe', at: hours(2), add: 120, del: 30, files: 4 },
    { sha: 'b2e3d4c5f6a70891b2e3d4c5f6a70891b2e3d4c5', repo: REPO_PAY, msg: 'PAY-2231 retry backoff', author: 'jdoe', name: 'Jane Doe', at: hours(5), add: 80, del: 12, files: 3 },
    { sha: 'c3d4e5f6a7b80912c3d4e5f6a7b80912c3d4e5f6', repo: REPO_PAY, msg: 'PAY-2234 retry unit tests', author: 'asmith', name: 'Alex Smith', at: hours(7), add: 210, del: 5, files: 6 },
    { sha: 'd4e5f6a7b8c90123d4e5f6a7b8c90123d4e5f6a7', repo: REPO_WEB, msg: 'OPS-2 alert routing wip', author: 'kchan', name: 'Ken Chan', at: hours(3), add: 60, del: 20, files: 2 },
    // This week
    { sha: 'e5f6a7b8c9d01234e5f6a7b8c9d01234e5f6a7b8', repo: REPO_PAY, msg: 'PAY-2232 webhook receipts', author: 'asmith', name: 'Alex Smith', at: days(-2), add: 150, del: 40, files: 5 },
    { sha: 'f6a7b8c9d0e12345f6a7b8c9d0e12345f6a7b8c9', repo: REPO_PAY, msg: 'PAY-2232 receipt storage', author: 'asmith', name: 'Alex Smith', at: days(-3), add: 95, del: 15, files: 3 },
    { sha: 'a7b8c9d0e1f23456a7b8c9d0e1f23456a7b8c9d0', repo: REPO_WEB, msg: 'OPS-1 deploy tool cli', author: 'kchan', name: 'Ken Chan', at: days(-2), add: 300, del: 80, files: 9 },
    { sha: 'b8c9d0e1f2a34567b8c9d0e1f2a34567b8c9d0e1', repo: REPO_WEB, msg: 'chore: tidy logging', author: 'kchan', name: 'Ken Chan', at: days(-1), add: 25, del: 60, files: 3 },
    // Earlier this month
    { sha: 'c9d0e1f2a3b45678c9d0e1f2a3b45678c9d0e1f2', repo: REPO_PAY, msg: 'PAY-2210 capture retries', author: 'jdoe', name: 'Jane Doe', at: days(-17), add: 220, del: 45, files: 7 },
    { sha: 'd0e1f2a3b4c56789d0e1f2a3b4c56789d0e1f2a3', repo: REPO_PAY, msg: 'PAY-2211 refund api', author: 'asmith', name: 'Alex Smith', at: days(-16), add: 340, del: 110, files: 11 },
    { sha: 'e1f2a3b4c5d67890e1f2a3b4c5d67890e1f2a3b4', repo: REPO_PAY, msg: 'PAY-2212 fix double charge', author: 'jdoe', name: 'Jane Doe', at: days(-14), add: 40, del: 22, files: 2 },
  ];
  for (const c of commits) {
    await prisma.commit.upsert({
      where: {
        tenantId_repoFullName_sha: {
          tenantId: TENANT_ID,
          repoFullName: c.repo,
          sha: c.sha,
        },
      },
      create: {
        id: `commit_${c.sha.slice(0, 8)}`,
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        repoFullName: c.repo,
        sha: c.sha,
        message: c.msg,
        authorLogin: c.author,
        authorName: c.name,
        authorEmail: `${c.author}@acme.dev`,
        authoredAt: c.at,
        additions: c.add,
        deletions: c.del,
        filesChanged: c.files,
      },
      update: { authoredAt: c.at, additions: c.add, deletions: c.del },
    });
  }

  /* eslint-disable no-console */
  console.log('Seeded detailing dataset:');
  console.log(`  login          = ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log('  projects       = PAY, OPS · epic PAY-100');
  console.log('  sprints        = PAY 101(closed) 102(active), OPS 201(active)');
  console.log('  releases       = payments-v1.2(released), payments-v1.3');
  console.log(`  work items     = ${items.length} (story/bug/task/subtask/epic)`);
  console.log(`  pull requests  = ${prs.length} (1 orphan for traceability)`);
  /* eslint-enable no-console */
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
