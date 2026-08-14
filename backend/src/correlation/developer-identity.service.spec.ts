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
    // commit arrived with authorLogin null and Developer Activity read zero.
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
    expect(index.displayNames.get('Sangeetha-S_athma')).toBe(
      'Sangeetha-S_athma',
    );
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
