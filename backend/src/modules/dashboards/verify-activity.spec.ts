import { BadRequestException } from '@nestjs/common';
import { Role } from '../../common/auth/role.enum';
import { ROLES_KEY } from '../../common/auth/roles.decorator';
import { InsightsController, VERIFY_MAX_DAYS } from './insights.controller';

/**
 * Activity verification spends the tenant's GitHub quota and shows one
 * developer's records in detail, so admin-only and audited are conditions of
 * the feature (docs/features/DASHBOARDS.md §4.4.3), not details.
 */
describe('InsightsController.verifyDeveloperActivity', () => {
  const user = { userId: 'u1', tenantId: 't1', roles: ['admin'] } as never;

  function setup() {
    const verification = {
      verify: jest.fn().mockResolvedValue({
        status: 'discrepancies',
        items: [{ category: 'missing_in_db' }, { category: 'unverifiable' }],
        unverified: [{ kind: 'commits', reason: 'rate_limited' }],
        coverage: { reposScanned: ['acme/api'], durationMs: 42 },
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new InsightsController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      verification as never,
      audit as never,
    );
    return { controller, verification, audit };
  }

  it('is restricted to the admin role', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      InsightsController.prototype.verifyDeveloperActivity,
    );
    expect(roles).toEqual([Role.ADMIN]);
  });

  it('verifies the IST range for the caller’s tenant and audits the run', async () => {
    const { controller, verification, audit } = setup();
    await controller.verifyDeveloperActivity(user, {
      developer: 'dev',
      from: '2026-10-01',
      to: '2026-10-07',
    });

    const [tenantId, developer, from, to, scope] =
      verification.verify.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(developer).toBe('dev');
    // IST day boundaries: 1 Oct 00:00 IST is 30 Sep 18:30 UTC.
    expect((from as Date).toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect((to as Date).toISOString()).toBe('2026-10-07T18:29:59.999Z');
    expect(scope).toBe('active');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorId: 'u1',
        action: 'dashboards.developer_activity.verify',
        targetType: 'developer',
        targetId: 'dev',
        metadata: expect.objectContaining({
          status: 'discrepancies',
          // Unverifiable records are not discrepancies.
          discrepancies: 1,
          unverifiedScopes: 1,
        }),
      }),
    );
  });

  it('rejects a missing developer, a bad scope, a bad date and an over-long range', async () => {
    const { controller, verification } = setup();
    const bad = [
      { from: '2026-10-01', to: '2026-10-07' },
      {
        developer: 'dev',
        from: '2026-10-01',
        to: '2026-10-07',
        scope: 'everything',
      },
      { developer: 'dev', from: '01-10-2026', to: '2026-10-07' },
      { developer: 'dev', from: '2026-10-08', to: '2026-10-07' },
      { developer: 'dev', from: '2026-08-01', to: '2026-10-07' },
      { developer: 'dev', from: '2999-01-01', to: '2999-01-02' },
    ];
    for (const body of bad) {
      await expect(
        controller.verifyDeveloperActivity(user, body),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(verification.verify).not.toHaveBeenCalled();
    expect(VERIFY_MAX_DAYS).toBe(31);
  });
});
