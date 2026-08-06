import { type ThemeMode, useThemeStore } from '../lib/stores/theme-store';

const ORDER: ThemeMode[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemeMode, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
        <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.4" />
        <path
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M8 1.25v1.5M8 13.25v1.5M2.4 2.4l1.06 1.06M12.54 12.54l1.06 1.06M1.25 8h1.5M13.25 8h1.5M2.4 13.6l1.06-1.06M12.54 3.46l1.06-1.06"
        />
      </svg>
    );
  }
  if (mode === 'dark') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
        <path
          fill="currentColor"
          d="M13.5 9.8A5.75 5.75 0 0 1 6.2 2.5a.5.5 0 0 0-.65-.6A6.75 6.75 0 1 0 14.1 10.45a.5.5 0 0 0-.6-.65Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.25" stroke="currentColor" strokeWidth="1.4" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M5.5 14h5M8 11.5V14" />
    </svg>
  );
}

/** Cycles system → light → dark → system; shows the stored preference, not just the resolved theme. */
export function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <button
      type="button"
      onClick={() => setMode(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length])}
      title={LABEL[mode]}
      aria-label={LABEL[mode]}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-fg-muted transition hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <ThemeIcon mode={mode} />
    </button>
  );
}
