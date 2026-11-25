import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonLines } from './helpers/read-json-lines.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

/**
 * A native `/rename` whose Enter TRAE took as a pasted newline (recorded on
 * traecli 0.216.0 when the command text and its Enter reach the TUI in one
 * read): the command stays in the composer, and whatever is typed next is
 * appended to it — the following Enter renames the thread to
 * `<title>\n<message>` and the message never becomes a turn. The fake below
 * reproduces exactly that surface; the real worker must not write a queued
 * message into it, must not lose it, and must run the rename only once.
 */

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  children.clear();
  for (const name of tmuxSessions) killWorkerTmuxSession(`=${name}`);
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function waitFor(child: ChildProcess, predicate: () => boolean, logs: string[], what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited before ${what}\n${logs.join('')}`);
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}\n${logs.join('')}`);
}

const TITLE = '[BotMux·Lark] 修复登录页报错';
const FOLLOW_UP = '这是追问内容';

interface Harness {
  child: ChildProcess;
  messages: WorkerToDaemon[];
  logs: string[];
  submissions: () => string[];
  renames: () => string[];
  recordNativeRename: (id: string, title: string) => void;
  userPressesEnter: () => void;
  /** The TUI stops reading its input for `ms` (host load); bytes written
   *  meanwhile reach it in one read afterwards. Resolves once it stopped. */
  stallReading: (ms: number) => Promise<void>;
  /** SIGKILL this worker and attach a replacement to the same surviving tmux
   *  pane/session store. The fake CLI process itself stays alive. */
  restartWorker: () => Promise<void>;
}

/** @param swallowedRenameEnters how many Enters the fake takes as a newline
 *  while `/rename …` sits in its composer (1 = the rename's own Enter).
 *  @param unknownFooterAfterRename once renamed, draw a footer no screen
 *  predicate knows (a future TRAE layout).
 *  @param outputWhileStalled emit cursor-only frames while stdin is paused:
 *  terminal output that neither consumes input nor changes the viewport. */
async function startWorker(
  swallowedRenameEnters: number,
  unknownFooterAfterRename = false,
  outputWhileStalled = false,
  forceTmux = false,
  unknownFooterWhileUnsubmitted = false,
  mismatchedRenameReceipt = false,
): Promise<Harness> {
  const sessionId = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'botmux-traex-rename-hold-'));
  tempDirs.add(root);
  const dataDir = join(root, 'session');
  const traeHome = join(root, '.trae');
  const cliDir = join(traeHome, 'cli');
  const indexPath = join(cliDir, 'session_index.jsonl');
  const rolloutDir = join(cliDir, 'sessions', '2026', '11', '23');
  const nativeSessionId = '00000000-0000-7000-8000-000000000777';
  const rolloutPath = join(rolloutDir, `rollout-2026-11-23T00-00-00-${nativeSessionId}.jsonl`);
  const submissionsPath = join(root, 'submissions.jsonl');
  const renamesPath = join(root, 'renames.jsonl');
  const userEnterPath = join(root, 'user-enter');
  const stallPath = join(root, 'stall');
  const stalledPath = join(root, 'stalled');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: '2026-11-23T00:00:00Z',
    type: 'session_meta',
    payload: { id: nativeSessionId, thread_source: 'user', timestamp: '2026-11-23T00:00:00Z' },
  })}\n`);
  writeFileSync(join(cliDir, 'history.jsonl'), '');
  writeFileSync(submissionsPath, '');
  writeFileSync(renamesPath, '');

  const fakeTraex = join(root, 'fake-traex');
  writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
// A live rollout fd proves this process owns the history SID.
const rolloutFd = fs.openSync(${JSON.stringify(rolloutPath)}, 'a');
const historyPath = ${JSON.stringify(join(cliDir, 'history.jsonl'))};
const indexPath = ${JSON.stringify(indexPath)};
const sessionId = ${JSON.stringify(nativeSessionId)};
let swallow = ${swallowedRenameEnters};
let footer = '  GPT-6-Astra xhigh · Context 90% left';
let draft = '';
let last = '◆ ready';
let pending = '';
let pasting = false;
const line = value => JSON.stringify(value) + '\\n';
function render() {
  const rows = [last, '─'.repeat(40)];
  if (!draft) rows.push('❯ Ask TraeCode CLI to do anything');
  else draft.split('\\n').forEach((text, i) => rows.push((i ? '  ' : '❯ ') + text));
  rows.push('─'.repeat(40), footer);
  process.stdout.write('\\x1b[2J\\x1b[H' + rows.join('\\r\\n') + '\\r\\n');
}
function enter(fromUser) {
  if (draft.startsWith('/rename ')) {
    if (swallow > 0 && !fromUser) {
      swallow--;
      draft += '\\n';
      if (${unknownFooterWhileUnsubmitted}) footer = '  GPT-6-Astra xhigh · an unreadable status cell';
      render();
      return;
    }
    const requestedName = draft.slice(8).trim();
    const name = ${mismatchedRenameReceipt} ? requestedName + ' (normalised)' : requestedName;
    draft = '';
    fs.appendFileSync(${JSON.stringify(renamesPath)}, line({ name }));
    fs.appendFileSync(indexPath, line({ id: sessionId, thread_name: name, updated_at: new Date().toISOString() }));
    last = '◆ Thread renamed to ' + name;
    if (${unknownFooterAfterRename}) footer = '  GPT-6-Astra xhigh · a status cell from a newer release';
    if (${unknownFooterWhileUnsubmitted}) footer = '  GPT-6-Astra xhigh · Context 90% left';
    render();
    return;
  }
  const text = draft.trim();
  draft = '';
  if (!text) { render(); return; }
  fs.appendFileSync(${JSON.stringify(submissionsPath)}, line({ text }));
  fs.appendFileSync(historyPath, line({ session_id: sessionId, ts: Date.now() / 1000, text }));
  const turnId = 'native-' + Date.now();
  fs.writeSync(rolloutFd, line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: text, images: [], local_images: [], text_elements: [], turn_id: turnId } }));
  fs.writeSync(rolloutFd, line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'ok', completed_at: Math.floor(Date.now() / 1000), duration_ms: 10 } }));
  last = '◆ ok';
  render();
}
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
render();
process.stdin.on('data', chunk => {
  pending += chunk;
  while (pending) {
    if (pasting) {
      const end = pending.indexOf('\\x1b[201~');
      if (end < 0) return;
      draft += pending.slice(0, end);
      pending = pending.slice(end + 6);
      pasting = false;
      continue;
    }
    if (pending.startsWith('\\x1b[200~')) { pasting = true; pending = pending.slice(6); continue; }
    if (pending[0] === '\\x1b') {
      const seq = /^\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/.exec(pending);
      if (!seq) { if (pending.length < 8) return; pending = pending.slice(1); continue; }
      pending = pending.slice(seq[0].length);
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === '\\r' || ch === '\\n') enter(false);
    else draft += ch;
  }
  render();
});
// The user finishing the rename in the Web terminal.
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(userEnterPath)})) { fs.rmSync(${JSON.stringify(userEnterPath)}); enter(true); }
  if (fs.existsSync(${JSON.stringify(stallPath)})) {
    const ms = Number(fs.readFileSync(${JSON.stringify(stallPath)}, 'utf8'));
    fs.rmSync(${JSON.stringify(stallPath)});
    process.stdin.pause();
    fs.writeFileSync(${JSON.stringify(stalledPath)}, '');
    const noise = ${outputWhileStalled}
      ? setInterval(() => process.stdout.write('\\x1b[?25l\\x1b[?25h'), 25)
      : undefined;
    setTimeout(() => {
      if (noise) clearInterval(noise);
      process.stdin.resume();
    }, ms);
  }
}, 25);
`);
  chmodSync(fakeTraex, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const workerBinary = process.env.BOTMUX_TEST_WORKER_BINARY;
  const backendType = workerBinary || forceTmux ? 'tmux' : 'pty';
  if (backendType === 'tmux') tmuxSessions.add(`bmx-${sessionId.slice(0, 8)}`);
  const options: SpawnOptions = {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      TRAE_HOME: traeHome,
      BOTMUX_TIME_SCALE: '0.01',
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  };
  let child!: ChildProcess;
  const launchWorker = () => {
    child = workerBinary
      ? spawn(workerBinary, ['__worker'], options)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'traex',
      cliPathOverride: fakeTraex,
      cliSessionId: nativeSessionId,
      nativeSessionTitle: TITLE,
      resume: true,
      backendType,
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
  };
  launchWorker();
  await waitFor(child, () => messages.some(m => m.type === 'prompt_ready'), logs, 'resumed TRAE prompt', 30_000);
  return {
    get child() { return child; },
    messages,
    logs,
    // The worker may append its own context block (e.g. a refreshed Skill
    // catalog) below the user's text; the user's text is the first line.
    submissions: () => readJsonLines<{ text: string }>(submissionsPath).map(s => s.text.split('\n')[0]!),
    renames: () => readJsonLines<{ name: string }>(renamesPath).map(r => r.name),
    recordNativeRename: (id, title) => appendFileSync(indexPath, `${JSON.stringify({ id, thread_name: title })}\n`),
    userPressesEnter: () => writeFileSync(userEnterPath, ''),
    stallReading: async (ms: number) => {
      writeFileSync(stallPath, String(ms));
      await waitFor(child, () => existsSync(stalledPath), logs, 'TUI input stall');
    },
    restartWorker: async () => {
      const previous = child;
      const exited = new Promise<void>(done => previous.once('exit', () => done()));
      previous.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>(done => setTimeout(done, 2_000))]);
      const prompts = messages.filter(message => message.type === 'prompt_ready').length;
      launchWorker();
      await waitFor(child, () => messages.filter(message => message.type === 'prompt_ready').length > prompts, logs, 'warm reattach prompt', 30_000);
    },
  };
}

function send(child: ChildProcess, message: DaemonToWorker): Promise<void> {
  return new Promise((done, fail) => child.send(message, error => error ? fail(error) : done()));
}

describe('TRAE native rename left in the composer', () => {
  it('restarts an idle CLI with a different saved title and delivers every held follow-up once', async () => {
    const h = await startWorker(0, false, false, false, false, true);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.logs.some(line => line.includes('Native session rename not confirmed (settled)')),
      h.logs, 'missing exact-title receipt', 30_000);
    expect(h.submissions()).toEqual([]);
    await waitFor(h.child, () => h.logs.some(line => line.includes('Restart requested (native session rename receipt timeout)')),
      h.logs, 'bounded rename recovery', 80_000);
    // Input arriving during teardown belongs to the replacement too.
    await send(h.child, { type: 'message', content: 'another follow-up', turnId: 'om_second' });
    await waitFor(h.child, () => h.submissions().includes('another follow-up'), h.logs, 'held inputs after recovery', 40_000);
    expect(h.submissions()).toEqual([FOLLOW_UP, 'another follow-up']);
    expect(h.renames()).toEqual([TITLE + ' (normalised)']);
    expect(h.logs.filter(line => line.includes('Restart requested (native session rename receipt timeout)'))).toHaveLength(1);
  }, 150_000);

  it('holds a follow-up arriving after the rename wait, completes the rename once, then delivers it as its own turn', async () => {
    const h = await startWorker(1);
    await send(h.child, { type: 'message', content: 'first question', turnId: 'om_first' });
    await waitFor(h.child, () => h.submissions().includes('first question'), h.logs, 'first turn');
    await send(h.child, { type: 'rename_session', title: TITLE });
    // Past the 5s bounded wait that used to release input into the composer.
    await sleep(5_500);
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up turn', 30_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual(['first question', FOLLOW_UP]);
  }, 90_000);

  it('after resume, holds a follow-up sent right behind the rename until the rename completes', async () => {
    const h = await startWorker(1);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up turn', 30_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
  }, 90_000);

  it('accepts this thread\'s valid rename receipt after a persistent worker replacement', async () => {
    const h = await startWorker(0, false, false, true);
    await h.restartWorker();
    await send(h.child, { type: 'rename_session', title: TITLE });
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up after warm reattach', 40_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
  }, 90_000);

  it('completes a surviving unsubmitted rename before restored input after worker replacement', async () => {
    const h = await startWorker(2, false, false, true);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await waitFor(h.child, () => h.logs.some(line => line.includes('pressed Enter once')), h.logs, 'recovery Enter before replacement');
    expect(h.renames()).toEqual([]);
    await h.restartWorker();
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'restored follow-up after surviving rename', 40_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
  }, 90_000);

  it('holds restored input on unknown surviving evidence and recovers after the user completes the rename', async () => {
    const h = await startWorker(1, false, false, true, true);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await waitFor(h.child, () => h.logs.some(line => line.includes('Native session rename not confirmed (unknown)')), h.logs, 'unknown surviving surface');
    await h.restartWorker();
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    const notices = () => h.messages.filter(message => message.type === 'user_notify' && message.turnId === 'om_follow');
    await sleep(6_000);
    expect(h.renames()).toEqual([]);
    expect(h.submissions()).toEqual([]);
    expect(notices()).toHaveLength(1);
    h.userPressesEnter();
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up after unknown surface settles', 40_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
    expect(notices()).toHaveLength(1);
  }, 90_000);

  it('ignores unrelated output and another thread\'s same-title receipt while the TUI has not read the rename', async () => {
    const h = await startWorker(1, false, true);
    // The screen stays at the pre-rename empty composer while cursor-only
    // frames keep advancing the worker's global PTY output generation.
    await h.stallReading(6_500);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await waitFor(h.child, () => h.logs.some(line => line.includes('Native session rename command sent')), h.logs, 'rename write');
    h.recordNativeRename('another-thread', TITLE);
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up turn', 40_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
  }, 90_000);

  it('releases on the CLI\'s own record of the rename when its screen layout is not recognised', async () => {
    const h = await startWorker(0, true);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up turn', 30_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
    expect(h.messages.filter(m => m.type === 'user_notify' && m.turnId === 'om_follow')).toEqual([]);
  }, 90_000);

  it('keeps holding with one notice when the extra Enter does not land either, and resumes once the user finishes the rename', async () => {
    const h = await startWorker(2);
    await send(h.child, { type: 'rename_session', title: TITLE });
    await send(h.child, { type: 'message', content: FOLLOW_UP, turnId: 'om_follow' });
    const notices = () => h.messages.filter(m => m.type === 'user_notify' && m.turnId === 'om_follow');
    await waitFor(h.child, () => notices().length > 0, h.logs, 'held-input notice', 30_000);
    // Several re-reads later the message is still queued, not typed anywhere.
    await sleep(5_000);
    expect(h.submissions()).toEqual([]);
    expect(h.renames()).toEqual([]);
    expect(notices()).toHaveLength(1);
    h.userPressesEnter();
    await waitFor(h.child, () => h.submissions().includes(FOLLOW_UP), h.logs, 'follow-up after the user finished the rename', 30_000);
    expect(h.renames()).toEqual([TITLE]);
    expect(h.submissions()).toEqual([FOLLOW_UP]);
    expect(notices()).toHaveLength(1);
  }, 90_000);
});
