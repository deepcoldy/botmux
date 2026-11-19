/**
 * Bot startupCommands edited after the worker forked must be what an in-worker
 * restart replays — against a REAL worker (tmux backend + claude-code adapter +
 * runStartupCommands) and a fake Claude Code that records every submit.
 *
 * Incident 2026-11-06: an Agent sync changed the bot's startup
 * commands from `/effort max, /effort ultracode` to `/effort xhigh`; the card
 * restart that followed respawned the CLI in place from the worker's fork-time
 * snapshot and replayed the OLD commands.
 *
 * One worker, three phases:
 *   1. fresh spawn: old startup commands, then the one-shot `/rename`, then the
 *      first prompt; the user then renames the session by hand (`/rename`
 *      passthrough).
 *   2. the config changes but the session is NOT restarted: a later turn types
 *      only the prompt into the running CLI — nothing is re-run in it.
 *   3. restart IPC carrying the new commands: the replacement CLI process runs
 *      exactly the new commands before the next prompt, and neither the old
 *      commands nor any `/rename` (which would undo the manual rename).
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const tmuxAvailable = probeTmuxFunctional().ok;

interface FakeEvent { t: number; pid: number; kind: 'ready' | 'submit'; text?: string }

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.304 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\\n');
fs.appendFileSync(cfg.pidFile, process.pid + '\\n');
process.stdin.setRawMode(true);
let composer = '';
const rule = '─'.repeat(48);
const render = () => {
  process.stdout.write('\\x1b[2J\\x1b[H Fake Claude Code\\r\\n\\r\\n' + rule + '\\r\\n❯ '
    + composer.split('\\n').join('\\r\\n  ') + '\\r\\n' + rule + '\\r\\n  ? for shortcuts\\r\\n');
};
const record = content => {
  fs.mkdirSync(path.dirname(cfg.transcript), { recursive: true });
  fs.appendFileSync(cfg.transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } }) + '\\n');
};
// Real Claude Code ends every turn with a terminal assistant record
// (stop_reason end_turn). Without one, scanRestartInterruption() always sees
// turnOpen=true: whether the restart interruption note is then delivered
// depends on which prompt-ready path wins the race (idle detector at ~2s vs
// the 15s first-prompt timeout), making the post-restart submit list flaky.
const closeTurn = () => fs.appendFileSync(cfg.transcript, JSON.stringify({
  type: 'assistant',
  uuid: 'a-' + process.pid + '-' + Date.now(),
  timestamp: new Date().toISOString(),
  message: {
    id: 'm-' + process.pid + '-' + Date.now(),
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
  },
}) + '\\n');
const submit = () => {
  const text = composer;
  composer = '';
  if (!text) { render(); return; }
  ev({ kind: 'submit', text });
  const m = /^(\\/[\\w:.-]+)(?:\\s+(.*))?$/.exec(text);
  if (m) {
    record('<command-name>' + m[1] + '</command-name>\\n<command-args>' + (m[2] || '') + '</command-args>');
    record('<local-command-stdout>ok</local-command-stdout>');
  } else {
    record(text);
  }
  closeTurn();
  render();
};
process.stdin.on('data', buf => {
  for (const ch of buf.toString('utf8')) {
    // Claude's soft newline: a trailing backslash before Enter continues the draft.
    if (ch === '\\r' && composer.endsWith('\\\\')) composer = composer.slice(0, -1) + '\\n';
    else if (ch === '\\r') submit();
    else composer += ch;
  }
  render();
});
ev({ kind: 'ready' });
render();
setInterval(() => {}, 1000);
`;

it.skipIf(!tmuxAvailable)(
  'an in-worker restart replays the bot startup commands it carries, not the fork-time snapshot, and never re-runs /rename',
  async () => {
    const sessionId = randomUUID();
    const botmuxDir = join(homedir(), '.botmux');
    mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
    chmodSync(botmuxDir, 0o700);
    const root = mkdtempSync(join('/tmp', 'bmx-restart-startup-'));
    const dataDir = join(root, 'data');
    const workingDir = join(root, 'work');
    const claudeDir = join(root, 'claude-config');
    mkdirSync(dataDir);
    mkdirSync(workingDir);
    mkdirSync(claudeDir);
    const eventsFile = join(root, 'events.jsonl');
    const pidFile = join(root, 'cli-pids');
    const transcript = claudeJsonlPathForSession(sessionId, workingDir, claudeDir);
    const configFile = join(root, 'fake-claude.json');
    writeFileSync(configFile, JSON.stringify({ events: eventsFile, pidFile, transcript }));
    const fakeCli = join(root, 'claude');
    // An extensionless script follows the nearest package.json; never inherit a
    // stray `"type": "module"` from a parent directory.
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
    chmodSync(fakeCli, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    let child: ChildProcess | undefined;
    const events = () => (existsSync(eventsFile) ? readJsonLines<FakeEvent>(eventsFile) : []);
    const pids = () => [...new Set(events().filter(e => e.kind === 'ready').map(e => e.pid))];
    // A prompt may carry a botmux context block after its first line; compare by first line.
    const submitsOf = (pid: number) => events()
      .filter(e => e.kind === 'submit' && e.pid === pid)
      .map(e => (e.text ?? '').split('\n')[0]);
    const dump = () => `${logs.join('')}\n${JSON.stringify(events())}`;
    const waitFor = async (condition: () => boolean, timeoutMs: number, what: string): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() >= deadline || child?.exitCode != null) {
          throw new Error(`timed out waiting for ${what}\n${dump()}`);
        }
        await new Promise(r => setTimeout(r, 50));
      }
    };
    const settle = () => new Promise(r => setTimeout(r, 2_500));
    try {
      const spawnOptions: SpawnOptions = {
        cwd: resolve('.'),
        env: privateTmuxEnv(root, {
          SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      };
      child = process.env.BOTMUX_TEST_WORKER_BINARY
        ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
        : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
      child.on('message', m => messages.push(m as WorkerToDaemon));
      child.stdout?.on('data', b => logs.push(b.toString()));
      child.stderr?.on('data', b => logs.push(b.toString()));
      child.send({
        type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
        workingDir, cliId: 'claude-code', cliPathOverride: fakeCli, cliConfigDir: claudeDir,
        backendType: 'tmux', startupCommands: ['/effort max', '/effort ultracode'],
        initialNativeRename: '/rename 初始标题',
        prompt: 'first prompt', turnId: 'om_first', larkAppId: 'app_test', larkAppSecret: 'secret',
      } satisfies DaemonToWorker);

      // ── 1. fresh spawn, then the user renames the session by hand ──
      await waitFor(() => pids().length === 1 && submitsOf(pids()[0]!).includes('first prompt'), 60_000, 'the first prompt');
      const first = pids()[0]!;
      child.send({ type: 'raw_input', content: '/rename 手动改的名字', turnId: 'om_rename' } satisfies DaemonToWorker);
      await waitFor(() => submitsOf(first).includes('/rename 手动改的名字'), 30_000, 'the manual rename');

      // ── 2. config changed, session not restarted: the running CLI gets the turn only ──
      child.send({ type: 'message', content: 'second turn', turnId: 'om_second' } satisfies DaemonToWorker);
      await waitFor(() => submitsOf(first).includes('second turn'), 30_000, 'the second turn');
      await settle();
      expect(submitsOf(first), dump()).toEqual([
        '/effort max', '/effort ultracode', '/rename 初始标题', 'first prompt',
        '/rename 手动改的名字', 'second turn',
      ]);

      // ── 3. restart carrying the bot's current startup commands ──
      child.send({ type: 'restart', attemptId: 'restart-1', startupCommands: ['/effort xhigh'] } satisfies DaemonToWorker);
      await waitFor(() => pids().length === 2, 60_000, 'the replacement CLI');
      const second = pids()[1]!;
      await waitFor(
        () => messages.some(m => m.type === 'restart_result' && m.attemptId === 'restart-1'),
        60_000, 'the restart receipt',
      );
      child.send({ type: 'message', content: 'after restart', turnId: 'om_third' } satisfies DaemonToWorker);
      await waitFor(() => submitsOf(second).includes('after restart'), 60_000, 'the post-restart turn');
      await settle();
      expect(submitsOf(second), dump()).toEqual(['/effort xhigh', 'after restart']);
      // The old process saw nothing more after the restart began.
      expect(submitsOf(first)).toHaveLength(6);
    } finally {
      if (child) await killProcessTree(child);
      if (existsSync(pidFile)) {
        for (const pid of readFileSync(pidFile, 'utf8').split('\n').filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { /* exited */ }
        }
      }
      // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
      // falls back to /tmp and the host's default server would be the target.
      const privateSocket = join(root, `tmux-${process.getuid?.() ?? 0}`, 'default');
      try { execFileSync('tmux', ['-S', privateSocket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);
