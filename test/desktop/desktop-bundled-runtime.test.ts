import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBundledRuntimeCandidate } from '../../src/desktop/main/bundled-runtime.js';

/**
 * Minimal stand-in for how `x64ArchFiles` is matched. app-builder-lib hands the
 * field to @electron/universal as a **minimatch** pattern, but minimatch is not a
 * declared dependency here — importing it would rely on transitive hoisting, which
 * is exactly the kind of layout assumption this repo just got burned by. So encode
 * only the two features the pattern actually uses, including the one that bites:
 * `**` does NOT cross into dot-directories (minimatch needs `dot:true` for that,
 * and nothing passes it), so a `.pnpm/…` path is invisible to `node_modules/**`.
 */
function matchesArchGlob(path: string, pattern: string): boolean {
  const braces = /^(.*)\{([^}]*)\}(.*)$/.exec(pattern);
  const alternatives = braces
    ? braces[2].split(',').map(alt => `${braces[1]}${alt}${braces[3]}`)
    : [pattern];
  return alternatives.some(alt => {
    const rx = alt
      .split('**').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      // `**` matches any depth, but never a path segment starting with `.`
      .join('(?:[^./][^/]*(?:/[^./][^/]*)*)?');
    return new RegExp(`^${rx}$`).test(path);
  });
}

describe('bundled desktop runtime', () => {
  it('selects the architecture-matched packaged Node and runtime', () => {
    const candidate = resolveBundledRuntimeCandidate({
      resourcesPath: '/Applications/Botmux.app/Contents/Resources',
      repoRoot: '/repo',
      isPackaged: true,
      arch: 'arm64',
      appVersion: '3.0.0',
      env: {},
      existsSync: () => true,
    });

    expect(candidate).toMatchObject({
      kind: 'bundled',
      root: '/Applications/Botmux.app/Contents/Resources/runtime',
      nodePath: '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin/node',
      cliPath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
      version: '3.0.0',
      runtimeSource: 'bundled',
    });
  });

  it('uses the package-manager Node for development', () => {
    const candidate = resolveBundledRuntimeCandidate({
      resourcesPath: '/unused',
      repoRoot: '/repo',
      isPackaged: false,
      arch: 'arm64',
      appVersion: '3.0.0',
      env: { npm_node_execpath: process.execPath },
    });

    expect(candidate.nodePath).toBe(process.execPath);
    expect(candidate.root).toBe('/repo');
  });

  it('keeps the architecture-qualified bundled binaries when merging a Universal app', () => {
    const config = readFileSync(resolve(import.meta.dirname, '../../electron-builder.yml'), 'utf8');

    const pattern = /^\s*x64ArchFiles:\s*'([^']+)'/m.exec(config)?.[1];
    expect(pattern).toBeTruthy();

    // Don't just pin the string — a glob that matches nothing does NOT error, so a
    // stale layout here silently stops excluding these files and lets
    // @electron/universal try to lipo already-arch-qualified Mach-O binaries.
    // Run the real matcher against the paths the bundled runtime actually produces
    // (app-builder-lib passes this field to @electron/universal as a minimatch
    // pattern; `prepare-desktop-runtime.mjs` installs that tree with bun, so the
    // layout is flat).
    const mustMatch = [
      'Contents/Resources/runtime/node_modules/@napi-rs/canvas-darwin-arm64/canvas.darwin-arm64.node',
      'Contents/Resources/runtime/node_modules/@napi-rs/canvas-darwin-x64/canvas.darwin-x64.node',
      'Contents/Resources/runtime/node_modules/node-pty/build/Release/pty.node',
      'Contents/Resources/node/darwin-arm64/bin/node',
      'Contents/Resources/node/darwin-x64/bin/node',
    ];
    // Must stay narrow: app code still has to be compared/merged normally.
    const mustNotMatch = [
      'Contents/Resources/app.asar',
      'Contents/Resources/runtime/dist/cli.js',
      'Contents/MacOS/Botmux',
    ];
    for (const p of mustMatch) expect(matchesArchGlob(p, pattern!), `should match ${p}`).toBe(true);
    for (const p of mustNotMatch) expect(matchesArchGlob(p, pattern!), `should NOT match ${p}`).toBe(false);
  });

  it('stages both native canvas architectures via bun install arch flags', () => {
    const script = readFileSync(resolve(import.meta.dirname, '../../scripts/prepare-desktop-runtime.mjs'), 'utf8');

    // bun selects optional-dependency arches through install flags rather than
    // project config, so `--os darwin --cpu '*'` replaces the generated
    // pnpm-workspace.yaml / supportedArchitectures dance.
    expect(script).toContain("'--os', 'darwin',");
    expect(script).toContain("'--cpu', '*',");
    expect(script).not.toContain("join(runtimeDir, 'pnpm-workspace.yaml')");
    // The flags only request both arches; this assertion is what proves they landed.
    expect(script).toContain("for (const arch of ['arm64', 'x64'])");
    expect(script).toContain('Bundled runtime is missing @napi-rs/canvas-darwin-${arch}');
  });
});
