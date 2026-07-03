import { useEffect, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate } from "react-router-dom";
import { useMe } from "../../lib/api/useMe";
import { useAuthStore } from "../../lib/stores/auth-store";
import { cn } from "../../lib/utils";
import { useAssignments } from "../../modules/dashboards/useInsights";
import { Spinner } from "../ui";

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
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-1 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-white">
            IQ
          </span>
          <span className="text-lg font-semibold text-slate-800">SprintIQ</span>
        </div>
        {/* Active tenant — one tenant's data at a time. */}
        <p className="mb-6 truncate px-2 text-xs font-medium text-slate-400">
          {tenant?.name ?? "—"}
        </p>
        <nav className="space-y-1">
          {nav.map((item) => (
            <NavLink
              key={item.key}
              to={item.path}
              end={item.path === "/"}
              title={item.description}
              className={({ isActive }) =>
                cn(
                  "block rounded-md px-3 py-2 text-sm font-medium",
                  isActive
                    ? "bg-brand-fg text-brand"
                    : "text-slate-600 hover:bg-slate-100",
                )
              }
            >
              {item.title}
            </NavLink>
          ))}
          {assignments.isLoading && (
            <p className="px-3 py-2 text-xs text-slate-400">Loading…</p>
          )}
        </nav>
        <p className="mt-auto px-2 text-xs text-slate-400">
          Engineering Intelligence
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <h1 className="text-sm font-medium text-slate-500">
            {tenant?.name
              ? `${tenant.name} · Engineering Intelligence`
              : "Engineering Intelligence Platform"}
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">{user?.email}</span>
            <button
              onClick={logout}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
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
