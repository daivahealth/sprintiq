import { Role } from '../../common/auth/role.enum';
import { dashboardAssignments } from './insights.controller';

describe('dashboardAssignments', () => {
  const nav = dashboardAssignments([Role.DEVELOPER]);

  it('leads with the two primary boards, in order, with no group', () => {
    expect(nav.slice(0, 2).map((d) => d.key)).toEqual([
      'developer-activity',
      'sprint-health',
    ]);
    expect(nav.slice(0, 2).every((d) => !('group' in d))).toBe(true);
  });

  it('puts every other board, Delivery Explorer included, in the Later group', () => {
    const later = nav.slice(2);
    expect(later.map((d) => d.key)).toEqual([
      'delivery',
      'sprint-risk',
      'velocity',
      'forecast',
      'productivity',
      'efficiency',
      'flow',
      'project-activity',
      'top-repos',
    ]);
    expect(later.every((d) => d.group === 'later')).toBe(true);
  });

  it('moves Delivery Explorer off `/` without changing its role-assignment key', () => {
    const delivery = nav.find((d) => d.key === 'delivery');
    expect(delivery?.path).toBe('/delivery-explorer');
    expect(nav.some((d) => d.path === '/')).toBe(false);
  });

  it('omits `children` where there are none', () => {
    expect(nav.find((d) => d.key === 'sprint-health')).not.toHaveProperty(
      'children',
    );
    expect(nav[0].children?.length).toBe(4);
  });

  it('shows nothing to a user with no roles', () => {
    expect(dashboardAssignments([])).toEqual([]);
  });
});
