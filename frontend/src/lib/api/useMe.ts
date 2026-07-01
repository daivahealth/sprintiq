import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { MeResponse } from './types';
import { useAuthStore } from '../stores/auth-store';

/**
 * Resolves the current identity + active tenant from the token on load. Used to
 * validate the session and display which tenant is active (one at a time).
 */
export function useMe() {
  const token = useAuthStore((s) => s.token);
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
    enabled: Boolean(token),
    retry: false,
  });
}
