import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../src/adapters/backend/tmux-socket.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { t } from '../src/i18n/index.js';
import type { AskResult } from '../src/core/ask-types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real worker + a fake traecli that draws the question page exactly as a real
// traecli 0.214.1 did (test/fixtures/traex-question, captured with
// `tmux capture-pane -e`) and reacts to it the way the real one does: a digit
// picks and submits that option, a paste lands in the page's notes field (the
// reported bug: a Lark message became a note and its Enter submitted the
// recommended option). Like 0.214.1 it reports OSC 7501 — `working`, then
// `blocked kind=question` while the page is up; with `reports: false` it is a
// CLI without them (or below the version gate), where only the screen tells.
// The daemon side is a fake `/api/asks` endpoint: the question card.
const FIXTURES = new URL('./fixtures/traex-question/', import.meta.url);
const rowsOf = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').replace(/\n+$/, '').split('\n');
const QUESTION = rowsOf('traex-0.214.1-single-160x50.ansi.txt');
const NOTES_TYPED = rowsOf('traex-0.214.1-single-notes-typed-160x50.ansi.txt');
const BANNER = rowsOf('traex-0.214.1-single-160x50.txt').slice(0, 7);
const COMPOSER = rowsOf('traex-0.214.1-answered-composer-160x50.txt').filter(row => row.trim()).slice(-5);
const IDLE_FRAME = [...BANNER, '', ...COMPOSER];
const workingFrame = (text: string) => [...BANNER, '', `▍ ${text}`, '', '◆ Working… (1s • esc to interrupt)', '', ...COMPOSER];

const tmuxAvailable = probeTmuxFunctional().ok;
for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType}: the question page becomes a card, a message sent meanwhile is held off its notes field, and the card's choice is entered`,
    () => runCardScenario(backendType),
    90_000,
  );
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType} without OSC 7501: the screen alone raises the card and its choice is entered`,
    () => runScreenOnlyScenario(backendType),
    90_000,
  );
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType} without OSC 7501: a quiet question page with text in its notes field does not end the turn`,
    () => runQuietScenario(backendType),
    120_000,
  );
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType}: the submit's late receipt is read before any retry Enter, which would answer the page`,
    () => runLateReceiptScenario(backendType),
    90_000,
  );
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType}: a message queued behind a write still awaiting its receipt is held off a page that came up meanwhile`,
    () => runDrainLoopScenario(backendType),
    90_000,
  );
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType}: a page coming up between a typed-ahead paste and its Enter gets no Enter`,
    () => runTypeAheadRaceScenario(backendType),
    90_000,
  );
}

interface Ask { body: { questions: Array<{ prompt: string; multiSelect: boolean; options: Array<{ key: string; label: string; description?: string }> }>; originKind?: string; originTurnId?: string }; closed: boolean; respond: (result: AskResult) => void }
interface Harness {
  messages: WorkerToDaemon[];
  logs: string[];
  asks: Ask[];
  events: () => string[];
  typed: () => string;
  send: (message: DaemonToWorker) => void;
  waitFor: (predicate: () => boolean, description: string, timeoutMs?: number) => Promise<void>;
}

async function startFakeDaemon(): Promise<{ server: Server; port: number; asks: Ask[] }> {
  const asks: Ask[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/asks') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const ask: Ask = {
        body: JSON.parse(body),
        closed: false,
        respond: result => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        },
      };
      res.on('close', () => { ask.closed = true; });
      asks.push(ask);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port, asks };
}

async function withTraexWorker(
  backendType: 'pty' | 'tmux',
  opts: {
    cliVersion: string;
    reports: boolean;
    /** Write the turn's user_message to the rollout (the structured start). */
    turnStart?: boolean;
    /** The page as first drawn: plain, or with text already in its notes. */
    questionFrame?: 'plain' | 'notes-typed';
    /** The first turn works this long before its question page comes up. */
    questionAfterMs?: number;
    /** TRAE writes its submit receipt this long after the Enter. */
    receiptLagMs?: number;
    /** TRAE opens the rollout only this long after the first submit (a fresh
     *  0.214 session does), so the first write keeps waiting for its owned
     *  receipt meanwhile. */
    rolloutOpenLagMs?: number;
    /** The first turn asks only when a message is typed ahead into it: the
     *  page comes up between that paste and its Enter. */
    askOnTypeAhead?: boolean;
  },
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync('/tmp/bmx-traex-question-');
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const dataDir = join(root, 'data');
  const traeHome = join(root, '.trae');
  const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '11', '12');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  // The worker reaches the daemon's ask endpoint with the host IPC secret.
  mkdirSync(join(root, '.botmux'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'test-secret\n', { mode: 0o600 });
  const rollout = join(sessionsDir, `rollout-2026-11-12T00-00-00-${nativeId}.jsonl`);
  const history = join(traeHome, 'cli', 'history.jsonl');
  const inputFile = join(root, 'input');
  const eventsFile = join(root, 'events');
  const pidFile = join(root, 'pid');
  const fakeCli = join(root, 'traex');
  writeFileSync(history, '');
  // The fake is an extension-less CommonJS script: pin its module type so a
  // stray ESM package.json above the temp dir cannot change it.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const ROLLOUT = ${JSON.stringify(rollout)};
const rec = line => fs.appendFileSync(ROLLOUT, line + '\\n');
rec(JSON.stringify({type:'session_meta', payload:{id:${JSON.stringify(nativeId)}, cwd:process.cwd()}}));
// Holding the rollout open is what tells botmux which session this pid owns.
const ROLLOUT_LAG = ${JSON.stringify(opts.rolloutOpenLagMs ?? 0)};
let held = ROLLOUT_LAG ? null : fs.openSync(ROLLOUT, 'a');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.setRawMode(true);
const event = line => fs.appendFileSync(${JSON.stringify(eventsFile)}, line + '\\n');
const reports = ${JSON.stringify(opts.reports)};
const report = (state, kind) => reports ? '\\x1b]7501;state=' + state + ':app=traecli' + (kind ? ':kind=' + kind : '') + '\\x1b\\\\' : '';
const draw = rows => process.stdout.write('\\x1b[2J\\x1b[H' + rows.map((row, i) => '\\x1b[' + (i + 1) + ';1H' + row).join(''));
const IDLE = ${JSON.stringify(IDLE_FRAME)};
const QUESTION = ${JSON.stringify(opts.questionFrame === 'notes-typed' ? NOTES_TYPED : QUESTION)};
const NOTES_TYPED = ${JSON.stringify(NOTES_TYPED)};
const BANNER = ${JSON.stringify(BANNER)};
const COMPOSER = ${JSON.stringify(COMPOSER)};
const working = text => [...BANNER, '', '▍ ' + text, '', '◆ Working… (1s • esc to interrupt)', '', ...COMPOSER];
let mode = 'idle';
let turn = 0;
let askedOnTypeAhead = false;
let buffer = '';
const queued = [];
process.stdout.write('\\x1b[?2004h');
draw(IDLE);
for (const d of [200, 500]) setTimeout(() => { if (mode === 'idle') draw(IDLE); }, d);
setTimeout(() => process.stdout.write(report('idle')), 800);
function finish(text) {
  mode = 'working';
  process.stdout.write(report('working'));
  draw(working('answer'));
  setTimeout(() => {
    rec(JSON.stringify({type:'response_item', payload:{type:'message', role:'assistant', phase:'final_answer', content:[{type:'output_text', text}]}}));
    rec(JSON.stringify({type:'event_msg', payload:{type:'task_complete', turn_id:'t' + turn, last_agent_message:text}}));
    mode = 'idle';
    process.stdout.write(report('done'));
    draw(IDLE);
    event('turn-done:' + turn);
    if (queued.length) start(queued.shift());
  }, 500);
}
function start(text) {
  turn++;
  if (${JSON.stringify(opts.turnStart !== false)} || turn > 1) rec(JSON.stringify({type:'event_msg', payload:{type:'user_message', message:text, images:[], local_images:[]}}));
  mode = 'working';
  process.stdout.write(report('working'));
  // TRAE keeps repainting its footer (with "Context N% left") under the
  // activity row while a turn runs.
  for (const d of [0, 150, 300, 450]) setTimeout(() => { if (mode === 'working') draw(working(text)); }, d);
  if (text === 'first-traex-input' && ${JSON.stringify(!!opts.askOnTypeAhead)}) { event('working:' + text); return; }
  setTimeout(() => {
    if (text !== 'first-traex-input') return finish('reply to ' + text);
    ask();
  }, ${JSON.stringify(opts.questionAfterMs ?? 700)});
}
function ask() {
  mode = 'question';
  process.stdout.write(report('blocked', 'question'));
  draw(QUESTION);
  event('question-shown');
}
process.stdin.on('data', chunk => {
  const s = chunk.toString('utf8');
  fs.appendFileSync(${JSON.stringify(inputFile)}, s);
  if (mode === 'question') {
    if (s.includes('\\x1b[200~')) {
      event('pasted-on-question:' + s.replace(/\\x1b\\[20[01]~/g, ''));
      draw(NOTES_TYPED);
      return;
    }
    if (/^[1-4]$/.test(s)) { event('answer:' + s); finish('answered ' + s); return; }
    if (s === '\\r') { event('answer:enter'); finish('answered with the highlighted option'); return; }
    event('key-on-question:' + JSON.stringify(s));
    return;
  }
  if (${JSON.stringify(!!opts.askOnTypeAhead)} && !askedOnTypeAhead && mode === 'working' && turn === 1 && s.includes('\\x1b[200~')) {
    askedOnTypeAhead = true;
    // The typed-ahead message sits in the composer as a draft; the agent's
    // question comes up right now, before that message's Enter.
    event('draft:' + s.replace(/\\x1b\\[20[01]~/g, ''));
    buffer += s;
    setTimeout(ask, 30);
    return;
  }
  buffer += s;
  let m;
  while ((m = /\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~([^\\x1b]*)\\r/.exec(buffer))) {
    buffer = buffer.slice(m.index + m[0].length);
    // Anything typed after the paste, before its Enter, is part of the line.
    const text = m[1] + m[2];
    // history.jsonl is TRAE's submit receipt, written at submit time.
    const receipt = () => fs.appendFileSync(${JSON.stringify(history)}, JSON.stringify({session_id:${JSON.stringify(nativeId)}, text, ts:Date.now()/1000})+'\\n');
    const lag = ${JSON.stringify(opts.receiptLagMs ?? 0)};
    if (lag) setTimeout(receipt, lag); else receipt();
    if (held === null) setTimeout(() => { held = fs.openSync(ROLLOUT, 'a'); }, ROLLOUT_LAG);
    event('submitted:' + text);
    if (mode === 'idle') start(text); else queued.push(text);
  }
  // A line typed without a paste (a passthrough command).
  while ((m = /^([^\\x1b\\r]+)\\r/.exec(buffer))) {
    buffer = buffer.slice(m[0].length);
    event('typed-line:' + m[1]);
  }
});
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);
  const daemon = await startFakeDaemon();
  const env = privateTmuxEnv(root, {
    HOME: root, TRAE_HOME: traeHome, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
    BOTMUX_DAEMON_IPC_PORT: String(daemon.port),
    CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test',
  });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const waitFor = async (predicate: () => boolean, description: string, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= until || child?.exitCode != null) throw new Error(`${description}\n${logs.join('')}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const options = { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as any };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], options)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    const send = (message: DaemonToWorker) => { child!.send(message); };
    send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
      workingDir: dataDir, cliId: 'traex', cliPathOverride: fakeCli, backendType,
      cliVersion: opts.cliVersion,
      prompt: 'first-traex-input', turnId: 'om_first',
      larkAppId: 'app_test', larkAppSecret: 'test',
    });
    await run({
      messages, logs, asks: daemon.asks, send, waitFor,
      events: () => read(eventsFile).split('\n').filter(Boolean),
      typed: () => read(inputFile),
    });
  } finally {
    for (const ask of daemon.asks) if (!ask.closed) ask.respond({ kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (backendType === 'tmux') {
      try {
        execFileSync('tmux', [...tmuxSocketArgs(preferredManagedTmuxSocket(env)), 'kill-server'], { env, stdio: 'ignore' });
      } catch { /* exited */ }
    }
    await new Promise<void>(r => daemon.server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}

const heldNotice = t('worker.traex_question.input_held', { cliName: lookupCliDisplayName('traex')! });

async function runCardScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.214.1\ninstallation: internal', reports: true }, async h => {
    await h.waitFor(() => h.events().includes('question-shown'), 'the fake drew its question page');
    // A Lark message arrives while the page is up. It never reaches the page:
    // no paste into the notes field, no Enter submitting the recommended option.
    h.send({ type: 'message', content: 'second-traex-input', turnId: 'om_second' });
    await new Promise(r => setTimeout(r, 3_000));
    expect(h.events().filter(e => e.startsWith('pasted-on-question') || e.startsWith('answer') || e.startsWith('key-on-question')), h.logs.join('')).toEqual([]);
    expect(h.typed()).not.toContain('second-traex-input');
    // The sender is told it is held until the question is answered.
    expect(h.messages.filter(m => m.type === 'user_notify' && m.message === heldNotice)).toHaveLength(1);

    // The page became one question card, through the native-question ask endpoint.
    await h.waitFor(() => h.asks.length > 0, 'question card raised');
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.body).toMatchObject({
      originKind: 'native-user-input',
      originTurnId: 'om_first',
      questions: [{
        prompt: 'Which database should the new service use?',
        multiSelect: false,
        options: [
          { key: '1', label: 'PostgreSQL (Recommended)', description: 'Mature, strong consistency' },
          { key: '2', label: 'MySQL', description: 'Widely deployed' },
          { key: '3', label: 'SQLite', description: 'Embedded, zero ops' },
        ],
      }],
    });

    // The card's choice goes in as its digit, after a fresh look at the page.
    h.asks[0]!.respond({ kind: 'answered', answers: [['2']], by: 'ou_user', comment: null, timedOut: false });
    await h.waitFor(() => h.events().includes('answer:2'), 'card choice entered as the digit');
    await h.waitFor(() => h.events().includes('turn-done:1'), 'the answered turn finished');
    // The held message follows once the question is gone, as its own turn.
    await h.waitFor(() => h.events().includes('turn-done:2'), 'the held message delivered after the answer');
    const events = h.events();
    expect(events.indexOf('submitted:second-traex-input')).toBeGreaterThan(events.indexOf('answer:2'));
    expect(events.filter(e => e.startsWith('answer') || e.startsWith('pasted-on-question'))).toEqual(['answer:2']);
    expect(h.typed().match(/second-traex-input/g)).toHaveLength(1);
    // A turn without a question raises no card.
    await new Promise(r => setTimeout(r, 1_500));
    expect(h.asks).toHaveLength(1);
  });
}

async function runScreenOnlyScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.213.1', reports: false }, async h => {
    await h.waitFor(() => h.events().includes('question-shown'), 'the fake drew its question page');
    await h.waitFor(() => h.asks.length > 0, 'question card raised from the screen');
    expect(h.asks[0]!.body.questions[0]!.options.map(o => o.label)).toEqual(['PostgreSQL (Recommended)', 'MySQL', 'SQLite']);
    const readyBefore = h.messages.filter(m => m.type === 'prompt_ready').length;
    h.asks[0]!.respond({ kind: 'answered', answers: [['3']], by: 'ou_user', comment: null, timedOut: false });
    await h.waitFor(() => h.events().includes('answer:3'), 'card choice entered as the digit');
    await h.waitFor(
      () => h.messages.filter(m => m.type === 'prompt_ready').length > readyBefore,
      'the turn ends once the question is answered',
    );
    expect(h.events().filter(e => e.startsWith('answer') || e.startsWith('pasted-on-question'))).toEqual(['answer:3']);
  });
}

/** The reported screen: text sits in the notes field of a quiet question page
 *  (typed there in the Web terminal — or, before this fix, a pasted Lark
 *  message). No OSC 7501, and the rollout has no start for the turn to
 *  attribute, so once the 20s structured-start lease runs out only the screen
 *  stands between that quiet page and "turn finished": its notes row reads as
 *  a composer. */
async function runQuietScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.213.1', reports: false, turnStart: false, questionFrame: 'notes-typed' }, async h => {
    await h.waitFor(() => h.events().includes('question-shown'), 'the fake drew its question page');
    const readyBefore = h.messages.filter(m => m.type === 'prompt_ready').length;
    await new Promise(r => setTimeout(r, 30_000));
    expect(h.messages.filter(m => m.type === 'prompt_ready').length, h.logs.join('')).toBe(readyBefore);
    expect(h.events().filter(e => e.startsWith('answer') || e.startsWith('pasted-on-question') || e.startsWith('key-on-question'))).toEqual([]);
    // The card is out, but its answer is never typed over someone else's notes.
    await h.waitFor(() => h.asks.length > 0, 'question card raised from the screen');
    h.asks[0]!.respond({ kind: 'answered', answers: [['2']], by: 'ou_user', comment: null, timedOut: false });
    const notWritten = t('worker.traex_question.not_written', { cliName: lookupCliDisplayName('traex')! });
    await h.waitFor(() => h.messages.some(m => m.type === 'user_notify' && m.message === notWritten), 'the dropped answer is reported');
    expect(h.events().filter(e => e.startsWith('answer') || e.startsWith('key-on-question'))).toEqual([]);
  });
}

/** TRAE writes its submit receipt a moment after the Enter, and the agent asks
 *  right away: the page is up before the adapter's 800ms retry. */
async function runLateReceiptScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.214.1\ninstallation: internal', reports: true, receiptLagMs: 30, questionAfterMs: 300 }, async h => {
    await h.waitFor(() => h.events().includes('question-shown'), 'the fake drew its question page');
    await new Promise(r => setTimeout(r, 3_000));
    expect(h.events().filter(e => e.startsWith('answer') || e.startsWith('key-on-question')), h.logs.join('')).toEqual([]);
    await h.waitFor(() => h.asks.length > 0, 'question card raised');
    h.asks[0]!.respond({ kind: 'answered', answers: [['2']], by: 'ou_user', comment: null, timedOut: false });
    await h.waitFor(() => h.events().includes('turn-done:1'), 'the answered turn finished');
    expect(h.events().filter(e => e.startsWith('answer'))).toEqual(['answer:2']);
  });
}

/** A fresh session's rollout opens late, so the first write is still polling
 *  for its receipt when the page comes up and the next message arrives: that
 *  message rides the same drain. */
async function runDrainLoopScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.214.1\ninstallation: internal', reports: true, rolloutOpenLagMs: 2_500, questionAfterMs: 300 }, async h => {
    await h.waitFor(() => h.events().includes('question-shown'), 'the fake drew its question page');
    h.send({ type: 'message', content: 'second-traex-input', turnId: 'om_second' });
    await new Promise(r => setTimeout(r, 4_000));
    expect(h.events().filter(e => e.startsWith('pasted-on-question') || e.startsWith('answer') || e.startsWith('key-on-question')), h.logs.join('')).toEqual([]);
    await h.waitFor(() => h.asks.length > 0, 'question card raised');
    h.asks[0]!.respond({ kind: 'answered', answers: [['2']], by: 'ou_user', comment: null, timedOut: false });
    await h.waitFor(() => h.events().includes('turn-done:2'), 'the held message delivered after the answer');
    const events = h.events();
    expect(events.indexOf('submitted:second-traex-input')).toBeGreaterThan(events.indexOf('answer:2'));
    expect(events.filter(e => e.startsWith('answer') || e.startsWith('pasted-on-question'))).toEqual(['answer:2']);
  });
}

/** A message typed ahead into a running turn: the agent's question comes up
 *  after its paste, before its Enter. That Enter would pick the recommended
 *  option, so it waits — the message sits in the composer as a draft — and is
 *  pressed once the question is answered: the draft is submitted once; a
 *  message arriving meanwhile is held (and told so); a passthrough command
 *  arriving right after the answer is not typed onto the draft. */
async function runTypeAheadRaceScenario(backendType: 'pty' | 'tmux'): Promise<void> {
  await withTraexWorker(backendType, { cliVersion: '0.214.1\ninstallation: internal', reports: true, askOnTypeAhead: true }, async h => {
    await h.waitFor(() => h.events().includes('working:first-traex-input'), 'the first turn is running');
    h.send({ type: 'message', content: 'second-traex-input', turnId: 'om_second' });
    await h.waitFor(() => h.events().includes('question-shown'), 'the question came up after the typed-ahead paste');
    const waiting = t('worker.traex_question.draft_waiting', { cliName: lookupCliDisplayName('traex')! });
    await h.waitFor(
      () => h.messages.some(m => m.type === 'user_notify' && m.message === waiting),
      'the sender is told the message waits for the question',
    );
    h.send({ type: 'message', content: 'third-traex-input', turnId: 'om_third' });
    await h.waitFor(
      () => h.messages.some(m => m.type === 'user_notify' && m.message === heldNotice),
      'a message arriving meanwhile is told it is held',
    );
    await new Promise(r => setTimeout(r, 1_500));
    expect(h.events().filter(e => e.startsWith('answer') || e.startsWith('key-on-question') || e.startsWith('submitted:second')), h.logs.join('')).toEqual([]);
    await h.waitFor(() => h.asks.length > 0, 'question card raised');
    const releases = () => h.logs.join('').split('releasing queued input').length - 1;
    const releasesBefore = releases();
    h.asks[0]!.respond({ kind: 'answered', answers: [['3']], by: 'ou_user', comment: null, timedOut: false });
    await h.waitFor(() => h.events().includes('answer:3'), 'card choice entered');
    // Right when the page has gone and the hold lets go — the draft's Enter
    // still pending (it is pressed on the guard's next look).
    await h.waitFor(() => releases() > releasesBefore, 'the hold let go', 5_000);
    // Passthrough commands across the gap between the hold letting go and the
    // draft's Enter (the guard looks every 500ms): none may land on the draft.
    for (let i = 0; i < 5; i++) {
      h.send({ type: 'raw_input', content: '/status', turnId: `om_status_${i}` });
      await new Promise(r => setTimeout(r, 100));
    }
    await h.waitFor(() => h.events().includes('turn-done:3'), 'the waiting draft and the held message ran in order');
    const events = h.events();
    expect(events.filter(e => e.startsWith('answer'))).toEqual(['answer:3']);
    const submitted = events.filter(e => e.startsWith('submitted:'));
    // The draft goes in exactly as pasted, once, with nothing typed onto it.
    expect(submitted.slice(0, 2)).toEqual(['submitted:first-traex-input', 'submitted:second-traex-input']);
    expect(submitted.slice(2).some(e => e.startsWith('submitted:third-traex-input'))).toBe(true);
    expect(events.indexOf('submitted:second-traex-input')).toBeGreaterThan(events.indexOf('answer:3'));
    expect(h.typed().match(/second-traex-input/g)).toHaveLength(1);
  });
}
