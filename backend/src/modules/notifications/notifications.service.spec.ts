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

/** Duck-typed Prisma unique-violation, matching what `isUniqueConstraintViolation` checks for. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

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
  unattributedCommits: 0,
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
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
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
    // Claimed via `create` (no existing row), delivery confirmed via `update`.
    expect(prisma.noCommitDigestRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.noCommitDigestRun.update).toHaveBeenCalledTimes(1);
  });

  it('claims the row with a `create` BEFORE posting to Teams, not after', async () => {
    // The idempotency guarantee lives entirely in this ordering: if the claim
    // happened after the POST, two racers could both read "no row" and both
    // post before either one writes anything.
    const { service, teams, prisma } = build();
    const callOrder: string[] = [];
    prisma.noCommitDigestRun.create.mockImplementation(async () => {
      callOrder.push('create');
      return {};
    });
    teams.postAdaptiveCard.mockImplementation(async () => {
      callOrder.push('post');
    });

    await service.runNoCommitDigest('tenant_a');

    expect(callOrder).toEqual(['create', 'post']);
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

  it('carries unattributedCommits from detection through to the persisted run row and the card', async () => {
    // The value this task exists to disclose must actually reach the row a
    // reader would open to answer "why was I on the list" — and the card a
    // channel reader sees. A regression here would silently strand the count
    // in `DigestDetection` without ever being recorded or shown.
    const { service, teams, prisma } = build({
      detect: { ...detection, unattributedCommits: 4 },
    });

    await service.runNoCommitDigest('tenant_a');

    const claimCall = prisma.noCommitDigestRun.create.mock.calls[0][0];
    expect(claimCall.data.unattributedCommits).toBe(4);
    const card = JSON.stringify(teams.postAdaptiveCard.mock.calls[0][2]);
    expect(card).toContain('4 commits');
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
    // CORRECTION 2: a card IS posted for the withheld outcomes — only
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

    const claimCall = prisma.noCommitDigestRun.create.mock.calls[0][0];
    expect(claimCall.data.outcome).toBe('withheld_stale_data');
    expect(claimCall.data.flagged).toEqual([]);
    expect(claimCall.data.deliveredAt).toBeNull();
    // The final update (after a successful POST) is what actually sets it.
    const finalUpdateCall =
      prisma.noCommitDigestRun.update.mock.calls[
        prisma.noCommitDigestRun.update.mock.calls.length - 1
      ][0];
    expect(finalUpdateCall.data.deliveredAt).toBeInstanceOf(Date);
  });

  it('posts nothing and writes nothing on a dry run', async () => {
    const { service, teams, prisma } = build();

    const result = await service.runNoCommitDigest('tenant_a', {
      dryRun: true,
    });

    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.create).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.update).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.flagged).toHaveLength(1);
  });

  it('returns unattributedCommits on a dry run, before any card is posted', async () => {
    // The dry run is the rollout step a human uses to reconcile the list
    // against the Activity Overview board BEFORE a name ever reaches a
    // channel — exactly the moment the counter-evidence must be visible.
    // Disclosing it only on the posted card, and not here, would put it
    // everywhere except the one place it is actually acted on.
    const { service } = build({
      detect: { ...detection, unattributedCommits: 7 },
    });

    const result = await service.runNoCommitDigest('tenant_a', {
      dryRun: true,
    });

    expect(result.unattributedCommits).toBe(7);
  });

  it('refuses to re-send a day already sent', async () => {
    const { service, teams } = build({ existing: { outcome: 'sent' } });

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow(
      /already sent/i,
    );
    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
  });

  it('re-sends a day already sent when forced, via update rather than create', async () => {
    const { service, teams, prisma } = build({ existing: { outcome: 'sent' } });

    await service.runNoCommitDigest('tenant_a', { force: true });

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    // A row already exists for this day — `create` would only ever lose this
    // race, so the deliberate-overwrite path goes straight to `update`.
    expect(prisma.noCommitDigestRun.create).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.update).toHaveBeenCalled();
  });

  it('re-runs a previously failed day normally, without force, via update', async () => {
    // api/README.md §8.1: "A day that is failed or one of the withheld_*
    // outcomes may be re-run normally... without force". A row already
    // exists (non-delivered), so this is not a race — it goes to `update`.
    const { service, teams, prisma } = build({
      existing: { outcome: 'failed' },
    });

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('sent');
    expect(prisma.noCommitDigestRun.create).not.toHaveBeenCalled();
    expect(prisma.noCommitDigestRun.update).toHaveBeenCalled();
  });

  it('loses the race when a concurrent runner claims the day first, and returns without posting', async () => {
    // The core fix: two runners racing a FRESH day (no existing row) both
    // read "no row yet". Only one `create` can win; the loser must not post.
    const { service, teams, prisma } = build();
    prisma.noCommitDigestRun.create.mockRejectedValue(uniqueViolation());

    const result = await service.runNoCommitDigest('tenant_a');

    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
    expect(result.outcome).toBe('sent');
    expect(result.dryRun).toBe(false);
    // No update either — this runner does not own the row it lost.
    expect(prisma.noCommitDigestRun.update).not.toHaveBeenCalled();
  });

  it('propagates a non-unique-violation error from the claim rather than swallowing it', async () => {
    const { service, teams, prisma } = build();
    prisma.noCommitDigestRun.create.mockRejectedValue(
      new Error('connection reset'),
    );

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow(
      'connection reset',
    );
    expect(teams.postAdaptiveCard).not.toHaveBeenCalled();
  });

  it('records a failed run when delivery throws, and rethrows', async () => {
    const { service, teams, prisma } = build();
    teams.postAdaptiveCard.mockRejectedValue(new Error('403'));

    await expect(service.runNoCommitDigest('tenant_a')).rejects.toThrow('403');

    // Claimed first...
    expect(prisma.noCommitDigestRun.create).toHaveBeenCalledTimes(1);
    // ...then updated to `failed` after the POST rejected.
    const finalUpdateCall =
      prisma.noCommitDigestRun.update.mock.calls[
        prisma.noCommitDigestRun.update.mock.calls.length - 1
      ][0];
    expect(finalUpdateCall.data.outcome).toBe('failed');
    expect(finalUpdateCall.data.deliveredAt).toBeNull();
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
    const finalUpdateCall =
      prisma.noCommitDigestRun.update.mock.calls[
        prisma.noCommitDigestRun.update.mock.calls.length - 1
      ][0];
    expect(finalUpdateCall.data.outcome).toBe('failed');
    expect(finalUpdateCall.data.deliveredAt).toBeNull();
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
