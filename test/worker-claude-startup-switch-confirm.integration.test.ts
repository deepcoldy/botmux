/**
 * Startup command `/effort max` replayed into a resumed Claude Code conversation
 * whose prompt cache may still be warm, against a REAL worker (tmux backend +
 * claude-code adapter + runStartupCommands) and a fake Claude Code.
 *
 * Incident 2026-11-06: sessions suspended by the live-worker cap were resumed a
 * couple of minutes later. Claude Code 2.1.319 answered the replayed
 * `/effort max` with "Change effort level? … This conversation is cached for the
 * current effort level. Switching to max means the full history gets re-read.
 * ❯ 1. Yes, switch to max / 2. No, go back" and records the command only once
 * that is answered. Nothing answered it: the command never showed an execution
 * record, the first message stayed held behind it, and the thread was told to
 * press Enter in a composer that was not there.
 *
 * The fake draws that dialog (in place of its composer, like Claude) after the
 * command is submitted, and records `<command-name>/effort</command-name>` only
 * when the dialog is answered — "Yes" on Enter or `1`, "No" on `2` or Esc.
 *
 *   A  the dialog comes up at once: botmux accepts it, the first message follows
 *      the command's record, and nobody is told anything was held.
 *   B  the dialog comes up only after the 20s wait for the record: the queue is
 *      held (and the thread told) first, then the dialog is still accepted and
 *      the held message delivered.
 *   C  the dialog asks on behalf of a user's PreModelSwitch hook: botmux never
 *      answers it; the thread is told a dialog is waiting (not "press Enter in
 *      the input box"), and the message stays held until a person answers in
 *      the terminal, then it is delivered.
 *   D  the first Enter is lost (the select was not listening yet): the dialog
 *      is still up 3s later, botmux presses again, nothing is held.
 *   E  the dialog comes up 16s into the 20s wait and the first two Enters are
 *      lost: each press restarts the wait, so the third one lands before
 *      anything is held.
 *   F  a hook's dialog comes up only AFTER the 20s hold (so the thread was
 *      already told "press Enter in the input box"): BotMux still answers
 *      nothing, and it corrects that one notice with the dialog notice — same
 *      turn, exactly once. The fake person does not answer until that
 *      correction arrives, so the dialog stays on screen for the worker's 1s
 *      hold poll to read; answering on a fixed timer instead raced that poll
 *      (the dialog lived ~0.4s on a loaded CI runner, the poll never saw it).
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { t } from '../src/i18n/index.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const tmuxAvailable = probeTmuxFunctional().ok;

const FIRST_PROMPT = 'review the follow-up commit';
const CACHE_SUBTITLE = 'Your next response will be slower and use more tokens';
const CACHE_BODY = 'This conversation is cached for the current effort level. Switching to {target} means the full history gets re-read.';
const HOOK_SUBTITLE = 'A PreModelSwitch hook asked you to confirm';
const HOOK_BODY = 'max is above this team budget; confirm with the owner first.';

interface FakeEvent { t: number; kind: 'ready' | 'chunk' | 'paste' | 'submit' | 'dialog' | 'accept' | 'cancel' | 'dialog-key' | 'person' | 'swallowed'; text?: string }

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.319 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
fs.writeFileSync(cfg.pidFile, String(process.pid));
process.stdin.setRawMode(true);
let composer = '';
let dialog = null;
let swallowLeft = cfg.swallowAccepts || 0;
const rule = '─'.repeat(48);
const header = '\\x1b[2J\\x1b[H Fake Claude Code\\r\\n\\r\\n● Earlier answer in the resumed conversation.\\r\\n\\r\\n';
const render = () => {
  if (dialog) {
    // Drawn INSTEAD of the composer, at the bottom, like Claude's dialog.
    process.stdout.write(header + '▔'.repeat(48) + '\\r\\n'
      + '   \\x1b[1m\\x1b[38;5;220mChange effort level?\\x1b[0m\\r\\n'
      + '   \\x1b[38;5;246m' + cfg.subtitle + '\\x1b[39m\\r\\n\\r\\n'
      + '   ' + cfg.body.replace('{target}', dialog.target) + '\\r\\n\\r\\n'
      + '   \\x1b[38;5;153m❯\\x1b[39m 1. Yes, switch to ' + dialog.target + '\\r\\n'
      + '     2. No, go back\\r\\n');
    return;
  }
  process.stdout.write(header + rule + '\\r\\n❯ ' + composer + '\\r\\n' + rule + '\\r\\n  ? for shortcuts\\r\\n');
};
const record = content => {
  fs.mkdirSync(path.dirname(cfg.transcript), { recursive: true });
  fs.appendFileSync(cfg.transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } }) + '\\n');
};
const runCommand = (name, args, stdout) => {
  record('<command-name>' + name + '</command-name>\\n<command-args>' + args + '</command-args>');
  record('<local-command-stdout>' + stdout + '</local-command-stdout>');
};
const submit = () => {
  const text = composer;
  if (!text) return;
  composer = '';
  ev({ kind: 'submit', text });
  const m = /^(\\/[\\w:.-]+)(?:\\s+(.*))?$/.exec(text);
  if (m && m[1] === '/effort') {
    // Warm prompt cache: ask before switching; record only once answered.
    setTimeout(() => { dialog = { target: m[2] }; ev({ kind: 'dialog' }); render(); }, cfg.dialogDelayMs);
    render();
    return;
  }
  if (m) runCommand(m[1], m[2] || '', 'ok'); else record(text);
  render();
};
const onData = buf => {
  const s = buf.toString('utf8');
  ev({ kind: 'chunk', text: s });
  if (dialog) {
    if (s === '\\r' && swallowLeft > 0) {
      // Lost before the select was listening.
      swallowLeft--;
      ev({ kind: 'swallowed' });
      return;
    }
    if (s === '\\r' || s === '1') {
      ev({ kind: 'accept' });
      const target = dialog.target;
      dialog = null;
      runCommand('/effort', target, 'Set effort level to ' + target);
    } else if (s === '2' || s === '\\x1b') {
      ev({ kind: 'cancel' });
      dialog = null;
      runCommand('/effort', '', 'Kept effort level as high');
    } else {
      ev({ kind: 'dialog-key', text: s });
    }
    render();
    return;
  }
  // Ink paste burst: Enter that arrives together with other bytes is a newline.
  if (s.length > 1 && s.includes('\\r')) {
    composer += s.replace(/\\r/g, '\\n');
    ev({ kind: 'paste', text: s });
    render();
    return;
  }
  if (s === '\\r') { submit(); return; }
  composer += s;
  render();
};
setTimeout(() => { ev({ kind: 'ready' }); render(); process.stdin.on('data', onData); }, 0);
// C: a person answers the dialog in the Web terminal.
setInterval(() => {
  if (!dialog || !cfg.personFile || !fs.existsSync(cfg.personFile)) return;
  fs.unlinkSync(cfg.personFile);
  ev({ kind: 'person' });
  onData(Buffer.from('\\r'));
}, 100);
setInterval(() => {}, 1000);
`;

interface Scenario {
  name: string;
  dialogDelayMs: number;
  hook?: boolean;
  /** Enters on the dialog that are lost before it listens. */
  swallowAccepts?: number;
  /**
   * The fake person answers only after the worker's dialog-pending correction
   * has been observed (scenario F: the dialog appears after the hold). This
   * makes the dialog stay on screen until a hold poll reads it, instead of
   * racing that 1s poll with an immediate answer.
   */
  awaitDialogPending?: boolean;
}

interface ScenarioRun {
  events: FakeEvent[];
  messages: WorkerToDaemon[];
  logs: string;
  transcript: string;
  personAt?: number;
}

const heldNotices = (run: ScenarioRun) =>
  run.messages.filter((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> =>
    m.type === 'user_notify' && m.message.includes('/effort max'));
/** Which notice was chosen, whatever the worker's locale. */
const noticeKey = (message: string): string | undefined => {
  const params = { cliName: lookupCliDisplayName('claude-code'), command: '/effort max', secs: 20 };
  for (const key of ['worker.startup_command_dialog_pending', 'worker.startup_command_unconfirmed'] as const) {
    if ((['zh', 'en'] as const).some(loc => t(key, params, loc) === message)) return key;
  }
  return undefined;
};

async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  // Short root: the tmux sockets live below it.
  const root = mkdtempSync(join('/tmp', 'bmx-switch-confirm-'));
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'work');
  const claudeDir = join(root, 'claude-config');
  mkdirSync(dataDir);
  mkdirSync(workingDir);
  mkdirSync(claudeDir);
  const eventsFile = join(root, 'events.jsonl');
  const pidFile = join(root, 'cli-pid');
  const personFile = join(root, 'person');
  const transcript = claudeJsonlPathForSession(sessionId, workingDir, claudeDir);
  const configFile = join(root, 'fake-claude.json');
  writeFileSync(configFile, JSON.stringify({
    events: eventsFile, pidFile, transcript, dialogDelayMs: scenario.dialogDelayMs,
    subtitle: scenario.hook ? HOOK_SUBTITLE : CACHE_SUBTITLE,
    body: scenario.hook ? HOOK_BODY : CACHE_BODY,
    personFile: scenario.hook ? personFile : undefined,
    swallowAccepts: scenario.swallowAccepts ?? 0,
  }));
  const fakeCli = join(root, 'claude');
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(fakeCli, FAKE_CLAUDE.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const events = () => readJsonLines<FakeEvent>(eventsFile);
  const waitFor = async (condition: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) {
        throw new Error(`[${scenario.name}] timed out waiting for ${what}\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}`);
      }
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const run: ScenarioRun = { events: [], messages, logs: '', transcript: '' };
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
      backendType: 'tmux', startupCommands: ['/effort max'],
      prompt: FIRST_PROMPT, turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    const promptSubmitted = () => events().some(e => e.kind === 'submit' && e.text === FIRST_PROMPT);
    if (scenario.hook) {
      if (scenario.awaitDialogPending) {
        // F: the dialog only renders after the hold (dialogDelayMs=24s > 20s
        // hold). It stays drawn until the person answers, so wait for the
        // worker's correction notice instead of answering on a timer: under a
        // loaded runner the old 4s-then-answer let the person press Enter while
        // the dialog had lived less than one 1s hold poll, the correction was
        // never sent, and the exact-notice-sequence assertion raced.
        await waitFor(
          () => heldNotices(run).some(m => noticeKey(m.message) === 'worker.startup_command_dialog_pending'),
          60_000,
          'the dialog-pending correction notice',
        );
      } else {
        await waitFor(() => heldNotices(run).length > 0, 60_000, 'the held-message notice');
        // A few seconds for an (unwanted) automatic answer to show up.
        await new Promise(r => setTimeout(r, 4_000));
      }
      expect(events().filter(e => e.kind === 'accept' || e.kind === 'cancel' || e.kind === 'dialog-key'), logs.join('')).toEqual([]);
      expect(promptSubmitted(), logs.join('')).toBe(false);
      run.personAt = Date.now();
      writeFileSync(personFile, 'enter');
    }
    await waitFor(promptSubmitted, 75_000, 'the first prompt submit');
    // Let a stray Enter or a duplicate write surface before asserting.
    await new Promise(r => setTimeout(r, 2_000));
  } finally {
    run.events = readJsonLines<FakeEvent>(eventsFile);
    run.logs = logs.join('');
    run.transcript = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    if (child) await killProcessTree(child);
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    // Only the private servers under this root, by explicit socket path: never a
    // bare kill-server (a missing TMUX_TMPDIR silently falls back to /tmp).
    for (const socket of ['default', 'botmux']) {
      const path = join(root, `tmux-${process.getuid?.() ?? 0}`, socket);
      try { execFileSync('tmux', ['-S', path, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* not running */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
  return run;
}

function expectDeliveredAfterAccept(run: ScenarioRun): void {
  const kinds = run.events.map(e => e.kind);
  const submits = run.events.filter(e => e.kind === 'submit').map(e => e.text);
  expect(submits, run.logs).toEqual(['/effort max', FIRST_PROMPT]);
  expect(run.events.filter(e => e.kind === 'paste'), run.logs).toEqual([]);
  // Answered "Yes" exactly once, never "No", and no key went into the dialog otherwise.
  expect(kinds.filter(k => k === 'accept'), run.logs).toHaveLength(1);
  expect(kinds.filter(k => k === 'cancel' || k === 'dialog-key'), run.logs).toEqual([]);
  // The message followed the answer, i.e. the command's record.
  const acceptedAt = run.events.find(e => e.kind === 'accept')!.t;
  const promptAt = run.events.find(e => e.kind === 'submit' && e.text === FIRST_PROMPT)!.t;
  expect(promptAt).toBeGreaterThan(acceptedAt);
  expect(run.transcript).toContain('Set effort level to max');
}

it.skipIf(!tmuxAvailable)(
  'a startup /effort answered by Claude\'s prompt-cache confirmation is accepted; a hook\'s confirmation is left to a person',
  async () => {
    const [atOnce, late, hook, lostOnce, lateLost, lateHook] = await Promise.all([
      runScenario({ name: 'A dialog at once', dialogDelayMs: 300 }),
      // Past STARTUP_COMMAND_ACK_TIMEOUT_MS (20s): the queue is held first.
      runScenario({ name: 'B dialog after the hold', dialogDelayMs: 24_000 }),
      runScenario({ name: 'C hook asks a person', dialogDelayMs: 300, hook: true }),
      runScenario({ name: 'D first Enter lost', dialogDelayMs: 300, swallowAccepts: 1 }),
      // The third press lands ~22s in: only the restarted wait keeps it unheld.
      runScenario({ name: 'E late dialog, two Enters lost', dialogDelayMs: 16_000, swallowAccepts: 2 }),
      // The hold notice went out first; the hook's dialog only turns up at 24s.
      // The fake person does not answer until the correction notice is seen, so
      // the dialog stays on screen across hold polls instead of racing them.
      runScenario({
        name: 'F late hook dialog', dialogDelayMs: 24_000, hook: true,
        awaitDialogPending: true,
      }),
    ]);

    // A: accepted by botmux; nothing was held, so nobody was told.
    expectDeliveredAfterAccept(atOnce);
    expect(heldNotices(atOnce), atOnce.logs).toEqual([]);

    // B: held (and told) while there was no dialog yet, then still accepted.
    expectDeliveredAfterAccept(late);
    expect(heldNotices(late), late.logs).toHaveLength(1);
    expect(noticeKey(heldNotices(late)[0]!.message)).toBe('worker.startup_command_unconfirmed');

    // C: botmux pressed nothing; the person's answer released the message.
    expectDeliveredAfterAccept(hook);
    const kinds = hook.events.map(e => e.kind);
    expect(kinds.indexOf('person'), hook.logs).toBeGreaterThan(-1);
    expect(kinds.indexOf('person')).toBeLessThan(kinds.indexOf('accept'));
    expect(heldNotices(hook), hook.logs).toHaveLength(1);
    expect(noticeKey(heldNotices(hook)[0]!.message), hook.logs).toBe('worker.startup_command_dialog_pending');

    // D / E: a lost Enter is pressed again, and the presses keep the wait open.
    for (const run of [lostOnce, lateLost]) {
      expectDeliveredAfterAccept(run);
      expect(heldNotices(run), run.logs).toEqual([]);
    }
    expect(lostOnce.events.filter(e => e.kind === 'swallowed')).toHaveLength(1);
    expect(lateLost.events.filter(e => e.kind === 'swallowed')).toHaveLength(2);

    // F: the hold's own notice was already out (nothing on screen yet), so the
    // hook's dialog is corrected by ONE more notice — never by pressing Enter,
    // and never on another turn. "Press Enter in the input box" here would
    // have made a person approve the hook's request on their own behalf.
    expectDeliveredAfterAccept(lateHook);
    const lateHookNotices = heldNotices(lateHook);
    expect(lateHookNotices.map(m => noticeKey(m.message)), lateHook.logs).toEqual([
      'worker.startup_command_unconfirmed',
      'worker.startup_command_dialog_pending',
    ]);
    // One notice per hold, both on the same turn as the held input.
    expect(lateHookNotices.map(m => m.turnId), lateHook.logs).toEqual(['om_test', 'om_test']);
    expect(lateHook.events.filter(e => e.kind === 'swallowed'), lateHook.logs).toEqual([]);
    expect(lateHook.events.map(e => e.kind).indexOf('dialog'))
      .toBeLessThan(lateHook.events.map(e => e.kind).indexOf('person'));
  },
  180_000,
);
