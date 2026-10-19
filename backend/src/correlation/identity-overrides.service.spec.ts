import { BadRequestException } from '@nestjs/common';
import {
  IdentityOverridesService,
  normalizeName,
} from './identity-overrides.service';

type Row = {
  canonicalDeveloperId: string;
  sourceKey: string;
  sourceLogin: string | null;
  name: string | null;
  excluded?: boolean;
  sourceSystem?: string;
};

function setup(seed: Row[]) {
  const rows = seed.map((r) => ({
    sourceSystem: 'github',
    excluded: false,
    ...r,
  }));
  const match = (
    r: Row & Record<string, unknown>,
    where: Record<string, unknown>,
  ) => Object.entries(where).every(([k, v]) => k === 'tenantId' || r[k] === v);
  const prisma = {
    developerIdentity: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => match(r, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => match(r, where)),
      ),
    },
    identityOverride: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const identities = { resolveTenant: jest.fn().mockResolvedValue({}) };
  const svc = new IdentityOverridesService(
    prisma as never,
    identities as never,
  );
  return { svc, prisma, identities };
}

const shubham: Row[] = [
  {
    canonicalDeveloperId: 'SHUBHAM_JAIN',
    sourceKey: 'login:SHUBHAM_JAIN',
    sourceLogin: 'SHUBHAM_JAIN',
    name: 'SHUBHAM JAIN',
  },
  {
    canonicalDeveloperId: 'Shubham Jain',
    sourceKey: 'email:sj@gmail.com',
    sourceLogin: null,
    name: 'Shubham Jain',
  },
  {
    canonicalDeveloperId: 'rocksolid911',
    sourceKey: 'login:rocksolid911',
    sourceLogin: 'rocksolid911',
    name: 'Siddhant Saraf',
  },
  {
    canonicalDeveloperId: 'Siddhant-Saraf_athma',
    sourceKey: 'login:Siddhant-Saraf_athma',
    sourceLogin: 'Siddhant-Saraf_athma',
    name: null,
  },
  {
    canonicalDeveloperId: 'bot',
    sourceKey: 'login:bot',
    sourceLogin: 'bot',
    name: 'Shubham Jain',
    excluded: true,
  },
  {
    canonicalDeveloperId: '366296',
    sourceKey: 'email:366296@x.org',
    sourceLogin: null,
    name: '366296',
  },
  {
    canonicalDeveloperId: 'Rakesh-R_athma',
    sourceKey: 'login:Rakesh-R_athma',
    sourceLogin: 'Rakesh-R_athma',
    name: null,
  },
];

describe('IdentityOverridesService', () => {
  it('normalises names to letters only', () => {
    expect(normalizeName('SHUBHAM_JAIN')).toBe('shubhamjain');
    expect(normalizeName('Shubham Jain')).toBe('shubhamjain');
    expect(normalizeName('366296')).toBe('');
  });

  it('suggests developers whose names match, never excluded entities or digit-only names', async () => {
    const { svc } = setup(shubham);
    const groups = await svc.possibleDuplicates('t1');
    expect(
      groups.map((g) => g.members.map((m) => m.canonicalDeveloperId)),
    ).toEqual([
      ['SHUBHAM_JAIN', 'Shubham Jain'],
      ['Siddhant-Saraf_athma', 'rocksolid911'],
    ]);
    const siddhant = groups[1].members.find(
      (m) => m.canonicalDeveloperId === 'rocksolid911',
    );
    expect(siddhant).toMatchObject({
      sourceKeys: ['login:rocksolid911'],
      hasLogin: true,
    });
  });

  it('records a merge with who and why, then re-resolves the tenant at once', async () => {
    const { svc, prisma, identities } = setup(shubham);
    await svc.set('t1', 'u1', {
      sourceSystem: 'github',
      sourceKey: 'login:rocksolid911',
      action: 'merge',
      canonicalDeveloperId: 'Siddhant-Saraf_athma',
      reason: 'personal account of Siddhant Saraf',
    });
    expect(prisma.identityOverride.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_sourceSystem_sourceKey: {
            tenantId: 't1',
            sourceSystem: 'github',
            sourceKey: 'login:rocksolid911',
          },
        },
        update: {
          action: 'merge',
          canonicalDeveloperId: 'Siddhant-Saraf_athma',
          reason: 'personal account of Siddhant Saraf',
          setByUserId: 'u1',
        },
      }),
    );
    expect(identities.resolveTenant).toHaveBeenCalledWith('t1');
  });

  it.each([
    [{ action: 'delete' }, /action/],
    [{ reason: 'x' }, /reason/],
    [{ sourceKey: 'login:nobody' }, /No github identity/],
    [{ canonicalDeveloperId: undefined }, /needs canonicalDeveloperId/],
    [{ canonicalDeveloperId: 'rocksolid911' }, /already belongs/],
    [{ canonicalDeveloperId: 'ghost' }, /No developer ghost/],
    [{ canonicalDeveloperId: 'bot' }, /excluded entity/],
  ])('refuses an invalid override %#', async (over, message) => {
    const { svc, prisma } = setup(shubham);
    await expect(
      svc.set('t1', 'u1', {
        sourceSystem: 'github',
        sourceKey: 'login:rocksolid911',
        action: 'merge',
        canonicalDeveloperId: 'Siddhant-Saraf_athma',
        reason: 'personal account',
        ...(over as object),
      }),
    ).rejects.toThrow(message);
    expect(prisma.identityOverride.upsert).not.toHaveBeenCalled();
  });

  it('merges every identity of one developer into another', async () => {
    const { svc, prisma } = setup(shubham);
    const r = await svc.mergeDeveloper(
      't1',
      'u1',
      'Shubham Jain',
      'SHUBHAM_JAIN',
      'same person, personal email',
    );
    expect(r).toEqual({
      merged: 1,
      from: 'Shubham Jain',
      into: 'SHUBHAM_JAIN',
    });
    expect(prisma.identityOverride.upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses to merge a developer with no GitHub identities', async () => {
    const { svc } = setup(shubham);
    await expect(
      svc.mergeDeveloper('t1', 'u1', 'nobody', 'SHUBHAM_JAIN', 'reason here'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes an override and re-resolves; reports when there was none', async () => {
    const { svc, prisma, identities } = setup(shubham);
    expect(await svc.remove('t1', 'github', 'login:rocksolid911')).toBe(true);
    expect(identities.resolveTenant).toHaveBeenCalledWith('t1');
    prisma.identityOverride.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.remove('t1', 'github', 'login:x')).toBe(false);
  });
});
