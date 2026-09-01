/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['InterVariable', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          fg: 'rgb(var(--brand-fg) / <alpha-value>)',
          muted: 'rgb(var(--brand-muted) / <alpha-value>)',
        },
        'on-brand': 'rgb(var(--on-brand) / <alpha-value>)',

        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        popover: 'rgb(var(--popover) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          strong: 'rgb(var(--muted-strong) / <alpha-value>)',
        },

        fg: {
          DEFAULT: 'rgb(var(--fg) / <alpha-value>)',
          secondary: 'rgb(var(--fg-secondary) / <alpha-value>)',
          muted: 'rgb(var(--fg-muted) / <alpha-value>)',
          subtle: 'rgb(var(--fg-subtle) / <alpha-value>)',
          faint: 'rgb(var(--fg-faint) / <alpha-value>)',
        },

        border: {
          DEFAULT: 'rgb(var(--border) / <alpha-value>)',
          subtle: 'rgb(var(--border-subtle) / <alpha-value>)',
          strong: 'rgb(var(--border-strong) / <alpha-value>)',
        },
        rule: 'rgb(var(--rule) / <alpha-value>)',

        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          fg: 'rgb(var(--success-fg) / <alpha-value>)',
          bg: 'rgb(var(--success-bg) / <alpha-value>)',
          border: 'rgb(var(--success-border) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          fg: 'rgb(var(--warning-fg) / <alpha-value>)',
          bg: 'rgb(var(--warning-bg) / <alpha-value>)',
          border: 'rgb(var(--warning-border) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
          bg: 'rgb(var(--danger-bg) / <alpha-value>)',
          border: 'rgb(var(--danger-border) / <alpha-value>)',
          solid: 'rgb(var(--danger-solid) / <alpha-value>)',
          'solid-hover': 'rgb(var(--danger-solid-hover) / <alpha-value>)',
        },
        'on-danger': 'rgb(var(--on-danger) / <alpha-value>)',

        chart: {
          1: 'rgb(var(--chart-1) / <alpha-value>)',
          2: 'rgb(var(--chart-2) / <alpha-value>)',
          3: 'rgb(var(--chart-3) / <alpha-value>)',
          4: 'rgb(var(--chart-4) / <alpha-value>)',
          5: 'rgb(var(--chart-5) / <alpha-value>)',
          6: 'rgb(var(--chart-6) / <alpha-value>)',
          grid: 'rgb(var(--chart-grid) / <alpha-value>)',
          axis: 'rgb(var(--chart-axis) / <alpha-value>)',
          empty: 'rgb(var(--chart-empty) / <alpha-value>)',
        },
      },

      // Editorial contrast is a squared language. Remapping the scale here
      // re-shapes the ~48 hardcoded `rounded-*` utilities across the page
      // modules without editing a single one of them. `full` is left alone —
      // its call sites are reviewed individually in the sweep.
      borderRadius: {
        none: '0px',
        sm: '1px',
        DEFAULT: '2px',
        md: '2px',
        lg: '3px',
        xl: '4px',
        '2xl': '6px',
        '3xl': '8px',
        '4xl': '10px',
        full: '9999px',
      },
    },
  },
  plugins: [],
};
