import { PrismaService } from '../database/prisma.service';
import { CorrelationSchedulerService } from './correlation-scheduler.service';
import { CorrelationService } from './correlation.service';

describe('CorrelationSchedulerService', () => {
  let correlation: jest.Mocked<CorrelationService>;
  let prisma: { tenant: { findMany: jest.Mock } };
  let service: CorrelationSchedulerService;

  beforeEach(() => {
    correlation = {
      reconcileOrphans: jest
        .fn()
        .mockResolvedValue({ candidates: 0, resolved: 0, stillOrphaned: 0 }),
    } as unknown as jest.Mocked<CorrelationService>;
    prisma = { tenant: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new CorrelationSchedulerService(
      correlation,
      prisma as unknown as PrismaService,
    );
  });

  it('sweeps every tenant separately — never one cross-tenant pass', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);

    await service.sweep();

    expect(correlation.reconcileOrphans).toHaveBeenCalledTimes(2);
    expect(correlation.reconcileOrphans).toHaveBeenCalledWith('tenant-a');
    expect(correlation.reconcileOrphans).toHaveBeenCalledWith('tenant-b');
  });

  it("one tenant's failure does not abort the sweep for the rest", async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);
    correlation.reconcileOrphans.mockRejectedValueOnce(new Error('boom'));

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(correlation.reconcileOrphans).toHaveBeenCalledWith('tenant-b');
  });
});
