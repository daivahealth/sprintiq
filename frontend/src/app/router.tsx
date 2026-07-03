import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuthStore } from '../lib/stores/auth-store';
import { AdminConfigurationsPage } from '../modules/admin/AdminConfigurationsPage';
import { AdminUsersPage } from '../modules/admin/AdminUsersPage';
import { LoginPage } from '../modules/auth/LoginPage';
import {
  DeveloperActivityBoard,
  ProjectActivityBoard,
} from '../modules/dashboards/activity-boards';
import {
  EfficiencyBoard,
  ForecastBoard,
  ProductivityBoard,
  SprintHealthBoard,
  SprintRiskBoard,
  VelocityBoard,
} from '../modules/dashboards/boards';
import { DeliveryDashboard } from '../modules/dashboards/DeliveryDashboard';

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
      <Route path="/project-activity" element={<Page><ProjectActivityBoard /></Page>} />
      <Route path="/developer-activity" element={<Page><DeveloperActivityBoard /></Page>} />
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
