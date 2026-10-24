import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('__self-update direction and outcome', () => {
  it.each([
    { version: '3.47.0', requested: 'latest', skipped: true },
    { version: '3.48.0', requested: 'latest', skipped: true },
    { version: '3.49.0', requested: 'latest', skipped: false },
    { version: '3.47.0', requested: '3.47.0', skipped: false },
    { version: '3.48.0', requested: '3.48.0', skipped: false },
  ])('handles $requested resolving to $version (skipped=$skipped)', ({ version, requested, skipped }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-self-update-direction-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const target = join(home, 'candidate');
    writeFileSync(target, 'CURRENT');
    try {
      const child = spawnSyncBunTsEvalWithRepoImports(`
        import { mock } from 'bun:test';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        import { Readable } from 'node:stream';
        import { createHash } from 'node:crypto';
        const diagnostics = { ...await import('./src/utils/install-diagnostics.js') };
        mock.module('./src/utils/install-diagnostics.js', () => ({
          ...diagnostics, resolveCurrentVersion: () => '3.48.0',
        }));
        const updateCheck = { ...await import('./src/core/update-check.js') };
        mock.module('./src/core/update-check.js', () => ({
          ...updateCheck,
          fetchReleaseLatestVersion: async () => ({ version: ${JSON.stringify(version)}, source: 'configured-fallback' }),
        }));
        const binaryUpdate = { ...await import('./src/core/binary-self-update.js') };
        const apply = binaryUpdate.applyStandaloneUpdate;
        const replace = binaryUpdate.replaceStandaloneBinary;
        const payload = Buffer.alloc(1_100_000, 0x42);
        mock.module('./src/core/binary-self-update.js', () => ({
          ...binaryUpdate,
          currentBinaryInstallShape: () => 'curl-binary',
          replaceStandaloneBinary: (resolved, target, deps) => {
            if (target !== join(homedir(), 'candidate')) throw new Error('unguarded write');
            return replace(resolved, target, deps);
          },
          applyStandaloneUpdate: (resolved, request) => apply(resolved, {
            ...request, target: join(homedir(), 'candidate'),
          }, {
            fetchStream: async () => Readable.from([payload]),
            fetchChecksum: async () => createHash('sha256').update(payload).digest('hex'),
            probeBinary: () => ({ status: 0, stdout: resolved }),
          }),
        }));
        process.argv = [process.execPath, 'cli.ts', '__self-update', ${JSON.stringify(requested)}];
        await import('./src/cli.js');
      `, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
        env: { ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: join(home, 'data') },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, String(child.stderr)).toBe(0);
      const output = String(child.stdout);
      if (skipped) {
        expect(output).toContain('BOTMUX_SELF_UPDATE_SKIPPED=already_latest');
        expect(output).toContain('BOTMUX_SELF_UPDATE_VERSION=3.48.0');
        expect(readFileSync(target, 'utf8')).toBe('CURRENT');
      } else {
        expect(output).not.toContain('BOTMUX_SELF_UPDATE_SKIPPED=');
        expect(output).toContain('BOTMUX_SELF_UPDATE_VERSION=' + version);
        expect(output).toContain('source=github-release');
        expect(readFileSync(target)).toEqual(Buffer.alloc(1_100_000, 0x42));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
