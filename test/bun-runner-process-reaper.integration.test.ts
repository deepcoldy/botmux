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
        // A test fixture may create another fence after the preload's one.
        // Each root must remain short and independently reapable.
        const auxiliaryFence = createTmuxFence(process.env);
        expect(auxiliaryFence.root).not.toBe(fence.root);
        const socketRoot = process.env.TMUX_TMPDIR!;
        const label = 'botmux-osc7501-45772-144f3677-cd8c-4889-936b-0777ee1f0ebd';
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        const socket = join(socketRoot, \`tmux-\${uid}\`, label);
        // Linux sockaddr_un.sun_path is 108 bytes INCLUDING the trailing NUL.
        expect(Buffer.byteLength(socket, 'utf8')).toBeLessThanOrEqual(107);
        const tmux = join(fence.binDir, 'tmux');
        const started = spawnSync(tmux, ['-L', label, 'new-session', '-d', '-s', 'leak', 'sleep 60'], { encoding: 'utf8' });
        expect(started.status).toBe(0);
        const query = spawnSync(tmux, ['-L', label, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
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

  it('reaps the scratch registry despite a truncated fence-root manifest', async () => {
    const root = mkdtempSync('/tmp/bmx-bun-runner-broken-manifest-');
    roots.push(root);
    mkdirSync(join(root, 'test'));
    symlinkSync(resolve('test/helpers'), join(root, 'test', 'helpers'), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const pidFile = join(root, 'sandbox.pid');
    const identityFile = join(root, 'sandbox.identity');
    const scratchFile = join(root, 'scratch.path');
    const fenceRootFile = join(root, 'fence.path');
    const readyFile = join(root, 'sandbox.ready');
    const script = join(root, 'fake-cli.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(readyFile)}, '1');\nsetInterval(() => {}, 1000);\n`);
    const fenceHelper = pathToFileURL(resolve('test/helpers/tmux-fence.ts')).href;
    const reaperHelper = pathToFileURL(resolve('scripts/test-process-reaper.mjs')).href;
    writeFileSync(join(root, 'test', 'broken-manifest.test.ts'), `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { spawn } from 'node:child_process';
      import { expect, it } from 'bun:test';
      import { createTmuxFence } from ${JSON.stringify(fenceHelper)};
      import { registerSandboxScriptForCleanup, testProcessIdentity } from ${JSON.stringify(reaperHelper)};
      it('leaves a registered process and a partial manifest', async () => {
        const manifest = process.env.BOTMUX_TMUX_FENCE_ROOTS!;
        const scratch = dirname(manifest);
        const fence = createTmuxFence(process.env);
        const script = ${JSON.stringify(script)};
        registerSandboxScriptForCleanup(script, {
          ...process.env, BOTMUX_TEST_SANDBOX_SCRIPT_LOG: join(scratch, 'sandbox-scripts.log'),
        });
        const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
        child.unref();
        expect(child.pid).toBeGreaterThan(1);
        for (let i = 0; i < 100 && !existsSync(${JSON.stringify(readyFile)}); i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(existsSync(${JSON.stringify(readyFile)})).toBe(true);
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        writeFileSync(${JSON.stringify(identityFile)}, testProcessIdentity(child.pid!));
        writeFileSync(${JSON.stringify(scratchFile)}, scratch);
        writeFileSync(${JSON.stringify(fenceRootFile)}, fence.root);
        // No trailing newline: this is a partial record, not a root to delete.
        appendFileSync(manifest, '/tmp/bm');
      });
    `);

    const result = spawnSync(process.execPath, [resolve('scripts/run-bun-tests.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '1' },
    });
    let pid = 0;
    let identity = '';
    let scratch = '';
    let fenceRoot = '';
    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('invalid tmux fence root record');
      pid = Number(readFileSync(pidFile, 'utf8'));
      identity = readFileSync(identityFile, 'utf8');
      scratch = readFileSync(scratchFile, 'utf8');
      fenceRoot = readFileSync(fenceRootFile, 'utf8');
      expect(testProcessIdentity(pid)).not.toBe(identity);
      // The malformed manifest fails the run and preserves both directories.
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(fenceRoot)).toBe(true);
    } finally {
      if (pid > 1 && identity && testProcessIdentity(pid) === identity) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      if (fenceRoot) rmSync(fenceRoot, { recursive: true, force: true });
    }
  }, 90_000);

  // One independent runner per victim so each manifest carries exactly ONE
  // illegal record. The runner fails closed on ANY invalid record and skips
  // every deletion, so putting two victims in one runner would let one invalid
  // record mask the deletion of the other during a partial-guard mutation.
  function runManifestGuard(victim: string, marker: string) {
    const root = mkdtempSync('/tmp/bmx-bun-runner-manifest-guard-');
    roots.push(root);
    mkdirSync(join(root, 'test'));
    symlinkSync(resolve('test/helpers'), join(root, 'test/helpers'), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(victim, marker), 'preserve me');
    const scratchFile = join(root, 'scratch.path');
    const fenceRootFile = join(root, 'fence.path');
    const fenceHelper = pathToFileURL(resolve('test/helpers/tmux-fence.ts')).href;
    writeFileSync(join(root, 'test', 'manifest-guard.test.ts'), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { it } from 'bun:test';
      import { createTmuxFence } from ${JSON.stringify(fenceHelper)};
      it('registers a legal fence then poisons the manifest', () => {
        const fence = createTmuxFence(process.env);
        const manifest = process.env.BOTMUX_TMUX_FENCE_ROOTS!;
        writeFileSync(${JSON.stringify(scratchFile)}, dirname(manifest));
        writeFileSync(${JSON.stringify(fenceRootFile)}, fence.root);
        appendFileSync(manifest, ${JSON.stringify(victim)} + '\\n');
      });
    `);

    const result = spawnSync(process.execPath, [resolve('scripts/run-bun-tests.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '1' },
    });
    return { result, scratchFile, fenceRootFile, victim, marker };
  }

  function expectVictimPreserved(
    run: ReturnType<typeof runManifestGuard>,
  ): void {
    let scratch = '';
    let fenceRoot = '';
    try {
      expect(run.result.status, `${run.result.stdout}\n${run.result.stderr}`).toBe(1);
      expect(run.result.stderr).toContain('invalid tmux fence root record');
      // The external directory is preserved, not removed as a fence root.
      expect(existsSync(join(run.victim, run.marker))).toBe(true);
      scratch = readFileSync(run.scratchFile, 'utf8');
      fenceRoot = readFileSync(run.fenceRootFile, 'utf8');
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(fenceRoot)).toBe(true);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      if (fenceRoot) rmSync(fenceRoot, { recursive: true, force: true });
    }
  }

  it('rejects a manifest record whose basename lacks the bmxt- prefix', () => {
    // Parent IS /tmp, but the name is outside the bmxt-* family.
    const victim = mkdtempSync('/tmp/bmx-bun-runner-victim-');
    roots.push(victim);
    expectVictimPreserved(runManifestGuard(victim, 'do-not-delete.txt'));
  }, 90_000);

  it('rejects a bmxt-named manifest record whose parent is outside /tmp', () => {
    // The name looks like a fence root, but the parent is a fixture dir, not /tmp.
    const fixture = mkdtempSync('/tmp/bmx-bun-runner-manifest-parent-');
    roots.push(fixture);
    const victim = mkdtempSync(join(fixture, 'bmxt-evil-'));
    expectVictimPreserved(runManifestGuard(victim, 'do-not-delete.txt'));
  }, 90_000);

  // 1s is the common case; 5s outlasts the fixed 2s waits the runner used to
  // give an announced start (both of its sweeps), as a loaded CI host did.
  for (const delaySeconds of [1, 5]) it(`settles a server that starts only after the test process exits (client delayed ${delaySeconds}s)`, () => {
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
    writeFileSync(join(delayedBin, 'tmux'), `#!/bin/sh\nsleep ${delaySeconds}\nexec ${JSON.stringify(realTmux!)} "$@"\n`, { mode: 0o755 });
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

  it('reaps a delayed restart when a dead server is registered on the same socket', () => {
    const root = mkdtempSync('/tmp/bmx-bun-runner-restart-reaper-');
    roots.push(root);
    mkdirSync(join(root, 'test'));
    symlinkSync(resolve('test/helpers'), join(root, 'test', 'helpers'), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const socketRoot = mkdtempSync('/tmp/bmx-bun-runner-restart-socket-');
    roots.push(socketRoot);
    const socket = join(socketRoot, 'socket');
    const fenceHelper = pathToFileURL(resolve('test/helpers/tmux-fence.ts')).href;
    const reaperHelper = pathToFileURL(resolve('scripts/test-process-reaper.mjs')).href;
    const delayedBin = join(root, 'bin');
    mkdirSync(delayedBin);
    writeFileSync(join(delayedBin, 'tmux'), `#!/bin/sh\nsleep 1\nexec ${JSON.stringify(realTmux!)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'test', 'restart.test.ts'), `
      import { expect, it } from 'bun:test';
      import { spawn, spawnSync } from 'node:child_process';
      import { join } from 'node:path';
      import { applyTmuxFenceEnv, createTmuxFence } from ${JSON.stringify(fenceHelper)};
      import { registerTmuxServer } from ${JSON.stringify(reaperHelper)};
      it('leaves a delayed client after retaining the previous server registration', () => {
        const fence = createTmuxFence(process.env);
        applyTmuxFenceEnv(fence);
        const tmux = join(fence.binDir, 'tmux');
        const socket = ${JSON.stringify(socket)};
        const oldClient = spawnSync(tmux, ['-S', socket, 'new-session', '-d', '-s', 'old', 'sleep 60'], { encoding: 'utf8' });
        expect(oldClient.status, oldClient.stderr).toBe(0);
        expect(registerTmuxServer(${JSON.stringify(realTmux!)}, socket, { env: process.env })).not.toBeNull();
        const oldKill = spawnSync(${JSON.stringify(realTmux!)}, ['-S', socket, 'kill-server'], { encoding: 'utf8' });
        expect(oldKill.status, oldKill.stderr).toBe(0);
        // The append-only registry still contains the old pending row and full
        // server identity. They must not hide this new start on the same socket.
        const client = spawn(tmux, ['-S', socket, 'new-session', '-d', '-s', 'new', 'sleep 60'], { stdio: 'ignore', detached: true });
        client.unref();
        expect(client.pid).toBeGreaterThan(1);
        // Deliberately no teardownTmuxFence: both outer-runner sweeps must settle it.
      });
    `);
    const result = spawnSync(process.execPath, [resolve('scripts/run-bun-tests.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '1',
        PATH: `${delayedBin}:${process.env.PATH}` },
    });

    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (let attempt = 0; attempt < 34; attempt++) {
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
