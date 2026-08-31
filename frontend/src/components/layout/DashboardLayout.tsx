import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useMe } from "../../lib/api/useMe";
import { useAuthStore } from "../../lib/stores/auth-store";
import {
  useAssignments,
  type DashboardAssignment,
} from "../../modules/dashboards/useInsights";
import { ThemeToggle } from "../theme-toggle";
import { NavItem, Spinner } from "../ui";

/**
 * One nav entry, plus its subsections when it has any.
 *
 * Children are revealed only while the section is active, rather than sitting
 * open permanently: Engineering Activity's four subpages would otherwise grow
 * the sidebar by four items for every reader, including the ones who never
 * open it. `children` is optional throughout — an API deployed before the
 * section existed sends none, and the nav must render exactly as it did then.
 */
function NavSection({ item }: { item: DashboardAssignment }) {
  const { pathname } = useLocation();
  const children = item.children ?? [];
  // Match on the parent path's directory, not the entry's own `path` — that
  // points at the default child (`/engineering-activity/overview`), so comparing
  // against it would collapse the children the moment you opened any other tab.
  const sectionRoot = item.path.split("/").slice(0, 2).join("/");
  const inSection =
    children.length > 0 &&
    (pathname === sectionRoot || pathname.startsWith(`${sectionRoot}/`));

  return (
    <div>
      <NavItem
        to={item.path}
        end={item.path === "/"}
        title={item.description}
        active={inSection || undefined}
      >
        {item.title}
      </NavItem>
      {inSection && (
        <div className="mt-1 space-y-0.5 border-l border-border pl-3">
          {children.map((child) => (
            <NavItem key={child.key} to={child.path} title={child.description}>
              {child.title}
            </NavItem>
          ))}
        </div>
      )}
    </div>
  );
}

export function DashboardLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const tenant = useAuthStore((s) => s.tenant);
  const clear = useAuthStore((s) => s.clear);
  const setIdentity = useAuthStore((s) => s.setIdentity);

  // Validate the token + resolve the active tenant on load.
  const me = useMe();
  // Role-assigned dashboards drive the nav (no persona pages).
  const assignments = useAssignments();
  const nav = assignments.data?.dashboards ?? [];
  const isAdmin = user?.roles.includes("admin") ?? false;
  useEffect(() => {
    if (me.data) {
      setIdentity(me.data.user, me.data.tenant);
    }
  }, [me.data, setIdentity]);

  const logout = () => {
    clear();
    navigate("/login");
  };

  if (me.isError) {
    // Token rejected (client already cleared auth on 401).
    return <Navigate to="/login" replace />;
  }
  if (me.isLoading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-1 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-on-brand">
            IQ
          </span>
          <span className="text-lg font-semibold tracking-[-0.01em] text-fg">SprintIQ</span>
        </div>
        {/* Active tenant — one tenant's data at a time. */}
        <p className="mb-6 truncate px-2 text-xs font-medium text-fg-faint">
          {tenant?.name ?? "—"}
        </p>
        <nav className="space-y-1">
          {nav.map((item) => (
            <NavSection key={item.key} item={item} />
          ))}
          {assignments.isLoading && (
            <p className="px-3 py-2 text-xs text-fg-faint">Loading…</p>
          )}
          {isAdmin && (
            <>
              <NavItem to="/admin/users">Users & Roles</NavItem>
              <NavItem to="/admin/configuration">Configuration</NavItem>
              <NavItem
                to="/admin/sync-status"
                title="Data transfer/backfill progress and live scheduler status"
              >
                Sync Status
              </NavItem>
            </>
          )}
        </nav>
        <p className="mt-auto px-2 text-xs text-fg-faint">
          Engineering Intelligence
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <h1 className="text-sm font-medium text-fg-subtle">
            {tenant?.name
              ? `${tenant.name} · Engineering Intelligence`
              : "Engineering Intelligence Platform"}
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-fg-muted">{user?.email}</span>
            <ThemeToggle />
            <button
              onClick={logout}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-muted hover:bg-muted"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
