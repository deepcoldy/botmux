/**
 * Kimi Code's "cache expired" menu through the REAL worker (src/worker.ts over
 * its daemon IPC) on the real tmux and PTY backends. The CLI is
 * test/fixtures/fake-kimi-cache-expiry.mjs: it draws the real Kimi 2.5.3
 * screens captured in test/fixtures/stuck-pages and reports OSC 7501 the way
 * the real binary did in the probes those captures come from (nothing at all
 * while the menu is up).
 *
 * Covers, end to end:
 *  - idle submit, auto-compact off: the parked turn is NOT completed by the
 *    quiet screen (before the fix: `prompt_ready` ~17s after the submit, while
 *    the menu was still up), the stuck card is raised for that turn with only
 *    the menu rows as its tail, and its Enter continues the turn;
 *  - idle submit, auto-compact on: Enter is pressed on "Compact and continue",
 *    the turn completes on Kimi's own `done`, nothing else is pressed;
 *  - pointer moved off "Compact and continue": no key at all, the card offers
 *    none;
 *  - Enter that never takes (no `working`): after the bounded window the card
 *    is raised with the failure notice;
 *  - resume: the queued prompt is held off the menu (never pasted into it),
 *    then delivered after the compaction the card / auto-compact started.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { workerTmuxArgs } from './helpers/worker-tmux-session.js';

const FAKE_KIMI = resolve('test/fixtures/fake-kimi-cache-expiry.mjs');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FakeEvent { t: number; ev: string; text?: string; pointer?: string }

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function startWorker(opts: {
  backendType: 'tmux' | 'pty';
  scenario: 'idle' | 'resume';
  auto?: boolean;
  pointer?: 'compact' | 'new';
  ignoreEnter?: boolean;
  workingDelayMs?: number;
  /** First prompt (init), for the resume scene. */
  prompt?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), 'bmx-kimi-cache-'));
  const data = join(root, 'data');
  mkdirSync(data);
  const fakeLog = join(root, 'fake-kimi.log');
  // tmux backend: the worker subscribes to the pane (`pipe-pane`) only after
  // `new-session` has started the CLI, and what the CLI writes before that
  // never reaches the worker. Real Kimi 2.5.3 writes its first byte ~0.6s
  // after exec; the fake would paint within tens of milliseconds, and under CI
  // load the subscription came later: the composer and the only startup `idle`
  // were lost and the worker was left on its 15s first-prompt fallback, past
  // the readiness wait below. So the fake paints once the pane is piped.
  const startFile = join(root, 'fake-kimi.start');
  const wrapper = join(root, 'kimi');
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE_KIMI)} "$@"\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: root, BOTMUX_HOME: join(root, '.botmux'), SESSION_DATA_DIR: data,
    TMUX_TMPDIR: root, SHELL: '/bin/bash', BOTMUX_NO_CLAIM: '1', LARK_APP_ID: 'test', LARK_APP_SECRET: 'test',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (opts.backendType === 'tmux') {
    // A live private server lets the worker tell a missing session from an
    // unreachable socket.
    expect(spawnSync('tmux', ['new-session', '-d', '-s', 'anchor', 'sleep', '300'], { env }).status).toBe(0);
  }
  const sessionId = randomUUID();
  const child: ChildProcess = spawnTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: WorkerToDaemon[] = [];
  let logs = '';
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', b => { logs += b; });
  child.stderr?.on('data', b => { logs += b; });
  const exited = new Promise<void>(r => child.once('exit', () => r()));
  let closed = false;
  cleanups.push(async () => {
    closed = true;
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    const timer = setTimeout(() => { void killProcessTree(child); }, 5000);
    await exited;
    clearTimeout(timer);
    if (opts.backendType === 'tmux') spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  });
  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir: data,
    cliId: 'kimi', cliPathOverride: wrapper, backendType: opts.backendType, launchShell: '/bin/bash',
    prompt: opts.prompt ?? '', ...(opts.prompt ? { turnId: 'om_turn_init' } : {}),
    // The resume scene is a resumed Kimi session (`--session <id>`): the menu
    // comes right after the resume finishes loading.
    ...(opts.scenario === 'resume' ? { resume: true, cliSessionId: 'session_kimi-cache-expiry-fake' } : {}),
    env: {
      FAKE_KIMI_LOG: fakeLog,
      FAKE_KIMI_SCENARIO: opts.scenario,
      ...(opts.backendType === 'tmux' ? { FAKE_KIMI_START_FILE: startFile } : {}),
      ...(opts.pointer ? { FAKE_KIMI_POINTER: opts.pointer } : {}),
      ...(opts.ignoreEnter ? { FAKE_KIMI_IGNORE_ENTER: '1' } : {}),
      ...(opts.workingDelayMs ? { FAKE_KIMI_WORKING_DELAY_MS: String(opts.workingDelayMs) } : {}),
    },
    ...(opts.auto ? { kimiCacheExpiryAutoCompact: true as const } : {}),
    larkAppId: 'test', larkAppSecret: 'test', apiOnly: true, locale: 'en',
  } satisfies DaemonToWorker);
  if (opts.backendType === 'tmux') {
    void (async () => {
      const piped = [...workerTmuxArgs(env), 'display-message', '-p', '-t', TmuxBackend.sessionName(sessionId), '#{pane_pipe}'];
      while (!closed && child.exitCode == null) {
        if (spawnSync('tmux', piped, { env, encoding: 'utf8' }).stdout?.trim() === '1') {
          writeFileSync(startFile, '');
          return;
        }
        await pause(20);
      }
    })();
  }

  const fake = (): FakeEvent[] => existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeEvent)
    : [];
  const waitFor = async (cond: () => boolean, what: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() >= deadline || child.exitCode != null) {
        const types = messages.map(m => m.type + ('turnId' in m && m.turnId ? `:${m.turnId}` : '')).join(' ');
        throw new Error(`timed out: ${what}\n--- fake ---\n${JSON.stringify(fake())}\n--- ipc ---\n${types.slice(-3000)}\n--- logs ---\n${logs.slice(-6000)}`);
      }
      await pause(100);
    }
  };
  const send = (text: string, turnId: string) =>
    child.send({ type: 'message', content: text, turnId } satisfies DaemonToWorker);
  const indexOf = (pred: (m: WorkerToDaemon) => boolean) => messages.findIndex(pred);
  /** `prompt_ready` after this turn's literal write: the daemon settles an
   *  ordinary Kimi turn on it. */
  const settled = (turnId: string) => {
    const started = indexOf(m => m.type === 'turn_execution_started' && m.turnId === turnId);
    return started >= 0 && messages.slice(started + 1).some(m => m.type === 'prompt_ready');
  };
  const stuckWarnings = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'stuck_warning' }> => m.type === 'stuck_warning');
  const notices = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'user_notify' }> => m.type === 'user_notify');
  return { child, messages, fake, waitFor, send, settled, stuckWarnings, notices, logs: () => logs };
}

type Worker = ReturnType<typeof startWorker>;

async function firstTurn(w: Worker): Promise<void> {
  await w.waitFor(() => w.messages.some(m => m.type === 'prompt_ready'), 'CLI ready');
  w.send('Summarize the project layout', 'om_turn_1');
  await w.waitFor(() => w.settled('om_turn_1'), 'turn 1 settled');
}

async function parkSecondTurn(w: Worker): Promise<number> {
  w.send('Now list the open questions', 'om_turn_2');
  await w.waitFor(() => w.fake().some(e => e.ev === 'menu-shown'), 'menu shown');
  return w.fake().find(e => e.ev === 'menu-shown')!.t;
}

for (const backendType of ['tmux', 'pty'] as const) describe.skipIf(!hasTmux)(`Kimi cache-expiry menu on the ${backendType} backend`, () => {
  it('auto-compact off: the parked turn is not completed by the quiet screen; the card continues it', async () => {
    const w = startWorker({ backendType, scenario: 'idle' });
    await firstTurn(w);
    const shownAt = await parkSecondTurn(w);

    await w.waitFor(() => w.stuckWarnings().length > 0, 'stuck card raised');
    const card = w.stuckWarnings()[0]!;
    expect(card).toMatchObject({ matchedPattern: 'kimi cache expiry', reason: 'turn_stalled', turnId: 'om_turn_2' });
    // Only the menu leaves the terminal, never the conversation above it.
    expect(card.screenTail).toContain('Cache expired — the next message re-sends the entire history');
    expect(card.screenTail).toContain('❯ Compact and continue');
    expect(card.screenTail).not.toContain('Summarize the project layout');

    // Past the submit's 15s busy deadline + the 2s quiet-screen fallback that
    // used to end the turn here.
    const wait = shownAt + 21_000 - Date.now();
    if (wait > 0) await pause(wait);
    expect(w.settled('om_turn_2'), w.logs().slice(-4000)).toBe(false);
    expect(w.fake().filter(e => e.ev.startsWith('menu-enter'))).toEqual([]);

    // The card's only key, as the daemon forwards it.
    w.child.send({
      type: 'tui_keys', keys: ['Enter'], isFinal: true, stuckNonce: 7,
      stuckCliLifetime: card.cliLifetime, stuckPageType: card.matchedPattern,
    } satisfies DaemonToWorker);
    await w.waitFor(() => w.messages.some(m => m.type === 'tui_keys_delivered' && m.nonce === 7), 'card key delivered');
    await w.waitFor(() => w.settled('om_turn_2'), 'turn 2 settled after compaction');
    const ev = w.fake().map(e => e.ev);
    expect(ev).toContain('compact');
    expect(w.fake().filter(e => e.ev === 'turn-done').map(e => e.text)).toEqual(['Summarize the project layout', 'Now list the open questions']);
    expect(ev).not.toContain('wrong-row');
  }, 60_000);

  it('auto-compact on: presses Compact and continue, and the turn completes on Kimi\'s own done', async () => {
    const w = startWorker({ backendType, scenario: 'idle', auto: true });
    await firstTurn(w);
    const shownAt = await parkSecondTurn(w);
    await w.waitFor(() => w.settled('om_turn_2'), 'turn 2 settled');

    const enter = w.fake().find(e => e.ev === 'menu-enter')!;
    expect(enter.pointer).toBe('compact');
    // Well before the screen-idle fallback (~17s): the tick opens the event.
    expect(enter.t - shownAt).toBeLessThan(10_000);
    const done = w.fake().filter(e => e.ev === 'turn-done');
    expect(done.map(e => e.text)).toEqual(['Summarize the project layout', 'Now list the open questions']);
    // Completed only after the parked message actually ran.
    const settledIdx = w.messages.findIndex((m, i) => m.type === 'prompt_ready'
      && i > w.messages.findIndex(x => x.type === 'turn_execution_started' && x.turnId === 'om_turn_2'));
    expect(settledIdx).toBeGreaterThan(-1);
    expect(w.fake().filter(e => e.ev === 'menu-enter')).toHaveLength(1);
    expect(w.stuckWarnings()).toEqual([]);
    expect(w.notices().some(n => /Compact and continue/.test(n.message))).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasTmux)('Kimi cache-expiry menu: never pressed blindly (tmux)', () => {
  it('pointer moved off Compact and continue: no key, the card offers none', async () => {
    const w = startWorker({ backendType: 'tmux', scenario: 'idle', auto: true, pointer: 'new' });
    await firstTurn(w);
    await parkSecondTurn(w);
    await w.waitFor(() => w.stuckWarnings().length > 0, 'stuck card raised');
    expect(w.stuckWarnings()[0]).toMatchObject({ matchedPattern: 'kimi cache expiry moved', turnId: 'om_turn_2' });
    await pause(3000);
    expect(w.fake().filter(e => e.ev === 'menu-enter' || e.ev === 'wrong-row')).toEqual([]);
    expect(w.settled('om_turn_2')).toBe(false);
  }, 60_000);

  it('a `working` report that arrives after the key still counts as started', async () => {
    const w = startWorker({ backendType: 'tmux', scenario: 'idle', auto: true, workingDelayMs: 400 });
    await firstTurn(w);
    await parkSecondTurn(w);
    await w.waitFor(() => w.settled('om_turn_2'), 'turn 2 settled');
    const enterAt = w.fake().find(e => e.ev === 'menu-enter')!.t;
    // Past the bounded window: a missed report would read as "unconfirmed" there.
    const wait = enterAt + 11_000 - Date.now();
    if (wait > 0) await pause(wait);
    const texts = w.notices().map(n => n.message);
    expect(texts.filter(m => /Compact and continue was picked: the held message continues/.test(m))).toHaveLength(1);
    expect(texts.some(m => /was not seen starting/.test(m))).toBe(false);
    expect(w.stuckWarnings()).toEqual([]);
  }, 60_000);

  it('an Enter that never takes raises the card with the failure notice', async () => {
    const w = startWorker({ backendType: 'tmux', scenario: 'idle', auto: true, ignoreEnter: true });
    await firstTurn(w);
    await parkSecondTurn(w);
    await w.waitFor(() => w.fake().some(e => e.ev === 'menu-enter'), 'auto Enter pressed');
    await w.waitFor(() => w.stuckWarnings().length > 0, 'failure card raised', 20_000);
    const card = w.stuckWarnings()[0]!;
    expect(card).toMatchObject({ matchedPattern: 'kimi cache expiry', reason: 'turn_stalled', turnId: 'om_turn_2' });
    expect(card.noticeText).toMatch(/did not start working within 10s/);
    // Exactly one automatic Enter for this menu event.
    expect(w.fake().filter(e => e.ev === 'menu-enter')).toHaveLength(1);
    expect(w.settled('om_turn_2')).toBe(false);
  }, 60_000);
});

for (const backendType of ['tmux', 'pty'] as const) describe.skipIf(!hasTmux)(`Kimi cache-expiry menu on resume (${backendType})`, () => {
  it('auto-compact off: the first prompt is held off the menu and delivered after the card\'s compaction', async () => {
    const w = startWorker({ backendType, scenario: 'resume', prompt: 'Continue where we left off' });
    await w.waitFor(() => w.stuckWarnings().length > 0, 'held-input card raised');
    const card = w.stuckWarnings()[0]!;
    expect(card).toMatchObject({ matchedPattern: 'kimi cache expiry', reason: 'input_held', turnId: 'om_turn_init' });
    await pause(1500);
    expect(w.fake().filter(e => e.ev === 'paste-in-menu' || e.ev === 'menu-enter')).toEqual([]);

    w.child.send({
      type: 'tui_keys', keys: ['Enter'], isFinal: true, stuckNonce: 3,
      stuckCliLifetime: card.cliLifetime, stuckPageType: card.matchedPattern,
    } satisfies DaemonToWorker);
    await w.waitFor(() => w.fake().some(e => e.ev === 'turn-done'), 'held prompt ran');
    const ev = w.fake().map(e => e.ev);
    expect(ev.indexOf('compact-done')).toBeLessThan(ev.indexOf('submit'));
    // A resumed session's opening prompt carries botmux's own refresh blocks after the text.
    const submits = w.fake().filter(e => e.ev === 'submit').map(e => e.text);
    expect(submits).toHaveLength(1);
    expect(submits[0]!.startsWith('Continue where we left off')).toBe(true);
    expect(ev).not.toContain('paste-in-menu');
  }, 60_000);

  it('auto-compact on: compacts first, then delivers the held prompt', async () => {
    const w = startWorker({ backendType, scenario: 'resume', auto: true, prompt: 'Continue where we left off' });
    await w.waitFor(() => w.fake().some(e => e.ev === 'turn-done'), 'held prompt ran');
    const ev = w.fake().map(e => e.ev);
    expect(ev.filter(e => e === 'menu-enter')).toHaveLength(1);
    expect(ev.indexOf('compact-done')).toBeLessThan(ev.indexOf('submit'));
    expect(ev).not.toContain('paste-in-menu');
    expect(w.stuckWarnings()).toEqual([]);
  }, 60_000);
});
