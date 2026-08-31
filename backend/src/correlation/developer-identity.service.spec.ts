import { PrismaService } from '../database/prisma.service';
import { DeveloperIdentityService } from './developer-identity.service';

interface Row {
  authorLogin: string | null;
  authorEmail: string | null;
  authorName: string | null;
}

function prismaStub(commitRows: Row[], prLogins: string[]) {
  const upserted: Record<string, unknown>[] = [];
  const orphans: Record<string, unknown>[] = [];
  const prisma = {
    commit: {
      groupBy: jest.fn().mockResolvedValue(commitRows),
      count: jest.fn().mockResolvedValue(0),
    },
    pullRequest: {
      groupBy: jest
        .fn()
        .mockResolvedValue(prLogins.map((authorLogin) => ({ authorLogin }))),
    },
    developerIdentity: {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
        upserted.push(args.create);
        return args.create;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orphan: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        orphans.push(args.data);
        return args.data;
      }),
    },
  };
  return { prisma, upserted, orphans };
}

describe('DeveloperIdentityService.resolveTenant', () => {
  it('reunites a person whose commits carry no login with their PR account', async () => {
    // The production case: `Sangeetha-S_athma` opened PRs (so GitHub knows the
    // account) but commits under an unverified corporate address, so every
    // commit arrived with authorLogin null and Engineering Activity read zero.
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: '372281@example.org',
          authorName: 'sangeethas',
        },
      ],
      ['Sangeetha-S_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveTenant('tenant-a');

    expect(result.recovered).toBe(1);
    const recovered = upserted.find(
      (row) => row.sourceKey === 'email:372281@example.org',
    );
    expect(recovered).toMatchObject({
      canonicalDeveloperId: 'Sangeetha-S_athma',
      method: 'name_normalized',
    });
  });

  it('records evidence for every link, so an attribution can be explained', async () => {
    const { prisma, upserted } = prismaStub(
      [{ authorLogin: null, authorEmail: 'a@x.io', authorName: 'sangeethas' }],
      ['Sangeetha-S_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    await service.resolveTenant('tenant-a');

    expect(
      upserted.find((r) => r.sourceKey === 'email:a@x.io')?.evidence,
    ).toMatchObject({ matchedLogin: 'Sangeetha-S_athma' });
  });

  it('queues an ambiguous name as an orphan instead of crediting a coin flip', async () => {
    const { prisma, upserted, orphans } = prismaStub(
      [{ authorLogin: null, authorEmail: 'x@x.io', authorName: 'Jo Bloggs' }],
      ['Jo-Bloggs_acme', 'JoBloggs'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveTenant('tenant-a');

    expect(result.ambiguous).toBe(1);
    expect(orphans[0]).toMatchObject({
      nodeType: 'developer_identity',
      reason: 'ambiguous_identity',
    });
    // Critically: nothing was written attributing this commit to either of them.
    expect(
      upserted.find((r) => r.sourceKey === 'email:x@x.io'),
    ).toBeUndefined();
  });

  it('does not merge people who happen to share a machine email', async () => {
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: 'bot-user',
          authorEmail: 'noreply@github.com',
          authorName: 'Bot',
        },
        {
          authorLogin: null,
          authorEmail: 'noreply@github.com',
          authorName: 'Someone Unknown',
        },
      ],
      [],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    await service.resolveTenant('tenant-a');

    const unknown = upserted.find((r) => r.name === 'Someone Unknown');
    expect(unknown?.canonicalDeveloperId).not.toBe('bot-user');
    expect(unknown?.method).toBe('unresolved');
  });

  it('gives an unresolved identity a readable id and still counts it', async () => {
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: '357486@example.org',
          authorName: 'saravanakumar_athma',
        },
      ],
      [],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveTenant('tenant-a');

    expect(result.unresolved).toBe(1);
    expect(upserted[0]).toMatchObject({
      canonicalDeveloperId: 'saravanakumar_athma',
      method: 'unresolved',
      confidence: 0,
    });
  });
});

describe('DeveloperIdentityService.attributionIndex', () => {
  it('maps every known login and email to its canonical developer, with a display name', async () => {
    const { prisma } = prismaStub([], []);
    prisma.developerIdentity.findMany.mockResolvedValue([
      {
        canonicalDeveloperId: 'Sangeetha-S_athma',
        sourceLogin: 'Sangeetha-S_athma',
        email: null,
        name: null,
      },
      {
        canonicalDeveloperId: 'Sangeetha-S_athma',
        sourceLogin: null,
        email: '372281@Example.org',
        name: 'Sangeetha S',
      },
    ]);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const index = await service.attributionIndex('tenant-a');

    // Both halves of one person point at the same canonical id — this is the
    // bulk counterpart of aliasesFor, for reads that bucket EVERY commit.
    expect(index.byLogin.get('Sangeetha-S_athma')).toBe('Sangeetha-S_athma');
    expect(index.byEmail.get('372281@example.org')).toBe('Sangeetha-S_athma');
    // Rendered through the display ladder, not the raw login: the same human
    // used to read as `Sangeetha-S_athma` here and `Sangeetha S` in Jira.
    expect(index.displayNames.get('Sangeetha-S_athma')).toBe('Sangeetha S');
  });

  it('prefers the login as display name, falling back to the recorded name', async () => {
    const { prisma } = prismaStub([], []);
    prisma.developerIdentity.findMany.mockResolvedValue([
      {
        canonicalDeveloperId: 'ravi kumar',
        sourceLogin: null,
        email: 'ravi@example.org',
        name: 'Ravi Kumar',
      },
    ]);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const index = await service.attributionIndex('tenant-a');

    expect(index.displayNames.get('ravi kumar')).toBe('Ravi Kumar');
  });
});

describe('DeveloperIdentityService.aliasesFor', () => {
  it('returns every login and email the developer works under', async () => {
    const { prisma } = prismaStub([], []);
    prisma.developerIdentity.findMany.mockResolvedValue([
      { sourceLogin: 'Sangeetha-S_athma', email: null },
      { sourceLogin: null, email: '372281@Example.org' },
    ]);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const aliases = await service.aliasesFor('tenant-a', 'Sangeetha-S_athma');

    expect(aliases.logins).toEqual(['Sangeetha-S_athma']);
    expect(aliases.emails).toEqual(['372281@example.org']);
  });

  it('falls back to the requested id when nothing is resolved yet', async () => {
    // Before the first resolution pass the table is empty. An empty alias set
    // would widen "this developer's commits" into "every commit"; falling back
    // to the id reproduces exactly the pre-resolution behaviour instead.
    const { prisma } = prismaStub([], []);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const aliases = await service.aliasesFor('tenant-a', 'jdoe');

    expect(aliases).toMatchObject({ logins: ['jdoe'], emails: [] });
  });
});

function jiraPrismaStub(
  assignees: { assigneeLogin: string | null; assigneeName: string | null }[],
  canonicalDeveloperIds: string[],
) {
  const upserted: Record<string, unknown>[] = [];
  const orphans: Record<string, unknown>[] = [];
  const prisma = {
    story: { groupBy: jest.fn().mockResolvedValue(assignees) },
    developerIdentity: {
      findMany: jest.fn().mockResolvedValue(
        canonicalDeveloperIds.map((canonicalDeveloperId) => ({
          canonicalDeveloperId,
        })),
      ),
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
        upserted.push(args.create);
        return args.create;
      }),
    },
    orphan: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        orphans.push(args.data);
        return args.data;
      }),
    },
  };
  return { prisma, upserted, orphans };
}

describe('DeveloperIdentityService.resolveJiraAssignees', () => {
  it('bridges a Jira assignee to the developer of the same name', async () => {
    const { prisma, upserted } = jiraPrismaStub(
      [{ assigneeLogin: '5b10a2', assigneeName: 'Priya Iyer' }],
      ['Priya-Iyer_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveJiraAssignees('tenant-a');

    expect(result).toMatchObject({ observed: 1, matched: 1, unmatched: 0 });
    expect(upserted[0]).toMatchObject({
      sourceSystem: 'jira',
      sourceKey: 'login:5b10a2',
      canonicalDeveloperId: 'Priya-Iyer_athma',
    });
  });

  it('writes Jira rows under their own sourceSystem, never github', async () => {
    // The corruption guard. These rows share a table with commit attribution;
    // filed under `github` they would enter AttributionIndex.byLogin and a
    // Jira accountId would start matching commits.
    const { prisma, upserted } = jiraPrismaStub(
      [{ assigneeLogin: '5b10a2', assigneeName: 'Priya Iyer' }],
      ['Priya-Iyer_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    await service.resolveJiraAssignees('tenant-a');

    expect(upserted.every((row) => row.sourceSystem === 'jira')).toBe(true);
  });

  it('counts an unmatched assignee rather than dropping or guessing it', async () => {
    // This count is the Watchlist's denominator: without it, "no assigned
    // work" cannot be told apart from "we never matched this person".
    const { prisma, upserted, orphans } = jiraPrismaStub(
      [{ assigneeLogin: '5b10a2', assigneeName: 'Nobody Known' }],
      ['Priya-Iyer_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveJiraAssignees('tenant-a');

    expect(result).toMatchObject({ observed: 1, matched: 0, unmatched: 1 });
    expect(upserted[0]).toMatchObject({ canonicalDeveloperId: 'jira:5b10a2' });
    expect(orphans[0]).toMatchObject({ reason: 'unresolved_identity' });
  });

  it('records ambiguity as an orphan instead of assigning someones tickets to another', async () => {
    const { prisma, upserted, orphans } = jiraPrismaStub(
      [{ assigneeLogin: null, assigneeName: 'Priya Iyer' }],
      ['Priya-Iyer', 'priya.iyer'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveJiraAssignees('tenant-a');

    expect(result).toMatchObject({ ambiguous: 1, matched: 0 });
    expect(upserted).toHaveLength(0);
    expect(orphans[0]).toMatchObject({ reason: 'ambiguous_identity' });
  });

  it('collapses two spellings of one assignee into a single row', async () => {
    const { prisma, upserted } = jiraPrismaStub(
      [
        { assigneeLogin: null, assigneeName: 'Priya Iyer' },
        { assigneeLogin: null, assigneeName: 'priya.iyer' },
      ],
      ['Priya-Iyer_athma'],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveJiraAssignees('tenant-a');

    expect(result.observed).toBe(1);
    expect(upserted).toHaveLength(1);
  });
});

describe('DeveloperIdentityService read scoping', () => {
  /**
   * These reads answer "whose commit is this". A Jira account reference must
   * never be a candidate answer — it would enter `AttributionIndex.byLogin`,
   * which commit attribution is looked up in, and would widen `aliasesFor`
   * with an identifier git has never seen.
   *
   * Asserted as an invariant about the RESULT rather than by counting queries:
   * `attributionIndex` deliberately reads Jira rows now, for display names
   * only, so a "every findMany is github-scoped" check would fail on a change
   * that is entirely safe.
   */
  function stubWith(rows: Record<string, unknown>[]) {
    const findMany = jest.fn(
      async (args: { where?: { sourceSystem?: string } }) =>
        rows.filter((r) => r.sourceSystem === args?.where?.sourceSystem),
    );
    return {
      prisma: {
        developerIdentity: { findMany },
        commit: {
          groupBy: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      },
      findMany,
    };
  }

  const ROWS = [
    {
      sourceSystem: 'github',
      canonicalDeveloperId: 'dev',
      sourceLogin: 'dev-login',
      email: 'dev@corp.example',
      name: 'Dev',
      sourceKey: 'login:dev-login',
      method: 'github_login',
    },
    {
      // Same table, different source. Must never reach commit attribution.
      sourceSystem: 'jira',
      canonicalDeveloperId: 'dev',
      sourceLogin: '5b10a2ffffffffffffffffff',
      email: null,
      name: 'Dev From Jira',
      sourceKey: 'login:5b10a2ffffffffffffffffff',
      method: 'name_normalized',
    },
  ];

  it('keeps a Jira account reference out of commit attribution', async () => {
    const { prisma } = stubWith(ROWS);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const index = await service.attributionIndex('t');

    expect(index.byLogin.get('dev-login')).toBe('dev');
    expect(index.byLogin.has('5b10a2ffffffffffffffffff')).toBe(false);
    // The Jira row IS read — for the display name, which is its whole purpose.
    expect(index.displayNames.get('dev')).toBe('Dev From Jira');
  });

  it('never widens a developer alias set with a Jira identifier', async () => {
    const { prisma } = stubWith(ROWS);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const aliases = await service.aliasesFor('t', 'dev');

    expect(aliases.logins).toEqual(['dev-login']);
    expect(aliases.logins).not.toContain('5b10a2ffffffffffffffffff');
  });

  it('does not offer a Jira-only person in the developer picker', async () => {
    const { prisma } = stubWith(ROWS);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const devs = await service.listDevelopers('t');

    // One entity, named from Jira but sourced from GitHub activity.
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({
      canonicalDeveloperId: 'dev',
      displayName: 'Dev From Jira',
    });
  });

  it('scopes the attribution-coverage read to github identities', async () => {
    const { prisma, findMany } = stubWith(ROWS);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    await service.attributionCoverage('t', new Date(0), new Date());

    expect(findMany).toHaveBeenCalled();
    for (const call of findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ sourceSystem: 'github' });
    }
  });
});
