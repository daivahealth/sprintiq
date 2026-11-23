import { PrismaService } from '../database/prisma.service';
import { DeveloperIdentityService } from './developer-identity.service';

/**
 * `resolveJiraPeople` (ADR-0014): worklog authors and creators resolved with
 * the assignee ladder, read-only — so the assignee coverage other boards
 * publish is unchanged by a page that is not about assignees.
 */
describe('DeveloperIdentityService.resolveJiraPeople', () => {
  function build(
    persisted: unknown[] = [],
    github: unknown[] = [],
    overrides: unknown[] = [],
  ) {
    const findMany = jest.fn(
      async (args: { where: { sourceSystem?: string } }) =>
        args.where.sourceSystem === 'jira' ? persisted : github,
    );
    const prisma = {
      developerIdentity: {
        findMany,
        upsert: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      identityOverride: { findMany: jest.fn().mockResolvedValue(overrides) },
      orphanRecord: { upsert: jest.fn() },
    };
    return {
      prisma,
      service: new DeveloperIdentityService(prisma as unknown as PrismaService),
    };
  }

  it('prefers the persisted assignee resolution, which already carries admin overrides', async () => {
    const { service, prisma } = build([
      {
        sourceKey: 'login:acc-1',
        canonicalDeveloperId: 'asha',
        method: 'admin_override',
        excluded: false,
      },
    ]);
    const out = await service.resolveJiraPeople('tenant-a', [
      { login: 'acc-1', name: 'Asha' },
    ]);
    expect(out.get('login:acc-1')).toEqual({
      developer: 'asha',
      excluded: false,
    });
    expect(
      prisma.developerIdentity.findMany.mock.calls[0][0].where,
    ).toMatchObject({
      tenantId: 'tenant-a',
      sourceSystem: 'jira',
    });
  });

  it('runs anyone else through the same ladder in memory — and writes nothing', async () => {
    const { service, prisma } = build(
      [],
      [{ canonicalDeveloperId: 'asha-rao', email: null }],
    );
    const out = await service.resolveJiraPeople('tenant-a', [
      { login: 'acc-9', name: 'Asha Rao' },
    ]);
    expect(out.get('login:acc-9')).toEqual({
      developer: 'asha-rao',
      excluded: false,
    });
    expect(prisma.developerIdentity.upsert).not.toHaveBeenCalled();
    expect(prisma.developerIdentity.create).not.toHaveBeenCalled();
    expect(prisma.orphanRecord.upsert).not.toHaveBeenCalled();
  });

  it('refuses to guess: an unmatched or ambiguous person resolves to nobody', async () => {
    const { service } = build(
      [
        {
          sourceKey: 'login:acc-x',
          canonicalDeveloperId: 'jira:acc-x',
          method: 'unresolved',
          excluded: false,
        },
      ],
      [
        { canonicalDeveloperId: 'priya.n', email: null },
        { canonicalDeveloperId: 'priya-n', email: null },
      ],
    );
    const out = await service.resolveJiraPeople('tenant-a', [
      { login: 'acc-x', name: 'Someone' },
      { login: 'acc-y', name: 'Priya N' },
    ]);
    expect(out.get('login:acc-x')?.developer).toBeNull();
    expect(out.get('login:acc-y')?.developer).toBeNull();
  });

  it('asks nothing of the database for an empty list', async () => {
    const { service, prisma } = build();
    expect((await service.resolveJiraPeople('tenant-a', [])).size).toBe(0);
    expect(prisma.developerIdentity.findMany).not.toHaveBeenCalled();
  });
});
