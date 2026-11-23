import { NotFoundException } from '@nestjs/common';
import { Role } from '../../common/auth/role.enum';
import { ROLES_KEY } from '../../common/auth/roles.decorator';
import { InsightsController } from './insights.controller';

/**
 * Efforts names people beside their logged hours, and the decision that
 * permits it (ADR-0014) covers admins only with every view audited — so both
 * are conditions of the feature, pinned here, not details.
 */
describe('InsightsController.sprintEfforts', () => {
  const user = { userId: 'u1', tenantId: 't1', roles: ['admin'] } as never;

  function setup(
    view: unknown = {
      days: ['2026-11-17', '2026-11-18'],
      rows: [{ developer: 'asha' }, { developer: 'bala' }],
    },
  ) {
    const detail = { efforts: jest.fn().mockResolvedValue(view) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new InsightsController(
      {} as never,
      detail as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
    );
    return { controller, detail, audit };
  }

  it('is restricted to the admin role', () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        InsightsController.prototype.sprintEfforts,
      ),
    ).toEqual([Role.ADMIN]);
  });

  it('passes IST day bounds through and audits who was shown', async () => {
    const { controller, detail, audit } = setup();
    await controller.sprintEfforts(
      user,
      '42',
      'ACT,NHC',
      '2026-11-17',
      '2026-11-18',
    );

    expect(detail.efforts).toHaveBeenCalledWith(
      '42',
      ['ACT', 'NHC'],
      new Date('2026-11-16T18:30:00.000Z'),
      new Date('2026-11-18T18:29:59.999Z'),
    );
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 't1',
      actorType: 'user',
      actorId: 'u1',
      action: 'dashboards.sprint_health.efforts.view',
      targetType: 'sprint',
      targetId: '42',
      metadata: {
        projects: ['ACT', 'NHC'],
        from: '2026-11-17',
        to: '2026-11-18',
        shown: ['asha', 'bala'],
      },
    });
  });

  it('404s an unknown sprint, without an audit row for a view that never happened', async () => {
    const { controller, audit } = setup(null);
    await expect(controller.sprintEfforts(user, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
