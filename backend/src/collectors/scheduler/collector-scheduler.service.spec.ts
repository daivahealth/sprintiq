import { Connection } from '@prisma/client';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { CollectorRegistry } from '../framework/collector.registry';
import { SourceCollector } from '../framework/source-collector';
import { IngestionService } from '../ingestion/ingestion.service';
import { CollectorSchedulerService } from './collector-scheduler.service';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    tenantId: 'tenant-a',
    sourceSystem: 'github',
    name: 'acme/payments',
    config: {},
    secretRef: null,
    webhookSecretRef: null,
    syncCursors: {},
    rateLimitState: {},
    status: 'active',
    lastSyncAt: null,
    syncLagSeconds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

describe('CollectorSchedulerService', () => {
  let connections: jest.Mocked<ConnectionsService>;
  let registry: jest.Mocked<CollectorRegistry>;
  let ingestion: jest.Mocked<IngestionService>;
  let tenantContext: TenantContextService;
  let collector: jest.Mocked<SourceCollector>;
  let service: CollectorSchedulerService;

  beforeEach(() => {
    collector = {
      source: 'github',
      normalizeWebhook: jest.fn(),
      poll: jest.fn().mockResolvedValue([]),
    };
    connections = {
      listActive: jest.fn().mockResolvedValue([]),
      touchSync: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    registry = {
      get: jest.fn().mockReturnValue(collector),
    } as unknown as jest.Mocked<CollectorRegistry>;
    ingestion = {
      ingest: jest
        .fn()
        .mockResolvedValue({ status: 'accepted', eventId: 'e1' }),
    } as unknown as jest.Mocked<IngestionService>;
    tenantContext = new TenantContextService();
    service = new CollectorSchedulerService(
      connections,
      registry,
      ingestion,
      tenantContext,
    );
  });

  it('ingests every envelope a collector returns, under that connection tenant context', async () => {
    connections.listActive.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue([
      {
        schemaVersion: '1.0',
        eventId: 'e1',
        idempotencyKey: 'k1',
        sourceSystem: 'github',
        connectionId: 'conn_1',
        collectionMode: 'backfill',
        eventType: 't',
        occurredAt: 'now',
        collectedAt: 'now',
        externalRefs: {},
        data: {},
      },
    ]);
    let observedTenantDuringIngest: string | undefined;
    ingestion.ingest.mockImplementation(async (tenantId) => {
      observedTenantDuringIngest = tenantId;
      return { status: 'accepted', eventId: 'e1' };
    });

    await service.syncAll();

    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(observedTenantDuringIngest).toBe('tenant-a');
    expect(connections.touchSync).toHaveBeenCalledWith('conn_1');
  });

  it('skips a connection whose source has no registered collector', async () => {
    connections.listActive.mockResolvedValue([
      connection({ sourceSystem: 'gitlab' }),
    ]);
    registry.get.mockReturnValue(undefined);

    await service.syncAll();

    expect(collector.poll).not.toHaveBeenCalled();
  });

  it("isolates one connection's failure — the sweep still processes the rest", async () => {
    connections.listActive.mockResolvedValue([
      connection({ id: 'bad' }),
      connection({ id: 'good' }),
    ]);
    collector.poll
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    await expect(service.syncAll()).resolves.toBeUndefined();

    expect(collector.poll).toHaveBeenCalledTimes(2);
    expect(connections.touchSync).toHaveBeenCalledWith('good');
    expect(connections.touchSync).not.toHaveBeenCalledWith('bad');
  });
});
