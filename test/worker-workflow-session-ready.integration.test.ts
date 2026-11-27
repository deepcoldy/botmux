/**
 * SessionStart readiness for a v3 workflow worker, against a REAL worker (tmux
 * backend + claude-code adapter + ready gate) and a fake Claude whose
 * SessionStart hook is the real `botmux session-ready` CLI.
 *
 * A workflow worker is forked by the v3 ephemeral pool and has no daemon
 * session record. The hook's only transport used to be the daemon's
 * `/api/session-ready`, which looks the session up in its own session table:
 * for a workflow worker the signal was silently dropped and every Claude node
 * waited out the ready-gate fallback before reporting prompt readiness.
 *
 *   1. With the hook running, the real signal reaches the worker and the first
 *      prompt becomes ready long before the fallback.
 *   2. Without a hook the gate still waits for its fallback: the missing-signal
 *      behaviour and its timeout are unchanged.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionReadyHookCommand } from '../src/adapters/hook-command.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const tmuxAvailable = probeTmuxFunctional().ok;

interface FakeEvent { t: number; kind: 'started' | 'hook-exit' | 'composer'; code?: number | null }

// Real Claude renders its composer only after every SessionStart hook has
// finished; the hook is the real botmux CLI with the env the worker handed us.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
fs.writeFileSync(cfg.pidFile, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.on('data', () => {});
const rule = '─'.repeat(48);
const show = text => process.stdout.write('\\x1b[2J\\x1b[H' + text.split('\\n').join('\\r\\n'));
const composer = () => { ev({ kind: 'composer' }); show(' Fake Claude Code\\n\\n' + rule + '\\n❯ \\n' + rule + '\\n  ? for shortcuts\\n'); };
ev({ kind: 'started' });
show(' Fake Claude Code\\n\\n  starting…\\n');
if (cfg.hook) {
  if (cfg.earlyComposer) composer();
  const hook = spawn(cfg.hook[0], cfg.hook.slice(1), { cwd: cfg.repo, env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
  hook.stdin.end(JSON.stringify({ source: 'startup', session_id: 'fake' }));
  hook.on('close', code => { ev({ kind: 'hook-exit', code }); if (!cfg.earlyComposer) composer(); });
} else {
  setTimeout(composer, 300);
}
setInterval(() => {}, 1000);
`;

interface Harness {
  messages: WorkerToDaemon[];
  logs: () => string;
  events: () => FakeEvent[];
  child: ChildProcess;
  /** Run a tmux client against the worker's private server. */
  tmux: (args: string[]) => string;
  root: string;
  cleanup: () => Promise<void>;
}

async function startWorker(opts: { runHook: boolean; earlyComposer?: boolean; backendType?: 'tmux' | 'pty' }): Promise<Harness> {
  const sessionId = randomUUID();
  const root = mkdtempSync(join('/tmp', 'bmx-wf-ready-'));
  const socketDir = join(root, `tmux-${process.getuid?.() ?? 0}`);
  // Private HOME: the worker and the hook CLI resolve ~/.botmux from it, so the
  // host's real ~/.botmux (and its daemon registry) is never touched.
  const home = join(root, 'home');
  mkdirSync(join(home, '.botmux'), { recursive: true, mode: 0o700 });
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  mkdirSync(dataDir);
  mkdirSync(workingDir);
  mkdirSync(claudeDir);
  const eventsFile = join(root, 'events.jsonl');
  const pidFile = join(root, 'cli-pid');
  const configFile = join(root, 'fake-claude.json');
  const runner = tsRunnerPrefix();
  writeFileSync(configFile, JSON.stringify({
    events: eventsFile, pidFile, repo: resolve('.'), earlyComposer: opts.earlyComposer,
    hook: opts.runHook ? [runner.command, ...runner.prefixArgs, resolve('src/cli.ts'), 'session-ready'] : null,
  }));
  // The worker arms its ready gate only when botmux's SessionStart hook is installed.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: sessionReadyHookCommand() }] }] },
  }));
  const fakeCli = join(root, 'claude');
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logChunks: string[] = [];
  const spawnOptions: SpawnOptions = {
    cwd: resolve('.'),
    env: privateTmuxEnv(root, {
      HOME: home,
      SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
      // What the v3 ephemeral pool sets for its workers.
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_PTY_LOG_PATH: join(root, 'pty.log'),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  };
  const child = process.env.BOTMUX_TEST_WORKER_BINARY
    ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
    : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', b => logChunks.push(b.toString()));
  child.stderr?.on('data', b => logChunks.push(b.toString()));
  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'v3-root-test',
    workingDir, cliId: 'claude-code', cliPathOverride: fakeCli, cliConfigDir: claudeDir,
    // The pool sends the goal itself once the worker reports prompt_ready.
    backendType: opts.backendType ?? 'tmux', prompt: '', larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return {
    messages,
    logs: () => logChunks.join(''),
    events: () => (existsSync(eventsFile) ? readJsonLines<FakeEvent>(eventsFile) : []),
    child,
    root,
    tmux: args => {
      // The worker runs its server on a named socket under the private TMUX_TMPDIR.
      const sockets = readdirSync(socketDir);
      expect(sockets).toHaveLength(1);
      return execFileSync('tmux', ['-S', join(socketDir, sockets[0]!), ...args], {
        env: privateTmuxEnv(root), encoding: 'utf8', timeout: 10_000,
      });
    },
    cleanup: async () => {
      await killProcessTree(child);
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
      }
      // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
      // falls back to /tmp and the host's default server would be the target.
      // Only sockets inside this test's private directory are addressed.
      for (const name of existsSync(socketDir) ? readdirSync(socketDir) : []) {
        try { execFileSync('tmux', ['-S', join(socketDir, name), 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(h: Harness, condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline || h.child.exitCode != null) {
      throw new Error(`timed out waiting for ${what}\n${h.logs()}\n${JSON.stringify(h.events())}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Arrival time of the worker's first prompt_ready IPC message. */
function trackPromptReady(h: Harness): () => number | undefined {
  let at: number | undefined;
  h.child.on('message', m => { if ((m as WorkerToDaemon).type === 'prompt_ready') at ??= Date.now(); });
  return () => at;
}

describe.skipIf(!tmuxAvailable)('v3 workflow worker — SessionStart readiness', () => {
  it('releases the ready gate on the real SessionStart hook instead of the 45s fallback', async () => {
    const h = await startWorker({ runHook: true });
    const promptReadyAt = trackPromptReady(h);
    try {
      await waitFor(h, () => h.logs().includes('Ready gate armed'), 60_000, 'the ready gate');
      const armedAt = Date.now();
      // Bounded by the fallback plus margin, so the pre-fix behaviour reports how long it waited.
      await waitFor(h, () => promptReadyAt() !== undefined, 75_000, 'prompt_ready');
      const waitedMs = promptReadyAt()! - armedAt;
      const logs = h.logs();
      expect(h.events().find(e => e.kind === 'hook-exit')?.code, logs).toBe(0);
      expect(logs).toContain('SessionStart ready signal received (source=startup)');
      expect(logs).not.toContain('signal timeout fallback');
      // The hook spawns a TypeScript CLI under the test runner; well under the 45s fallback.
      expect(waitedMs, logs).toBeLessThan(30_000);
      // The prompt that turned ready is the one Claude drew after its hooks finished.
      expect(promptReadyAt()!).toBeGreaterThanOrEqual(h.events().find(e => e.kind === 'composer')!.t);

      // The private HOME has no daemon registry and the worker injects no
      // daemon port, so the signal can only have come through the local
      // channel: tmux forwarded both keys into the target pane. They must not
      // be left in the shared server's global env, nor reach another pane.
      const globalEnv = h.tmux(['show-environment', '-g']);
      expect(globalEnv.split('\n').filter(line => /^-?BOTMUX_SESSION_READY_SIGNAL_/.test(line)).map(line => line.split('=')[0])).toEqual([]);
      const otherOut = join(h.root, 'other-pane.env');
      h.tmux(['new-session', '-d', '-s', 'co-tenant', '--', '/bin/sh', '-c', '/usr/bin/env > "$1"; tmux wait-for -S bmx-other-done; sleep 30', '_', otherOut]);
      h.tmux(['wait-for', 'bmx-other-done']);
      const otherEnv = readFileSync(otherOut, 'utf8').split('\n');
      expect(otherEnv.filter(line => line.startsWith('BOTMUX_SESSION_READY_SIGNAL_'))).toEqual([]);
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  it('admits a quiet PTY composer already drawn before the hook returned, without a redraw', async () => {
    const h = await startWorker({ runHook: true, backendType: 'pty', earlyComposer: true });
    const promptReadyAt = trackPromptReady(h);
    try {
      await waitFor(h, () => h.logs().includes('Ready gate armed'), 60_000, 'the ready gate');
      const armedAt = Date.now();
      await waitFor(h, () => promptReadyAt() !== undefined, 75_000, 'prompt_ready');
      const logs = h.logs();
      expect(logs).toContain('SessionStart ready signal received (source=startup)');
      expect(logs).not.toContain('signal timeout fallback');
      expect(promptReadyAt()! - armedAt, logs).toBeLessThan(30_000);
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  it('still waits for the fallback when no SessionStart signal arrives', async () => {
    const h = await startWorker({ runHook: false });
    const promptReadyAt = trackPromptReady(h);
    try {
      await waitFor(h, () => h.logs().includes('Ready gate armed'), 60_000, 'the ready gate');
      const armedAt = Date.now();
      await waitFor(h, () => promptReadyAt() !== undefined, 75_000, 'prompt_ready');
      const logs = h.logs();
      expect(logs).toContain('Ready gate released (signal timeout fallback)');
      expect(logs).not.toContain('SessionStart ready signal received');
      expect(promptReadyAt()! - armedAt, logs).toBeGreaterThanOrEqual(40_000);
    } finally {
      await h.cleanup();
    }
  }, 180_000);
});
