import { BadRequestException } from '@nestjs/common';
import { Role } from '../../common/auth/role.enum';
import { ROLES_KEY } from '../../common/auth/roles.decorator';
import { previousWorkingDayKey } from '../../common/time';
import { InsightsController } from './insights.controller';

/**
 * The previous-working-day list names people, and the decision that permits
 * it in the app (ADR-0009, 2026-10-19 amendment) covers admins only — so the
 * role restriction is a condition of the feature, not a detail.
 */
describe('InsightsController.previousDayInactive', () => {
  const user = { userId: 'u1', tenantId: 't1', roles: ['admin'] } as never;

  function setup() {
    const noCommit = {
      previousDayView: jest.fn().mockResolvedValue({
        day: 'x',
        outcome: 'named',
        flagged: [{ developer: 'a', displayName: 'A' }],
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
      noCommit as never,
      {} as never,
      audit as never,
    );
    return { controller, noCommit, audit };
  }

  it('is restricted to the admin role', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      InsightsController.prototype.previousDayInactive,
    );
    expect(roles).toEqual([Role.ADMIN]);
  });

  it('defaults to the previous working day and audits the view', async () => {
    const { controller, noCommit, audit } = setup();
    await controller.previousDayInactive(user);
    const day = previousWorkingDayKey();
    expect(noCommit.previousDayView).toHaveBeenCalledWith('t1', day);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorId: 'u1',
        action: 'dashboards.watchlist.previous_day.view',
        targetId: day,
        metadata: { outcome: 'named', flaggedCount: 1 },
      }),
    );
  });

  it('takes an explicit past day', async () => {
    const { controller, noCommit } = setup();
    await controller.previousDayInactive(user, '2026-10-16');
    expect(noCommit.previousDayView).toHaveBeenCalledWith('t1', '2026-10-16');
  });

  it('rejects a malformed or future day', async () => {
    const { controller } = setup();
    await expect(
      controller.previousDayInactive(user, '16-10-2026'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.previousDayInactive(user, '2999-01-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
