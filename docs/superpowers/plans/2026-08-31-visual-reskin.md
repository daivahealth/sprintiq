# Editorial-Contrast Visual Re-skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the SprintIQ frontend a new visual identity — editorial contrast on a sienna accent — by retuning design tokens and restyling the existing primitives, without changing a single page layout, route, hook or API call.

**Architecture:** The frontend has zero raw Tailwind palette classes; every colour resolves through a CSS variable in `src/index.css`. So colour is changed centrally by replacing token *values*. Shape is changed centrally by remapping Tailwind's `borderRadius` scale in `tailwind.config.js`, which re-shapes 48 hardcoded `rounded-*` utilities in page files without editing them. Only structural class changes (box → rule, pill → square, sentence-case → wide-tracked caps) require touching the 11 affected primitives in `src/components/ui/`.

**Tech Stack:** React 18, TypeScript 5.5, Vite 5, Tailwind CSS 3.4 (`darkMode: 'class'`), `class-variance-authority`, `motion` (replacing `framer-motion@13`), Vitest 2 (node environment, no DOM).

**Spec:** `docs/superpowers/specs/2026-08-31-visual-reskin-design.md` — read it before starting. This plan argues from it and does not restate its reasoning.

**Branch:** `design/editorial-reskin` (already created; the spec is committed there as `f6743cd`).

## Global Constraints

- **No shadcn, no Radix, no token rename.** Decided in spec §1. Token *names* never change; only values.
- **Token values are space-separated RGB channels, never hex** — `--brand: 184 72 26`. A hex value silently breaks every opacity-modifier utility (`bg-brand/5`, `ring-brand/20`) via the `rgb(var(--x) / <alpha-value>)` contract in `tailwind.config.js`.
- **Never introduce a raw Tailwind palette class** (`slate-*`, `emerald-*`, `indigo-*`, …). Currently at zero across the whole frontend; Task 2 adds a test that keeps it there.
- **Never interpolate a class name.** Tailwind's scanner is a regex over source text, not an evaluator — `` `stroke-chart-${i}` `` is invisible to it and ships as nothing. Applies to `cn()` arguments, the `COLORS`/`DOT_COLORS`/`LEGEND_DOT_COLORS` arrays, and `BarList`'s `color` prop.
- **Primitive variant APIs, prop types and exported names do not change.** `BadgeTone` stays `'neutral' | 'good' | 'warn' | 'bad'` — three call sites (`PACE_TONE`, `MetricRowsTable` confidence thresholds, `TypeBadge`) type against that exact union.
- **Provenance text stays sentence case at `text-xs text-fg-subtle`.** Spec §5 — legibility of lineage/freshness text is a CLAUDE.md data-trust requirement and outranks the visual direction.
- **Contrast floor 4.5:1** for `{status}-fg` on `{status}-bg` and `on-brand` on `brand`, in both themes.
- **Tests are node-environment only.** `vitest.config.ts` sets `environment: 'node'` and `include: ['src/**/*.test.ts']`. There is no jsdom and no React Testing Library. Component *rendering* cannot be tested — do not add a `.test.tsx`, it will not even be collected.
- **Every command runs from `frontend/`.**
- **Visual claims must be labelled unverified.** Browser automation is unavailable in this environment and the running app is on a remote host. `tsc`/`eslint`/`build`/`vitest` prove compilation and logic, never appearance.

---

## File Structure

**Created:**
- `frontend/src/modules/styleguide/StyleguidePage.tsx` — dev-only review surface rendering every primitive in every variant, both themes.
- `frontend/src/design-system.test.ts` — guard tests over `index.css` and the source tree (token parity, channel format, contrast contract, palette-leak, class interpolation).

**Modified:**
- `frontend/src/app/router.tsx` — mount the styleguide route under `import.meta.env.DEV`.
- `frontend/src/index.css` — replace both token blocks.
- `frontend/tailwind.config.js` — register `rule` colour; remap `borderRadius`.
- `frontend/src/components/ui/{button,badge,card,status-dot,nav-item,table,segmented-control,input,field,filter-bar,skeleton}.tsx` — 11 primitives.
- `frontend/src/components/{multi-select,search-select}.tsx`, `frontend/src/providers/app-providers.tsx` — motion import swap.
- `frontend/src/modules/dashboards/widgets.tsx` — metric type scale + KPI settle.
- `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx` — tab rule wipe.
- 11 further page files — `tracking-[…]` sweep and the four `rounded-full`/`shadow-sm` sites.
- `frontend/package.json` — `framer-motion` out, `motion` in.
- `docs/development/DESIGN-SYSTEM.md` — rewritten.

**Deliberately untouched:** `spinner.tsx`, `provenance-note.tsx`, and `TableBodyRow` in `table.tsx`. All three are already token-only; the new palette reaches them without a code change. Editing them would be churn.

## Review Gates

Spec §12 requires human review after its phases 1, 3 and 4. Those map to **Task 1**, **Task 4** and **Task 5** here (this plan splits the spec's phase 3 into guard tests + token change). Stop at each and hand back for human review — the executing agent cannot see rendered output and must not self-certify appearance.

---

### Task 1: Dev-only style gallery

This must land **before** any token changes. It is the surface the whole re-skin gets reviewed on, and it is worthless if built after the thing it exists to show.

**Files:**
- Create: `frontend/src/modules/styleguide/StyleguidePage.tsx`
- Modify: `frontend/src/app/router.tsx`

**Interfaces:**
- Consumes: every export of `frontend/src/components/ui/index.ts`.
- Produces: route `/_styleguide`, dev builds only. Nothing imports `StyleguidePage` except the router.

**No unit test.** The gallery is a `.tsx` component and `vitest` here is node-environment with no DOM (see Global Constraints). Its verification is `npm run build` plus a human opening the page. Do not fabricate a test for it.

- [ ] **Step 1: Create the gallery page**

Both themes are shown side by side by putting `.dark` on a wrapper div — the token blocks are plain CSS custom properties, so re-declaring them on any ancestor re-themes that subtree. No store, no toggle, no state.

```tsx
// frontend/src/modules/styleguide/StyleguidePage.tsx
import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Field,
  FilterBar,
  Input,
  NavItem,
  ProvenanceNote,
  SegmentedControl,
  Skeleton,
  Spinner,
  StatusDot,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { cn } from '../../lib/utils';

/**
 * Dev-only review surface for the design system. Mounted at `/_styleguide`
 * under `import.meta.env.DEV` only, and deliberately outside `RequireAuth` so
 * it renders with no backend and no login.
 *
 * It exists because this repository has no component tests — `vitest` runs in a
 * node environment with no DOM. `tsc`, `eslint` and `vite build` prove the
 * primitives compile; only a person looking at this page can say whether they
 * look right. Keep it current when adding a primitive.
 */

const CHART_SWATCHES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
] as const;

const ROWS = [
  { repo: 'sprintiq/api', prs: 12, linked: '94%', tone: 'good' as const },
  { repo: 'sprintiq/web', prs: 7, linked: '71%', tone: 'warn' as const },
  { repo: 'sprintiq/infra', prs: 3, linked: '38%', tone: 'bad' as const },
  { repo: 'sprintiq/collectors', prs: 9, linked: '88%', tone: 'good' as const },
  { repo: 'sprintiq/docs', prs: 1, linked: '52%', tone: 'warn' as const },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Gallery() {
  return (
    <div className="min-h-full bg-canvas p-6 text-fg">
      <div className="space-y-8">
        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Run analysis</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">Details</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="primary" disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Badges and status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">Neutral</Badge>
            <Badge tone="good">On track</Badge>
            <Badge tone="warn">At risk</Badge>
            <Badge tone="bad">Blocked</Badge>
            <StatusDot tone="good" />
            <StatusDot tone="warn" />
            <StatusDot tone="bad" />
            <StatusDot tone="neutral" size="md" />
            <Spinner />
          </div>
        </Section>

        <Section title="Status tints on popover surface">
          <div className="flex flex-wrap items-center gap-2 bg-popover p-3">
            <Badge tone="good">On track</Badge>
            <Badge tone="warn">At risk</Badge>
            <Badge tone="bad">Blocked</Badge>
          </div>
        </Section>

        <Section title="KPI trio">
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Cycle time', '3.2d', '−0.4d vs prev'],
              ['Review latency', '14h', '+2h vs prev'],
              ['Deploy freq', '4.1/d', 'stable'],
            ].map(([label, value, hint]) => (
              <Card key={label}>
                <div className="text-[28px] font-bold tracking-[-0.045em] tabular-nums text-fg">
                  {value}
                </div>
                <div className="text-xs text-fg-subtle">{label}</div>
                <div className="mt-0.5 text-[11px] text-fg-faint">{hint}</div>
              </Card>
            ))}
          </div>
        </Section>

        <Section title="Dense table">
          <Card>
            <table className="w-full">
              <thead>
                <TableHeadRow>
                  <th className="py-2 pr-3">Repository</th>
                  <th className="py-2 pr-3">Open PRs</th>
                  <th className="py-2 pr-3">Linked</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <TableBodyRow key={r.repo}>
                    <td className="py-2.5 pr-3 text-sm">
                      <StatusDot tone={r.tone} /> {r.repo}
                    </td>
                    <td className="py-2.5 pr-3 text-sm tabular-nums">{r.prs}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={r.tone}>{r.linked}</Badge>
                    </td>
                  </TableBodyRow>
                ))}
              </tbody>
            </table>
            <ProvenanceNote className="mt-3">
              Computed 6 minutes ago · 214 events · linkage coverage 78%
            </ProvenanceNote>
          </Card>
        </Section>

        <Section title="Chart series">
          <div className="flex items-end gap-1">
            {CHART_SWATCHES.map((c, i) => (
              <span key={c} className={cn(c, 'block w-8')} style={{ height: 24 + i * 8 }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-fg-subtle">
            {CHART_SWATCHES.map((c, i) => (
              <span key={c} className="flex items-center gap-1.5">
                <span className={cn(c, 'inline-block h-2 w-2')} />
                Series {i + 1}
              </span>
            ))}
          </div>
        </Section>

        <Section title="Controls">
          <FilterBar>
            <Field label="Repository">
              <Input placeholder="sprintiq/api" />
            </Field>
            <Field label="Disabled">
              <Input placeholder="Disabled" disabled />
            </Field>
            <SegmentedControl
              label="Range"
              value="30d"
              options={[
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: '90d', label: '90 days' },
              ]}
              onChange={() => undefined}
            />
          </FilterBar>
        </Section>

        <Section title="Navigation">
          <div className="w-56 space-y-1">
            <NavItem to="/_styleguide" active>Active item</NavItem>
            <NavItem to="/_styleguide/never">Inactive item</NavItem>
          </div>
        </Section>

        <Section title="Skeletons">
          <div className="space-y-2">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Section>
      </div>
    </div>
  );
}

export function StyleguidePage() {
  return (
    <div className="grid min-h-screen grid-cols-2">
      <Gallery />
      <div className="dark">
        <Gallery />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount the route, dev only**

In `frontend/src/app/router.tsx`, add the import beside the other module imports:

```tsx
import { StyleguidePage } from '../modules/styleguide/StyleguidePage';
```

and add this as the **first** child of `<Routes>`, directly above `<Route path="/login" …>`:

```tsx
      {/* Design-system review surface. Dev builds only, and deliberately
          outside RequireAuth/DashboardLayout so it renders with no backend
          and no login — it exists to show the primitives, not the app. */}
      {import.meta.env.DEV ? (
        <Route path="/_styleguide" element={<StyleguidePage />} />
      ) : null}
```

Use the ternary, not `&&`. React Router builds its route tree with `React.Children.forEach` and skips anything failing `isValidElement`, so `null` is safe — `false` is too, but the ternary makes the intent unambiguous to the next reader.

- [ ] **Step 3: Verify it compiles and ships nothing in production**

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: all three pass. Then confirm the gallery is tree-shaken out of the production bundle:

```bash
grep -rl "Dense table" dist/assets/ | head
```

Expected: **no output.** `import.meta.env.DEV` is statically replaced with `false` at build time, so Rollup drops the branch and the component with it. If this prints a file, the dead-code elimination did not happen — stop and report it rather than shipping a dev page to production.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modules/styleguide/StyleguidePage.tsx frontend/src/app/router.tsx
git commit -F - <<'EOF'
Add a page where the design system can be looked at

The frontend has no component tests — vitest runs in a node environment
with no DOM — so nothing mechanical can say whether a primitive looks
right. This renders all fourteen in every variant, both themes side by
side, on one page.

Dev builds only, and outside the auth wrapper: it describes the design
system, not the product, and should not need a backend to open.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: STOP — review gate 1**

Hand back to the human. Ask them to run `npm run dev` and open `/_styleguide`, confirming the gallery covers everything they want to review *before* the palette changes underneath it. This is the baseline they will compare against.

---

### Task 2: Design-system guard tests

These encode the rules that make the whole approach safe. They are written against the **current** tokens and must pass immediately — they are regression guards, not red-then-green tests. If any fails now, that is a pre-existing bug in the current design system: stop and report it rather than editing the test to accommodate it.

**Files:**
- Create: `frontend/src/design-system.test.ts`

**Interfaces:**
- Consumes: `frontend/src/index.css`, and the `frontend/src/` tree as text.
- Produces: nothing importable. Later tasks rely on these tests continuing to pass.

- [ ] **Step 1: Write the test file**

```ts
// frontend/src/design-system.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the design system itself, not on any component.
 *
 * Three of these encode rules that fail *silently* when broken — a hex token
 * kills every `bg-brand/5` in the app, an interpolated class name is invisible
 * to Tailwind's regex scanner and simply never ships, and a status pair that
 * drops under 4.5:1 is unreadable rather than absent. None of them would be
 * caught by tsc, eslint or a build.
 */

const SRC = join(process.cwd(), 'src');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

function parseBlock(pattern: RegExp): Map<string, string> {
  const match = CSS.match(pattern);
  if (!match) throw new Error(`token block not found: ${pattern}`);
  const tokens = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const decl = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
    if (decl) tokens.set(decl[1], decl[2].trim());
  }
  return tokens;
}

const LIGHT = parseBlock(/:root\s*\{([\s\S]*?)\n\}/);
const DARK = parseBlock(/\.dark\s*\{([\s\S]*?)\n\}/);

/** WCAG 2.x relative luminance from an "R G B" channel triple. */
function luminance(channels: string): number {
  const [r, g, b] = channels.split(/\s+/).map((n) => {
    const c = Number(n) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => join(SRC, f));
}

describe('token blocks', () => {
  it('define exactly the same token names in both themes', () => {
    expect([...DARK.keys()].sort()).toEqual([...LIGHT.keys()].sort());
  });

  it('express every token as space-separated RGB channels, never hex', () => {
    for (const [theme, tokens] of [['light', LIGHT], ['dark', DARK]] as const) {
      for (const [name, value] of tokens) {
        expect(
          value,
          `${theme} ${name} must be "R G B" channels — a hex value silently ` +
            'breaks every opacity-modifier utility (bg-brand/5, ring-brand/20)',
        ).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      }
    }
  });
});

describe('contrast contract', () => {
  const PAIRS: [fg: string, bg: string][] = [
    ['--success-fg', '--success-bg'],
    ['--warning-fg', '--warning-bg'],
    ['--danger-fg', '--danger-bg'],
    ['--on-brand', '--brand'],
  ];

  for (const [theme, tokens] of [['light', LIGHT], ['dark', DARK]] as const) {
    for (const [fg, bg] of PAIRS) {
      it(`${theme}: ${fg} on ${bg} is at least 4.5:1`, () => {
        const fgValue = tokens.get(fg);
        const bgValue = tokens.get(bg);
        expect(fgValue, `${theme} ${fg} missing`).toBeDefined();
        expect(bgValue, `${theme} ${bg} missing`).toBeDefined();
        expect(contrast(fgValue!, bgValue!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('source hygiene', () => {
  it('uses no raw Tailwind palette classes', () => {
    const raw =
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    const offenders = sourceFiles().filter((f) => raw.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      'every colour must reference a semantic token so dark mode and ' +
        're-theming stay a token edit rather than a per-file hunt',
    ).toEqual([]);
  });

  it('never interpolates a Tailwind class name', () => {
    // Tailwind's scanner is a regex over source text, not an evaluator:
    // `stroke-chart-${i}` is invisible to it and ships as nothing at all.
    const interpolated = /`[^`]*\b(?:bg|text|border|ring|fill|stroke)-[a-z-]*\$\{/;
    const offenders = sourceFiles().filter((f) =>
      interpolated.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests against the current design system**

```bash
npm run test
```

Expected: **all pass**, including the two pre-existing test files. The tightest margin is light-mode `--warning-fg` on `--warning-bg`, which sits at ≈4.51 — barely over the floor. That is expected and is one of the reasons the spec moves warning to mustard (≈5.41) in Task 4.

If a contrast assertion fails, do not relax the threshold. Report it: it means the current palette violates the contract DESIGN-SYSTEM.md claims it meets.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/design-system.test.ts
git commit -F - <<'EOF'
Test the design system's rules, not just its components

Each of these guards a failure that is silent by nature: a hex token kills
every opacity-modifier utility, an interpolated class name never reaches
Tailwind's scanner, and a status pair below 4.5:1 renders unreadable rather
than missing. None of them shows up in tsc, eslint or a build.

Written before the re-skin so the palette that replaces the current one has
to clear the same bar.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Swap `framer-motion` for `motion`

Isolated and independently verifiable, so it lands on its own before anything visual moves.

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/providers/app-providers.tsx:2`
- Modify: `frontend/src/components/multi-select.tsx:1`
- Modify: `frontend/src/components/search-select.tsx:1`

**Interfaces:**
- Produces: `motion/react` as the import path for `motion`, `AnimatePresence`, `MotionConfig`. Task 7 depends on this.

- [ ] **Step 1: Swap the dependency**

```bash
npm uninstall framer-motion
npm install motion
```

If the registry is unreachable (this environment sits behind a TLS-inspecting proxy — `gh` already fails certificate verification here), **stop and report**. Do not hand-edit `package.json` to fake the install; a lockfile that disagrees with `node_modules` is worse than a blocked task.

- [ ] **Step 2: Update the three import sites**

`framer-motion@13` and `motion` are the same library — Motion is the renamed successor and v13 already *is* that codebase. Only the specifier changes; every API is identical.

In `frontend/src/providers/app-providers.tsx`, line 2:

```tsx
import { MotionConfig } from 'motion/react';
```

In `frontend/src/components/multi-select.tsx`, line 1:

```tsx
import { AnimatePresence, motion } from 'motion/react';
```

In `frontend/src/components/search-select.tsx`, line 1:

```tsx
import { AnimatePresence, motion } from 'motion/react';
```

- [ ] **Step 3: Verify no reference survives**

```bash
grep -rn "framer-motion" src/ package.json
```

Expected: **no output.**

```bash
npm run typecheck && npm run lint && npm run build && npm run test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/providers/app-providers.tsx frontend/src/components/multi-select.tsx frontend/src/components/search-select.tsx
git commit -F - <<'EOF'
Call the animation library by its current name

framer-motion@13 already is Motion; the project renamed and the old package
name trails it. Imports move to motion/react. Same library, same API, no
behaviour change — MotionConfig reducedMotion="user" still collapses every
animation under an OS-level reduced-motion preference.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Tokens, `--rule`, and the radius scale

The colour and shape change. Every page changes appearance at this point; no page file is edited.

**Files:**
- Modify: `frontend/src/index.css` (both token blocks)
- Modify: `frontend/tailwind.config.js`

**Interfaces:**
- Produces: token values per spec §4; a new `rule` colour yielding `border-rule` / `bg-rule` / `text-rule`; a remapped `borderRadius` scale. Task 5 consumes all three.

- [ ] **Step 1: Replace the light token block**

In `frontend/src/index.css`, replace the body of `:root { … }` — keep `color-scheme: light;` as its first line and keep the explanatory comment above the block:

```css
  --brand: 184 72 26;
  --brand-fg: 247 236 230;
  --brand-muted: 143 54 18;
  --on-brand: 255 255 255;

  --canvas: 255 255 255;
  --surface: 255 255 255;
  --popover: 255 255 255;
  --subtle: 250 250 249;
  --muted: 244 244 242;
  --muted-strong: 232 232 229;

  --fg: 17 17 20;
  --fg-secondary: 46 46 52;
  --fg-muted: 90 90 99;
  --fg-subtle: 107 107 118;
  --fg-faint: 143 143 156;

  --border: 230 230 234;
  --border-subtle: 240 240 243;
  --border-strong: 196 196 203;
  --rule: 17 17 20;

  --success: 47 111 82;
  --success-fg: 26 107 69;
  --success-bg: 220 239 228;
  --success-border: 190 222 205;

  --warning: 154 123 16;
  --warning-fg: 122 90 16;
  --warning-bg: 245 236 212;
  --warning-border: 230 214 170;

  --danger: 168 32 47;
  --danger-fg: 143 22 32;
  --danger-bg: 246 220 220;
  --danger-border: 234 194 194;
  --danger-solid: 168 32 47;
  --danger-solid-hover: 143 22 32;
  --on-danger: 255 255 255;

  --chart-1: 184 72 26;
  --chart-2: 47 111 82;
  --chart-3: 61 90 138;
  --chart-4: 143 22 32;
  --chart-5: 154 123 16;
  --chart-6: 90 78 120;
  --chart-grid: 240 240 243;
  --chart-axis: 143 143 156;
  --chart-empty: 240 240 243;
```

- [ ] **Step 2: Replace the dark token block**

Replace the body of `.dark { … }`, keeping `color-scheme: dark;` as its first line:

```css
  --brand: 224 114 60;
  --brand-fg: 46 26 16;
  --brand-muted: 240 160 113;
  --on-brand: 26 13 6;

  --canvas: 13 13 16;
  --surface: 13 13 16;
  --popover: 26 26 31;
  --subtle: 21 21 25;
  --muted: 32 32 38;
  --muted-strong: 45 45 52;

  --fg: 240 240 242;
  --fg-secondary: 214 214 219;
  --fg-muted: 168 168 178;
  --fg-subtle: 143 143 156;
  --fg-faint: 112 112 124;

  --border: 42 42 49;
  --border-subtle: 32 32 38;
  --border-strong: 62 62 71;
  --rule: 240 240 242;

  --success: 79 184 127;
  --success-fg: 95 199 142;
  --success-bg: 18 48 31;
  --success-border: 30 74 50;

  --warning: 217 185 92;
  --warning-fg: 224 185 92;
  --warning-bg: 46 36 16;
  --warning-border: 74 60 26;

  --danger: 224 90 105;
  --danger-fg: 240 138 149;
  --danger-bg: 51 21 26;
  --danger-border: 82 34 42;
  --danger-solid: 199 58 74;
  --danger-solid-hover: 216 78 93;
  --on-danger: 255 255 255;

  --chart-1: 224 114 60;
  --chart-2: 79 184 127;
  --chart-3: 107 147 214;
  --chart-4: 224 90 105;
  --chart-5: 217 185 92;
  --chart-6: 154 138 198;
  --chart-grid: 32 32 38;
  --chart-axis: 112 112 124;
  --chart-empty: 32 32 38;
```

Note `--surface` is now identical to `--canvas` in both themes. That is deliberate (spec §4.4): cards stop being filled boxes and become ruled regions. `--popover` stays distinct so floating layers still lift where shadows do not read.

- [ ] **Step 3: Register `rule` and remap the radius scale**

In `frontend/tailwind.config.js`, add to `theme.extend.colors`, directly after the `border` group:

```js
        rule: 'rgb(var(--rule) / <alpha-value>)',
```

and add a sibling of `colors` inside `theme.extend`:

```js
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
        full: '9999px',
      },
```

- [ ] **Step 4: Run the guard tests against the new palette**

```bash
npm run test
```

Expected: **all pass**, including all eight contrast assertions. The margins improve over the old palette — light warning moves from ≈4.51 to ≈5.41.

If a contrast test fails, the token values are wrong, not the test. Fix the value.

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/tailwind.config.js
git commit -F - <<'EOF'
Repaint the whole application from its tokens

Editorial contrast on a sienna accent: near-black ink on paper, and surface
collapsed into canvas so cards read as ruled regions rather than filled
boxes. Adds --rule for the heavy ink line; --border-strong already means
"input border" and overloading it would break that contract.

Warning moves from amber to mustard. Amber and sienna are close enough that
brand and caution stop reading as different ideas, which matters more here
than in most products: a caution badge is a claim about delivery, not
decoration. Chart series 3 leaves amber for the same reason.

Remapping Tailwind's borderRadius scale re-shapes the ~48 hardcoded
rounded-* utilities in the page modules without editing any of them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: STOP — review gate 2**

Hand back. The human opens `/_styleguide` in both themes. The specific question the spec cares about: **do the sienna primary button and the mustard "at risk" badge read as different ideas?** That is the one judgement no test in this plan can make. Also ask them to check the status tints against both `canvas` and `popover` — the second half of the contrast contract is "visually distinct from the surface it sits on", which is not computable.

---

### Task 5: Restyle the primitives

Structural class changes only. No variant API, prop type or export name moves.

**Files:**
- Modify: `frontend/src/components/ui/card.tsx`
- Modify: `frontend/src/components/ui/badge.tsx`
- Modify: `frontend/src/components/ui/button.tsx`
- Modify: `frontend/src/components/ui/table.tsx`
- Modify: `frontend/src/components/ui/nav-item.tsx`
- Modify: `frontend/src/components/ui/status-dot.tsx`
- Modify: `frontend/src/components/ui/segmented-control.tsx`
- Modify: `frontend/src/components/ui/input.tsx`
- Modify: `frontend/src/components/ui/field.tsx`
- Modify: `frontend/src/components/ui/filter-bar.tsx`
- Modify: `frontend/src/components/ui/skeleton.tsx`

**Interfaces:**
- Consumes: `border-rule` and the remapped radius scale from Task 4.
- Produces: unchanged public API. `Button` keeps `variant`/`size`; `Badge` and `StatusDot` keep their `tone` unions; `SegmentedControl<T>` keeps its generic signature.

- [ ] **Step 1: `Card` — box becomes rule**

Replace the class string in `card.tsx`:

```tsx
        'border-t-2 border-rule bg-surface p-4',
```

`p-4` is retained deliberately. Dropping horizontal padding would push content flush to the card edge and change every page's layout — this is a re-skin, and the spec forbids layout changes. The `shadow-sm dark:shadow-none` pair is removed entirely; shadows have no role in this language.

- [ ] **Step 2: `Badge` — pill becomes squared caps**

Replace the base string in `badge.tsx`, leaving the `variants` object and the `BadgeTone` type untouched:

```tsx
  'inline-flex items-center rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]',
```

- [ ] **Step 3: `Button` — ruled secondary, sienna primary**

Replace the base string and the `variant` block in `button.tsx`:

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-sm font-semibold tracking-[0.02em] transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-on-brand hover:bg-brand-muted',
        secondary: 'border border-fg bg-transparent text-fg hover:bg-muted',
        ghost: 'bg-transparent text-brand hover:bg-brand/5',
        destructive: 'bg-danger-solid text-on-danger hover:bg-danger-solid-hover',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);
```

Button labels stay sentence case. The approved mockup rendered them that way, and uppercase would reflow every button in the app — a layout change the spec rules out.

- [ ] **Step 4: `TableHeadRow` — the ink rule**

Replace only the `TableHeadRow` class string in `table.tsx`:

```tsx
        'border-b-2 border-rule text-left text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted',
```

Header text moves from `fg-faint` to `fg-muted`: bold 10px caps need more contrast than the mixed-case 11px they replace. **`TableBodyRow` is not edited** — its hairline divider already reads correctly against the new tokens.

- [ ] **Step 5: `NavItem` — squared tint block**

Replace the `cn(...)` body in `nav-item.tsx`:

```tsx
          'block rounded-sm px-3 py-2 text-sm font-medium transition',
          active ?? isActive
            ? 'bg-brand-fg text-brand-muted'
            : 'text-fg-muted hover:bg-subtle',
```

Active text moves from `text-brand` to `text-brand-muted`. `brand-fg` is a *tint background*, and the token pairs invert correctly by theme: light gives dark sienna on a pale tint, dark gives light sienna on a deep tint. `text-brand` would be low-contrast on the tint in dark mode.

- [ ] **Step 6: `StatusDot` — square**

Replace the first `cn(...)` argument in `status-dot.tsx`:

```tsx
        'inline-block rounded-none',
```

- [ ] **Step 7: `SegmentedControl` — ruled track, ink active**

In `segmented-control.tsx`, replace the track wrapper class:

```tsx
      <div className="flex overflow-hidden rounded-sm border border-border-strong">
```

and the active/inactive branch:

```tsx
              value === opt.value
                ? 'bg-fg text-canvas'
                : 'bg-surface text-fg-muted hover:bg-subtle',
```

Active goes to ink rather than the brand tint, per spec §6 — it keeps a *control* visually distinct from *navigation*, which uses the sienna tint.

Also update the label above it to the section-head type:

```tsx
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted">
```

- [ ] **Step 8: `Input` and `Field`**

In `input.tsx`, change `rounded-md` to `rounded-sm` in the first class string. The `focus:border-brand focus:ring-2 focus:ring-brand/20` line already resolves to sienna through the tokens — leave it.

In `field.tsx`, replace the label span so field labels match the section-head role:

```tsx
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted">{label}</span>
```

- [ ] **Step 9: `FilterBar` — rule beneath instead of a box**

Replace the class string in `filter-bar.tsx`:

```tsx
        'flex flex-wrap items-end gap-3 border-b border-border pb-4',
```

- [ ] **Step 10: `Skeleton`**

Replace `rounded-md` with `rounded-sm` in `skeleton.tsx`. The `animate-pulse … motion-reduce:animate-none` pair stays.

- [ ] **Step 11: Verify**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: all pass. The `source hygiene` tests from Task 2 specifically confirm no raw palette class crept in.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/components/ui/
git commit -F - <<'EOF'
Draw the primitives with rules instead of boxes

Cards become ruled regions, badges squared caps, the table head an ink rule,
status dots square, the filter bar a line rather than a container. Secondary
buttons become an outline; primary carries the sienna.

Every variant API, prop type and export name is unchanged — BadgeTone still
reads neutral/good/warn/bad because three call sites type against that exact
union. Spinner, ProvenanceNote and TableBodyRow are untouched: they were
already token-only and the new palette reaches them without an edit.

Provenance stays sentence case against the direction. Wide-tracked caps read
worse at small sizes, and freshness and lineage text is the one place the UI
tells you how much to trust a number.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 13: STOP — review gate 3**

Hand back. The human reviews `/_styleguide`, then the two densest real pages — `/engineering-activity/overview` (`MetricRowsTable`) and `/admin/sync-status`. The spec's stated risk is that rules-instead-of-boxes flatters a KPI trio and turns austere on dense grids. This is where that gets decided.

---

### Task 6: Page-level sweep

The literals that neither tokens nor the radius remap can reach.

**Files:**
- Modify: `frontend/src/modules/admin/AdminConfigurationsPage.tsx:359,399`
- Modify: `frontend/src/modules/admin/AdminUsersPage.tsx:55,75`
- Modify: `frontend/src/modules/admin/SyncStatusPage.tsx:107,262,536`
- Modify: `frontend/src/modules/auth/LoginPage.tsx:43`
- Modify: `frontend/src/modules/dashboards/activity-boards.tsx:27`
- Modify: `frontend/src/modules/dashboards/boards.tsx:43,296`
- Modify: `frontend/src/modules/dashboards/DeliveryDashboard.tsx:44`
- Modify: `frontend/src/modules/dashboards/TopRepos.tsx:43`
- Modify: `frontend/src/modules/dashboards/widgets.tsx:26`
- Modify: `frontend/src/modules/dashboards/ProjectActivityChart.tsx:158`
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx:79`
- Modify: `frontend/src/components/layout/DashboardLayout.tsx:98`

- [ ] **Step 1: Page titles**

Every `text-xl font-semibold tracking-[-0.02em]` becomes `text-xl font-bold tracking-[-0.035em]`. Sites: `activity-boards.tsx:27`, `boards.tsx:43`, `DeliveryDashboard.tsx:44`, `TopRepos.tsx:43`, `DeveloperActivitySection.tsx:79`, `SyncStatusPage.tsx:536`.

The two `text-2xl font-semibold tracking-[-0.02em]` headings — `AdminConfigurationsPage.tsx:359`, `AdminUsersPage.tsx:55` — become `text-2xl font-bold tracking-[-0.035em]`.

- [ ] **Step 2: Wordmark and login heading**

`DashboardLayout.tsx:98` and `LoginPage.tsx:43` both use `text-lg font-semibold tracking-[-0.01em]`. Both become `text-lg font-bold tracking-[-0.025em]`.

- [ ] **Step 3: Metric values**

`widgets.tsx:26` and `SyncStatusPage.tsx:107` both use `text-2xl font-semibold tracking-[-0.03em] tabular-nums`. Both become:

```
text-[28px] font-bold tracking-[-0.045em] tabular-nums
```

- [ ] **Step 4: The fake table header**

`AdminUsersPage.tsx:75` is a CSS-grid table head that hand-rolls what `TableHeadRow` now provides. Replace its type classes so the two do not drift — change `text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-faint` to:

```
text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted
```

and change its `border-b border-border` to `border-b-2 border-rule` to match.

- [ ] **Step 5: The four round/shadow sites**

The spec guessed these were avatars and pill counters. They are not — read them before editing. What is actually there:

- `AdminConfigurationsPage.tsx:399` — `h-1.5 w-1.5 shrink-0 rounded-full bg-warning`, an ad-hoc status dot. Change `rounded-full` to `rounded-none` so it matches `StatusDot`.
- `ProjectActivityChart.tsx:158` — `h-2 w-2 rounded-full` legend swatch. Change to `rounded-none`, matching `StatusDot` and the squared marks. Leave `LEGEND_DOT_COLORS[i % …]` exactly as it is: it is a static-literal array indexed at runtime, which is fine — what Tailwind cannot see is an interpolated *class name*, not an indexed lookup.
- `SyncStatusPage.tsx:262` — `h-2 w-full overflow-hidden rounded-full bg-muted`, a progress track. Change to `rounded-none`.
- `boards.tsx:296` — `space-y-2 rounded-xl border bg-surface p-4 text-left shadow-sm transition hover:border-brand/60`. Drop `shadow-sm`. Leave `rounded-xl` (now 4px via the remap) and the hover state.

There are no avatars among them, so nothing keeps `rounded-full`.

- [ ] **Step 6: Verify**

```bash
grep -rn "rounded-full\|shadow-sm" src/modules src/components
```

Expected: **no output.**

Then check the chart mark/legend pairing that spec §10 requires — the legend swatch was just edited, so this is where it can drift:

```bash
grep -n "DOT_COLORS\|LEGEND_DOT_COLORS\|^const COLORS" src/modules/dashboards/ProjectActivityChart.tsx
```

Read the two arrays. `DOT_COLORS` (SVG marks, `fill-chart-N`) and `LEGEND_DOT_COLORS` (HTML swatches, `bg-chart-N`) must be the same length and name the same `chart-N` index at every position. They are parallel arrays kept in sync by hand, and drift between them is invisible — the legend simply describes the wrong series. If they disagree, fix the array; do not proceed.

Both must remain static string literals. `fill-*` is SVG-only and has no effect on an HTML element, which is why the legend uses `bg-*` and the marks use `fill-*` rather than sharing one array.

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/modules frontend/src/components/layout
git commit -F - <<'EOF'
Bring the hardcoded type and shape literals in line

Tokens carry colour and the remapped radius scale carries shape, but page
titles, metric values and a hand-rolled grid header spell their tracking out
inline and had to be swept by hand.

The four rounded-full and shadow-sm sites turned out to be status dots, a
chart legend swatch and a progress track — not the avatars and pill counters
the design assumed — so all four square off rather than staying round.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Motion character

Two animations, matching the direction's stillness. Spec §8 explicitly rules out springs, hover lift, route transitions and layout animations — do not add them.

**Files:**
- Modify: `frontend/src/modules/dashboards/widgets.tsx`
- Modify: `frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx`
- Modify: `frontend/src/components/multi-select.tsx`
- Modify: `frontend/src/components/search-select.tsx`

**Interfaces:**
- Consumes: `motion/react` from Task 3; the metric type scale from Task 6.

- [ ] **Step 1: KPI settle**

In `widgets.tsx`, add to the imports:

```tsx
import { motion } from 'motion/react';
```

and replace the value `<div>` inside `Stat`:

```tsx
      <motion.div
        // Re-keyed on the value so a changed figure animates in rather than
        // swapping silently: when the range changes, every number on the page
        // changes at once, and a still swap reads as nothing having happened.
        key={String(value)}
        initial={{ opacity: 0, y: 1 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="text-[28px] font-bold tracking-[-0.045em] tabular-nums text-fg"
      >
        {value}
      </motion.div>
```

- [ ] **Step 2: Tab rule wipe**

In `DeveloperActivitySection.tsx`, add to the imports:

```tsx
import { motion } from 'motion/react';
```

and replace the `<NavLink>` inside `TABS.map` with a render-prop form that draws its own rule:

```tsx
            <NavLink
              key={tab.to}
              to={{ pathname: tab.to, search: `?${rangeParams(range)}` }}
              title={tab.title}
              className={({ isActive }) =>
                cn(
                  'relative whitespace-nowrap px-3 py-2 text-sm font-medium transition',
                  isActive
                    ? 'text-brand-muted'
                    : 'text-fg-muted hover:text-fg-secondary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {tab.label}
                  {isActive && (
                    <motion.span
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-brand"
                    />
                  )}
                </>
              )}
            </NavLink>
```

The static `border-b-2` classes come off the link — the animated rule replaces them. The wrapper's `border-b border-border` and the nav's `-mb-px` stay as they are, so the active rule still sits on the container's line.

This is a `scaleX` transform, not a `layoutId`. A shared-layout underline would be a layout animation, which spec §8 rules out.

- [ ] **Step 3: Bring the popovers to the standard timing**

Spec §8 fixes popovers at 120ms on the standard easing. The two existing popovers predate that table and set their own values.

Open `frontend/src/components/multi-select.tsx` and `frontend/src/components/search-select.tsx`, find the `<motion.div>` inside each `<AnimatePresence>`, and set its transition to:

```tsx
        transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
```

Leave each popover's `initial`/`animate`/`exit` offsets exactly as they are — only the duration and easing are being standardised. If a file already has these values, make no edit and say so.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: all pass. `MotionConfig reducedMotion="user"` in `app-providers.tsx` already collapses every one of these animations under an OS reduced-motion preference — do not add a `prefers-reduced-motion` check.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modules/dashboards/widgets.tsx frontend/src/modules/dashboards/developer-activity/DeveloperActivitySection.tsx frontend/src/components/multi-select.tsx frontend/src/components/search-select.tsx
git commit -F - <<'EOF'
Let a changed figure show that it changed

Two animations, both short and neither decorative. A metric settles when its
value changes, because a range switch rewrites every number on the page at
once and a silent swap reads as nothing having happened. A tab's rule wipes
in on selection. The two existing popovers move onto the same 120ms timing,
so every animation in the app now comes from one table.

No springs, no hover lift, no route transitions: the direction is a still
one, and motion here marks a state change rather than performing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Rewrite DESIGN-SYSTEM.md

CLAUDE.md's Documentation-First policy makes this part of the change, not follow-up. The current doc describes an indigo, boxed, rounded system that no longer exists.

**Files:**
- Modify: `docs/development/DESIGN-SYSTEM.md`

- [ ] **Step 1: Update the doc**

Read the current file in full first. Keep its structure — Principles, Token reference, Contrast contract, Chart tokens are structural, Typography, Primitives, Dark mode, Motion, Density, Adding a new color, Change policy — and keep every piece of reasoning that is still true. In particular **keep verbatim**: the RGB-channels-not-hex explanation, the Tailwind-scanner/static-literal rule, the `fill` vs `bg` legend-swatch warning, and the dark-mode three-moving-parts section. None of those changed.

Change:

1. **Token reference table** — add a `Rule` family row for `--rule`: the heavy ink line for section boundaries and table heads, deliberately separate from `border-strong` (which means input/control border) so neither is overloaded.
2. **Surface row** — record that `canvas` and `surface` are now the same value, and why: cards are ruled regions, not filled boxes. Keep the note that `popover` stays distinct so floating layers lift where shadows do not read.
3. **Contrast contract** — replace the prose with the measured table from spec §4.5 (light/dark for the three status pairs and `on-brand` on `brand`), and add: *"`src/design-system.test.ts` asserts this floor on every build. If a new value fails, change the value, not the threshold."*
4. **A new subsection, "Why warning is mustard"** — amber `245 158 11` sits too close to sienna `184 72 26`; brand and caution stopped reading as different ideas. `chart-3` left amber for the same reason. Say this explicitly, so the next person does not "fix" it back to amber.
5. **Typography table** — the new scale from spec §5, including the note that provenance stays sentence case at `text-xs text-fg-subtle` deliberately, against the visual direction, because lineage text has to stay legible.
6. **A new "Shape" subsection** — the remapped `borderRadius` scale, and the point that remapping it centrally is what let ~48 hardcoded `rounded-*` utilities change without page edits. Note `rounded-full` now has no call sites.
7. **Primitives table** — update `Card` (rule, no shadow), `Badge` (squared caps), `Button` (ruled secondary), `TableHeadRow` (ink rule, `fg-muted`), `NavItem` (`text-brand-muted`), `StatusDot` (square), `SegmentedControl` (ink active). Add a row for the `/_styleguide` gallery and say it is dev-only and where it lives.
8. **Motion section** — `framer-motion` becomes `motion` (imports from `motion/react`); add the four-row motion table from spec §8 and the explicit not-built list.
9. **Density** — unchanged, still `max-w-6xl` and `p-4`.

- [ ] **Step 2: Verify no stale references survive**

```bash
grep -n "framer-motion\|indigo\|shadow-sm\|rounded-full\|amber" docs/development/DESIGN-SYSTEM.md
```

Expected: matches only where the text is *explaining what changed and why* (the mustard subsection names amber deliberately). Any line still describing the old system as current is a bug — fix it.

- [ ] **Step 3: Commit**

```bash
git add docs/development/DESIGN-SYSTEM.md
git commit -F - <<'EOF'
Describe the system that now exists

Rewrites the token table, contrast contract, typography, shape and motion
sections for editorial contrast, and adds --rule and the style gallery.

Keeps the reasoning that did not change — RGB channels over hex, static class
literals over interpolation, fill versus bg for legend swatches — because
each of those records a failure that is silent when someone gets it wrong.

Records why warning is mustard rather than amber, so it does not get quietly
restored to a hue the brand can be confused with.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Final verification

Run from `frontend/`:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

All four must pass. Then confirm the invariants:

```bash
grep -rn "framer-motion" src/ package.json          # expect: nothing
grep -rn "rounded-full\|shadow-sm" src/             # expect: nothing
grep -rl "Dense table" dist/assets/                 # expect: nothing
```

**What none of this proves:** how any of it looks. Browser verification is unavailable in this environment and the app under test runs on a remote host. The final report must state plainly that every visual claim is unverified except the ones a human confirmed at review gates 1, 2 and 3, and must list what they actually looked at.

**Known open item, deliberately not addressed:** `multi-select.tsx` and `search-select.tsx` hand-roll focus trapping, roving tabindex and `aria-*`. Spec §2 records this as considered and deferred. It remains open after this plan completes.
