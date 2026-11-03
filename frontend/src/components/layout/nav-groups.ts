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

export interface NavLink {
  to: string;
  label: string;
  title: string;
  /** Roles that may see the link; the route enforces the same with RequireRole. */
  roles: string[];
}

/**
 * The Engineering Intelligence group. Front-end owned rather than in the
 * server's dashboard registry, like the other admin links: it is an admin
 * tool, not a role-assigned board. Admin only by ADR-0013 — the server's
 * `@Roles(ADMIN)` is the enforcement; this only avoids offering a page that
 * would answer 403.
 */
export const ENGINEERING_INTELLIGENCE_LINKS: NavLink[] = [
  {
    to: "/engineering-intelligence/knowledge-graph",
    label: "Knowledge Graph",
    title: "Explore repositories, developers and their activity (admin only)",
    roles: ["admin"],
  },
];

export function engineeringIntelligenceLinks(roles: string[]): NavLink[] {
  return ENGINEERING_INTELLIGENCE_LINKS.filter((link) =>
    link.roles.some((role) => roles.includes(role)),
  );
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
