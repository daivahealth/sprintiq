import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuthStore } from '../lib/stores/auth-store';
import { LoginPage } from '../modules/auth/LoginPage';
import { DeliveryDashboard } from '../modules/dashboards/DeliveryDashboard';

function RequireAuth({ children }: { children: JSX.Element }) {
  const authed = useAuthStore((s) => s.isAuthenticated());
  return authed ? children : <Navigate to="/login" replace />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardLayout>
              <DeliveryDashboard />
            </DashboardLayout>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
