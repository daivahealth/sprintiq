import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { useThemeStore } from '../lib/stores/theme-store';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

/** Keeps <html class="dark"> in sync with the theme store after mount (the index.html pre-paint script owns the pre-mount value). */
function ThemeSync() {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    if (mode === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [mode]);

  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <ThemeSync />
          {children}
        </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  );
}
