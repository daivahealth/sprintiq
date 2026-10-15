import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { GithubCopilotMetricsClient } from './github-copilot-metrics.client';
import {
  COPILOT_TOKEN_REF_FIELD,
  GithubCopilotUsageSyncService,
  contentHash,
  copilotDaysToFetch,
  reportDayEnvelope,
  seatsEnvelope,
  usageEnvelope,
} from './github-copilot-usage-sync.service';

const NOW = new Date('2026-10-15T04:30:00.000Z');

function record(overrides: Record<string, unknown> = {}) {
  return {
    day: '2026-10-12',
    user_id: 42,
    user_login: 'asha',
    user_initiated_interaction_count: 7,
    code_generation_activity_count: 20,
    code_acceptance_activity_count: 9,
    loc_suggested_to_add_sum: 300,
    loc_suggested_to_delete_sum: 10,
    loc_added_sum: 120,
    loc_deleted_sum: 4,
    used_agent: true,
    used_chat: true,
    used_cli: false,
    used_copilot_cloud_agent: true,
    ai_credits_used: 1.5,
    ...overrides,
  };
}

describe('copilotDaysToFetch', () => {
  it('first run reaches back backfillDays, ending yesterday (UTC)', () => {
    const days = copilotDaysToFetch(null, NOW, 3);
    expect(days).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
  });

  it('re-reads the restatement window behind the cursor', () => {
    // GitHub finalizes a day over ~3 days — the last three ingested days are
    // asked again so a restatement can reach us.
    const days = copilotDaysToFetch('2026-10-12', NOW, 28);
    expect(days).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
  });

  it("never asks before GitHub's first report day", () => {
    const days = copilotDaysToFetch(
      null,
      new Date('2025-10-12T04:30:00.000Z'),
      28,
    );
    expect(days).toEqual(['2025-10-10', '2025-10-11']);
  });

  it('never asks past the one year GitHub keeps', () => {
    const days = copilotDaysToFetch('2025-01-01', NOW, 28);
    expect(days[0]).toBe('2025-10-15');
  });
});

describe('copilot envelopes', () => {
  it('normalizes a record and keys it on its content', () => {
    const env = usageEnvelope('cfg_1', 'acme', '2026-10-12', record(), NOW);
    expect(env).not.toBeNull();
    expect(env!.eventType).toBe('code.copilot.usage.reported');
    expect(env!.idempotencyKey).toBe(
      `github:copilot:acme:2026-10-12:user:42:${contentHash(record())}`,
    );
    expect(env!.data).toMatchObject({
      login: 'asha',
      githubUserId: 42,
      interactions: 7,
      locAdded: 120,
      usedCodingAgent: true,
      aiCreditsUsed: 1.5,
      record: record(),
    });
  });

  it('gives an identical record the same key and a restated one a new key', () => {
    const a = usageEnvelope('c', 'acme', '2026-10-12', record(), NOW)!;
    const reordered = usageEnvelope(
      'c',
      'acme',
      '2026-10-12',
      Object.fromEntries(Object.entries(record()).reverse()),
      new Date('2026-10-16T04:30:00.000Z'),
    )!;
    const restated = usageEnvelope(
      'c',
      'acme',
      '2026-10-12',
      record({ loc_added_sum: 121 }),
      NOW,
    )!;
    expect(reordered.idempotencyKey).toBe(a.idempotencyKey);
    expect(restated.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it('skips a record that names no user', () => {
    expect(
      usageEnvelope('c', 'acme', '2026-10-12', { user_login: 'x' }, NOW),
    ).toBeNull();
  });

  it('report-day marker carries the sorted user list', () => {
    const env = reportDayEnvelope(
      'c',
      'acme',
      '2026-10-12',
      [9, 3],
      ['k1'],
      NOW,
    );
    expect(env.data).toMatchObject({ userCount: 2, githubUserIds: [3, 9] });
  });

  it('seat snapshot drops team-only seats and is stable in order', () => {
    const env = seatsEnvelope(
      'c',
      'acme',
      [
        {
          assignee: { login: 'b', id: 2 },
          last_activity_at: '2026-10-14T10:00:00Z',
        },
        { assignee: null },
        { assignee: { login: 'a', id: 1 } },
      ],
      NOW,
    );
    expect(
      (env.data as { seats: { login: string }[] }).seats.map((s) => s.login),
    ).toEqual(['a', 'b']);
  });
});

describe('GithubCopilotUsageSyncService.syncTenant', () => {
  function setup(opts: {
    config?: unknown;
    cursorDay?: string | null;
    token?: string;
    reports?: Record<string, unknown>;
    files?: Record<string, unknown>;
    seats?: unknown;
  }) {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      tenantConfiguration: {
        findUnique: jest.fn().mockResolvedValue(
          opts.config === undefined
            ? {
                id: 'cfg_1',
                status: 'active',
                values: { organization: 'acme' },
                secretRefs: { [COPILOT_TOKEN_REF_FIELD]: 'COPILOT_TOKEN' },
              }
            : opts.config,
        ),
      },
      githubCopilotSync: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.cursorDay
              ? { lastCompleteDay: new Date(`${opts.cursorDay}T00:00:00Z`) }
              : null,
          ),
        upsert,
      },
    } as unknown as PrismaService;
    const secrets = {
      resolve: jest.fn().mockResolvedValue(opts.token ?? 'tok'),
    } as unknown as SecretsService;
    const getUsersDayReport = jest.fn(
      async (_org: string, day: string) =>
        opts.reports?.[day] ?? { status: 'not_ready' },
    );
    const client = {
      getUsersDayReport,
      downloadReport: jest.fn(async (url: string) => opts.files?.[url]),
      listSeats: jest
        .fn()
        .mockResolvedValue(
          opts.seats ?? { status: 'ok', seats: [], truncated: false },
        ),
    } as unknown as GithubCopilotMetricsClient;
    const ingested: { idempotencyKey: string; eventType: string }[] = [];
    const ingestion = {
      ingest: jest.fn(async (_t: string, env: never) => {
        ingested.push(env);
        return { status: 'accepted', eventId: 'e' };
      }),
    } as unknown as IngestionService;
    const service = new GithubCopilotUsageSyncService(
      prisma,
      secrets,
      client,
      ingestion,
    );
    return { service, upsert, getUsersDayReport, ingested, ingestion };
  }

  const okDay = (day: string) => ({
    status: 'ok',
    links: [`https://copilot-reports.github.com/${day}.ndjson`],
    reportDay: day,
  });
  const file = (...records: unknown[]) => ({
    status: 'ok',
    records,
    malformedLines: 0,
  });

  it('ingests each ready day and stops at the first not-ready one', async () => {
    const { service, ingested, upsert } = setup({
      cursorDay: '2026-10-12',
      reports: {
        '2026-10-10': okDay('2026-10-10'),
        '2026-10-11': okDay('2026-10-11'),
        '2026-10-12': okDay('2026-10-12'),
        // 13th not ready → 14th must not be asked.
      },
      files: {
        'https://copilot-reports.github.com/2026-10-10.ndjson': file(
          record({ day: '2026-10-10' }),
        ),
        'https://copilot-reports.github.com/2026-10-11.ndjson': file(),
        'https://copilot-reports.github.com/2026-10-12.ndjson': file(
          record(),
          record({ user_id: 43, user_login: 'ravi' }),
        ),
      },
    });

    const result = await service.syncTenant('tenant-a', NOW);

    expect(result).toMatchObject({
      status: 'ok',
      daysIngested: 3,
      recordsAccepted: 3,
      lastCompleteDay: '2026-10-12',
      seats: 'ok',
    });
    const types = ingested.map((e) => e.eventType);
    expect(
      types.filter((t) => t === 'code.copilot.report_day.collected'),
    ).toHaveLength(3);
    expect(
      types.filter((t) => t === 'code.copilot.usage.reported'),
    ).toHaveLength(3);
    expect(types).toContain('code.copilot.seats.observed');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_org: { tenantId: 'tenant-a', org: 'acme' } },
        update: expect.objectContaining({
          lastStatus: 'ok',
          lastCompleteDay: new Date('2026-10-12T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('a refusal stops the walk and never moves the cursor forward', async () => {
    const { service, upsert, ingested } = setup({
      cursorDay: '2026-10-12',
      reports: {
        '2026-10-10': { status: 'forbidden', httpStatus: 403 },
      },
    });

    const result = await service.syncTenant('tenant-a', NOW);

    expect(result.status).toBe('forbidden');
    expect(result.error).toMatch(/read:org/);
    expect(result.lastCompleteDay).toBe('2026-10-12');
    expect(
      ingested.filter((e) => e.eventType !== 'code.copilot.seats.observed'),
    ).toHaveLength(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: 'forbidden',
          lastCompleteDay: new Date('2026-10-12T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('does not mark a day collected when one of its files fails to download', async () => {
    const { service, ingested } = setup({
      cursorDay: '2026-10-15',
      reports: {
        '2026-10-13': okDay('2026-10-13'),
        '2026-10-14': {
          ...okDay('2026-10-14'),
          links: [
            'https://copilot-reports.github.com/2026-10-14.ndjson',
            'https://copilot-reports.github.com/2026-10-14-part2.ndjson',
          ],
        },
      },
      files: {
        'https://copilot-reports.github.com/2026-10-13.ndjson': file(record()),
        'https://copilot-reports.github.com/2026-10-14.ndjson': file(record()),
        'https://copilot-reports.github.com/2026-10-14-part2.ndjson': {
          status: 'error',
          reason: 'http_500',
        },
      },
    });

    const result = await service.syncTenant('tenant-a', NOW);

    expect(result.status).toBe('error');
    expect(result.daysIngested).toBe(1);
    const markers = ingested.filter(
      (e) => e.eventType === 'code.copilot.report_day.collected',
    );
    // Only the 13th: the 14th's first file must not be ingested on its own.
    expect(markers).toHaveLength(1);
    expect(
      ingested.filter((e) => e.eventType === 'code.copilot.usage.reported'),
    ).toHaveLength(1);
  });

  it('skips a tenant with no Copilot token ref without calling GitHub', async () => {
    const { service, getUsersDayReport } = setup({
      config: {
        id: 'cfg_1',
        status: 'active',
        values: { organization: 'acme' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      },
    });
    const result = await service.syncTenant('tenant-a', NOW);
    expect(result.status).toBe('not_configured');
    expect(getUsersDayReport).not.toHaveBeenCalled();
  });

  it('records no_token when the ref resolves to nothing', async () => {
    const { service, getUsersDayReport, upsert } = setup({ token: '' });
    const result = await service.syncTenant('tenant-a', NOW);
    expect(result.status).toBe('no_token');
    expect(getUsersDayReport).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
  });

  it('does not ingest a truncated seat list', async () => {
    const { service, ingested } = setup({
      seats: { status: 'ok', seats: [], truncated: true },
    });
    const result = await service.syncTenant('tenant-a', NOW);
    expect(result.seats).toBe('truncated');
    expect(
      ingested.some((e) => e.eventType === 'code.copilot.seats.observed'),
    ).toBe(false);
  });
});
