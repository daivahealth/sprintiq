import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuthStore } from '../lib/stores/auth-store';
import { AdminConfigurationsPage } from '../modules/admin/AdminConfigurationsPage';
import { AdminUsersPage } from '../modules/admin/AdminUsersPage';
import { SyncStatusPage } from '../modules/admin/SyncStatusPage';
import { LoginPage } from '../modules/auth/LoginPage';
import { ProjectActivityBoard } from '../modules/dashboards/activity-boards';
import { DeveloperActivitySection } from '../modules/dashboards/developer-activity/DeveloperActivitySection';
import { DeveloperPage } from '../modules/dashboards/developer-activity/DeveloperPage';
import { OverviewPage } from '../modules/dashboards/developer-activity/OverviewPage';
import { PrStatusPage } from '../modules/dashboards/developer-activity/PrStatusPage';
import { WatchlistPage } from '../modules/dashboards/developer-activity/WatchlistPage';
import {
  EfficiencyBoard,
  FlowBoard,
  ForecastBoard,
  ProductivityBoard,
  SprintHealthBoard,
  SprintRiskBoard,
  VelocityBoard,
} from '../modules/dashboards/boards';
import { DeliveryDashboard } from '../modules/dashboards/DeliveryDashboard';
import { TopRepos } from '../modules/dashboards/TopRepos';

function RequireAuth({ children }: { children: JSX.Element }) {
  const authed = useAuthStore((s) => s.isAuthenticated());
  return authed ? children : <Navigate to="/login" replace />;
}

function Page({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DashboardLayout>{children}</DashboardLayout>
    </RequireAuth>
  );
}

/**
 * `/developer-activity/...` → `/engineering-activity/...`, keeping the subpage
 * and the query string.
 *
 * Rebuilt from the current location rather than pointed at a fixed target: the
 * section carries its range in the URL, so a link shared as
 * `?window=custom&from=2026-04-01&to=2026-06-30` must arrive showing that
 * range, not a default week. Redirecting to a bare overview would drop it
 * silently — the reader would see real numbers for a range they did not ask
 * for, which is the one failure this section is built to prevent.
 */
function LegacyDeveloperActivityRedirect() {
  const { pathname, search } = useLocation();
  return (
    <Navigate
      to={`${pathname.replace('/developer-activity', '/engineering-activity')}${search}`}
      replace
    />
  );
}

function RequireRole({
  role,
  children,
}: {
  role: string;
  children: JSX.Element;
}) {
  const user = useAuthStore((s) => s.user);
  return user?.roles.includes(role) ? children : <Navigate to="/" replace />;
}

/**
 * COMMON dashboards (metric-centric, role-assigned) — not persona pages.
 * The nav is driven by /api/dashboards/assignments per the user's roles.
 */
export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Page><DeliveryDashboard /></Page>} />
      <Route path="/sprint-health" element={<Page><SprintHealthBoard /></Page>} />
      <Route path="/sprint-risk" element={<Page><SprintRiskBoard /></Page>} />
      <Route path="/velocity" element={<Page><VelocityBoard /></Page>} />
      <Route path="/forecast" element={<Page><ForecastBoard /></Page>} />
      <Route path="/productivity" element={<Page><ProductivityBoard /></Page>} />
      <Route path="/efficiency" element={<Page><EfficiencyBoard /></Page>} />
      <Route path="/flow" element={<Page><FlowBoard /></Page>} />
      <Route path="/project-activity" element={<Page><ProjectActivityBoard /></Page>} />
      {/* Engineering Activity is four subpages under one shell, which owns the
          window and the tab strip (DASHBOARDS.md §4.4). The index redirect
          keeps every existing `/engineering-activity` link working. */}
      <Route path="/engineering-activity" element={<Page><DeveloperActivitySection /></Page>}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="developer" element={<DeveloperPage />} />
        <Route path="pr-status" element={<PrStatusPage />} />
      </Route>
      {/* The section was called Developer Activity until 2026-08-31. Every link
          to the old path still resolves — including the subpage and the query
          string, which is not incidental: the range lives in the URL
          (`?window=custom&from=&to=`), so redirecting to a bare overview would
          silently drop the range a shared link was pointing at. */}
      <Route
        path="/developer-activity/*"
        element={<LegacyDeveloperActivityRedirect />}
      />
      <Route
        path="/developer-activity"
        element={<LegacyDeveloperActivityRedirect />}
      />
      <Route path="/top-repos" element={<Page><TopRepos /></Page>} />
      {/* Team Capacity was retired into §Watchlist (2026-08-25): it answered
          "who has no PR activity in this window", the same question the
          recency buckets answer over commits, PRs, merges and reviews
          together. Redirected rather than deleted so existing links survive. */}
      <Route
        path="/team-capacity"
        element={<Navigate to="/engineering-activity/watchlist" replace />}
      />
      <Route
        path="/admin/users"
        element={
          <Page>
            <RequireRole role="admin">
              <AdminUsersPage />
            </RequireRole>
          </Page>
        }
      />
      <Route
        path="/admin/configuration"
        element={
          <Page>
            <RequireRole role="admin">
              <AdminConfigurationsPage />
            </RequireRole>
          </Page>
        }
      />
      <Route
        path="/admin/sync-status"
        element={
          <Page>
            <RequireRole role="admin">
              <SyncStatusPage />
            </RequireRole>
          </Page>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
