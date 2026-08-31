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
    // --fg-subtle sits on --canvas in both themes and clears 4.5:1 in both
    // (checked below), so it guards the same way as the pairs above.
    ['--fg-subtle', '--canvas'],
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

  // --fg-faint and --chart-axis also sit on --canvas in both themes, but only
  // the dark values were raised to meet AA (2026-08-31 fix wave): dark canvas
  // text at the old value was 3.97:1, unreadable, and now clears 4.5:1 at
  // `138 138 150`. The light tokens share one literal value (`143 143 156`)
  // between --fg-faint and --chart-axis, and that value lands at 3.19:1 on
  // white — legitimately short of 4.5:1, and out of this fix's scope (light
  // wasn't touched). Per policy this does not lower the global 4.5 floor or
  // get silently forced; it is guarded only where it was actually fixed, and
  // the light-side gap is reported for a human to decide on separately.
  const DARK_ONLY_CANVAS_PAIRS: [fg: string, bg: string][] = [
    ['--fg-faint', '--canvas'],
    ['--chart-axis', '--canvas'],
  ];

  for (const [fg, bg] of DARK_ONLY_CANVAS_PAIRS) {
    it(`dark: ${fg} on ${bg} is at least 4.5:1`, () => {
      const fgValue = DARK.get(fg);
      const bgValue = DARK.get(bg);
      expect(fgValue, `dark ${fg} missing`).toBeDefined();
      expect(bgValue, `dark ${bg} missing`).toBeDefined();
      expect(contrast(fgValue!, bgValue!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('source hygiene', () => {
  it('uses no raw Tailwind palette classes', () => {
    const raw =
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    const offenders = sourceFiles().filter((f) => raw.test(readFileSync(f, 'utf8')));
    expect(
      offenders,
      'every colour must reference a semantic token so dark mode and ' +
        're-theming stay a token edit rather than a per-file hunt',
    ).toEqual([]);
  });

  it('never interpolates a Tailwind class name', () => {
    // Tailwind's scanner is a regex over source text, not an evaluator: a
    // stroke-chart class built by joining a prefix with an index at runtime
    // is invisible to it and ships as nothing at all.
    const interpolated = /`[^`]*\b(?:bg|text|border|ring|fill|stroke)-[a-z-]*\$\{/;
    const offenders = sourceFiles().filter((f) =>
      interpolated.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
