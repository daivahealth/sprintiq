# Visual re-skin: editorial contrast

**Date:** 2026-08-31
**Status:** Approved design, not yet implemented
**Scope:** `frontend/` presentation layer only — tokens, shape/type scale, the 14 primitives in `src/components/ui/`, motion character. No route, layout, data-flow, hook or API change.

This is a working design document. The durable rules it settles belong in the
canonical doc — `docs/development/DESIGN-SYSTEM.md` — and must be written there
as part of the implementation, not left here.

## 1. Problem

The request was "revamp the website with shadcn and motion.dev". Investigation
changed the shape of it:

- **shadcn's substrate is already here.** `src/components/ui/` is Tailwind +
  `class-variance-authority` + `cn()` over semantic tokens — that is the shadcn
  recipe. Adopting the library would buy Radix accessibility primitives and the
  CLI registry, at the cost of renaming every token to shadcn's
  `background`/`foreground`/`primary` convention across 531 call sites.
- **`framer-motion@13` is motion.dev.** Motion is the renamed successor; v13 is
  already that codebase under the old package name. "Adopt motion.dev" is an
  import swap, not a new capability.
- **The actual goal is a new visual identity** — the app should look different.

So the job is a re-skin, and shadcn is not the vehicle for it. Decided
explicitly: **no shadcn, no Radix, no token rename.** The existing primitives get
restyled in place.

## 2. What is being built

A new visual language, **editorial contrast**, applied across all 20 routes by
changing tokens and primitives rather than pages: near-black ink on paper, rules
instead of filled boxes, large tight numerals, wide-tracked uppercase micro-labels,
and a **sienna** accent used sparingly.

**Out of scope, decided:** shadcn/Radix adoption; new components; any page
layout restructuring; chart type or data changes; the `fix/activity-window-range`
work currently in flight. Accessibility of the hand-rolled `multi-select` /
`search-select` popovers is a real gap but is **not** addressed here — it was
considered and deferred, and remains open.

## 3. Why a re-skin is safe here, and where it isn't

A grep over `frontend/src` finds **zero** raw Tailwind palette classes
(`slate-*`, `emerald-*`, …). The token discipline in DESIGN-SYSTEM.md held
completely. Every colour in the app resolves through a CSS variable, so retuning
token *values* propagates to all 531 token-class usages across 26 page files
with no page edits.

Shape is the exception. Pages hardcode utilities that colour tokens do not
cover:

| Utility | Count | Handled by |
|---|---|---|
| `rounded-md` | 39 | `theme.extend.borderRadius` override |
| `rounded-lg` | 5 | same |
| `rounded-sm` | 3 | same |
| `rounded-full` | 3 | **individual review** — see §5 |
| `rounded-xl` | 1 | same override |
| `shadow-sm` | 1 | individual review |
| `tracking-[…]` | 13 | mechanical sweep |

Remapping Tailwind's `borderRadius` scale in `tailwind.config.js` re-shapes 48
of these centrally, without touching a page file. The 13 letter-spacing values
are per-element literals and cannot be remapped; they get a sweep.

## 4. Tokens

Names are unchanged so no call site moves. Values are replaced wholesale in
`src/index.css`. Channels, not hex — the `rgb(var(--x) / <alpha-value>)` contract
in `tailwind.config.js` is unchanged.

### 4.1 One new token

`--rule` — the heavy ink line that defines section boundaries and table heads.
`--border-strong` already means "input/control border" per DESIGN-SYSTEM.md;
overloading it would break that contract. This is the deliberate new-colour call
that doc's §"Adding a new color" requires, made here rather than two components
deep in implementation.

It is registered in `tailwind.config.js` as `rule: 'rgb(var(--rule) / <alpha-value>)'`,
yielding `border-rule`, `bg-rule`, `text-rule`.

### 4.2 Light

```css
--brand: 184 72 26;        --brand-fg: 247 236 230;
--brand-muted: 143 54 18;  --on-brand: 255 255 255;

--canvas: 255 255 255;     --surface: 255 255 255;
--popover: 255 255 255;    --subtle: 250 250 249;
--muted: 244 244 242;      --muted-strong: 232 232 229;

--fg: 17 17 20;            --fg-secondary: 46 46 52;
--fg-muted: 90 90 99;      --fg-subtle: 107 107 118;
--fg-faint: 143 143 156;

--border: 230 230 234;     --border-subtle: 240 240 243;
--border-strong: 196 196 203;
--rule: 17 17 20;

--success: 47 111 82;      --success-fg: 26 107 69;
--success-bg: 220 239 228; --success-border: 190 222 205;

--warning: 154 123 16;     --warning-fg: 122 90 16;
--warning-bg: 245 236 212; --warning-border: 230 214 170;

--danger: 168 32 47;       --danger-fg: 143 22 32;
--danger-bg: 246 220 220;  --danger-border: 234 194 194;
--danger-solid: 168 32 47; --danger-solid-hover: 143 22 32;
--on-danger: 255 255 255;

--chart-1: 184 72 26;   /* sienna — mirrors brand */
--chart-2: 47 111 82;   /* deep green */
--chart-3: 61 90 138;   /* ink blue */
--chart-4: 143 22 32;   /* oxblood */
--chart-5: 154 123 16;  /* mustard */
--chart-6: 90 78 120;   /* slate violet */
--chart-grid: 240 240 243; --chart-axis: 143 143 156;
--chart-empty: 240 240 243;
```

### 4.3 Dark

```css
--brand: 224 114 60;       --brand-fg: 46 26 16;
--brand-muted: 240 160 113; --on-brand: 26 13 6;

--canvas: 13 13 16;        --surface: 13 13 16;
--popover: 26 26 31;       --subtle: 21 21 25;
--muted: 32 32 38;         --muted-strong: 45 45 52;

--fg: 240 240 242;         --fg-secondary: 214 214 219;
--fg-muted: 168 168 178;   --fg-subtle: 143 143 156;
--fg-faint: 112 112 124;

--border: 42 42 49;        --border-subtle: 32 32 38;
--border-strong: 62 62 71;
--rule: 240 240 242;

--success: 79 184 127;     --success-fg: 95 199 142;
--success-bg: 18 48 31;    --success-border: 30 74 50;

--warning: 217 185 92;     --warning-fg: 224 185 92;
--warning-bg: 46 36 16;    --warning-border: 74 60 26;

--danger: 224 90 105;      --danger-fg: 240 138 149;
--danger-bg: 51 21 26;     --danger-border: 82 34 42;
--danger-solid: 199 58 74; --danger-solid-hover: 216 78 93;
--on-danger: 255 255 255;

--chart-1: 224 114 60;  --chart-2: 79 184 127;
--chart-3: 107 147 214; --chart-4: 224 90 105;
--chart-5: 217 185 92;  --chart-6: 154 138 198;
--chart-grid: 32 32 38; --chart-axis: 112 112 124;
--chart-empty: 32 32 38;
```

### 4.4 Two consequences worth stating plainly

**Surface collapses into canvas.** `--surface` and `--canvas` are the same paper
white (and the same near-black in dark). Cards stop being filled boxes and become
ruled regions. This is the single largest visual consequence of the direction and
it lands on every page simultaneously. `--popover` stays distinct from both, in
dark especially, because floating layers still need to lift where shadows don't
read — the reasoning DESIGN-SYSTEM.md already records.

**Warning moves from amber to mustard.** Forced by the accent. Amber
`245 158 11` is a near neighbour of sienna `184 72 26`; a user could not reliably
tell "this is the brand" from "this is a caution". Pushing warning yellow-ward to
`154 123 16` restores the separation. `--chart-3` moves off amber to ink blue for
the same reason — otherwise the series palette carries three warms.

### 4.5 Contrast contract

Computed pairs against the ≥4.5:1 requirement (WCAG relative luminance):

| Pair | Light | Dark |
|---|---|---|
| `success-fg` on `success-bg` | 5.41 | 6.85 |
| `warning-fg` on `warning-bg` | 5.41 | 8.19 |
| `danger-fg` on `danger-bg` | 7.03 | 6.95 |
| `on-brand` on `brand` | 5.27 | 6.02 |

These are computed, not observed. The second half of the contract —
*"`bg-{status}-bg` is visually distinct from the surface it sits on"* — cannot be
computed and must be checked by eye on the style gallery (§7).

## 5. Shape and type

**Radius scale** (`theme.extend.borderRadius` in `tailwind.config.js`):

| Token | Now | Becomes |
|---|---|---|
| `sm` | 2px | 1px |
| `DEFAULT` | 4px | 2px |
| `md` | 6px | 2px |
| `lg` | 8px | 3px |
| `xl` | 12px | 4px |
| `full` | 9999px | **unchanged** |

`rounded-full` is left alone because its 3 call sites are round by meaning
(avatars, pill counters), not by style. Each gets read individually during
implementation; the default assumption is "keep round". The single `shadow-sm`
gets the same treatment.

**Type scale** (applied in primitives; page-level `tracking-[…]` literals swept
to match):

| Role | Becomes |
|---|---|
| Page title | `text-xl font-bold tracking-[-0.035em]` |
| Section head | `text-[11px] font-bold uppercase tracking-[0.14em]` |
| Metric value | `text-[28px] font-bold tracking-[-0.045em] tabular-nums` |
| Body / table cell | `text-sm` (unchanged) |
| Table header | `text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted` |
| Provenance / hint | `text-xs text-fg-subtle` — **unchanged, sentence case** |

Provenance is a deliberate departure from the direction. The mockup that was
approved rendered the freshness footer in wide-tracked caps, and it looked right
— but DESIGN-SYSTEM.md fixes provenance at `fg-subtle` rather than the dimmer
`fg-faint` specifically so lineage text stays legible, and CLAUDE.md requires
users can judge how trustworthy a number is. Tiny uppercase text is harder to
read, not easier. Legibility wins; provenance stays sentence case.

Table headers move from `fg-faint` to `fg-muted` for the same reason: bold caps
at 10px need more contrast than the mixed-case 11px they replace.

Inter Variable and JetBrains Mono Variable are unchanged. The self-hosted latin
subset and `tabular-nums` throughout stay exactly as they are.

## 6. Primitives

All 14 keep their current variant APIs, prop types and exported names. Nothing
downstream changes signature, so no page recompiles differently.

| Primitive | Change |
|---|---|
| `Card` | Loses `border` + `bg-surface` box; becomes a `border-t-2 border-rule` region with padding. The `shadow-sm dark:shadow-none` pair is dropped entirely. |
| `Badge` | Squared (`rounded-sm`), `uppercase tracking-[0.08em] font-bold text-[9px]`. `tone` union (`neutral · good · warn · bad`) unchanged — three call sites type against it. |
| `Button` | `primary` solid sienna; `secondary` becomes a ruled outline (`border border-fg` + transparent bg) rather than a filled grey; `ghost` and `destructive` retuned only. Keeps `focus-visible` ring and `active:scale-[0.98]`. |
| `TableHeadRow` | Gains `border-b-2 border-rule` and the new caps/tracking header type. |
| `TableBodyRow` | Hairline `border-border-subtle` divider; `hoverable` uses `bg-subtle`. |
| `NavItem` | Active state becomes a `bg-brand-fg text-brand-muted` tint block, squared. |
| `StatusDot` | Square (`rounded-none`), 7px. |
| `SegmentedControl` | Ruled track, squared thumb, active segment on ink rather than tint. |
| `Input`, `Field` | `border-border-strong`, squared, sienna focus ring. |
| `FilterBar` | Rule beneath instead of a bordered box. |
| `Skeleton` | `bg-muted`, squared. |
| `Spinner` | Colour only. |
| `ProvenanceNote` | Colour only — type deliberately unchanged (§5). |

## 7. Style gallery

`/_styleguide`, a new page at `frontend/src/modules/styleguide/StyleguidePage.tsx`,
mounted in `src/app/router.tsx` **only** under `import.meta.env.DEV` and
deliberately outside `RequireAuth` so it renders without a backend or a login.

It renders, on one scrollable page: every primitive in every variant; the four
`Badge` tones; a KPI trio; a dense table of ~12 rows; a chart with all six series
and its legend; the status triad against both `canvas` and `popover`; and a
side-by-side of light and dark.

This exists because **the repository has no component tests** — `utils.test.ts`
and `activity-range.test.ts` are the only two, both pure logic. `tsc`, `eslint`,
`vite build` and `vitest run` prove the re-skin compiles and that existing logic
still passes; they prove nothing whatsoever about how it looks. The gallery is
the review surface, and it stays in the repository afterwards as the place new
primitives get checked.

## 8. Motion

`framer-motion` is replaced by `motion` (same library, current name; imports move
to `motion/react`). Version pinned at install time. The two existing popover
call sites and the `MotionConfig reducedMotion="user"` wrapper in
`src/providers/app-providers.tsx` are the only files touched by the swap.

Motion character matched to the direction — confident and still:

| Where | What | Duration |
|---|---|---|
| Popovers | opacity + 2px y | 120ms |
| KPI values on range change | settle (opacity + 1px y) | 180ms |
| Tab / segment change | rule wipe (`scaleX`) | 150ms |
| Hover, focus | plain CSS `transition` | 150ms |

Easing stays `cubic-bezier(0.16, 1, 0.3, 1)`. Explicitly **not** built: springs,
card lift on hover, route/page transitions, layout animations on filter change.
DESIGN-SYSTEM.md's existing rule — reserve `motion` for enter/exit choreography,
leave the rest to CSS — is retained, not loosened.

## 9. Risks

**The direction may read as austere on dense pages.** Rules-instead-of-boxes and
wide-tracked caps flatter a KPI trio; they are unproven on `MetricRowsTable` and
the `SyncStatusPage` grids, which are the densest surfaces in the app. Those two
pages are an explicit review gate, not a final spot-check.

**Sienna versus mustard cannot be verified by computation.** §4.4 reasons about
the collision and §4.5 proves the contrast ratios, but whether a sienna button
and a mustard badge read as different *ideas* on a real page is a judgement only
a human eye makes. This is the single most likely thing to need a second pass.

**Browser-based verification is unavailable in this environment**, and the
running app is on a remote host. The implementing agent can run `tsc`, `eslint`,
`vite build`, `vitest run` and grep assertions — nothing more. Every visual claim
in the implementation report must be labelled as unverified unless a human
confirmed it.

**Surface/canvas collapse is not incrementally reversible.** It changes every
page at once and there is no flag behind it — a parallel-skin approach was
considered and rejected in design, because the direction's structural changes
(box → rule) cannot be expressed as token values alone.

## 10. Verification

Mechanical, by the implementing agent:

- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test` in `frontend/`.
- Grep assertion that raw palette classes remain at **zero** — this is currently
  true and is the property that makes the whole approach work.
- Grep assertion that no `cn()` argument or chart series array uses an
  interpolated class name (DESIGN-SYSTEM.md's static-literal rule; Tailwind's
  scanner is a regex, not an evaluator).
- Every `chart-N` mark (`fill-`/`stroke-`) still pairs with its legend swatch
  (`bg-`) at the same index.

Human, and required before this is called done:

- `/_styleguide` in both themes.
- `MetricRowsTable` and `SyncStatusPage` at real data density.
- One chart page for series separation.

## 11. Documentation

`docs/development/DESIGN-SYSTEM.md` is rewritten in the same change: token table
(including `--rule`), the retuned contrast contract with the values in §4.5, the
new typography and radius scales, the motion table, and the reasoning behind the
warning-hue move so the next person does not "fix" it back to amber.

No other canonical doc is affected. `docs/features/DASHBOARDS.md` describes
dashboard *behaviour and content*, none of which changes; `docs/api/` and
`docs/security/` are untouched because no contract, endpoint, metric or auth
path is involved. This is the justification CLAUDE.md's Documentation-First
policy asks for when a change does not require broader doc updates.

## 12. Sequencing

Detailed steps belong in the implementation plan, not here. The phase order is
constrained, though: the gallery must exist **before** the tokens change, or
there is no way to see what the tokens did.

1. Style gallery against the current design system.
2. `framer-motion` → `motion` swap (isolated, independently verifiable).
3. Tokens + `tailwind.config.js` (colour, `--rule`, radius scale).
4. Primitives.
5. Page-level `tracking-[…]` sweep; `rounded-full` / `shadow-sm` review.
6. DESIGN-SYSTEM.md rewrite.

Review gates after 1, 3 and 4.
