import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUser, Tenant } from '../api/types';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  tenant: Tenant | null;
  isAuthenticated: () => boolean;
  setAuth: (token: string, user: AuthUser, tenant: Tenant | null) => void;
  /** Refresh identity/tenant without changing the token (e.g. after /me). */
  setIdentity: (user: AuthUser, tenant: Tenant | null) => void;
  clear: () => void;
}

/**
 * Persisted session. The tenant is resolved server-side from the user and kept
 * here for display only — all tenant scoping is enforced by the JWT on the
 * server (ADR-0006).
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      tenant: null,
      isAuthenticated: () => Boolean(get().token),
      setAuth: (token, user, tenant) => set({ token, user, tenant }),
      setIdentity: (user, tenant) => set({ user, tenant }),
      clear: () => set({ token: null, user: null, tenant: null }),
    }),
    { name: 'sprintiq-auth' },
  ),
);
