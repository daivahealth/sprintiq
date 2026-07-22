import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { SecretsService } from './secrets.service';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64'); // deterministic 32-byte key for tests

// `null` means "no key configured" — distinct from the default so it isn't
// swallowed by default-parameter substitution the way `build(undefined)` would be.
function build(encryptionKey: string | null = VALID_KEY) {
  const store = new Map<string, { id: string; ciphertext: string }>();
  const prisma = {
    tenantSecret: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.tenantId_ref.tenantId}:${where.tenantId_ref.ref}`;
        const existing = store.get(key);
        const row = existing
          ? { ...existing, ciphertext: update.ciphertext }
          : { id: create.id, ciphertext: create.ciphertext };
        store.set(key, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where, select }: any) => {
        const key = `${where.tenantId_ref.tenantId}:${where.tenantId_ref.ref}`;
        const row = store.get(key);
        if (!row) return null;
        return select ? { id: row.id } : row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        store.delete(`${where.tenantId}:${where.ref}`);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const configService = {
    get: jest.fn().mockReturnValue(encryptionKey ?? undefined),
  } as unknown as ConfigService;
  return { svc: new SecretsService(prisma, configService), prisma };
}

describe('SecretsService', () => {
  it('round-trips a secret through encryption', async () => {
    const { svc } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'ghp_supersecret');
    const value = await svc.resolve('tenant-a', 'GITHUB_TOKEN');
    expect(value).toBe('ghp_supersecret');
  });

  it('never stores the plaintext value in the row it persists', async () => {
    const { svc, prisma } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'ghp_supersecret');
    const [args] = (prisma.tenantSecret.upsert as jest.Mock).mock.calls[0];
    expect(JSON.stringify(args)).not.toContain('ghp_supersecret');
  });

  it('isolates secrets per tenant even under the same ref name', async () => {
    const { svc } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'secret-for-a');
    await svc.setSecret('tenant-b', 'GITHUB_TOKEN', 'secret-for-b');
    expect(await svc.resolve('tenant-a', 'GITHUB_TOKEN')).toBe('secret-for-a');
    expect(await svc.resolve('tenant-b', 'GITHUB_TOKEN')).toBe('secret-for-b');
  });

  it('falls back to process.env when no DB row exists', async () => {
    process.env.SOME_ENV_TOKEN = 'from-env';
    const { svc } = build();
    expect(await svc.resolve('tenant-a', 'SOME_ENV_TOKEN')).toBe('from-env');
    delete process.env.SOME_ENV_TOKEN;
  });

  it('DB value takes precedence over an env var of the same name', async () => {
    process.env.GITHUB_TOKEN = 'from-env';
    const { svc } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'from-db');
    expect(await svc.resolve('tenant-a', 'GITHUB_TOKEN')).toBe('from-db');
    delete process.env.GITHUB_TOKEN;
  });

  it('deleteSecret() reverts resolution back to the env var', async () => {
    process.env.GITHUB_TOKEN = 'from-env';
    const { svc } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'from-db');
    await svc.deleteSecret('tenant-a', 'GITHUB_TOKEN');
    expect(await svc.resolve('tenant-a', 'GITHUB_TOKEN')).toBe('from-env');
    delete process.env.GITHUB_TOKEN;
  });

  it('hasSecret() reflects whether a DB-stored value exists', async () => {
    const { svc } = build();
    expect(await svc.hasSecret('tenant-a', 'GITHUB_TOKEN')).toBe(false);
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'value');
    expect(await svc.hasSecret('tenant-a', 'GITHUB_TOKEN')).toBe(true);
  });

  it('isEnabled() is false without a configured key', () => {
    const { svc } = build(null);
    expect(svc.isEnabled()).toBe(false);
  });

  it('isEnabled() is false when the key is the wrong length', () => {
    const { svc } = build(Buffer.alloc(16).toString('base64'));
    expect(svc.isEnabled()).toBe(false);
  });

  it('setSecret() throws a clear error when no key is configured', async () => {
    const { svc } = build(null);
    await expect(
      svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'x'),
    ).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('resolve() degrades to an empty string (not a throw) if the key changed since encryption', async () => {
    const { svc, prisma } = build();
    await svc.setSecret('tenant-a', 'GITHUB_TOKEN', 'value');

    // Same stored row, but a service instance configured with a different key
    // (simulating a botched key rotation) can no longer decrypt it.
    const rotatedConfig = {
      get: jest.fn().mockReturnValue(Buffer.alloc(32, 9).toString('base64')),
    } as unknown as ConfigService;
    const svcAfterRotation = new SecretsService(prisma, rotatedConfig);

    await expect(
      svcAfterRotation.resolve('tenant-a', 'GITHUB_TOKEN'),
    ).resolves.toBe('');
  });
});
