import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

/**
 * Persisted alongside the pre-paint script in index.html, which reads this
 * same storage key to set the `dark` class before first paint — keep the key
 * and the `state.mode` shape in sync with that script if either changes.
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => set({ mode }),
    }),
    { name: 'sprintiq-theme' },
  ),
);
