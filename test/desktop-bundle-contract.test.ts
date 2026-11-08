import { build } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// K1 build-contract guard: the desktop entries are bundled with esbuild for
// Electron (node/cjs main+preload, browser/iife renderer). Bun-only builtins
// (`bun:sqlite`) are reached in sqlite-compat.ts behind a `typeof Bun` runtime
// guard and must be marked external — otherwise esbuild fails at BUNDLE time
// ("Could not resolve bun:sqlite"), which silently removes the desktop app
// from a release (v3.57.0). Keep these option sets in sync with the
// `desktop:bundle` npm script; assertions are in-memory (write:false).
const repoRoot = resolve(import.meta.dirname, '..');

const entries = [
  {
    name: 'main (node/cjs)',
    entryPoint: resolve(repoRoot, 'src/desktop/main.ts'),
    options: { platform: 'node', format: 'cjs', external: ['electron', 'bun:sqlite'] },
  },
  {
    name: 'preload (node/cjs)',
    entryPoint: resolve(repoRoot, 'src/desktop/preload.ts'),
    options: { platform: 'node', format: 'cjs', external: ['electron'] },
  },
  {
    name: 'renderer (browser/iife)',
    entryPoint: resolve(repoRoot, 'src/desktop/renderer/app.ts'),
    options: { platform: 'browser', format: 'iife' },
  },
] as const;

describe('desktop esbuild bundle contract', () => {
  it.each(entries)('$name bundles without unresolved Bun builtins', async ({ entryPoint, options }) => {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      logLevel: 'silent',
      ...options,
    });
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0].contents.length).toBeGreaterThan(0);
  });
});
