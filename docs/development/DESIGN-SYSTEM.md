# Frontend Design System

The token, primitive, and motion system behind `frontend/src/`. This is the "shared theme tokens" `CLAUDE.md`'s frontend rules refer to — before this doc existed, no such tokens did; the app was ~360 hardcoded Tailwind color utilities with one unmodified `indigo-600` accent and no dark mode. Read this before adding a new screen, primitive, or color.

> Context: [DASHBOARDS.md](../features/DASHBOARDS.md) (dashboard behavior/content this system styles), [DEVELOPER-ONBOARDING.md](DEVELOPER-ONBOARDING.md) (local setup).

## Principles

1. **Instrument, not marketing page.** SprintIQ is a measurement tool; the UI reads as trustworthy and dense, not celebratory. Provenance chrome (freshness, confidence, linkage coverage) is legible, not an afterthought — CLAUDE.md requires users know how trustworthy a number is.
2. **Tokens, never raw palette classes.** Every color in a component references a semantic token (`bg-surface`, `text-fg-muted`, `bg-success-bg`) — never `bg-white`, `text-slate-500`, `bg-emerald-100`, etc. This is what makes dark mode and future re-theming a token edit, not a per-file hunt.
3. **Reuse before invent.** Check `src/components/ui/` before writing a new primitive or duplicating a class string. Duplicated literal class strings are a signal something belongs in `ui/`.

## Token reference

Defined in `src/index.css` as space-separated RGB channels (`--brand: 91 87 214`) and registered in `tailwind.config.js` as `rgb(var(--x) / <alpha-value>)`. **Channels, not hex** — hex breaks every opacity-modifier utility (`bg-brand/5`, `ring-brand/20`).

| Token family | Members | Use for |
|---|---|---|
| Brand | `brand`, `brand-fg`, `brand-muted`, `on-brand` | Primary actions, active nav/segment state, focus rings. `brand-fg` is a *background* tint (active nav), not a foreground color — legacy name, kept to avoid churn. |
| Surface | `canvas`, `surface`, `popover`, `subtle`, `muted`, `muted-strong` | Page bg → card/sidebar → floating popover → inset panel → chip/track → secondary-button hover, in ascending prominence. `popover` is deliberately distinct from `surface` (lighter, in dark) so dropdowns lift off the page where shadows don't read. |
| Foreground | `fg`, `fg-secondary`, `fg-muted`, `fg-subtle`, `fg-faint` | Heading → body → label → hint → decorative-text, in descending emphasis. |
| Border | `border`, `border-subtle`, `border-strong` | Card/table borders → dividers → input/control borders. |
| Status | `success`/`warning`/`danger` × `{DEFAULT, fg, bg, border}` | `DEFAULT` (500-tier) is a solid fill (dots, bar fills, chart strokes) — same value in both themes. `fg`/`bg`/`border` are the Badge/callout triad and *do* re-tune per theme (see Contrast contract). `danger` additionally has `solid`/`solid-hover` + `on-danger` for the destructive Button. |
| Chart | `chart-1`..`chart-6`, `chart-grid`, `chart-axis`, `chart-empty` | The categorical series palette for `CommitChart`/`ProjectActivityChart`, plus chart-specific grid/axis/empty-bar colors (kept separate from the general status tokens — chart-1 mirrors `brand`, chart-2 mirrors `success`, but the rest are chart-only hues chosen for series separation). |

### Contrast contract

Badges are the highest-frequency colored element in the app — validate new status colors against this contract in **both** themes:

- `bg-{status}-bg` + `text-{status}-fg` ≥ 4.5:1.
- `bg-{status}-bg` is visually distinct from the surface it sits on (card or page).
- Dark mode does not invert light values — `{status}-bg` becomes a low-opacity tint of the hue over the dark canvas, `{status}-fg` moves to the 300-tier. `{status}` (the solid 500-tier) and `{status}-fg` (badge/text tier) are separate tokens on purpose: a hue that reads fine as a small dot/fill is often too saturated as body text.

### Chart tokens are structural, not just color

Tailwind derives `fill-*`/`stroke-*` utilities from `theme.colors` automatically, so `--chart-1..6` gave `fill-chart-1`/`stroke-chart-1` etc. for free — no `theme.extend.fill` needed, and dark mode is handled entirely by the `.dark` block flipping the CSS variable. The series arrays in `ProjectActivityChart.tsx` **must stay static string literals**:

```ts
const COLORS = ['stroke-chart-1', 'stroke-chart-2', /* … */];
```

Tailwind's class scanner is a regex over source text, not an evaluator — `` `stroke-chart-${i}` `` is invisible to it and the class silently never ships. The same applies to `BarList`'s `color` prop (`widgets.tsx`) and any `cn()` argument anywhere: no interpolated class names.

`CommitChart`'s legend swatches are `<span>` elements styled with `bg-chart-*`, not `fill-chart-*` — `fill` is an SVG-only CSS property and has zero effect on an HTML element. (This exact mistake existed in `ProjectActivityChart`'s legend before the token migration — the dots were invisible. Fixed as `LEGEND_DOT_COLORS`, a `bg-*` array parallel to the `fill-*` `DOT_COLORS` array used by the SVG circles.) When adding a new chart, mirror `chart-N` between the mark (`fill-`/`stroke-`) and its legend swatch (`bg-`), and never let the two drift to different indices.

## Typography

Self-hosted **Inter Variable** (`font-sans`) + **JetBrains Mono Variable** (`font-mono`), latin subset only, `src/assets/fonts/` + `src/styles/fonts.css`. No external font CDN — this is a self-hosted enterprise product. Inter's genuine tabular figures are why it was chosen over a system stack: the metric tables lean on `tabular-nums` throughout.

| Role | Classes |
|---|---|
| Page title | `text-xl font-semibold tracking-[-0.02em]` |
| Section head | `text-sm font-semibold` (or `font-medium` for lighter sub-heads) |
| Metric value | `text-2xl font-semibold tracking-[-0.03em] tabular-nums` |
| Body / table cell | `text-sm` |
| Table header | `text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-faint` |
| Provenance / hint | `text-xs text-fg-subtle` — deliberately `fg-subtle`, not the dimmer `fg-faint`, so freshness/lineage text stays legible (CLAUDE.md's data-trust requirement) |

## Primitives (`src/components/ui/`)

One file per primitive, barrel-exported from `ui/index.ts` (`import { Button, Card } from '.../components/ui'` — unchanged from the pre-refactor single-file module). Built with [`class-variance-authority`](https://cva.style) for typed variants and `cn()` (`clsx` + `tailwind-merge`, `src/lib/utils.ts`) for merge-safe overrides.

| Primitive | Variants | Notes |
|---|---|---|
| `Button` | `variant`: primary · secondary · ghost · destructive. `size`: sm · md | Has a visible `focus-visible` ring and `active:scale-[0.98]` press feedback — the pre-refactor Button had neither. |
| `Badge` | `tone`: neutral · good · warn · bad | `tone` is intentionally not renamed to `success`/`warning`/`danger` — three call sites (`PACE_TONE`, `MetricRowsTable`'s confidence thresholds, `TypeBadge`) type against this exact union. |
| `Card`, `Input`, `Field`, `Spinner` | — | Same API as before the refactor; `Card` dropped `shadow-sm` for a hairline `border` in dark mode (shadows barely read on dark surfaces) via `shadow-sm dark:shadow-none`. |
| `FilterBar` | — | The scope/filter-bar shell, previously copy-pasted 5×. |
| `SegmentedControl<T>` | — | Generic toggle group (time-range, group-by, activity-window pickers were 3 independent copies). |
| `TableHeadRow`, `TableBodyRow` | `hoverable` (body row) | Shared `<tr>` chrome only — column definitions stay per-table. Deliberately **not** a full `DataTable`: the app's four tables (`MetricRowsTable`, `WorkItemsTable`, the Users grid, Sync Status's tables) have genuinely different shapes (fixed `colgroup`, CSS-grid fake table, sticky scrolling heads) that a generic config surface would fight more than it'd save. |
| `ProvenanceNote` | — | The `computed {timeAgo}` / lineage-source footer, previously copy-pasted 7×. Each call site still supplies its own sentence — the four distinct loading/error copy variants across dashboards were preserved as `label`/`fallback` props on `LoadingCard`/`ErrorCard` (`modules/dashboards/widgets.tsx`) rather than collapsed to one string. |
| `NavItem` | — | Wraps `react-router`'s `NavLink` with the active/inactive token classes, replacing 4 duplicated blocks in `DashboardLayout`. |
| `Skeleton`, `StatusDot` | `StatusDot` `tone` | New — `Skeleton` for first-load placeholders, `StatusDot` for the PR-linkage/status dots previously hand-rolled per call site. |

## Dark mode

`darkMode: 'class'` — the `dark` class on `<html>` is the single switch. Three moving parts:

1. **`index.html`** has a blocking inline script, first thing in `<head>`, that reads `localStorage['sprintiq-theme']` and sets the class before first paint (avoids a light-then-dark flash; this cannot be a React effect for the same reason).
2. **`src/lib/stores/theme-store.ts`** — zustand + persist, `mode: 'light' | 'dark' | 'system'`, same key the inline script reads. Keep the storage key and the `state.mode` shape in sync with the script if either changes.
3. **`ThemeSync`** (`src/providers/app-providers.tsx`) — applies the resolved theme after mount and listens for OS-level `prefers-color-scheme` changes when `mode === 'system'`.

`.dark { color-scheme: dark }` in `index.css` is required beyond the class itself — it's what makes browser-native controls (the `SprintPicker` `<select>`, checkboxes) render dark. `ThemeToggle` (`src/components/theme-toggle.tsx`) cycles system → light → dark, mounted in `DashboardLayout`'s header.

## Motion

`framer-motion`, used narrowly — most transitions stay plain CSS (`transition`, `hover:`, `focus-visible:`). Reserve `framer-motion` for state that needs enter/exit choreography (the two combobox popovers today). `MotionConfig reducedMotion="user"` wraps the app root (`app-providers.tsx`), so every `framer-motion` animation automatically collapses under OS-level reduced-motion — don't hand-roll `prefers-reduced-motion` checks per component.

Standard easing: `cubic-bezier(0.16, 1, 0.3, 1)`. ~120ms for popovers, 150ms for hover/color transitions.

## Density

One page-shell width (`max-w-6xl`) — the pre-refactor split between `max-w-5xl` and `max-w-6xl` across dashboards had no rationale. `Card` padding is `p-4` (was `p-5`); table rows `py-2.5` (unchanged, already tight). This is an instrument-density product: prefer showing more rows/columns over generous whitespace.

## Adding a new color

1. Is it a status (success/warning/danger)? Use the existing triad — don't invent a fourth.
2. Is it a chart series? Add to the `chart-N` sequence, keep the mark/legend pair (`fill-`/`stroke-` + `bg-`) at the same index.
3. Anything else, ask first — a new brand-adjacent hue changes the product's visual identity and should be a deliberate call, not an incidental one made two components deep in a feature PR.

## Change policy

New tokens, primitives, or a re-tuned palette update this doc in the same change (Documentation-First, per `CLAUDE.md`). Don't reintroduce raw Tailwind palette classes (`slate-*`, `emerald-*`, etc.) in component code — if you find yourself reaching for one, the token you need is probably missing from the table above, not absent from the system.
