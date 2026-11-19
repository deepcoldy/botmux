/**
 * Claude Code's one-time startup questions, against a REAL worker (tmux backend
 * + claude-code adapter + ready gate + markPromptReady / flushPending) and a
 * fake Claude that shows them exactly as 2.1.310 does.
 *
 * #2309: the first Claude session of every Feishu live run started on "Detected
 * a custom API key in your environment — Do you want to use this API key?",
 * which runs before the SessionStart hooks. The worker held the first prompt
 * for its ready signal, gave up at the 45s fallback and typed the prompt into
 * the dialog: the text was swallowed, its Enter answered the question, the
 * SessionStart hook fired, and the next question — "Make auto mode your default
 * permission mode?", default "Yes" — took the submit retry's Enter. The message
 * was lost and the user's default permission mode was changed for them.
 *
 * Both screens are the captured fixtures. The fake records every byte that
 * reaches it while a question is up; a "human" answers each one by creating a
 * file (the Web terminal), and real Claude's SessionStart hook is reported
 * between the two questions. Only then does the composer appear.
 *
 *   1. Past the 15s first-prompt timeout and the 45s ready-gate fallback, not
 *      one byte may reach the API key question; the thread hears once what it
 *      is waiting for.
 *   2. After SessionStart, the auto-mode question's ❯ is not a prompt: nothing
 *      may reach it either, and the thread hears about it once.
 *   3. Once both are answered, the first prompt is submitted from the composer.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { sessionReadyHookCommand } from '../src/adapters/hook-command.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const tmuxAvailable = probeTmuxFunctional().ok;

const FIRST_PROMPT = 'startup-dialog-probe: reply with one line';

interface FakeEvent { t: number; kind: 'question' | 'dialog-input' | 'composer' | 'submit' | 'paste'; phase?: string; text?: string }

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
fs.writeFileSync(cfg.pidFile, String(process.pid));
process.stdin.setRawMode(true);
const questions = [
  { phase: 'api_key', screen: fs.readFileSync(cfg.apiKeyScreen, 'utf8'), answer: cfg.answerApiKey },
  { phase: 'auto_mode', screen: fs.readFileSync(cfg.autoModeScreen, 'utf8'), answer: cfg.answerAutoMode },
];
let phase = 0;
let composer = '';
const rule = '─'.repeat(48);
const show = text => process.stdout.write('\\x1b[2J\\x1b[H' + text.split('\\n').join('\\r\\n'));
const renderComposer = () => show(' Fake Claude Code\\n\\n' + rule + '\\n❯ ' + composer + '\\n' + rule + '\\n  ? for shortcuts\\n');
const ask = () => { ev({ kind: 'question', phase: questions[phase].phase }); show(questions[phase].screen); };
const onData = buf => {
  const s = buf.toString('utf8');
  if (phase < questions.length) { ev({ kind: 'dialog-input', phase: questions[phase].phase, text: s }); return; }
  if (s.length > 1 && s.includes('\\r')) { ev({ kind: 'paste', text: s }); composer += s.replace(/\\r/g, '\\n'); renderComposer(); return; }
  if (s === '\\r') {
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
};
process.stdin.on('data', onData);
ask();
setInterval(() => {
  if (phase >= questions.length || !fs.existsSync(questions[phase].answer)) return;
  phase += 1;
  if (phase < questions.length) { ask(); return; }
  ev({ kind: 'composer' });
  renderComposer();
}, 100);
setInterval(() => {}, 1000);
`;

const fixture = (name: string) => resolve('test/fixtures/startup-blockers', name);

it.skipIf(!tmuxAvailable)('never types the first prompt into a Claude startup question, and delivers it once both are answered', async () => {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  const root = mkdtempSync(join('/tmp', 'bmx-claude-dialog-'));
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  mkdirSync(dataDir);
  mkdirSync(workingDir);
  mkdirSync(claudeDir);
  const eventsFile = join(root, 'events.jsonl');
  const pidFile = join(root, 'cli-pid');
  const answerApiKey = join(root, 'answer-api-key');
  const answerAutoMode = join(root, 'answer-auto-mode');
  const transcript = claudeJsonlPathForSession(sessionId, workingDir, claudeDir);
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({
    events: eventsFile, pidFile, transcript, answerApiKey, answerAutoMode,
    apiKeyScreen: fixture('claude-2.1.310-custom-api-key.txt'),
    autoModeScreen: fixture('claude-2.1.310-auto-mode-offer.txt'),
  }));
  // The worker arms its ready gate only when botmux's SessionStart hook is installed.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: sessionReadyHookCommand() }] }] },
  }));
  const fakeCli = join(root, 'claude');
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  // The worker hands the CLI a filtered env, so bake the config path in.
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
  const notices = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> => m.type === 'user_notify');
  const dialogInput = () => events().filter(e => e.kind === 'dialog-input');
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
      backendType: 'tmux', prompt: FIRST_PROMPT, turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => logs.join('').includes('Ready gate armed'), 60_000, 'the ready gate');
    await waitFor(() => events().some(e => e.kind === 'question' && e.phase === 'api_key'), 30_000, 'the API key question');
    const askedAt = events().find(e => e.kind === 'question')!.t;

    // 1. Past the 15s first-prompt timeout, the 45s ready-gate fallback and its settle.
    while (Date.now() < askedAt + 55_000) await new Promise(r => setTimeout(r, 250));
    expect(dialogInput(), context()).toEqual([]);
    expect(notices(), context()).toHaveLength(1);

    // 2. Someone answers in the Web terminal; Claude runs its hooks, then asks the next question.
    writeFileSync(answerApiKey, 'no');
    await waitFor(() => events().some(e => e.kind === 'question' && e.phase === 'auto_mode'), 10_000, 'the auto-mode question');
    child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
    const secondAskedAt = Date.now();
    while (Date.now() < secondAskedAt + 15_000) await new Promise(r => setTimeout(r, 250));
    expect(dialogInput(), context()).toEqual([]);
    expect(notices(), context()).toHaveLength(2);
    expect(notices()[1]!.message).not.toBe(notices()[0]!.message);

    // 3. Answered too: the composer appears and the first prompt is submitted from it.
    writeFileSync(answerAutoMode, 'no');
    await waitFor(() => events().some(e => e.kind === 'submit'), 60_000, 'the first prompt to be submitted');
    // Let a late retry Enter or a stray write surface before asserting.
    await new Promise(r => setTimeout(r, 2_000));
    const composerAt = events().find(e => e.kind === 'composer')!.t;
    const submits = events().filter(e => e.kind === 'submit');
    expect(dialogInput(), context()).toEqual([]);
    expect(events().filter(e => e.kind === 'paste'), context()).toEqual([]);
    expect(submits.map(e => e.text), context()).toEqual([FIRST_PROMPT]);
    expect(submits[0]!.t).toBeGreaterThan(composerAt);
    expect(readFileSync(transcript, 'utf8')).toContain(FIRST_PROMPT);
  } finally {
    if (child) await killProcessTree(child);
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    // Never a bare kill-server: should TMUX_TMPDIR be missing, tmux silently
    // falls back to /tmp and the host's default server would be the target.
    const privateSocket = join(root, `tmux-${process.getuid?.() ?? 0}`, 'default');
    try { execFileSync('tmux', ['-S', privateSocket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
