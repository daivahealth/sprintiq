import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Field, Input, Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api/client';
import type { LoginResponse } from '../../lib/api/types';
import { useAuthStore } from '../../lib/stores/auth-store';

export function LoginPage() {
  const navigate = useNavigate();
  const authed = useAuthStore((s) => s.isAuthenticated());
  const setAuth = useAuthStore((s) => s.setAuth);

  const [tenantId, setTenantId] = useState('tenant_seed');
  const [email, setEmail] = useState('admin@seed.test');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () =>
      api.post<LoginResponse>('/api/auth/login', { tenantId, email, password }),
    onSuccess: (res) => {
      setAuth(res.accessToken, res.user);
      navigate('/', { replace: true });
    },
  });

  if (authed) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand text-sm font-bold text-white">
            IQ
          </div>
          <h1 className="text-lg font-semibold text-slate-800">
            Sign in to SprintIQ
          </h1>
          <p className="text-sm text-slate-500">Engineering Intelligence Platform</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Tenant ID">
            <Input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              autoComplete="organization"
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>

          {login.isError && (
            <p className="text-sm text-rose-600">
              {(login.error as ApiError)?.message ?? 'Login failed'}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? <Spinner /> : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
