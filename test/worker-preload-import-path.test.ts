import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { preloadImportSpecifier } from '../src/core/self-spawn.js';
import { workerForkExecArgv } from '../src/core/worker-pool.js';

function runtimeAvailable(bin: string): boolean {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
}

const hasBun = runtimeAvailable('bun');
const hasNode = runtimeAvailable('node');

describe('worker IPC preload under a non-ASCII install path', () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-preload-path-'));
  // A CJK install dir plus the other characters a file URL percent-encodes or
  // treats as URL syntax.
  const dist = join(root, '任务目录', 'diff 命令#%41', 'dist');
  const preload = join(dist, 'worker-ipc-preload.js');
  const main = join(dist, 'worker.js');
  mkdirSync(dist, { recursive: true });
  writeFileSync(preload, 'globalThis.__botmuxPreloadRan = true;\n');
  writeFileSync(main, "console.log(globalThis.__botmuxPreloadRan === true ? 'PRELOADED' : 'NO_PRELOAD');\n");

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function fork(bin: 'bun' | 'node') {
    return spawnSync(bin, ['--import', preloadImportSpecifier(preload, bin === 'bun'), main], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it.skipIf(!hasBun)('bun loads the preload before the worker entry', () => {
    const result = fork('bun');
    expect(result.stderr).not.toContain('preload not found');
    expect(result.stdout.trim()).toBe('PRELOADED');
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasNode)('node loads the preload before the worker entry', () => {
    const result = fork('node');
    expect(result.stdout.trim()).toBe('PRELOADED');
    expect(result.status).toBe(0);
  });
});

describe('workerForkExecArgv', () => {
  it('hands bun the raw preload path and node a file URL to the same file', () => {
    const bunArgv = workerForkExecArgv(true);
    const nodeArgv = workerForkExecArgv(false);
    expect(bunArgv.at(-2)).toBe('--import');
    expect(nodeArgv.at(-2)).toBe('--import');
    const bunPreload = bunArgv.at(-1)!;
    expect(isAbsolute(bunPreload)).toBe(true);
    expect(bunPreload.endsWith('worker-ipc-preload.js')).toBe(true);
    expect(nodeArgv.at(-1)!.startsWith('file://')).toBe(true);
    expect(fileURLToPath(nodeArgv.at(-1)!)).toBe(bunPreload);
  });

  it('defaults to the runtime it is running under', () => {
    const bun = Boolean(process.versions.bun);
    expect(workerForkExecArgv()).toEqual(workerForkExecArgv(bun));
    expect(preloadImportSpecifier('/opt/任务/p.js')).toBe(preloadImportSpecifier('/opt/任务/p.js', bun));
  });
});
