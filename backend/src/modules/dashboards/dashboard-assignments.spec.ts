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
    expect(nav.find((d) => d.key === 'velocity')).not.toHaveProperty(
      'children',
    );
    expect(nav[0].children?.length).toBe(4);
  });

  it('omits `children` when the role leaves only one — Sprint Health for non-admins', () => {
    // Efforts is admin-only (ADR-0014). A lone "Board" sub-item would add a
    // nav row that says nothing, so the entry renders exactly as before.
    expect(nav.find((d) => d.key === 'sprint-health')).not.toHaveProperty(
      'children',
    );
  });

  it('shows the Sprint Health Efforts subpage to admins only', () => {
    const sprintHealth = dashboardAssignments([Role.ADMIN]).find(
      (d) => d.key === 'sprint-health',
    );
    expect(sprintHealth?.children?.map((c) => c.path)).toEqual([
      '/sprint-health',
      '/sprint-health/efforts',
    ]);
  });

  it('shows the Tracked Developers subpage to admins only, without its roles', () => {
    const key = 'developer-activity-tracked-developers';
    expect(nav[0].children?.some((c) => c.key === key)).toBe(false);
    const admin = dashboardAssignments([Role.ADMIN])[0].children ?? [];
    expect(admin.map((c) => c.key)).toContain(key);
    expect(admin.every((c) => !('roles' in c))).toBe(true);
  });

  it('shows nothing to a user with no roles', () => {
    expect(dashboardAssignments([])).toEqual([]);
  });
});
