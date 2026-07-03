import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { AdminRole, AdminUser, UserRole } from '../../lib/api/types';
import { Badge, Button, Card, Spinner } from '../../components/ui';

function useAdminRoles() {
  return useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<{ roles: AdminRole[] }>('/api/admin/roles'),
    staleTime: 10 * 60_000,
  });
}

function useAdminUsers() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/admin/users'),
  });
}

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const roles = useAdminRoles();
  const users = useAdminUsers();
  const updateRoles = useMutation({
    mutationFn: (input: { userId: string; roles: UserRole[] }) =>
      api.patch<AdminUser>(`/api/admin/users/${input.userId}/roles`, {
        roles: input.roles,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['assignments'] });
    },
  });

  const roleOptions = roles.data?.roles ?? [];
  const rows = users.data?.users ?? [];
  const loading = roles.isLoading || users.isLoading;

  const toggleRole = (user: AdminUser, role: UserRole) => {
    const next = user.roles.includes(role)
      ? user.roles.filter((r) => r !== role)
      : [...user.roles, role];
    if (next.length === 0) {
      return;
    }
    updateRoles.mutate({ userId: user.id, roles: next });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">
            Users & Roles
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Tenant-scoped access control
          </p>
        </div>
        {loading && <Spinner />}
      </div>

      {users.isError || roles.isError ? (
        <Card>
          <p className="text-sm text-rose-700">
            Role data could not be loaded.
          </p>
        </Card>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[minmax(220px,1.2fr)_minmax(160px,0.8fr)_minmax(420px,2fr)] border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span>User</span>
            <span>Status</span>
            <span>Roles</span>
          </div>
          {rows.map((user) => (
            <div
              key={user.id}
              className="grid grid-cols-[minmax(220px,1.2fr)_minmax(160px,0.8fr)_minmax(420px,2fr)] gap-3 border-b border-slate-100 px-4 py-4 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">
                  {user.displayName}
                </p>
                <p className="truncate text-sm text-slate-500">{user.email}</p>
              </div>
              <div>
                <Badge tone={user.status === 'active' ? 'good' : 'neutral'}>
                  {user.status}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {roleOptions.map((role) => {
                  const checked = user.roles.includes(role.key);
                  return (
                    <Button
                      key={role.key}
                      type="button"
                      onClick={() => toggleRole(user, role.key)}
                      disabled={updateRoles.isPending}
                      className={
                        checked
                          ? 'border border-brand bg-brand px-3 py-1.5 text-xs text-white'
                          : 'border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50'
                      }
                      aria-pressed={checked}
                    >
                      {role.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
          {!loading && rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No users found.</p>
          ) : null}
        </div>
      </div>

      {updateRoles.isError ? (
        <p className="text-sm text-rose-700">
          {updateRoles.error instanceof Error
            ? updateRoles.error.message
            : 'Roles could not be updated.'}
        </p>
      ) : null}
    </section>
  );
}
