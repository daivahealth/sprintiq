import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUser } from '../api/types';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: () => boolean;
  setAuth: (token: string, user: AuthUser) => void;
  clear: () => void;
}

/** Persisted JWT + user. The API client reads the token from here. */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: () => Boolean(get().token),
      setAuth: (token, user) => set({ token, user }),
      clear: () => set({ token: null, user: null }),
    }),
    { name: 'sprintiq-auth' },
  ),
);
