import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { realTmuxBinary } from './helpers/tmux-fence.js';
import { testProcessIdentity } from '../scripts/test-process-reaper.mjs';

const roots: string[] = [];
const realTmux = realTmuxBinary();
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux' || !realTmux)('Bun runner process reaping', () => {
  it('reaps a detached private server when the child never runs its own fence teardown', () => {
    const root = mkdtempSync('/tmp/bmx-bun-runner-reaper-');
    roots.push(root);
    mkdirSync(join(root, 'test'));
    // The real runner collects only this directory. Its selector still resolves
    // the real helper and TypeScript through these read-only links.
    symlinkSync(resolve('test/helpers'), join(root, 'test', 'helpers'), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const pidFile = join(root, 'server.pid');
    const identityFile = join(root, 'server.identity');
    const fenceHelper = pathToFileURL(resolve('test/helpers/tmux-fence.ts')).href;
    const reaperHelper = pathToFileURL(resolve('scripts/test-process-reaper.mjs')).href;
    writeFileSync(join(root, 'test', 'leak.test.ts'), `
      import { expect, it } from 'bun:test';
      import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { spawnSync } from 'node:child_process';
      import { applyTmuxFenceEnv, createTmuxFence } from ${JSON.stringify(fenceHelper)};
      import { testProcessIdentity } from ${JSON.stringify(reaperHelper)};
      it('leaves a private server for the outer runner', () => {
        const fence = createTmuxFence(process.env);
        applyTmuxFenceEnv(fence);
        const socketRoot = mkdtempSync('/tmp/bmx-bun-runner-leaked-socket-');
        const socket = join(socketRoot, 'socket');
        const tmux = join(fence.binDir, 'tmux');
        const started = spawnSync(tmux, ['-S', socket, 'new-session', '-d', '-s', 'leak', 'sleep 60'], { encoding: 'utf8' });
        expect(started.status).toBe(0);
        const query = spawnSync(tmux, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
        const pid = Number(query.stdout.trim());
        expect(pid).toBeGreaterThan(1);
        writeFileSync(${JSON.stringify(pidFile)}, String(pid));
        const identity = testProcessIdentity(pid);
        expect(identity).toBeTruthy();
        writeFileSync(${JSON.stringify(identityFile)}, identity);
        rmSync(socketRoot, { recursive: true, force: true });
        // Deliberately no teardownTmuxFence: the outer runner owns this case.
      });
    `);

    const result = spawnSync(process.execPath, [resolve('scripts/run-bun-tests.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '1' },
    });

    const readRef = (): { pid: number; identity: string } | undefined => {
      if (!existsSync(pidFile) || !existsSync(identityFile)) return undefined;
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const identity = readFileSync(identityFile, 'utf8');
      return pid > 1 && identity ? { pid, identity } : undefined;
    };
    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const ref = readRef();
      expect(ref).toBeDefined();
      // A different live identity means the ORIGINAL server is gone; never
      // signal a replacement that happens to reuse its pid during this check.
      expect(testProcessIdentity(ref!.pid), result.stdout).not.toBe(ref!.identity);
    } finally {
      const ref = readRef();
      if (ref && testProcessIdentity(ref.pid) === ref.identity) {
        try { process.kill(ref.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 90_000);

  it('settles a server that starts only after the test process exits', () => {
    const root = mkdtempSync('/tmp/bmx-bun-runner-startup-reaper-');
    roots.push(root);
    mkdirSync(join(root, 'test'));
    symlinkSync(resolve('test/helpers'), join(root, 'test', 'helpers'), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const socketRoot = mkdtempSync('/tmp/bmx-bun-runner-startup-socket-');
    roots.push(socketRoot);
    const socket = join(socketRoot, 'socket');
    const fenceHelper = pathToFileURL(resolve('test/helpers/tmux-fence.ts')).href;
    const delayedBin = join(root, 'bin');
    mkdirSync(delayedBin);
    writeFileSync(join(delayedBin, 'tmux'), `#!/bin/sh\nsleep 1\nexec ${JSON.stringify(realTmux!)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'test', 'startup.test.ts'), `
      import { expect, it } from 'bun:test';
      import { spawn } from 'node:child_process';
      import { join } from 'node:path';
      import { applyTmuxFenceEnv, createTmuxFence } from ${JSON.stringify(fenceHelper)};
      it('exits while the real client is still starting the server', () => {
        const fence = createTmuxFence(process.env);
        applyTmuxFenceEnv(fence);
        const tmux = join(fence.binDir, 'tmux');
        const client = spawn(tmux, ['-S', ${JSON.stringify(socket)}, 'new-session', '-d', '-s', 'late', 'sleep 60'], { stdio: 'ignore', detached: true });
        client.unref();
        expect(client.pid).toBeGreaterThan(1);
        // The delayed real tmux has not created the server yet, and this test
        // deliberately has no afterAll. The outer runner must settle the start.
      });
    `);
    // PATH selects the delayed wrapper only for this generated fixture; all
    // other tests keep their normal tmux binary.
    const result = spawnSync(process.execPath, [resolve('scripts/run-bun-tests.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '1',
        PATH: `${delayedBin}:${process.env.PATH}` },
    });

    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (let attempt = 0; attempt < 24; attempt++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      }
      const query = spawnSync(realTmux!, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
      expect(query.status, `${query.stdout}\n${query.stderr}`).not.toBe(0);
    } finally {
      const query = spawnSync(realTmux!, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
      if (query.status === 0) {
        const pid = Number(query.stdout.trim());
        if (testProcessIdentity(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }
  }, 90_000);
});
