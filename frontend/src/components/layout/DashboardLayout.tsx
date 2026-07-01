import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../lib/stores/auth-store';
import { cn } from '../../lib/utils';

const NAV = [{ to: '/', label: 'Delivery', end: true }];

export function DashboardLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);

  const logout = () => {
    clear();
    navigate('/login');
  };

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-white">
            IQ
          </span>
          <span className="text-lg font-semibold text-slate-800">SprintIQ</span>
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'block rounded-md px-3 py-2 text-sm font-medium',
                  isActive
                    ? 'bg-brand-fg text-brand'
                    : 'text-slate-600 hover:bg-slate-100',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-2 text-xs text-slate-400">
          Engineering Intelligence
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <h1 className="text-sm font-medium text-slate-500">
            Engineering Intelligence Platform
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
