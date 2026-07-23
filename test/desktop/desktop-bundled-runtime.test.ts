import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBundledRuntimeCandidate } from '../../src/desktop/main/bundled-runtime.js';

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

    expect(config).toContain("x64ArchFiles: 'Contents/Resources/{node/**,runtime/node_modules/.pnpm/**}'");
  });

  it('stages both native canvas architectures using pnpm workspace settings', () => {
    const script = readFileSync(resolve(import.meta.dirname, '../../scripts/prepare-desktop-runtime.mjs'), 'utf8');

    expect(script).toContain("join(runtimeDir, 'pnpm-workspace.yaml')");
    expect(script).toContain("supportedArchitectures: { os: ['darwin'], cpu: ['arm64', 'x64'] }");
    expect(script).toContain("for (const arch of ['arm64', 'x64'])");
    expect(script).toContain('Bundled runtime is missing @napi-rs/canvas-darwin-${arch}');
  });
});
