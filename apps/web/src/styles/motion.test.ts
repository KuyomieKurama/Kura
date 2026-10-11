import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// REQ-DL-008 AC30: no endless animation; with prefers-reduced-motion the stagger, fade-in and view transitions are gone.
const dir = __dirname;
const sheets = readdirSync(dir).filter((name) => name.endsWith('.css')).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

it('has no endless animation in any style sheet', () => {
  for (const sheet of sheets) expect(sheet.text, sheet.name).not.toMatch(/animation[^;]*\binfinite\b/);
});

it('switches all animations and transitions off for prefers-reduced-motion', () => {
  const base = sheets.find((sheet) => sheet.name === 'base.css')!.text;
  const block = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
  expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);

  const tokens = sheets.find((sheet) => sheet.name === 'tokens.css')!.text;
  const reduced = tokens.slice(tokens.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const token of ['--dur-fast', '--dur-base', '--dur-slow']) expect(reduced).toMatch(new RegExp(`${token}:\\s*0\\.01ms`));
});

it('keeps a reduced-motion rule for view transitions wherever they are declared', () => {
  const declared = sheets.filter((sheet) => sheet.text.includes('::view-transition'));
  for (const sheet of declared) expect(sheet.text, sheet.name).toMatch(/prefers-reduced-motion/);
});
