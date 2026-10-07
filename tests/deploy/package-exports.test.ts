import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression for the container start failure ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING:
// in the production image workspace packages live under node_modules, where Node refuses
// to run TypeScript. Every package must therefore load compiled dist/ JavaScript by default.
// "types" (tsc) and "development" (vite/vitest, never set by plain Node) may point to src.

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages');
const sourceOnlyConditions = new Set(['types', 'development']);

type Json = string | null | { [key: string]: Json | Json[] } | Json[];

interface PackageJson {
  name: string;
  exports?: Json;
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
}

const packages = readdirSync(packagesDir)
  .filter((dir) => existsSync(join(packagesDir, dir, 'package.json')))
  .map((dir) => ({
    dir,
    json: JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')) as PackageJson
  }));

/** Collect every export target reachable at runtime by plain Node (all conditions except source-only ones). */
function runtimeTargets(node: Json | undefined): string[] {
  if (node === undefined || node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(runtimeTargets);
  return Object.entries(node).flatMap(([key, value]) => (sourceOnlyConditions.has(key) ? [] : runtimeTargets(value)));
}

describe('workspace package exports (container start)', () => {
  it('finds the workspace packages', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  describe.each(packages)('packages/$dir', ({ json }) => {
    it('exposes an exports map with a types and a default condition', () => {
      expect(json.exports, `${json.name}: exports must be an object`).toBeTypeOf('object');
      const conditions = json.exports as Record<string, unknown>;
      expect(conditions.types, `${json.name}: types condition`).toBeTypeOf('string');
      expect(conditions.default, `${json.name}: default condition`).toBeTypeOf('string');
    });

    it('never makes Node load raw TypeScript', () => {
      const targets = [...runtimeTargets(json.exports), ...(json.main ? [json.main] : []), ...runtimeTargets(json.bin as Json)];
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target, `${json.name}: ${target}`).not.toMatch(/\.[cm]?tsx?$/);
        expect(target, `${json.name}: ${target}`).toMatch(/^\.\/dist\//);
      }
    });

    it('keeps types pointing to src and has a build script', () => {
      const conditions = json.exports as Record<string, string>;
      expect(conditions.types).toMatch(/^\.\/src\/.*\.ts$/);
      expect(json.scripts?.build, `${json.name}: build script`).toBeTruthy();
    });
  });
});
