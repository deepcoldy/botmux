/**
 * Worker-level integration test for the dsh adapter: spawns a real worker
 * with cliId 'dsh', drives one turn through the fake dsh server, and asserts
 * the final_output IPC contract (content, turnId, usage) and that OSC control
 * bytes never leak into the display stream.
 *
 * Run: pnpm vitest run test/worker-dsh-turn.integration.test.ts
 */
import { type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Dep gate for the sandbox case (same shape as sandbox.test.ts): the direct
// sandbox must actually ESTABLISH bwrap's namespaces (--unshare-user & co.),
// not merely find bwrap on PATH. Stock Ubuntu 23.10+ (incl. GitHub's
// ubuntu-24.04 runners and colima VMs) sets
// kernel.apparmor_restrict_unprivileged_userns=1 and the 24.04 bubblewrap
// package ships no AppArmor profile, so bwrap dies instantly with
// "bwrap: setting up uid map: Permission denied" (exit 1) — an environment
// limitation, not a code bug. Probe the product's own namespace set and skip
// loudly when the host can't do it; ci.yml lifts the restriction so the case
// still truly runs on CI runners.
const sandboxHost = probeHostCredentialIsolationMechanism();
if (!sandboxHost.supported) {
  console.warn(`[worker-dsh-turn] sandbox case will SKIP — host cannot establish the file sandbox: ${sandboxHost.reason}`);
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    else child.kill('SIGTERM');
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { /* sandbox may leave root-owned mount points; best effort */ }
  }
  tempDirs.clear();
});

function waitFor(
  child: ChildProcess,
  logs: string[],
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (!predicate()) return;
      cleanup();
      resolvePromise();
    }, 50);
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`worker dsh timeout\n${logs.join('')}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectPromise(new Error(`worker exited early (${code ?? signal})\n${logs.join('')}`));
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

describe('dsh worker final_output integration', () => {
  it('delivers one final_output with correct content/turnId/usage and no OSC leak', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-dsh-'));
    tempDirs.add(root);
    const fakeDsh = join(root, 'fake-dsh-server');
    copyFileSync(resolve('test/fixtures/fake-dsh-server.mjs'), fakeDsh);
    chmodSync(fakeDsh, 0o755);

    const sessionId = `dsh-it-${randomBytes(4).toString('hex')}-${process.pid}`;
    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        NODE_ENV: 'test',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' '),
        BOTMUX_TEST_DSH_RUNNER_PATH: resolve('src/dsh-runner.ts'),
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_dsh_it',
        LARK_APP_SECRET: 'secret',
        FAKE_DSH_SCENARIO: 'happy',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      messages.push(message);
      if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
    });

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_dsh_it',
      rootMessageId: 'om_dsh_it_root',
      workingDir: resolve('.'),
      cliId: 'dsh',
      cliPathOverride: fakeDsh,
      backendType: 'pty',
      prompt: '<user_message>你好 dsh</user_message>',
      larkAppId: 'app_dsh_it',
      larkAppSecret: 'secret',
      turnId: 'om_dsh_it_turn_1',
    };

    try {
      child.send(init);
      await waitFor(child, logs, () =>
        messages.some(m => m.type === 'final_output'));

      const finals = messages.filter(
        (m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output',
      );
      expect(finals).toHaveLength(1);
      expect(finals[0].content).toContain('你好，我是 dsh。');
      expect(finals[0].turnId).toBe('om_dsh_it_turn_1');
      // Usage comes through the four-bucket shape.
      expect(finals[0].usage).toEqual({
        inputTokens: 100,
        outputTokens: 42,
        cacheReadTokens: 10,
        cacheCreateTokens: 0,
      });

      // OSC control bytes must not appear in any screen/display payload.
      const screenLeaks = messages
        .filter(m => m.type === 'screen_update' || m.type === 'display')
        .filter(m => JSON.stringify(m).includes('\x1b]777;botmux:'));
      expect(screenLeaks).toHaveLength(0);
    } finally {
      await stopChild(child);
    }
  }, 60_000);

  it.skipIf(!sandboxHost.supported)('survives the file sandbox and persists config/sessions to the real HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-dsh-sb-'));
    tempDirs.add(root);
    const fakeDsh = join(root, 'fake-dsh-server');
    copyFileSync(resolve('test/fixtures/fake-dsh-server.mjs'), fakeDsh);
    chmodSync(fakeDsh, 0o755);

    const sessionId = `dsh-sb-${randomBytes(4).toString('hex')}-${process.pid}`;
    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        NODE_ENV: 'test',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' '),
        BOTMUX_TEST_DSH_RUNNER_PATH: resolve('src/dsh-runner.ts'),
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_dsh_sb',
        LARK_APP_SECRET: 'secret',
        FAKE_DSH_SCENARIO: 'happy',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      messages.push(message);
      if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
    });

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_dsh_sb',
      rootMessageId: 'om_dsh_sb_root',
      workingDir: resolve('.'),
      cliId: 'dsh',
      cliPathOverride: fakeDsh,
      backendType: 'pty',
      sandbox: true,
      prompt: '<user_message>沙盒测试</user_message>',
      larkAppId: 'app_dsh_sb',
      larkAppSecret: 'secret',
      turnId: 'om_dsh_sb_turn_1',
    };

    try {
      child.send(init);
      await waitFor(child, logs, () =>
        messages.some(m => m.type === 'final_output'));

      const finals = messages.filter(
        (m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output',
      );
      expect(finals).toHaveLength(1);
      expect(finals[0].content).toContain('你好，我是 dsh。');

      // The generated composition and session JSONL must land in the REAL
      // HOME's native dsh dir, not in a throwaway tmpfs that dies with the sandbox.
      // The runner no longer generates cordis.yml — the dsh --profile CLI
      // handles composition. It only creates the profile directory.
      expect(existsSync(join(root, '.dsh', 'profiles', 'botmux'))).toBe(true);
      expect(existsSync(join(root, '.dsh', 'sessions', 'botmux', sessionId))).toBe(true);
    } finally {
      await stopChild(child);
    }
  }, 60_000);
});
