import { PrismaService } from '../database/prisma.service';
import { DeveloperIdentityService } from './developer-identity.service';

interface Row {
  authorLogin: string | null;
  authorEmail: string | null;
  authorName: string | null;
}

function prismaStub(
  commitRows: Row[],
  prLogins: string[],
  overrides: Record<string, unknown>[] = [],
) {
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
    identityOverride: {
      findMany: jest.fn(async (args: { where?: { sourceSystem?: string } }) =>
        overrides.filter((o) => o.sourceSystem === args?.where?.sourceSystem),
      ),
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
  overrides: Record<string, unknown>[] = [],
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
    identityOverride: {
      findMany: jest.fn(async (args: { where?: { sourceSystem?: string } }) =>
        overrides.filter((o) => o.sourceSystem === args?.where?.sourceSystem),
      ),
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
        identityOverride: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('never offers automation as a selectable developer', async () => {
    // The picker filtered on `excluded` alone, so a bot stayed selectable
    // unless someone wrote a rule for it. `root` is the case that proves the
    // rule approach cannot work on its own: its identity key is
    // `root@<build-host>`, so a row only ever covers the host it was written
    // for and the next build machine reintroduces it.
    const { prisma } = stubWith([
      ...ROWS,
      {
        sourceSystem: 'github',
        canonicalDeveloperId: 'root',
        sourceKey: 'email:root@some-build-host.example.org',
        sourceLogin: null,
        name: 'root',
        method: 'unresolved',
        excluded: false,
      },
      {
        sourceSystem: 'github',
        canonicalDeveloperId: 'copilot-swe-agent',
        sourceKey: 'login:copilot-swe-agent',
        sourceLogin: 'copilot-swe-agent',
        name: null,
        method: 'github_login',
        excluded: false,
      },
    ]);
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const devs = await service.listDevelopers('t');

    const ids = devs.map((d) => d.canonicalDeveloperId);
    expect(ids).not.toContain('root');
    expect(ids).not.toContain('copilot-swe-agent');
    expect(ids).toContain('dev');
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

describe('DeveloperIdentityService admin overrides', () => {
  it('merges a stray git identity into the developer an admin named', async () => {
    // The production case: `Junaid Haneef` commits from a personal Gmail with
    // no login, no shared address and a name matching no known login, so every
    // evidential rung correctly declines. Only a colleague knows this is
    // `Mohammed-Junaid-Haneef_athma`.
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: 'junaid.mumtaz567@gmail.com',
          authorName: 'Junaid Haneef',
        },
      ],
      ['Mohammed-Junaid-Haneef_athma'],
      [
        {
          sourceSystem: 'github',
          sourceKey: 'email:junaid.mumtaz567@gmail.com',
          action: 'merge',
          canonicalDeveloperId: 'Mohammed-Junaid-Haneef_athma',
          reason: 'personal Gmail on a second laptop',
          setByUserId: 'user_admin',
        },
      ],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveTenant('tenant-a');

    expect(result.overridden).toBe(1);
    expect(
      upserted.find(
        (row) => row.sourceKey === 'email:junaid.mumtaz567@gmail.com',
      ),
    ).toMatchObject({
      canonicalDeveloperId: 'Mohammed-Junaid-Haneef_athma',
      method: 'admin_override',
      excluded: false,
    });
  });

  it('re-derives the merge on a later pass, which is what makes it durable', async () => {
    // Why this lives in resolution rather than in a one-off UPDATE:
    // resolveTenant rebuilds every row from collected commits on each sweep,
    // so a merge applied afterwards is gone within one cycle — and certainly
    // gone once the database is cleared and collection restarts.
    const overrides = [
      {
        sourceSystem: 'github',
        sourceKey: 'email:357486@narayanahealth.org',
        action: 'merge',
        canonicalDeveloperId: 'Saravanakumar-N_athma',
        reason: 'employee number in a work laptop git config',
        setByUserId: 'user_admin',
      },
    ];
    const commits = [
      {
        authorLogin: null,
        authorEmail: '357486@narayanahealth.org',
        authorName: 'saravanakumar_athma',
      },
    ];

    const first = prismaStub(commits, [], overrides);
    await new DeveloperIdentityService(
      first.prisma as unknown as PrismaService,
    ).resolveTenant('tenant-a');

    // A second pass over the same facts: the sweep that would otherwise undo a
    // hand-applied merge.
    const second = prismaStub(commits, [], overrides);
    await new DeveloperIdentityService(
      second.prisma as unknown as PrismaService,
    ).resolveTenant('tenant-a');

    expect(second.upserted[0]).toMatchObject({
      canonicalDeveloperId: 'Saravanakumar-N_athma',
      method: 'admin_override',
    });
    // Identical row-for-row apart from the generated primary key, which is
    // fresh per upsert and says nothing about the conclusion reached.
    const withoutId = (rows: Record<string, unknown>[]) =>
      rows.map(({ id: _id, ...rest }) => rest);
    expect(withoutId(second.upserted)).toEqual(withoutId(first.upserted));
  });

  it('withholds an excluded entity without moving its attribution', async () => {
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: 'kritikajain0209@gmail.com',
          authorName: 'kritika jain',
        },
      ],
      [],
      [
        {
          sourceSystem: 'github',
          sourceKey: 'email:kritikajain0209@gmail.com',
          action: 'exclude',
          canonicalDeveloperId: null,
          reason: 'not a member of this engineering org',
          setByUserId: 'user_admin',
        },
      ],
    );
    const service = new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    );

    const result = await service.resolveTenant('tenant-a');

    expect(result.excluded).toBe(1);
    // Still its own canonical developer, still carrying its email, so commits
    // keep resolving and stay in every repo and LOC total. Only the flag that
    // keeps it out of head-counts is new.
    expect(upserted[0]).toMatchObject({
      canonicalDeveloperId: 'kritika jain',
      excluded: true,
    });
  });

  it('does not queue an excluded entity as an orphan for someone to chase', async () => {
    // An identity a human has ruled on is a settled question, not an open one.
    // Leaving it queued asks a reviewer to re-decide it every sweep.
    const { prisma, orphans } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: 'kritikajain0209@gmail.com',
          authorName: 'kritika jain',
        },
      ],
      [],
      [
        {
          sourceSystem: 'github',
          sourceKey: 'email:kritikajain0209@gmail.com',
          action: 'exclude',
          canonicalDeveloperId: null,
          reason: 'not a member of this engineering org',
          setByUserId: 'user_admin',
        },
      ],
    );

    await new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    ).resolveTenant('tenant-a');

    expect(orphans).toHaveLength(0);
  });

  it('ignores an override written against the other source arm', async () => {
    // A Jira account reference and a GitHub login are different namespaces, so
    // a github-keyed pass must not pick up a jira-keyed statement.
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: 'junaid.mumtaz567@gmail.com',
          authorName: 'Junaid Haneef',
        },
      ],
      [],
      [
        {
          sourceSystem: 'jira',
          sourceKey: 'email:junaid.mumtaz567@gmail.com',
          action: 'merge',
          canonicalDeveloperId: 'Someone-Else_athma',
          reason: 'wrong arm',
          setByUserId: 'user_admin',
        },
      ],
    );

    const result = await new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    ).resolveTenant('tenant-a');

    expect(result.overridden).toBe(0);
    expect(upserted[0]).toMatchObject({
      canonicalDeveloperId: 'Junaid Haneef',
    });
  });

  it('drops an override with an unrecognised action instead of guessing at it', async () => {
    const { prisma, upserted } = prismaStub(
      [
        {
          authorLogin: null,
          authorEmail: 'junaid.mumtaz567@gmail.com',
          authorName: 'Junaid Haneef',
        },
      ],
      [],
      [
        {
          sourceSystem: 'github',
          sourceKey: 'email:junaid.mumtaz567@gmail.com',
          action: 'merrge',
          canonicalDeveloperId: 'Mohammed-Junaid-Haneef_athma',
          reason: 'typo in the verb',
          setByUserId: 'user_admin',
        },
      ],
    );

    const result = await new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    ).resolveTenant('tenant-a');

    expect(result.overridden).toBe(0);
    expect(upserted[0]).toMatchObject({
      canonicalDeveloperId: 'Junaid Haneef',
    });
  });

  it('bridges a Jira-only assignee an admin pointed at a developer', async () => {
    const { prisma, upserted } = jiraPrismaStub(
      [{ assigneeLogin: '63a93194', assigneeName: 'Pavankumar M' }],
      ['Some-Other-Dev_athma'],
      [
        {
          sourceSystem: 'jira',
          sourceKey: 'login:63a93194',
          action: 'merge',
          canonicalDeveloperId: '366296',
          reason: 'commits under an employee number',
          setByUserId: 'user_admin',
        },
      ],
    );

    const result = await new DeveloperIdentityService(
      prisma as unknown as PrismaService,
    ).resolveJiraAssignees('tenant-a');

    expect(result.overridden).toBe(1);
    expect(upserted[0]).toMatchObject({
      canonicalDeveloperId: '366296',
      method: 'admin_override',
    });
  });
});
