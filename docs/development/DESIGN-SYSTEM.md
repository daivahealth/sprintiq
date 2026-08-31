# Frontend Design System

The token, primitive, and motion system behind `frontend/src/`. This is the "shared theme tokens" `CLAUDE.md`'s frontend rules refer to — before this doc existed, no such tokens did; the app was ~360 hardcoded Tailwind color utilities with one unmodified `indigo-600` accent and no dark mode. Read this before adding a new screen, primitive, or color.

This doc describes **editorial contrast**, the visual language that replaced the earlier indigo/boxed/rounded system on 2026-08-31: near-black ink on paper, rules instead of filled boxes, large tight numerals, wide-tracked uppercase micro-labels, and a **sienna** accent used sparingly. The re-skin changed token *values*, shape, type, and motion character. It did not rename any token, change any primitive's API, or touch routes, layouts, or data flow — see [`docs/superpowers/specs/2026-08-31-visual-reskin-design.md`](../superpowers/specs/2026-08-31-visual-reskin-design.md) for the full design record.

> Context: [DASHBOARDS.md](../features/DASHBOARDS.md) (dashboard behavior/content this system styles), [DEVELOPER-ONBOARDING.md](DEVELOPER-ONBOARDING.md) (local setup).

## Principles

1. **Instrument, not marketing page.** SprintIQ is a measurement tool; the UI reads as trustworthy and dense, not celebratory. Provenance chrome (freshness, confidence, linkage coverage) is legible, not an afterthought — CLAUDE.md requires users know how trustworthy a number is.
2. **Tokens, never raw palette classes.** Every color in a component references a semantic token (`bg-surface`, `text-fg-muted`, `bg-success-bg`) — never `bg-white`, `text-slate-500`, `bg-emerald-100`, etc. This is what makes dark mode and future re-theming a token edit, not a per-file hunt.
3. **Reuse before invent.** Check `src/components/ui/` before writing a new primitive or duplicating a class string. Duplicated literal class strings are a signal something belongs in `ui/`.

## Token reference

Defined in `src/index.css` as space-separated RGB channels (`--brand: 184 72 26`) and registered in `tailwind.config.js` as `rgb(var(--x) / <alpha-value>)`. **Channels, not hex** — hex breaks every opacity-modifier utility (`bg-brand/5`, `ring-brand/20`).

| Token family | Members | Use for |
|---|---|---|
| Brand | `brand`, `brand-fg`, `brand-muted`, `on-brand` | Primary actions, active nav/segment state, focus rings. `brand-fg` is a *background* tint (active nav), not a foreground color — legacy name, kept to avoid churn. Sienna (`184 72 26` light / `224 114 60` dark) — used sparingly, per the direction. |
| Surface | `canvas`, `surface`, `popover`, `subtle`, `muted`, `muted-strong` | Page bg → card region → floating popover → inset panel → chip/track → secondary-button hover, in ascending prominence. `popover` is deliberately distinct from `surface` (lighter, in dark) so dropdowns lift off the page where shadows don't read. |
| Foreground | `fg`, `fg-secondary`, `fg-muted`, `fg-subtle`, `fg-faint` | Heading → body → label → hint → decorative-text, in descending emphasis. |
| Border | `border`, `border-subtle`, `border-strong` | Card/table borders → dividers → input/control borders. |
| Rule | `rule` | The heavy ink line for section boundaries and table heads (`border-t-2 border-rule` on `Card`, `border-b-2 border-rule` on `TableHeadRow`). Deliberately a separate token from `border-strong` — `border-strong` already means "input/control border" per this doc; overloading it to also mean "structural ink line" would break that contract. Added in the re-skin as the one genuinely new color, per the "Adding a new color" policy below. |
| Status | `success`/`warning`/`danger` × `{DEFAULT, fg, bg, border}` | `fg`/`bg`/`border` are the Badge/callout triad and re-tune per theme (see Contrast contract). `danger` additionally has `solid`/`solid-hover` + `on-danger` for the destructive Button. **`DEFAULT` (the solid tier, used for dots/bar fills/chart strokes) is now theme-varying, not a shared constant** — see below. |
| Chart | `chart-1`..`chart-6`, `chart-grid`, `chart-axis`, `chart-empty` | The categorical series palette for `CommitChart`/`ProjectActivityChart`, plus chart-specific grid/axis/empty-bar colors (kept separate from the general status tokens — chart-1 mirrors `brand`, chart-2 mirrors `success`, but the rest are chart-only hues chosen for series separation). |

**The status `DEFAULT` tier is no longer the same value in both themes.** Before the re-skin it was a fixed 500-tier solid shared across light and dark. It isn't anymore: `--success` is `47 111 82` in light and `79 184 127` in dark, and `--warning`/`--danger` re-tune the same way. The reason is legibility, not taste — a solid tuned to read as a small dot or bar fill on white paper is too dark to read on the new near-black (`13 13 16`) canvas; the dark values in `src/index.css` are deliberately lighter/brighter than their light counterparts, the same direction `fg`/`border` already move. If you're tempted to "restore" a single shared solid value across both `:root` and `.dark`, don't — check `src/index.css` for the current per-theme pair instead of assuming one.

### Surface and canvas are the same value

`--canvas` and `--surface` collapse to the same paper white (`255 255 255` light, `13 13 16` dark) — this was two distinct tokens before the re-skin. Cards stop being filled boxes and become ruled regions: `Card` (`src/components/ui/card.tsx`) is `border-t-2 border-rule bg-surface p-4`, not a bordered/shadowed box sitting visually above the page. `--popover` stays distinct from both (lighter than canvas, in dark) for the reason above — floating layers still need to lift where shadows don't read.

### Contrast contract

Badges are the highest-frequency colored element in the app — validate new status colors against this contract in **both** themes:

- `bg-{status}-bg` + `text-{status}-fg` ≥ 4.5:1.
- `bg-{status}-bg` is visually distinct from the surface it sits on (card or page).
- Dark mode does not invert light values — `{status}-bg` becomes a low-opacity tint of the hue over the dark canvas, `{status}-fg` moves to a lighter tier. `{status}` (the solid tier) and `{status}-fg` (badge/text tier) are separate tokens on purpose: a hue that reads fine as a small dot/fill is often too saturated — or, per above, too dark — as body text.

Computed pairs against the ≥4.5:1 floor (WCAG relative luminance):

| Pair | Light | Dark |
|---|---|---|
| `success-fg` on `success-bg` | 5.41 | 6.85 |
| `warning-fg` on `warning-bg` | 5.41 | 8.19 |
| `danger-fg` on `danger-bg` | 7.03 | 6.95 |
| `on-brand` on `brand` | 5.27 | 6.02 |

`src/design-system.test.ts` asserts this floor on every build. If a new value fails, change the value, not the threshold.

### Why warning is mustard

`--warning` moved from amber (`245 158 11`) to mustard (`154 123 16` light / `217 185 92` dark). Amber sits too close to sienna (`184 72 26`, the new `--brand`) — a user could not reliably tell "this is the brand" from "this is a caution" at a glance. Pushing warning yellow-ward restores the separation. `--chart-3` left amber for the same reason, moving to ink blue (`61 90 138` light / `107 147 214` dark) — otherwise the six-series chart palette carried three warm hues. Do not "fix" `--warning` or `--chart-3` back to amber; the collision with brand is the reason they moved.

### Chart tokens are structural, not just color

Tailwind derives `fill-*`/`stroke-*` utilities from `theme.colors` automatically, so `--chart-1..6` gave `fill-chart-1`/`stroke-chart-1` etc. for free — no `theme.extend.fill` needed, and dark mode is handled entirely by the `.dark` block flipping the CSS variable. The series arrays in `ProjectActivityChart.tsx` **must stay static string literals**:

```ts
const COLORS = ['stroke-chart-1', 'stroke-chart-2', /* … */];
```

Tailwind's class scanner is a regex over source text, not an evaluator — `` `stroke-chart-${i}` `` is invisible to it and the class silently never ships. The same applies to `BarList`'s `color` prop (`widgets.tsx`) and any `cn()` argument anywhere: no interpolated class names. `src/design-system.test.ts` greps every `.ts`/`.tsx` file under `src/` for this pattern (`` `bg-...${ `` and friends) as a build-time guard, alongside a guard that fails if any raw Tailwind palette class (`slate-*`, `emerald-*`, `amber-*`, ...) appears anywhere in source.

`CommitChart`'s legend swatches are `<span>` elements styled with `bg-chart-*`, not `fill-chart-*` — `fill` is an SVG-only CSS property and has zero effect on an HTML element. (This exact mistake existed in `ProjectActivityChart`'s legend before the token migration — the dots were invisible. Fixed as `LEGEND_DOT_COLORS`, a `bg-*` array parallel to the `fill-*` `DOT_COLORS` array used by the SVG circles.) When adding a new chart, mirror `chart-N` between the mark (`fill-`/`stroke-`) and its legend swatch (`bg-`), and never let the two drift to different indices.

## Typography

Self-hosted **Inter Variable** (`font-sans`) + **JetBrains Mono Variable** (`font-mono`), latin subset only, `src/assets/fonts/` + `src/styles/fonts.css`. No external font CDN — this is a self-hosted enterprise product. Inter's genuine tabular figures are why it was chosen over a system stack: the metric tables lean on `tabular-nums` throughout.

| Role | Classes |
|---|---|
| Page title | `text-xl font-bold tracking-[-0.035em]` |
| Section head | `text-[11px] font-bold uppercase tracking-[0.14em]` |
| Metric value | `text-[28px] font-bold tracking-[-0.045em] tabular-nums` |
| Body / table cell | `text-sm` |
| Table header | `text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted` |
| Provenance / hint | `text-xs text-fg-subtle` |

Provenance is a deliberate departure from the direction, and stays sentence case rather than the wide-tracked uppercase the rest of the scale moved to. The approved mockup rendered the freshness footer in wide-tracked caps and it looked right — but this doc fixes provenance at `fg-subtle` rather than the dimmer `fg-faint` specifically so lineage text stays legible, and CLAUDE.md requires users can judge how trustworthy a number is. Tiny uppercase text is harder to read, not easier. Legibility wins here even though it's off-direction; don't "complete the sweep" by uppercasing `ProvenanceNote`.

Table headers moved from `fg-faint` (11px, mixed case) to `fg-muted` (10px, bold caps) for the same underlying reason: bold caps at 10px need more contrast than the mixed-case 11px they replaced, so the color tier had to strengthen alongside the size/weight change.

## Shape

**Radius scale** (`theme.extend.borderRadius` in `tailwind.config.js`) was remapped, not removed — editorial contrast is a squared language, so every radius step got smaller:

| Token | Was | Now |
|---|---|---|
| `sm` | 2px | 1px |
| `DEFAULT` | 4px | 2px |
| `md` | 6px | 2px |
| `lg` | 8px | 3px |
| `xl` | 12px | 4px |
| `full` | 9999px | unchanged |

Remapping the scale centrally in `tailwind.config.js` is what let ~48 hardcoded `rounded-md`/`rounded-lg`/`rounded-sm`/`rounded-xl` utilities scattered across the page modules re-shape without a single page edit — the utility names didn't change, only what they resolve to.

`rounded-full` was reviewed individually rather than remapped, and is unchanged at `9999px`. `src/components/ui/spinner.tsx` is now its sole call site in `src/` — the loading spinner is a circle by meaning (`animate-spin` on a ring), not by style, so it stays round under a squared direction. If you find a second `rounded-full` call site being added, check whether it's actually round-by-meaning like the spinner before assuming it should follow the squared direction instead.

The single `shadow-sm` in the pre-reskin app was on `Card`, and was dropped entirely — `Card` no longer casts a shadow at all, per the box-to-rule change above. `shadow-sm` has no remaining call sites in `src/`.

## Primitives (`src/components/ui/`)

One file per primitive, barrel-exported from `ui/index.ts` (`import { Button, Card } from '.../components/ui'`). Built with [`class-variance-authority`](https://cva.style) for typed variants and `cn()` (`clsx` + `tailwind-merge`, `src/lib/utils.ts`) for merge-safe overrides. All primitives kept their variant APIs, prop types and exported names through the re-skin — only their class strings changed, so no call site or page needed an edit.

| Primitive | Variants | Notes |
|---|---|---|
| `Button` | `variant`: primary · secondary · ghost · destructive. `size`: sm · md | `primary` is a solid sienna fill; `secondary` is a ruled outline (`border border-fg` over a transparent background) rather than the earlier filled grey. Keeps the visible `focus-visible` ring and `active:scale-[0.98]` press feedback from before the re-skin. |
| `Badge` | `tone`: neutral · good · warn · bad | Squared caps: `rounded-sm`, `uppercase tracking-[0.08em] font-bold text-[9px]`. `tone` is intentionally not renamed to `success`/`warning`/`danger` — three call sites (`PACE_TONE`, `MetricRowsTable`'s confidence thresholds, `TypeBadge`) type against this exact union. |
| `Card` | — | `border-t-2 border-rule bg-surface p-4` — a ruled region, no side/bottom border and no shadow (see Shape, above). |
| `Input`, `Field` | — | `Input` is squared (`rounded-sm`) with a `border-border-strong` border and a sienna focus ring (`focus:border-brand focus:ring-brand/20`). |
| `FilterBar` | — | The scope/filter-bar shell, previously copy-pasted 5×; a rule beneath (`border-b border-border`) rather than a bordered box. |
| `SegmentedControl<T>` | — | Generic toggle group (time-range, group-by, activity-window pickers were 3 independent copies). Ruled track (`border border-border-strong`); the active segment sits on solid ink (`bg-fg text-canvas`) rather than a tint. |
| `TableHeadRow`, `TableBodyRow` | `hoverable` (body row) | `TableHeadRow` gains the ink rule (`border-b-2 border-rule`) and the caps/tracking header type, in `fg-muted`. `TableBodyRow` keeps a hairline `border-border-subtle` divider; `hoverable` uses `bg-subtle`. Deliberately **not** a full `DataTable`: the app's four tables (`MetricRowsTable`, `WorkItemsTable`, the Users grid, Sync Status's tables) have genuinely different shapes (fixed `colgroup`, CSS-grid fake table, sticky scrolling heads) that a generic config surface would fight more than it'd save. |
| `ProvenanceNote` | — | The `computed {timeAgo}` / lineage-source footer, previously copy-pasted 7×. Color/type unchanged by the re-skin (see Typography, above). Each call site still supplies its own sentence — the four distinct loading/error copy variants across dashboards were preserved as `label`/`fallback` props on `LoadingCard`/`ErrorCard` (`modules/dashboards/widgets.tsx`) rather than collapsed to one string. |
| `NavItem` | — | Wraps `react-router`'s `NavLink` with the active/inactive token classes, replacing 4 duplicated blocks in `DashboardLayout`. Active state is now a `bg-brand-fg text-brand-muted` tint block, squared. |
| `Skeleton`, `StatusDot` | `StatusDot` `tone` | `Skeleton` for first-load placeholders (`bg-muted`, squared). `StatusDot` for the PR-linkage/status dots previously hand-rolled per call site — now square (`rounded-none`), 7px (`h-1.5 w-1.5`/`h-2 w-2` depending on `size`). |
| `Spinner` | — | Color only through the re-skin; still `rounded-full` (see Shape, above) — a spinner is a circle. |

### `/_styleguide` — the style gallery

`frontend/src/modules/styleguide/StyleguidePage.tsx`, mounted in `src/app/router.tsx` only under `import.meta.env.DEV`, and deliberately outside `RequireAuth`/`DashboardLayout` so it renders with no backend and no login. It exists because this repository has no component-level tests — `utils.test.ts` and `activity-range.test.ts` are the only two `frontend/src` specs besides `design-system.test.ts` itself, and all three check pure logic or token values, never rendered output. `tsc`/`eslint`/`vite build`/`vitest run` prove the primitives compile, not that they look right. The page renders every primitive in every variant, the four `Badge` tones, a KPI trio, a dense table, a chart-series swatch strip, and a side-by-side light/dark render (via a nested `.dark` wrapper) on one scrollable page. Keep it current when adding a primitive — it is the review surface for new ones, not a one-time artifact of the re-skin.

## Dark mode

`darkMode: 'class'` — the `dark` class on `<html>` is the single switch. Three moving parts:

1. **`index.html`** has a blocking inline script, first thing in `<head>`, that reads `localStorage['sprintiq-theme']` and sets the class before first paint (avoids a light-then-dark flash; this cannot be a React effect for the same reason).
2. **`src/lib/stores/theme-store.ts`** — zustand + persist, `mode: 'light' | 'dark' | 'system'`, same key the inline script reads. Keep the storage key and the `state.mode` shape in sync with the script if either changes.
3. **`ThemeSync`** (`src/providers/app-providers.tsx`) — applies the resolved theme after mount and listens for OS-level `prefers-color-scheme` changes when `mode === 'system'`.

`.dark { color-scheme: dark }` in `index.css` is required beyond the class itself — it's what makes browser-native controls (the `SprintPicker` `<select>`, checkboxes) render dark. `ThemeToggle` (`src/components/theme-toggle.tsx`) cycles system → light → dark, mounted in `DashboardLayout`'s header.

## Motion

`motion` (the renamed successor to `framer-motion` — same library, current name; `framer-motion@13` was already this codebase under the old package name, so the re-skin's swap was an import change, not a new capability), used narrowly — most transitions stay plain CSS (`transition`, `hover:`, `focus-visible:`). Import from `motion/react`, not `framer-motion`. Reserve `motion` for state that needs enter/exit choreography; leave the rest to CSS — this rule is retained from before the re-skin, not loosened. `MotionConfig reducedMotion="user"` wraps the app root (`app-providers.tsx`), so every `motion` animation automatically collapses under OS-level reduced-motion — don't hand-roll `prefers-reduced-motion` checks per component.

Motion character, matched to the direction — confident and still:

| Where | What | Duration |
|---|---|---|
| Popovers | opacity + 2px y | 120ms |
| KPI values on range change | settle (opacity + 1px y) | 180ms |
| Tab / segment change | rule wipe (`scaleX`) | 150ms |
| Hover, focus | plain CSS `transition` | 150ms |

Standard easing: `cubic-bezier(0.16, 1, 0.3, 1)`.

Explicitly **not** built, and not to be added incidentally: springs, card lift on hover, route/page transitions, layout animations on filter change. If a change seems to call for one of these, it's a deliberate design call, not a natural extension of the existing motion table.

## Density

One page-shell width (`max-w-6xl`) — the pre-refactor split between `max-w-5xl` and `max-w-6xl` across dashboards had no rationale. `Card` padding is `p-4` (was `p-5`); table rows `py-2.5` (unchanged, already tight). This is an instrument-density product: prefer showing more rows/columns over generous whitespace.

## Adding a new color

1. Is it a status (success/warning/danger)? Use the existing triad — don't invent a fourth.
2. Is it a chart series? Add to the `chart-N` sequence, keep the mark/legend pair (`fill-`/`stroke-` + `bg-`) at the same index.
3. Anything else, ask first — a new brand-adjacent hue changes the product's visual identity and should be a deliberate call, not an incidental one made two components deep in a feature PR. `--rule` (above) is the one example of this being done right: reasoned about explicitly, given its own token rather than overloading `border-strong`, and recorded here in the same change that introduced it.

## Change policy

New tokens, primitives, or a re-tuned palette update this doc in the same change (Documentation-First, per `CLAUDE.md`). Don't reintroduce raw Tailwind palette classes (`slate-*`, `emerald-*`, `amber-*`, etc.) in component code — if you find yourself reaching for one, the token you need is probably missing from the table above, not absent from the system. `src/design-system.test.ts` enforces the no-raw-palette and no-interpolated-class rules on every build; a change that needs to violate either is a signal to reconsider the change, not the test.
