import { motion } from 'motion/react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../../lib/stores/auth-store';
import { cn } from '../../../lib/utils';

/**
 * Shell for Sprint Health's subpages (DASHBOARDS.md §4.1): the Board, and —
 * for admins only — Efforts (ADR-0014).
 *
 * The Board stays at `/sprint-health` itself (the index route), not behind a
 * redirect: Velocity deep-links `/sprint-health?projects=…&sprint=…`, and an
 * index render keeps that link and its query string exactly as it was.
 *
 * The tab strip carries the current query string, so the sprint being read
 * survives a switch between Board and Efforts. A reader who sees only the
 * Board gets no tab strip at all — one tab is not a choice.
 */
const TABS = [
  {
    to: '/sprint-health',
    end: true,
    label: 'Board',
    title: 'Commit activity, check-ins, productivity, quality and release candidates.',
  },
  {
    to: '/sprint-health/efforts',
    end: false,
    label: 'Efforts',
    title: 'Jira hours logged and subtasks created per day. Admins only.',
    adminOnly: true,
  },
];

export function SprintHealthSection() {
  const { search } = useLocation();
  const isAdmin = useAuthStore((s) => s.user?.roles.includes('admin') ?? false);
  const tabs = TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <div className="space-y-6">
      {tabs.length > 1 && (
        <div className="mx-auto max-w-6xl border-b border-border">
          <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Sprint Health sections">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={{ pathname: tab.to, search }}
                end={tab.end}
                title={tab.title}
                className={({ isActive }) =>
                  cn(
                    'relative whitespace-nowrap px-3 py-2 text-sm font-medium transition',
                    isActive ? 'text-brand-muted' : 'text-fg-muted hover:text-fg-secondary',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {tab.label}
                    {isActive && (
                      <motion.span
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-brand"
                      />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      )}
      <Outlet />
    </div>
  );
}
