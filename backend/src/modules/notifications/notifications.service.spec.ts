import { NotificationsService } from './notifications.service';

/**
 * The configured secret ref is deliberately NOT equal to the config field key
 * ('teamsWebhookRef'). `ConfigurationsService` lets an admin name the ref
 * anything; `secretRefs.teamsWebhookRef` holds whatever name they chose. A
 * double where the ref equals the field key would let
 * `runNoCommitDigest` pass the literal field key straight to
 * `postAdaptiveCard` and still pass every test below — that bug shipped once
 * already. Keeping them visibly different, and asserting on the resolved
 * value, is what catches a regression back to the field key.
 */
const TEAMS_WEBHOOK_REF = 'TEAMS_DIGEST_WEBHOOK';

const detection = {
  reportedDay: '2026-09-17',
  rosterCount: 66,
  evaluation: {
    flagged: [{ developer: 'bob_athma', displayName: 'Bob Bose' }],
    unresolved: [],
    incomplete: [],
    suppressed: [],
  },
  withhold: null,
  collectedThroughAt: new Date('2026-09-18T04:00:00.000Z'),
};

function build(overrides: { detect?: unknown; existing?: unknown } = {}) {
  const detector = {
    detect: jest.fn().mockResolvedValue(overrides.detect ?? detection),
  };
  const teams = { postAdaptiveCard: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    noCommitDigestRun: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    tenantConfiguration: {
      findUnique: jest.fn().mockResolvedValue({
        values: { dailyDigestEnabled: true },
        secretRefs: { teamsWebhookRef: TEAMS_WEBHOOK_REF },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    trackedDeveloper: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const service = new NotificationsService(
    prisma as never,
    detector as never,
    teams as never,
    audit as never,
  );
  return { service, detector, teams, audit, prisma };
}

describe('NotificationsService.runNoCommitDigest', () => {
  it('posts the card and records the run as sent', async () => {
    const { service, teams, prisma } = build();

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent');
    expect(prisma.noCommitDigestRun.upsert).toHaveBeenCalled();
  });

  it('resolves the ref from secretRefs.teamsWebhookRef, not the config field key', async () => {
    // CORRECTION 1: 'teamsWebhookRef' is the config field key, not the ref
    // name. Passing the literal field key to postAdaptiveCard is the bug
    // this test guards against.
    const { service, teams, prisma } = build();

    await service.runNoCommitDigest('tenant_a');

    expect(prisma.tenantConfiguration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_namespace_key: {
            tenantId: 'tenant_a',
            namespace: 'notifications',
            key: 'default',
          },
        },
      }),
    );
    expect(teams.postAdaptiveCard).toHaveBeenCalledWith(
      'tenant_a',
      TEAMS_WEBHOOK_REF,
      expect.any(Object),
    );
  });

  it('writes an audit entry for the outbound notification', async () => {
    // CLAUDE.md requires every outbound notification to be audit-logged.
    const { service, audit } = build();

    await service.runNoCommitDigest('tenant_a');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_a',
        actorType: 'system',
        action: 'notification.no_commit_digest.sent',
      }),
    );
  });

  it('posts an all-clear when nobody is flagged', async () => {
    // Silence cannot be distinguished from a dead cron.
    const { service, teams } = build({
      detect: {
        ...detection,
        evaluation: { ...detection.evaluation, flagged: [] },
      },
    });

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent_all_clear');
  });

  it('posts the withheld reason and names nobody when a gate fires', async () => {
    const { service, teams, audit } = build({
      detect: {
        ...detection,
        withhold: {
          outcome: 'withheld_stale_data',
          detail: 'Collection is behind. Names withheld.',
        },
      },
    });

    const result = await service.runNoCommitDigest('tenant_a');

    expect(result.outcome).toBe('withheld_stale_data');
    const card = JSON.stringify(teams.postAdaptiveCard.mock.calls[0][2]);
    expect(card).toContain('Names withheld');
    expect(card).not.toContain('Bob Bose');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.no_commit_digest.withheld_stale_data',
      }),
    );
  });

  it('sets deliveredAt for a withheld outcome, because a card was still posted', async () => {
    // CORRECTION 2: a card IS posted for the three withheld outcomes — only
    // the names are missing from it. deliveredAt answers "did a card reach
    // the channel", which is true here; `flagged` (a separate field) is what
    // stays empty.
    const { service, prisma } = build({
      detect: {
        ...detection,
        withhold: {
          outcome: 'withheld_stale_data',
          detail: 'Collection is behind. Names withheld.',
        },
      },
    });

    await service.runNoCommitDigest('tenant_a');

    const call = prisma.noCommitDigestRun.upsert.mock.calls[0][0];
    expect(call.create.deliveredAt).toBeInstanceOf(Date);
    expect(call.create.outcome).toBe('withheld_stale_data');
    expect(call.create.flagged).toEqual([]);
  });

  it('posts nothing and writes nothing on a dry run', async () => {
    const { service, teams, prisma } = build();

    const result = await service.runNoCommitDigest('tenant_a', {
      dryRun: true,
    });

    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.upsert).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.flagged).toHaveLength(1);
  });

  it('refuses to re-send a day already sent', async () => {
    // The unique key on (tenantId, reportedDay) is the idempotency guard; a
    // restart or redeploy at 10:30 must not double-post.
    const { service, teams } = build({ existing: { outcome: 'sent' } });

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow(
      /already sent/i,
    );
    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
  });

  it('re-sends a day already sent when forced', async () => {
    const { service, teams } = build({ existing: { outcome: 'sent' } });

    await service.runNoCommitDigest('tenant_a', { force: true });

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
  });

  it('records a failed run when delivery throws, and rethrows', async () => {
    const { service, teams, prisma } = build();
    teams.postAdaptiveCard.mockRejectedValue(new Error('403'));

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow('403');

    const call = prisma.noCommitDigestRun.upsert.mock.calls[0][0];
    expect(call.create.outcome).toBe('failed');
    expect(call.create.deliveredAt).toBeNull();
  });

  it('records a failed run and throws when no webhook ref is configured', async () => {
    // A misconfigured tenant (no ref set on the notifications row) is a
    // failed delivery too, not a silent throw past the run record.
    const { service, teams, prisma } = build();
    prisma.tenantConfiguration.findUnique.mockResolvedValue({
      values: { dailyDigestEnabled: true },
      secretRefs: {},
    });

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow(
      /teamsWebhookRef/,
    );

    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
    const call = prisma.noCommitDigestRun.upsert.mock.calls[0][0];
    expect(call.create.outcome).toBe('failed');
    expect(call.create.deliveredAt).toBeNull();
  });
});

describe('NotificationsService.tenantsToDigest', () => {
  it('includes only tenants with the digest enabled, a webhook ref, and a roster', async () => {
    const { service, prisma } = build();
    prisma.tenantConfiguration.findMany.mockResolvedValue([
      {
        tenantId: 'tenant_enabled',
        values: { dailyDigestEnabled: true },
        secretRefs: { teamsWebhookRef: TEAMS_WEBHOOK_REF },
      },
      {
        tenantId: 'tenant_no_ref',
        values: { dailyDigestEnabled: true },
        secretRefs: {},
      },
      {
        tenantId: 'tenant_disabled',
        values: { dailyDigestEnabled: false },
        secretRefs: { teamsWebhookRef: TEAMS_WEBHOOK_REF },
      },
      {
        tenantId: 'tenant_empty_roster',
        values: { dailyDigestEnabled: true },
        secretRefs: { teamsWebhookRef: TEAMS_WEBHOOK_REF },
      },
    ]);
    prisma.trackedDeveloper.count.mockImplementation(
      async ({ where }: { where: { tenantId: string } }) =>
        where.tenantId === 'tenant_enabled' ? 3 : 0,
    );

    const tenants = await service.tenantsToDigest();

    expect(tenants).toEqual(['tenant_enabled']);
  });
});
