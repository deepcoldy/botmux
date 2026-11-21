/**
 * A cold Claude whose SessionStart hooks outlast the 45s ready-gate fallback
 * (#2917). Claude already draws its composer, but takes no submit until its
 * hooks finish. The worker gives up waiting, types the first prompt into that
 * composer and presses Enter: every Enter is dropped and the prompt stays in
 * the composer, unsubmitted. When the late SessionStart signal then arrives,
 * the prompt must still be submitted from there.
 *
 * Real worker (tmux backend + claude-code adapter + ready gate), fake Claude.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { preferredManagedTmuxSocket } from '../src/adapters/backend/tmux-socket.js';
import { sessionReadyHookCommand } from '../src/adapters/hook-command.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const tmuxAvailable = probeTmuxFunctional().ok;

const FIRST_PROMPT = 'late-session-start-probe: reply with one line';

interface FakeEvent { t: number; kind: 'ready' | 'enter-dropped' | 'submit'; text?: string }

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
fs.writeFileSync(cfg.pidFile, String(process.pid));
process.stdin.setRawMode(true);
let ready = false;
let composer = '';
const rule = '─'.repeat(48);
const show = text => process.stdout.write('\\x1b[2J\\x1b[H' + text.split('\\n').join('\\r\\n'));
const renderComposer = () => show(' Fake Claude Code\\n\\n' + rule + '\\n❯ ' + composer + '\\n' + rule + '\\n  ? for shortcuts\\n');
process.stdin.on('data', buf => {
  const s = buf.toString('utf8');
  if (s === '\\r') {
    if (!ready) { ev({ kind: 'enter-dropped' }); return; }
    const text = composer;
    if (!text) return;
    composer = '';
    ev({ kind: 'submit', text });
    fs.mkdirSync(path.dirname(cfg.transcript), { recursive: true });
    fs.appendFileSync(cfg.transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\\n');
    renderComposer();
    return;
  }
  composer += s;
  renderComposer();
});
renderComposer();
setInterval(() => {
  if (ready || !fs.existsSync(cfg.hooksDone)) return;
  ready = true;
  ev({ kind: 'ready', text: composer });
  renderComposer();
}, 100);
setInterval(() => {}, 1000);
`;

it.skipIf(!tmuxAvailable)('submits the first prompt left in the composer once the late SessionStart arrives', async () => {
  const sessionId = randomUUID();
  const root = mkdtempSync(join('/tmp', 'bmx-late-session-start-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  for (const dir of [home, dataDir, workingDir, claudeDir]) mkdirSync(dir);
  mkdirSync(join(home, '.botmux'), { mode: 0o700 });
  const eventsFile = join(root, 'events.jsonl');
  const pidFile = join(root, 'cli-pid');
  const hooksDone = join(root, 'hooks-done');
  const transcript = claudeJsonlPathForSession(sessionId, workingDir, claudeDir);
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({ events: eventsFile, pidFile, transcript, hooksDone }));
  // The worker arms its ready gate only when botmux's SessionStart hook is installed.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: sessionReadyHookCommand() }] }] },
  }));
  const fakeCli = join(root, 'claude');
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const events = () => readJsonLines<FakeEvent>(eventsFile);
  const context = () => `${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}\n${JSON.stringify(existsSync(eventsFile) ? events() : [])}`;
  const waitFor = async (condition: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) throw new Error(`timed out waiting for ${what}\n${context()}`);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: privateTmuxEnv(root, {
        HOME: home, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir, cliId: 'claude-code', cliPathOverride: fakeCli, cliConfigDir: claudeDir,
      backendType: 'tmux', prompt: FIRST_PROMPT, turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => logs.join('').includes('Ready gate armed'), 60_000, 'the ready gate');
    // The fallback types the prompt and its Enters are dropped while Claude starts.
    await waitFor(() => events().filter(e => e.kind === 'enter-dropped').length >= 3, 90_000, 'the dropped submit attempts');
    await new Promise(r => setTimeout(r, 3_000));

    // The hooks finish with the prompt still in the composer; the signal follows.
    writeFileSync(hooksDone, '');
    await waitFor(() => events().some(e => e.kind === 'ready'), 10_000, 'the composer');
    expect(events().find(e => e.kind === 'ready')!.text).toContain(FIRST_PROMPT);
    child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);

    await waitFor(() => events().some(e => e.kind === 'submit'), 30_000, 'the first prompt to be submitted');
    await new Promise(r => setTimeout(r, 2_000));
    expect(events().filter(e => e.kind === 'submit').map(e => e.text), context()).toEqual([FIRST_PROMPT]);
  } finally {
    if (child) await killProcessTree(child);
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
    // falls back to /tmp and the host's default server would be the target.
    for (const name of new Set(['default', preferredManagedTmuxSocket() ?? 'default'])) {
      const privateSocket = join(root, `tmux-${process.getuid?.() ?? 0}`, name);
      try { execFileSync('tmux', ['-S', privateSocket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
