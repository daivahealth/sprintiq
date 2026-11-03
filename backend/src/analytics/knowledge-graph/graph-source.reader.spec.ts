import { DeveloperIdentityService } from '../../correlation/developer-identity.service';
import { PrismaService } from '../../database/prisma.service';
import { DeveloperDirectory } from './developer-directory';
import {
  GraphSourceReader,
  isIssueInWindow,
  PR_ISSUE_EDGE,
} from './graph-source.reader';

const SINCE = new Date('2026-08-01T00:00:00Z');

function directory(): DeveloperDirectory {
  return new DeveloperDirectory(
    {
      byLogin: new Map([['asha-gh', 'asha']]),
      byEmail: new Map([['asha@acme.dev', 'asha']]),
      displayNames: new Map([['asha', 'Asha Rao']]),
      excluded: new Set(['svc-deploy']),
    },
    {
      byDeveloper: new Map([['asha', { logins: ['jira-acc-1'], names: [] }]]),
      assignees: { observed: 1, matched: 1, unmatched: 0 },
    },
  );
}

/** A Prisma fake that records every call's arguments. */
function fakePrisma(rows: {
  commits?: unknown[];
  prs?: unknown[];
  reviews?: unknown[];
  links?: unknown[];
  stories?: unknown[];
}) {
  const calls: { model: string; args: { where: Record<string, unknown> } }[] =
    [];
  const model = (name: string, result: unknown[]) => ({
    findMany: jest.fn((args) => {
      calls.push({ model: name, args });
      return Promise.resolve(result);
    }),
    findFirst: jest.fn((args) => {
      calls.push({ model: name, args });
      return Promise.resolve(result[0] ?? null);
    }),
  });
  const prisma = {
    commit: model('commit', rows.commits ?? []),
    pullRequest: model('pullRequest', rows.prs ?? []),
    prReview: model('prReview', rows.reviews ?? []),
    correlationLink: model('correlationLink', rows.links ?? []),
    story: model('story', rows.stories ?? []),
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

const identities = {} as DeveloperIdentityService;

const prRow = {
  id: 'p1',
  repoFullName: 'acme/billing',
  externalNumber: '7',
  title: 'PAY-1 invoices',
  state: 'merged',
  openedAt: new Date('2026-10-01T00:00:00Z'),
  mergedAt: new Date('2026-10-02T00:00:00Z'),
  authorLogin: 'asha-gh',
};
const storyRow = (over: Record<string, unknown>) => ({
  id: 's1',
  externalKey: 'PAY-1',
  title: 'Invoice generation',
  status: 'Done',
  type: 'story',
  assigneeLogin: null,
  assigneeName: null,
  statusCategory: 'indeterminate',
  resolvedAt: null,
  sourceCreatedAt: new Date('2025-01-01T00:00:00Z'),
  ...over,
});

describe('GraphSourceReader', () => {
  it('scopes every query of every read path to the calling tenant', async () => {
    const { prisma, calls } = fakePrisma({
      commits: [],
      prs: [prRow],
      links: [
        {
          fromId: 'acme/billing#7',
          toId: 's1',
          confidence: 0.8,
          method: 'regex',
        },
      ],
      stories: [storyRow({})],
    });
    const reader = new GraphSourceReader(prisma, identities);
    const dir = directory();

    await reader.loadSnapshot('tenant_a', SINCE, dir);
    await reader.findCommit('tenant_a', 'acme/billing', 'abc', SINCE, dir);
    await reader.findPullRequest('tenant_a', 'acme/billing', '7', SINCE, dir);
    await reader.findIssue('tenant_a', 'PAY-1', SINCE, dir);

    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect({ model: call.model, tenantId: call.args.where.tenantId }).toEqual(
        {
          model: call.model,
          tenantId: 'tenant_a',
        },
      );
    }
  });

  it('builds the snapshot through identity resolution, keeping only links to loaded PRs', async () => {
    const { prisma } = fakePrisma({
      commits: [
        {
          id: 'c1',
          repoFullName: 'acme/billing',
          sha: 'abc',
          authoredAt: new Date('2026-10-01T00:00:00Z'),
          parentCount: 1,
          authorLogin: null,
          authorEmail: 'Asha@acme.dev',
        },
        {
          id: 'c2',
          repoFullName: 'acme/billing',
          sha: 'def',
          authoredAt: new Date('2026-10-01T00:00:00Z'),
          parentCount: 1,
          authorLogin: null,
          authorEmail: 'stranger@example.com',
        },
      ],
      prs: [prRow],
      reviews: [
        {
          id: 'r1',
          repoFullName: 'acme/billing',
          externalNumber: '7',
          state: 'approved',
          submittedAt: new Date('2026-10-01T12:00:00Z'),
          isBot: false,
          reviewerLogin: 'ravi-gh',
        },
      ],
      links: [
        {
          fromId: 'acme/billing#7',
          toId: 's1',
          confidence: 0.8,
          method: 'regex',
        },
        // A PR outside the window: its link must not pull the story in.
        {
          fromId: 'acme/billing#1',
          toId: 's9',
          confidence: 0.9,
          method: 'regex',
        },
      ],
      stories: [
        storyRow({}),
        storyRow({
          id: 's2',
          externalKey: 'PAY-2',
          assigneeLogin: 'jira-acc-1',
        }),
        storyRow({
          id: 's3',
          externalKey: 'PAY-3',
          assigneeLogin: 'unknown-acc',
        }),
      ],
    });
    const reader = new GraphSourceReader(prisma, identities);
    const snapshot = await reader.loadSnapshot('tenant_a', SINCE, directory());

    expect(snapshot.commits.map((c) => c.author?.developerId)).toEqual([
      'asha',
      undefined,
    ]);
    const pr = snapshot.pullRequests[0];
    expect(pr.author).toEqual({
      developerId: 'asha',
      displayName: 'Asha Rao',
      excluded: false,
    });
    // An unresolved reviewer login is still an identity (the boards' rule).
    expect(pr.reviews[0].reviewer?.developerId).toBe('ravi-gh');
    expect(pr.issueLinks.map((l) => l.issue.key)).toEqual(['PAY-1']);
    // Assigned-only issues: resolved assignees only; PAY-1 arrives via its PR.
    expect(snapshot.issues.map((i) => i.key)).toEqual(['PAY-2']);
    expect(snapshot.issues[0].assignee?.developerId).toBe('asha');

    const storyQuery = (prisma.story.findMany as jest.Mock).mock.calls[0][0];
    expect(storyQuery.where.OR[0]).toEqual({ id: { in: ['s1'] } });
  });

  it('reads PR-to-issue links only of the correlation edge it projects', async () => {
    const { prisma } = fakePrisma({ prs: [prRow] });
    await new GraphSourceReader(prisma, identities).findPullRequest(
      'tenant_a',
      'acme/billing',
      '7',
      SINCE,
      directory(),
    );
    const linkQuery = (prisma.correlationLink.findMany as jest.Mock).mock
      .calls[0][0];
    expect(linkQuery.where).toEqual({
      tenantId: 'tenant_a',
      edgeType: PR_ISSUE_EDGE,
      fromId: 'acme/billing#7',
    });
  });

  it('treats a commit authored before the window as out of scope', async () => {
    const { prisma } = fakePrisma({
      commits: [
        {
          id: 'c1',
          repoFullName: 'acme/billing',
          sha: 'abc',
          authoredAt: new Date('2026-01-01T00:00:00Z'),
          parentCount: 1,
          authorLogin: 'asha-gh',
          authorEmail: null,
        },
      ],
    });
    const found = await new GraphSourceReader(prisma, identities).findCommit(
      'tenant_a',
      'acme/billing',
      'abc',
      SINCE,
      directory(),
    );
    expect(found).toBeNull();
  });

  it('windows assigned issues by source dates, never by our own updatedAt', async () => {
    const { prisma } = fakePrisma({});
    await new GraphSourceReader(prisma, identities).loadSnapshot(
      'tenant_a',
      SINCE,
      directory(),
    );
    const where = (prisma.story.findMany as jest.Mock).mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('updatedAt');
    expect(where.OR[1].AND[1]).toEqual({
      OR: [
        { statusCategory: null },
        { statusCategory: { not: 'done' } },
        { resolvedAt: { gte: SINCE } },
        { sourceCreatedAt: { gte: SINCE } },
      ],
    });
  });

  it('applies the same issue window to a single row as to the full load', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-10-01T00:00:00Z');
    const row = (statusCategory: string | null, resolvedAt: Date | null) => ({
      statusCategory,
      resolvedAt,
      sourceCreatedAt: old,
    });
    expect(isIssueInWindow(row('indeterminate', null), SINCE)).toBe(true);
    expect(isIssueInWindow(row(null, null), SINCE)).toBe(true);
    expect(isIssueInWindow(row('done', recent), SINCE)).toBe(true);
    expect(isIssueInWindow(row('done', old), SINCE)).toBe(false);
    expect(
      isIssueInWindow(
        { statusCategory: 'done', resolvedAt: old, sourceCreatedAt: recent },
        SINCE,
      ),
    ).toBe(true);
  });

  it('marks admin-excluded identities so the read layer can withhold them', () => {
    const ref = directory().loginAuthor('svc-deploy');
    expect(ref).toMatchObject({ developerId: 'svc-deploy', excluded: true });
  });
});
