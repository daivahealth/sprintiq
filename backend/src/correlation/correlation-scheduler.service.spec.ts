import { PrismaService } from '../database/prisma.service';
import { CorrelationSchedulerService } from './correlation-scheduler.service';
import { CorrelationService } from './correlation.service';
import { DeveloperIdentityService } from './developer-identity.service';

describe('CorrelationSchedulerService', () => {
  let correlation: jest.Mocked<CorrelationService>;
  let identities: jest.Mocked<DeveloperIdentityService>;
  let prisma: { tenant: { findMany: jest.Mock } };
  let service: CorrelationSchedulerService;

  beforeEach(() => {
    correlation = {
      reconcileOrphans: jest
        .fn()
        .mockResolvedValue({ candidates: 0, resolved: 0, stillOrphaned: 0 }),
    } as unknown as jest.Mocked<CorrelationService>;
    identities = {
      resolveTenant: jest.fn().mockResolvedValue({
        observed: 0,
        resolved: 0,
        recovered: 0,
        unresolved: 0,
        ambiguous: 0,
      }),
      resolveJiraAssignees: jest.fn().mockResolvedValue({
        observed: 0,
        matched: 0,
        unmatched: 0,
        ambiguous: 0,
      }),
    } as unknown as jest.Mocked<DeveloperIdentityService>;
    prisma = { tenant: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new CorrelationSchedulerService(
      correlation,
      identities,
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

  it('resolves Jira assignees after the GitHub pass, per tenant', async () => {
    // Order is load-bearing: the Jira arm matches against the canonical ids
    // the GitHub pass mints, so running it first would match against an empty
    // roster and record every assignee as unmatched — which the Watchlist
    // would then publish as a collapsed match rate.
    prisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }]);

    await service.sweep();

    expect(identities.resolveJiraAssignees).toHaveBeenCalledWith('tenant-a');
    const githubCall = identities.resolveTenant.mock.invocationCallOrder[0];
    const jiraCall =
      identities.resolveJiraAssignees.mock.invocationCallOrder[0];
    expect(jiraCall).toBeGreaterThan(githubCall);
  });

  it('skips the Jira pass when the GitHub pass failed, rather than matching against a stale roster', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }]);
    identities.resolveTenant.mockRejectedValueOnce(new Error('boom'));

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(identities.resolveJiraAssignees).not.toHaveBeenCalled();
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
