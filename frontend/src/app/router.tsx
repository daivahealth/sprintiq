import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuthStore } from '../lib/stores/auth-store';
import { LoginPage } from '../modules/auth/LoginPage';
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
