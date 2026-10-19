import type { DashboardAssignment } from "../../modules/dashboards/useInsights";

/**
 * Splits the role-filtered dashboards into the primary nav and the collapsed
 * **Later** group (DASHBOARDS.md §1.1), keeping the API's order within each.
 *
 * Membership comes from the API's `group`, never from a list kept here: the
 * registry's order and grouping are one product decision, made in one place.
 * An API that predates `group` sends none, and every entry is then primary —
 * the sidebar renders exactly as it did before.
 */
export function splitNav(items: DashboardAssignment[]): {
  primary: DashboardAssignment[];
  later: DashboardAssignment[];
} {
  return {
    primary: items.filter((d) => d.group !== "later"),
    later: items.filter((d) => d.group === "later"),
  };
}

/** Whether the current page is one of the Later boards, so the group opens on it. */
export function isInGroup(
  items: DashboardAssignment[],
  pathname: string,
): boolean {
  return items.some(
    (d) => pathname === d.path || pathname.startsWith(`${d.path}/`),
  );
}
