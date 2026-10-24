/**
 * A real worker (claude-code adapter + transcript bridge, tmux or pty backend)
 * driving a fake Claude Code that keeps its state the way 2.1.305+ does:
 * `/clear`, an in-pane `/resume` and `--fork-session` move it to another
 * conversation and rewrite `sessions/<pid>.json`'s sessionId; `/compact`
 * appends to the same transcript; `--resume` of an id whose transcript holds no
 * conversation record exits with "No conversation found". Background-task wake-ups are terminal-local
 * turns with no Lark message behind them.
 *
 * Each test drives generations of workers the way the daemon does: SIGKILL one
 * (its tmux pane and CLI survive) and re-attach (`restart`), or lose the CLI
 * too and launch it again from the daemon's record (`coldRestart`). Which
 * launch layers sit in front of the fake depends on the host (the OSC 7501
 * relay needs bun to run from source, the session scope needs a user systemd).
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { claudeJsonlPathForSession } from '../../src/adapters/cli/claude-code.js';
import { preferredManagedTmuxSocket } from '../../src/adapters/backend/tmux-socket.js';
import { probeTmuxFunctional } from '../../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../../src/types.js';
import { privateTmuxEnv } from './private-tmux-env.js';
import { readJsonLines } from './read-json-lines.js';
import { killProcessTree } from './process-tree.js';
import { spawnNodeTsScript } from './ts-runner.js';

export const claudeHarnessRunnable = process.platform === 'linux' && probeTmuxFunctional().ok;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('2.1.305 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
// A native install's comm is "claude".
if (cfg.commAsClaude) fs.writeFileSync('/proc/self/comm', 'claude');
const args = process.argv.slice(2);
const after = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const resumed = after('--resume');
// --fork-session continues the resumed conversation under a new id: its
// transcript gets a copy of the source plus what follows on first use.
let forkFrom = args.includes('--fork-session') ? resumed : undefined;
let sid = forkFrom ? cfg.forkSid : resumed || after('--session-id');
const spawnSid = sid;
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const procStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), pid: process.pid, sid, ...o }) + '\\n');
const transcriptOf = id => path.join(cfg.projectDir, id + '.jsonl');
// As Claude does: resuming needs a transcript with a user or assistant record.
const holdsConversation = id => fs.existsSync(transcriptOf(id)) && fs.readFileSync(transcriptOf(id), 'utf8').split('\\n')
  .some(line => { try { return ['user', 'assistant'].includes(JSON.parse(line).type); } catch { return false; } });
ev({ kind: 'start', args });
if (resumed && !holdsConversation(resumed)) {
  console.error('No conversation found with session ID: ' + resumed);
  process.exit(1);
}
// A fork child's file opens with metadata records before the conversation lands
// in it — tens of ms on 2.1.308. The fake stays in that state until its first
// turn, so that bridge ticks see it.
if (forkFrom) {
  fs.mkdirSync(cfg.projectDir, { recursive: true });
  fs.writeFileSync(transcriptOf(sid), [{ type: 'mode', mode: 'normal' }, { type: 'permission-mode', permissionMode: 'bypassPermissions' }]
    .map(row => JSON.stringify({ ...row, sessionId: sid }) + '\\n').join(''));
}
const record = o => {
  fs.mkdirSync(cfg.projectDir, { recursive: true });
  if (forkFrom) fs.appendFileSync(transcriptOf(sid), fs.readFileSync(transcriptOf(forkFrom)));
  forkFrom = undefined;
  fs.appendFileSync(transcriptOf(sid), JSON.stringify({
    uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, cwd: cfg.workingDir, ...o,
  }) + '\\n');
};
// Claude's own pid-state record, rewritten in place the way Claude does (never
// through a rename): the worker has to read through a torn record. Withheld
// until the gate file exists when the scenario wants a transcript nobody can
// locate.
const pidState = () => {
  if (cfg.pidStateGate && !fs.existsSync(cfg.pidStateGate)) return;
  fs.mkdirSync(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(cfg.claudeDir, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, cwd: cfg.workingDir, procStart, kind: 'interactive',
    // 2.1.123 keeps the spawn-time sessionId in the record across /clear.
    sessionId: cfg.stalePidState ? spawnSid : sid,
    version: cfg.stalePidState ? '2.1.123' : '2.1.305',
  }));
};
// Claude holds the active session's tasks dir open, across /clear too.
let tasksLock;
const holdTasksDir = () => {
  if (!cfg.holdTasksDir) return;
  if (tasksLock !== undefined) fs.closeSync(tasksLock);
  const dir = path.join(cfg.claudeDir, 'tasks', sid);
  fs.mkdirSync(dir, { recursive: true });
  tasksLock = fs.openSync(path.join(dir, '.lock'), 'a');
};
pidState();
holdTasksDir();
setInterval(pidState, 200);
process.stdin.setRawMode(true);
let composer = '';
let busy = false;
let spin = 0;
const rule = '─'.repeat(48);
const render = () => {
  process.stdout.write('\\x1b[2J\\x1b[H Fake Claude Code ' + (busy ? '|/-+'[spin++ % 4] : '') + '\\r\\n\\r\\n' + rule
    + '\\r\\n❯ ' + composer + '\\r\\n' + rule + '\\r\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    + (busy ? ' · esc to interrupt' : '') + '\\r\\n');
};
// A status clock ticking until the first turn: the screen never goes quiet, so
// the worker never sees the prompt settle and falls back to its first-prompt
// timeout, which reads the prompt off the screen instead.
let startupTicker = cfg.startupTicker
  ? setInterval(() => process.stdout.write('\x1b7\x1b[1;40H' + new Date().toISOString().slice(11, 19) + '\x1b8'), 500)
  : undefined;
const runTurn = (prompt, reply) => {
  if (startupTicker) { clearInterval(startupTicker); startupTicker = undefined; }
  busy = true;
  record({ type: 'user', message: { role: 'user', content: prompt } });
  render();
  const spinner = setInterval(render, 300);
  setTimeout(() => {
    clearInterval(spinner);
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } });
    record({ type: 'system', subtype: 'turn_duration', durationMs: cfg.turnMs });
    busy = false;
    render();
    ev({ kind: 'turn', reply });
  }, cfg.turnMs);
};
// A turn that ends on an API error the way Claude 2.1.296 writes it ("API
// Error: Connection lost mid-response."): a thinking block, then the error
// record and turn_duration. quietMs first parks the turn on a quiet, non-busy screen
// mid-work, which the worker reads as the turn ending.
const failTurn = (prompt, quietMs) => {
  busy = true;
  record({ type: 'user', message: { role: 'user', content: prompt } });
  render();
  let spinner = setInterval(render, 300);
  setTimeout(() => {
    record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: {} }], stop_reason: 'tool_use' } });
    clearInterval(spinner);
    busy = !quietMs;
    render();
    setTimeout(() => {
      busy = true;
      spinner = setInterval(render, 300);
      setTimeout(() => {
        clearInterval(spinner);
        record({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'thinking', thinking: 'next step' }], stop_reason: 'end_turn' } });
        record({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }], stop_reason: 'stop_sequence' } });
        record({ type: 'system', subtype: 'turn_duration', durationMs: cfg.turnMs });
        busy = false;
        render();
        ev({ kind: 'turn-failed', prompt });
      }, cfg.turnMs);
    }, quietMs || 0);
  }, cfg.turnMs);
};
const command = (name, value) => {
  record({ type: 'user', message: { role: 'user', content: '<command-name>' + name + '</command-name>\\n<command-args>' + (value || '') + '</command-args>' } });
  record({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } });
};
const submit = () => {
  const text = composer.replace(/\\x1b\\[20[01]~/g, '').trim();
  composer = '';
  if (!text) { render(); return; }
  ev({ kind: 'submit', text });
  const m = /^\\/(\\S+)(?:\\s+(.*))?$/.exec(text);
  if (m && m[1] === 'clear') { sid = cfg.clearSid; command('/clear'); pidState(); holdTasksDir(); }
  else if (m && m[1] === 'resume') { sid = m[2]; command('/resume', m[2]); pidState(); }
  else if (m && m[1] === 'compact') {
    record({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } });
    record({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } });
  } else if (m) command('/' + m[1], m[2]);
  else if (text.startsWith('FAIL_AFTER_QUIET')) { failTurn(text, 4000); return; }
  else if (text.startsWith('FAIL')) { failTurn(text, 0); return; }
  else { runTurn(text, 'reply: ' + text); return; }
  ev({ kind: 'command', text });
  render();
};
setTimeout(() => {
  render();
  process.stdin.on('data', buf => {
    const s = buf.toString('utf8');
    if (s === '\\r') { submit(); return; }
    composer += s.replace(/\\r/g, '\\n');
    render();
  });
}, 300);
// A background task finishing: Claude wakes up on its own and answers — a
// terminal-local turn with no Lark message behind it.
setInterval(() => {
  if (busy) return;
  for (const name of fs.readdirSync(cfg.notifyDir).sort()) {
    const file = path.join(cfg.notifyDir, name);
    const reply = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    runTurn('<task-notification>\\n<task-id>' + name + '</task-id>\\n<status>completed</status>\\n</task-notification>', reply);
    return;
  }
}, 100);
`;

export interface Harness {
  root: string;
  sessionId: string;
  workingDir: string;
  claudeDir: string;
  transcript: (sid: string) => string;
  clearSid: string;
  /** The id a `--fork-session` launch mints. */
  forkSid: string;
  pidStateGate: string;
  notify: (reply: string) => void;
  commands: () => string[];
  /** Every CLI launch: the session it opened and its argv. */
  launches: () => Array<{ sid: string; args: string[] }>;
  /** Lose the CLI and its tmux server — what a pty worker's death or a lost
   *  pane does to it. */
  killCli: () => void;
  /** When the fake finished `kind` (a command, or the turn that replied `text`). */
  doneAt: (kind: 'command' | 'turn', text: string) => number | undefined;
  /** When a turn started with a FAIL… prompt ended on its API error. */
  failedAt: (prompt: string) => number | undefined;
  startWorker: (init?: Partial<Extract<DaemonToWorker, { type: 'init' }>>) => Generation;
}

export interface Generation {
  child: ChildProcess;
  messages: WorkerToDaemon[];
  logs: string[];
  /** Arrival time of every prompt_ready. */
  readyAt: number[];
  finals: () => string[];
  notices: () => Extract<WorkerToDaemon, { type: 'user_notify' }>[];
  waitFor: (cond: () => boolean, what: string, timeoutMs?: number) => Promise<void>;
  kill: () => Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];
/** Register with `afterEach`: kills every worker, fake CLI and tmux server the
 *  test started, and removes its files. Workers go first, each with the tmux
 *  calls it still has in flight, so none of them outlives its TMUX_TMPDIR. */
export async function cleanUpClaudeHarnesses(): Promise<void> {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best effort */ }
  }
}

export function setupFakeClaude(opts: {
  turnMs: number;
  pidStateGated?: boolean;
  history?: { sid: string; reply: string };
  /** Launch the fake through a layer botmux does not know: a launcher that
   *  runs it as a child instead of exec'ing it.
   *  - `node-cli`: the fake is an interpreter-run install (`node …/claude`).
   *  - `cli-named-launcher`: the launcher's own argv names `claude`, and below
   *    it runs a native-looking Claude (comm `claude`). */
  unknownLayer?: 'node-cli' | 'cli-named-launcher';
  /** The pid-state record keeps the spawn-time sessionId (2.1.123), and the
   *  fake holds its active session's tasks dir open. */
  stalePidState?: boolean;
  /** Keep the screen busy with a status clock until the first turn, so the
   *  worker only finds the prompt through its first-prompt timeout. */
  startupTicker?: boolean;
}): Harness {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(tmpdir(), 'bmx-clear-restore-'));
  const sessionId = randomUUID();
  const clearSid = randomUUID();
  const forkSid = randomUUID();
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  const dataDir = join(root, 'data');
  const notifyDir = join(root, 'notify');
  for (const dir of [workingDir, claudeDir, dataDir, notifyDir]) mkdirSync(dir);
  const transcript = (sid: string) => claudeJsonlPathForSession(sid, workingDir, claudeDir);
  const events = join(root, 'events.jsonl');
  const pidStateGate = join(root, 'pid-state-gate');
  if (opts.history) {
    // An older conversation of this session, answered an hour ago.
    const ago = (ms: number) => new Date(Date.now() - 3_600_000 + ms).toISOString();
    mkdirSync(dirname(transcript(opts.history.sid)), { recursive: true });
    writeFileSync(transcript(opts.history.sid), [
      { type: 'user', uuid: randomUUID(), timestamp: ago(0), message: { role: 'user', content: '<task-notification>\n<task-id>old</task-id>\n</task-notification>' } },
      { type: 'assistant', uuid: randomUUID(), timestamp: ago(1_000), message: { role: 'assistant', content: [{ type: 'text', text: opts.history.reply }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1_000, uuid: randomUUID(), timestamp: ago(1_100) },
    ].map(row => `${JSON.stringify({ sessionId: opts.history!.sid, ...row })}\n`).join(''));
  }
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({
    events, claudeDir, workingDir, notifyDir, clearSid, forkSid, turnMs: opts.turnMs,
    projectDir: dirname(transcript(sessionId)),
    ...(opts.pidStateGated ? { pidStateGate } : {}),
    ...(opts.stalePidState ? { stalePidState: true, holdTasksDir: true } : {}),
    ...(opts.unknownLayer === 'cli-named-launcher' ? { commAsClaude: true } : {}),
    ...(opts.startupTicker ? { startupTicker: true } : {}),
  }));
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  const fakeCli = join(root, 'claude');
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);
  const launcher = opts.unknownLayer === 'cli-named-launcher' ? join(root, 'wrap', 'claude') : join(root, 'launcher');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(fakeCli)}, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`);
  chmodSync(launcher, 0o755);
  // The fake appends one line per event while tests poll this file.
  const readEvents = () => readJsonLines(events);
  const killCli = () => {
    for (const pid of new Set(readEvents().map(e => e.pid as number))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
    // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
    // falls back to /tmp and the host's default server would be the target.
    // Managed sessions live on the dedicated socket, both under this root.
    for (const name of new Set(['default', preferredManagedTmuxSocket() ?? 'default'])) {
      const socket = join(root, `tmux-${process.getuid?.() ?? 0}`, name);
      try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* gone */ }
    }
  };
  cleanups.push(() => {
    killCli();
    rmSync(root, { recursive: true, force: true });
  });

  let notified = 0;
  const harness: Harness = {
    root, sessionId, workingDir, claudeDir, transcript, clearSid, forkSid, pidStateGate, killCli,
    // Staged outside notifyDir and renamed in: the fake polls notifyDir every
    // 100ms, and a file it reads between creation and write is an empty reply.
    notify: reply => {
      const name = String(++notified).padStart(4, '0');
      const staged = join(root, `notify-${name}.tmp`);
      writeFileSync(staged, reply);
      renameSync(staged, join(notifyDir, name));
    },
    commands: () => readEvents().filter(e => e.kind === 'command').map(e => e.text as string),
    launches: () => readEvents().filter(e => e.kind === 'start').map(e => ({ sid: e.sid as string, args: e.args as string[] })),
    doneAt: (kind, text) => readEvents().find(e => e.kind === kind && (kind === 'command' ? e.text === text : e.reply === text))?.t,
    failedAt: prompt => readEvents().find(e => e.kind === 'turn-failed' && e.prompt === prompt)?.t,
    startWorker: (init = {}) => {
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const readyAt: number[] = [];
      const spawnOptions: SpawnOptions = {
        cwd: resolve('.'),
        env: privateTmuxEnv(root, {
          SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      };
      const child = process.env.BOTMUX_TEST_WORKER_BINARY
        ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
        : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
      child.on('message', m => {
        messages.push(m as WorkerToDaemon);
        if ((m as WorkerToDaemon).type === 'prompt_ready') readyAt.push(Date.now());
      });
      child.stdout?.on('data', b => logs.push(b.toString()));
      child.stderr?.on('data', b => logs.push(b.toString()));
      const kill = () => killProcessTree(child, 3_000);
      cleanups.push(kill);
      child.send({
        type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir,
        cliId: 'claude-code', cliPathOverride: opts.unknownLayer ? launcher : fakeCli, cliConfigDir: claudeDir, backendType: 'tmux',
        prompt: '', promptInjection: 'none', larkAppId: 'app_test', larkAppSecret: 'secret', locale: 'zh',
        ...init,
      } satisfies DaemonToWorker);
      const generation: Generation = {
        child, messages, logs, readyAt, kill,
        finals: () => messages.flatMap(m => (m.type === 'final_output' ? [m.content] : [])),
        notices: () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> => m.type === 'user_notify'),
        waitFor: async (cond, what, timeoutMs = 45_000) => {
          const deadline = Date.now() + timeoutMs;
          while (!cond()) {
            if (Date.now() >= deadline || child.exitCode !== null) {
              throw new Error(`timed out waiting for ${what}\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}`);
            }
            await new Promise(done => setTimeout(done, 50));
          }
        },
      };
      return generation;
    },
  };
  return harness;
}

export const promptReadyCount = (g: Generation) => g.messages.filter(m => m.type === 'prompt_ready').length;

/** The worker is back at the prompt after the fake finished `kind`, so the
 *  next step starts out of idle — the way a background wake-up does. */
export async function settled(h: Harness, g: Generation, kind: 'command' | 'turn', text: string): Promise<void> {
  await g.waitFor(() => {
    const at = h.doneAt(kind, text);
    return at !== undefined && g.readyAt.some(ready => ready > at);
  }, `the CLI back at its prompt after "${text}"`);
}

/** Let the CLI run a background turn to the end. */
export async function runBackgroundTurn(h: Harness, g: Generation, reply: string): Promise<void> {
  h.notify(reply);
  await settled(h, g, 'turn', reply);
}

/** ... and wait for its reply to be forwarded. */
export async function backgroundTurn(h: Harness, g: Generation, reply: string): Promise<void> {
  await runBackgroundTurn(h, g, reply);
  await g.waitFor(() => g.finals().some(text => text.includes(reply)), `the forwarded reply "${reply}"`);
}

export async function passthrough(h: Harness, g: Generation, command: string): Promise<void> {
  g.child.send({ type: 'raw_input', content: command, turnId: `om_${randomUUID().slice(0, 8)}` } satisfies DaemonToWorker);
  await settled(h, g, 'command', command);
  // One bridge poll tick (1s) for the worker to observe the rotation.
  await new Promise(done => setTimeout(done, 1_500));
}

/** SIGKILL the worker (pane and CLI survive), then re-attach a new one. */
export async function restart(h: Harness, g: Generation): Promise<Generation> {
  await g.kill();
  const next = h.startWorker({ resume: true });
  await next.waitFor(() => promptReadyCount(next) > 0, 'the re-attached CLI to be ready');
  return next;
}

/** What the daemon has on record after a generation: the CLI session id the
 *  worker reported last, else what it had before. */
export function recordedCliSessionId(g: Generation, before?: string): string | undefined {
  return g.messages.flatMap(m => (m.type === 'cli_session_id' ? [m.cliSessionId] : [])).at(-1) ?? before;
}

/** The worker dies and takes the CLI with it — a daemon restart on the pty
 *  backend, or a tmux pane that is gone — and a new one launches the CLI from
 *  the daemon's record. */
export async function coldRestart(
  h: Harness,
  g: Generation,
  init: Partial<Extract<DaemonToWorker, { type: 'init' }>>,
): Promise<Generation> {
  await g.kill();
  h.killCli();
  const next = h.startWorker({ resume: true, ...init });
  await next.waitFor(() => promptReadyCount(next) > 0, 'the relaunched CLI to be ready');
  return next;
}
