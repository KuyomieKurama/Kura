import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the design tokens of the web UI (apps/web/src/styles/tokens.css):
 * WCAG AA contrast for every text/background and border/background pair the stylesheets use,
 * both colour schemes defined completely, no pure black or white text, no colour literals outside the token file,
 * and the single radius rule.
 */

const stylesDirectory = resolve(process.cwd(), 'apps/web/src/styles');
const tokensCss = readFileSync(resolve(stylesDirectory, 'tokens.css'), 'utf8');

function declarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) result[match[1]!] = match[2]!.trim();
  return result;
}

function extractBlocks(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  expect(darkStart).toBeGreaterThan(0);
  return { light: declarations(css.slice(0, darkStart)), dark: declarations(css.slice(darkStart)) };
}

const { light, dark } = extractBlocks(tokensCss);
const COLOR_TOKENS = [
  'bg', 'surface', 'surface-sunken', 'ink', 'ink-muted', 'line', 'line-strong',
  'accent', 'accent-hover', 'accent-ink', 'accent-soft',
  'ok', 'ok-soft', 'warn', 'warn-soft', 'danger', 'danger-soft'
];

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const value = match[1]!;
  const [r, g, b] = [0, 2, 4].map((offset) => channel(parseInt(value.slice(offset, offset + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** [foreground, background, minimum ratio, where it is used] */
const PAIRS: Array<[string, string, number, string]> = [
  // Body and meta text
  ['ink', 'bg', 4.5, 'page text'],
  ['ink', 'surface', 4.5, 'panel text'],
  ['ink', 'surface-sunken', 4.5, 'row hover'],
  ['ink-muted', 'bg', 4.5, 'meta text on the page'],
  ['ink-muted', 'surface', 4.5, 'meta text in panels, helper text'],
  ['ink-muted', 'surface-sunken', 4.5, 'table header, neutral chip, hover rows'],
  // Accent
  ['accent', 'bg', 4.5, 'links, wordmark'],
  ['accent', 'surface', 4.5, 'links in panels'],
  ['accent', 'surface-sunken', 4.5, 'links on hover rows'],
  ['accent', 'accent-soft', 4.5, 'active navigation item, accent chip, info banner'],
  ['accent-ink', 'accent', 4.5, 'primary button, skip link'],
  ['accent-ink', 'accent-hover', 4.5, 'primary button on hover'],
  ['ink', 'accent-soft', 4.5, 'banner text'],
  // State colours
  ['ok', 'ok-soft', 4.5, 'ok chip, ok banner'],
  ['ok', 'surface', 4.5, 'verification stamp'],
  ['ink', 'ok-soft', 4.5, 'banner text'],
  ['warn', 'warn-soft', 4.5, 'warn chip, test strip, warn banner'],
  ['ink', 'warn-soft', 4.5, 'banner text'],
  ['danger', 'danger-soft', 4.5, 'danger chip, danger banner, danger hover'],
  ['danger', 'surface', 4.5, 'error text, destructive button'],
  ['danger', 'bg', 4.5, 'error text on the page'],
  ['ink', 'danger-soft', 4.5, 'banner text'],
  ['surface', 'danger', 4.5, 'destructive button inside a confirm dialog'],
  // Edges of controls and graphics: 3:1
  ['line-strong', 'surface', 3, 'input and button borders'],
  ['line-strong', 'bg', 3, 'borders on the page background'],
  ['line-strong', 'surface-sunken', 3, 'borders on sunken areas'],
  ['accent', 'bg', 3, 'focus ring on the page'],
  ['accent', 'surface', 3, 'focus ring in panels'],
  ['accent', 'surface-sunken', 3, 'focus ring on hover rows'],
  ['accent', 'accent-soft', 3, 'focus ring on the active navigation item'],
  ['ok', 'surface', 3, 'ledger segment: stored'],
  ['danger', 'surface', 3, 'ledger segment: failed'],
  ['warn', 'surface', 3, 'ledger segment: partly or attention']
];

describe.each([['light', light], ['dark', dark]] as const)('design tokens, %s scheme', (_name, tokens) => {
  it('defines every colour token as a 6-digit hex value', () => {
    for (const token of COLOR_TOKENS) expect(tokens[token], `--${token}`).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(PAIRS)('%s on %s reaches %s:1 (%s)', (foreground, background, minimum) => {
    const ratio = contrastRatio(tokens[foreground]!, tokens[background]!);
    expect(ratio, `${foreground} ${tokens[foreground]} on ${background} ${tokens[background]}`).toBeGreaterThanOrEqual(minimum);
  });

  it('uses neither pure black nor pure white as text colour', () => {
    for (const token of ['ink', 'ink-muted']) expect(['#000000', '#ffffff']).not.toContain(tokens[token]!.toLowerCase());
  });
});

describe('design tokens, both schemes', () => {
  it('defines the same colour tokens in the light and the dark scheme', () => {
    for (const token of COLOR_TOKENS) {
      expect(light[token], `light --${token}`).toBeDefined();
      expect(dark[token], `dark --${token}`).toBeDefined();
    }
  });

  it('keeps the dialog as the only element with a shadow', () => {
    for (const file of readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(resolve(stylesDirectory, file), 'utf8');
      const uses = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1]);
      for (const value of uses) expect(value, `${file}`).toMatch(/var\(--shadow-dialog\)|none/);
    }
  });
});

describe('stylesheets', () => {
  const others = readdirSync(stylesDirectory).filter((name) => name.endsWith('.css') && name !== 'tokens.css');

  it('contain no colour literals outside tokens.css', () => {
    for (const file of others) {
      const css = readFileSync(resolve(stylesDirectory, file), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css, file).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
    }
  });

  it('draw every radius from the three-step scale (controls, panels, chips)', () => {
    for (const file of others) {
      const css = readFileSync(resolve(stylesDirectory, file), 'utf8');
      for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
        expect(match[1], `${file}: border-radius`).toMatch(/^var\(--radius-(control|panel|chip)\)$/);
      }
    }
  });

  it('define no gradient except the loading shimmer', () => {
    for (const file of others) {
      const css = readFileSync(resolve(stylesDirectory, file), 'utf8');
      const gradients = [...css.matchAll(/(linear|radial|conic)-gradient/g)];
      expect(gradients.length, file).toBeLessThanOrEqual(file === 'components.css' ? 1 : 0);
    }
  });
});
