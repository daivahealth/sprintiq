import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuditSink } from '../../common/audit/audit-sink';
import { SecretsService } from '../../common/secrets/secrets.service';
import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from '../connections/connections.service';
import { ConfigurationsService } from './configurations.service';

describe('ConfigurationsService', () => {
  function build(existing: unknown = null) {
    const prisma = {
      tenantConfiguration: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest.fn(),
      },
    } as unknown as PrismaService;
    const audit: AuditSink = { record: jest.fn().mockResolvedValue(undefined) };
    const connections = {
      findByTenantSourceAndName: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'conn_1' }),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      setStatus: jest.fn().mockResolvedValue(undefined),
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    const secrets = {
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
      hasSecret: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<SecretsService>;
    return {
      svc: new ConfigurationsService(prisma, connections, secrets, audit),
      prisma,
      audit,
      connections,
      secrets,
    };
  }

  it('lists configurations only for the caller tenant', async () => {
    const { svc, prisma } = build();
    (prisma.tenantConfiguration.findMany as jest.Mock).mockResolvedValue([]);

    await svc.listTenantConfigurations('tenant-a');

    expect(
      prisma.tenantConfiguration.findMany as jest.Mock,
    ).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    });
  });

  it('upserts a valid tenant namespace/key configuration and records an audit entry', async () => {
    const { svc, prisma, audit } = build(null);
    (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
      id: 'cfg_1',
      namespace: 'llm',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await svc.upsertTenantConfiguration(
      'tenant-a',
      {
        namespace: 'llm',
        key: 'default',
        values: { provider: 'openai', defaultModel: 'gpt' },
        secretRefs: { apiKeyRef: 'LLM_API_KEY' },
        status: 'active',
      },
      { actorId: 'user-1' },
    );

    expect(prisma.tenantConfiguration.upsert as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_namespace_key: {
            tenantId: 'tenant-a',
            namespace: 'llm',
            key: 'default',
          },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-a',
          namespace: 'llm',
          key: 'default',
          values: { provider: 'openai', defaultModel: 'gpt' },
          secretRefs: { apiKeyRef: 'LLM_API_KEY' },
          status: 'active',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorId: 'user-1',
        action: 'configuration.created',
        metadata: expect.objectContaining({
          namespace: 'llm',
          changedValueKeys: expect.arrayContaining([
            'provider',
            'defaultModel',
          ]),
          changedSecretRefKeys: ['apiKeyRef'],
        }),
      }),
    );
  });

  it('rejects unsupported namespaces', async () => {
    const { svc } = build();

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'unsupported',
        values: {},
      }),
    ).rejects.toThrow('Unsupported configuration namespace.');
  });

  it('rejects a secret-ref value that looks like a raw token or URL', async () => {
    const { svc } = build(null);

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'llm',
        values: { provider: 'openai', defaultModel: 'gpt' },
        secretRefs: { apiKeyRef: 'sk-live-abc123' },
        status: 'active',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects missing required fields when saving as active', async () => {
    const { svc } = build(null);

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: {},
        secretRefs: {},
        status: 'active',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows an incomplete draft to be saved as disabled', async () => {
    const { svc, prisma } = build(null);
    (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
      id: 'cfg_2',
      namespace: 'github',
      updatedAt: new Date(),
    });

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme' },
        secretRefs: {},
        status: 'disabled',
      }),
    ).resolves.toMatchObject({ id: 'cfg_2' });
  });

  it('rejects unknown fields not present in the catalog', async () => {
    const { svc } = build(null);

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'metrics',
        values: { notARealField: 1 },
        status: 'disabled',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a save when the client baseline is stale (optimistic concurrency)', async () => {
    const { svc } = build({
      id: 'cfg_3',
      values: {},
      secretRefs: {},
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'metrics',
        values: { defaultWindowDays: 30 },
        status: 'disabled',
        expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(ConflictException);
  });

  describe('bridging github/jira config to a real Connection (BC-0)', () => {
    it('creates a Connection once organization+defaultRepo+tokenRef are complete and active', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock)
        .mockResolvedValueOnce(null) // during syncConnection: no existing bridge row yet
        .mockResolvedValueOnce({
          id: 'conn_gh',
          status: 'active',
          lastSyncAt: null,
          syncLagSeconds: 0,
        }); // during attachConnectionSummary: now exists

      const result = await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      expect(connections.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({
          sourceSystem: 'github',
          config: { repoFullName: 'acme/payments' },
          secretRef: 'GITHUB_TOKEN',
        }),
      );
      expect(result.connection).toEqual(
        expect.objectContaining({ linked: true, status: 'active' }),
      );
    });

    it('does not create a connection when defaultRepo is missing, and reports linked:false', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });

      const result = await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'disabled',
      });

      expect(connections.create).not.toHaveBeenCalled();
      expect(result.connection).toEqual({ linked: false });
    });

    it('updates (never duplicates) the existing bridge connection on a later save', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_jira',
        namespace: 'jira',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'conn_jira',
        status: 'active',
        lastSyncAt: null,
        syncLagSeconds: 0,
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'jira',
        values: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
        },
        secretRefs: { apiTokenRef: 'JIRA_API_TOKEN' },
        status: 'active',
      });

      expect(connections.create).not.toHaveBeenCalled();
      expect(connections.updateConfig).toHaveBeenCalledWith(
        'conn_jira',
        expect.objectContaining({
          config: {
            siteUrl: 'https://acme.atlassian.net',
            email: 'admin@acme.com',
            projectKey: undefined,
          },
          secretRef: 'JIRA_API_TOKEN',
          status: 'active',
        }),
      );
    });

    it('disables the existing connection when the config is saved as disabled', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'conn_gh',
        status: 'active',
        lastSyncAt: null,
        syncLagSeconds: 0,
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'disabled',
      });

      expect(connections.updateConfig).toHaveBeenCalledWith(
        'conn_gh',
        expect.objectContaining({ status: 'disabled' }),
      );
    });

    it('computes backfillSince from backfillDays on first creation', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });

      const before = Date.now();
      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: {
          organization: 'acme',
          defaultRepo: 'payments',
          backfillDays: 30,
        },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      const [, input] = (connections.create as jest.Mock).mock.calls[0] as [
        string,
        { config: { backfillSince: string } },
      ];
      const gotMs = new Date(input.config.backfillSince).getTime();
      expect(gotMs).toBeLessThanOrEqual(
        before - 30 * 24 * 60 * 60 * 1000 + 1000,
      );
      expect(gotMs).toBeGreaterThanOrEqual(
        before - 30 * 24 * 60 * 60 * 1000 - 1000,
      );
    });

    it('re-resolves backfillSince and resets cursors when backfillDays changes', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'conn_gh',
        status: 'active',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        syncLagSeconds: 0,
        config: {
          repoFullName: 'acme/payments',
          backfillDays: 30,
          backfillSince: '2026-06-01T00:00:00.000Z',
        },
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: {
          organization: 'acme',
          defaultRepo: 'payments',
          backfillDays: 365,
        },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      const [, input] = (connections.updateConfig as jest.Mock).mock
        .calls[0] as [string, { config: { backfillSince: string } }];
      expect(input.config.backfillSince).not.toBe('2026-06-01T00:00:00.000Z');
      expect(connections.setSyncCursors).toHaveBeenCalledWith('conn_gh', {});
    });

    it('preserves backfillSince and does not reset cursors on an unrelated re-save', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'conn_gh',
        status: 'active',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        syncLagSeconds: 0,
        config: {
          repoFullName: 'acme/payments',
          backfillDays: 30,
          backfillSince: '2026-06-01T00:00:00.000Z',
        },
      });

      // Same repo, same backfillDays — only the (unrelated) webhookSecretRef changes.
      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: {
          organization: 'acme',
          defaultRepo: 'payments',
          backfillDays: 30,
        },
        secretRefs: {
          tokenRef: 'GITHUB_TOKEN',
          webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
        },
        status: 'active',
      });

      const [, input] = (connections.updateConfig as jest.Mock).mock
        .calls[0] as [string, { config: { backfillSince: string } }];
      expect(input.config.backfillSince).toBe('2026-06-01T00:00:00.000Z');
      expect(connections.setSyncCursors).not.toHaveBeenCalled();
    });

    it('resets cursors when the target repo changes, even if backfillDays is unchanged', async () => {
      const { svc, prisma, connections } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });
      (connections.findByTenantSourceAndName as jest.Mock).mockResolvedValue({
        id: 'conn_gh',
        status: 'active',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        syncLagSeconds: 0,
        config: {
          repoFullName: 'acme/payments',
          backfillSince: '2026-06-01T00:00:00.000Z',
        },
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'web' }, // different repo
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      expect(connections.setSyncCursors).toHaveBeenCalledWith('conn_gh', {});
    });
  });

  describe('secret values (encrypted DB store, admin can paste a real token)', () => {
    it('stores a pasted secret value under the ref name and reports it in the audit trail', async () => {
      const { svc, prisma, secrets, audit } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        secretValues: { tokenRef: 'ghp_realtoken123' },
        status: 'active',
      });

      expect(secrets.setSecret).toHaveBeenCalledWith(
        'tenant-a',
        'GITHUB_TOKEN',
        'ghp_realtoken123',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ secretValuesSet: ['tokenRef'] }),
        }),
      );
      // The raw value must never appear anywhere in the audit payload.
      const auditCall = (audit.record as jest.Mock).mock.calls[0][0];
      expect(JSON.stringify(auditCall)).not.toContain('ghp_realtoken123');
    });

    it('rejects a pasted value when no ref name is set for that field', async () => {
      const { svc } = build(null);

      await expect(
        svc.upsertTenantConfiguration('tenant-a', {
          namespace: 'github',
          values: { organization: 'acme', defaultRepo: 'payments' },
          secretRefs: {},
          secretValues: { tokenRef: 'ghp_realtoken123' },
          status: 'disabled',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('clearSecrets deletes the stored value and reports it in the audit trail', async () => {
      const { svc, prisma, secrets, audit } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        clearSecrets: ['tokenRef'],
        status: 'active',
      });

      expect(secrets.deleteSecret).toHaveBeenCalledWith(
        'tenant-a',
        'GITHUB_TOKEN',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            secretValuesCleared: ['tokenRef'],
          }),
        }),
      );
    });

    it('leaves a stored secret untouched when the save omits that field entirely', async () => {
      const { svc, prisma, secrets } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        updatedAt: new Date(),
      });

      await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      expect(secrets.setSecret).not.toHaveBeenCalled();
      expect(secrets.deleteSecret).not.toHaveBeenCalled();
    });

    it('reports secretsConfigured per field in the response, reflecting the encrypted store', async () => {
      const { svc, prisma, secrets } = build(null);
      (prisma.tenantConfiguration.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg_gh',
        namespace: 'github',
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        updatedAt: new Date(),
      });
      (secrets.hasSecret as jest.Mock).mockImplementation(
        async (_tenantId: string, ref: string) => ref === 'GITHUB_TOKEN',
      );

      const result = await svc.upsertTenantConfiguration('tenant-a', {
        namespace: 'github',
        values: { organization: 'acme', defaultRepo: 'payments' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
        status: 'active',
      });

      expect(result.secretsConfigured).toMatchObject({
        tokenRef: true,
        webhookSecretRef: false,
      });
    });
  });
});
