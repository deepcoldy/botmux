/**
 * Regression: Codex's one-time model-migration picker must not swallow input.
 *
 * Codex 0.162 paints a skeleton composer (`› Ask Codex to do anything`)
 * before initialization, then — once per CODEX_HOME whenever the configured
 * model has an unacknowledged upgrade — replaces it with a modal picker:
 *
 *   Meet GPT-6 Sol
 *   › 1. Try new model
 *     2. Use existing model
 *   enter/esc confirm · ^c quit
 *
 * The idle detector latched ready evidence from the skeleton composer, so two
 * quiet seconds on the picker declared the first prompt ready. The first
 * message was then pasted into the picker (discarded) and its submit Enter
 * confirmed the default row, silently switching the user's global model to
 * the new one; the message never reached the model and the queue blocked on
 * `submit_unconfirmed`. (CI: every first Codex session of a run, because
 * scripts/run-e2e.ts pins `model = "gpt-5.5"`.)
 *
 * Every input path must hold while the picker owns the input surface — the
 * screen-idle gate, the 90s first-prompt hard timeout, type-ahead flushes and
 * raw slash-command passthrough — and the same menu text quoted in a resumed
 * transcript above a live composer must not be mistaken for the picker.
 *
 * The fake CLI below reproduces the real 0.162.1 key semantics measured with
 * the actual binary: Enter/Esc confirm the highlighted row, Down/Up move, a
 * digit picks its row directly, and a bracketed paste while the picker is
 * active is dropped.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const tmuxAvailable = probeTmuxFunctional().ok;
const productionBackend = tmuxAvailable ? 'tmux' : 'pty';
const FIRST_PROMPT = 'first-message-after-migration-picker';

interface FakeCodexOptions {
  /** `stream`: picker rows are recognisable in the PTY stream (real Codex).
   *  `screen-only`: labels and row numbers are painted separately, so only
   *  the rendered screen shows the picker (exercises the screen-idle gate). */
  paint: 'stream' | 'screen-only';
  /** `skeleton`: Codex 0.162 banner (no initialization evidence).
   *  `loaded-box`: older boxed banner, which proves startup and therefore
   *  lets type-ahead input reach flushPending directly. */
  banner: 'skeleton' | 'loaded-box';
  /** `normal`: honours keys. `sticky`: ignores every key until the release
   *  file appears (the operator resolving it in the Web terminal).
   *  `none`: no picker; the composer is live from the start. */
  picker: 'normal' | 'sticky' | 'none';
  /** Restored transcript quoting the menu rows above the composer. */
  history: boolean;
  /** The composer holds a multi-line draft containing the two menu rows (an
   *  owned session reattached with unsent text), above the status footer.
   *  `menu-first`: the draft starts with `1. Try new model`.
   *  `guided`: guidance text first, then the two rows. */
  draft?: 'menu-first' | 'guided';
  /** Launch 1 has no picker and crashes right after its first submission;
   *  launch 2 (the respawn) shows the normal picker. */
  relaunchPicker?: boolean;
}

interface Scenario {
  backendType: 'tmux' | 'pty';
  fake: FakeCodexOptions;
  /** Run as a v3 workflow worker (BOTMUX_WORKFLOW=1): no chat screen-update loop. */
  workflow?: boolean;
}

interface ScenarioContext {
  events: () => string[];
  composerInput: () => string;
  messages: WorkerToDaemon[];
  logs: string[];
  child: ChildProcess;
  waitFor: (condition: () => boolean, timeoutMs?: number) => Promise<void>;
  releasePicker: () => void;
  detail: () => string;
}

function fakeCodexSource(opts: FakeCodexOptions & { eventsFile: string; composerInputFile: string; cliPidFile: string; releaseFile: string; launchFile: string }): string {
  return `#!/usr/bin/env node
const opts = ${JSON.stringify(opts)};
` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const codexDir = path.join(require('node:os').homedir(), '.codex');
fs.mkdirSync(path.join(codexDir, 'sessions'), {recursive:true});
const sid = '11111111-2222-4333-8444-666666666666';
fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-10-15T00-00-00-' + sid + '.jsonl'), 'a');
fs.writeFileSync(opts.cliPidFile, String(process.pid));
const event = (line) => fs.appendFileSync(opts.eventsFile, line + '\n');
const launch = (fs.existsSync(opts.launchFile) ? Number(fs.readFileSync(opts.launchFile, 'utf8')) : 0) + 1;
fs.writeFileSync(opts.launchFile, String(launch));
const pickerMode = opts.relaunchPicker ? (launch === 1 ? 'none' : 'normal') : opts.picker;
let state = pickerMode === 'none' ? 'composer' : 'skeleton';
let selected = 1;
let composerInput = '';
const banner = opts.banner === 'loaded-box'
  ? '│ model: gpt-5.5 /model to change │\r\n│ directory: /tmp/work │\r\n'
  : '  >_ OpenAI Codex (v0.162.1)\r\n     loading\r\n';
const history = opts.history
  ? 'Earlier I was asked to choose:\r\n› 1. Try new model\r\n  2. Use existing model\r\nand kept the configured model.\r\n\r\n'
  : '';
const draftRows = opts.draft === 'guided'
  ? '› please pick one:\r\n  1. Try new model\r\n  2. Use existing model'
  : '› 1. Try new model\r\n  2. Use existing model';
const skeleton = '\x1b[?2004h\x1b[2J\x1b[H' + banner + history
  + (opts.draft ? '\r\n' + draftRows : '\r\n\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m')
  + '\r\n\r\n  gpt-5.5 default · /tmp/work';
const row = (n, label) => (selected === n ? '\x1b[7m\x1b[1m› ' : '\x1b[27m\x1b[22m  ') + n + '. ' + label + '\x1b[0m';
const options = opts.paint === 'stream'
  ? () => '\x1b[7;1H' + row(1, 'Try new model') + '\x1b[8;1H' + row(2, 'Use existing model')
  : () => '\x1b[7;6HTry new model\x1b[8;6HUse existing model'
    + '\x1b[7;1H' + (selected === 1 ? '› ' : '  ') + '1.\x1b[8;1H' + (selected === 2 ? '› ' : '  ') + '2.';
const picker = () => '\x1b[2J\x1b[2;3HMeet\x1b[2;8HGPT-6\x1b[2;14HSol'
  + '\x1b[4;3HOur\x1b[4;7Hlatest\x1b[4;14HSol\x1b[4;18His\x1b[4;21Hbetter.'
  + options()
  + '\x1b[10;3H\x1b[1menter/esc\x1b[22m\x1b[2m confirm · ^c quit\x1b[0m';
const composerLine = opts.draft ? draftRows : '› Ask Codex to do anything';
const composer = '\x1b[2J\x1b[H  >_ OpenAI Codex (v0.162.1)\r\n     /tmp/work\r\n\r\n' + history
  + composerLine + '\r\n\r\n  gpt-5.5 default · /tmp/work';
// Output produced by one input event is written at once, so a Down+Enter
// delivered together yields ONE read holding the picker repaint and the
// composer that replaced it (the coalesced shape seen under load).
let pending = '';
const choose = (n) => {
  event('choice:' + (n === 1 ? 'try-new-model' : 'use-existing-model'));
  state = 'composer';
  pending += composer;
};
process.stdin.setRawMode(true);
process.stdin.on('data', (buffer) => {
  let data = buffer.toString();
  if (state === 'composer') {
    fs.appendFileSync(opts.composerInputFile, data);
    composerInput += data;
    const match = composerInput.match(/\x1b\[200~([\s\S]*?)\x1b\[201~[^\r]*\r/);
    if (match) {
      composerInput = composerInput.slice(composerInput.indexOf(match[0]) + match[0].length);
      event('submitted:' + match[1]);
      if (opts.relaunchPicker && launch === 1) setTimeout(() => process.exit(1), 300);
      fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:match[1], ts:Date.now()/1000})+'\n');
    }
    return;
  }
  if (state !== 'picker') return;
  const paste = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
  if (paste) {
    event('paste-into-picker:' + paste[1]);
    data = data.replace(paste[0], '');
  }
  if (pickerMode === 'sticky') {
    // Navigation keys are expected (BotMux's bounded attempts); anything
    // else is user input that reached the menu.
    const text = data.replace(/\x1b\[[AB]|\x1bO[AB]|[\r\n]/g, '');
    if (text) event('picker-input:' + JSON.stringify(text));
    return;
  }
  for (let i = 0; i < data.length && state === 'picker';) {
    const seq = data.slice(i, i + 3);
    if (seq === '\x1b[B' || seq === '\x1bOB') { selected = 2; pending += picker(); i += 3; continue; }
    if (seq === '\x1b[A' || seq === '\x1bOA') { selected = 1; pending += picker(); i += 3; continue; }
    const ch = data[i++];
    if (ch === '1' || ch === '2') choose(Number(ch));
    else if (ch === '\r' || ch === '\n' || ch === '\x1b') choose(selected);
  }
  if (pending) { process.stdout.write(pending); pending = ''; }
});
process.stdout.write(skeleton);
event('started');
// Redraw after tmux subscribes to pipe-pane so the worker observes the
// startup screen, then present the picker the way Codex 0.162 does.
for (const delay of [200, 400, 700]) setTimeout(() => process.stdout.write(skeleton), delay);
event('launch:' + launch);
if (pickerMode !== 'none') {
  setTimeout(() => { state = 'picker'; process.stdout.write('\x1b[2;6H/tmp/work' + picker()); }, 1000);
}
setInterval(() => {
  if (state === 'picker' && fs.existsSync(opts.releaseFile)) {
    choose(2);
    process.stdout.write(pending);
    pending = '';
  }
}, 100);
`;
}

async function runScenario(scenario: Scenario, drive: (ctx: ScenarioContext) => Promise<void>): Promise<void> {
  const { backendType } = scenario;
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  const root = mkdtempSync(join(backendType === 'tmux' ? '/tmp' : tmpdir(), 'bmx-migration-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const eventsFile = join(root, 'events');
  const composerInputFile = join(root, 'composer-input');
  const cliPidFile = join(root, 'cli-pid');
  const releaseFile = join(root, 'release');
  const launchFile = join(root, 'launches');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(eventsFile, '');
  writeFileSync(composerInputFile, '');
  writeFileSync(fakeCli, fakeCodexSource({ ...scenario.fake, eventsFile, composerInputFile, cliPidFile, releaseFile, launchFile }));
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const events = () => readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
  const detail = () => `events=${JSON.stringify(events())}\n${logs.join('')}`;
  const waitFor = async (condition: () => boolean, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) throw new Error(detail());
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: {
        ...process.env, TMUX_TMPDIR: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
        ...(scenario.workflow ? { BOTMUX_WORKFLOW: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli,
      backendType,
      prompt: FIRST_PROMPT, turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await drive({
      events,
      composerInput: () => readFileSync(composerInputFile, 'utf8'),
      messages,
      logs,
      child,
      waitFor,
      releasePicker: () => writeFileSync(releaseFile, 'resolved in the Web terminal'),
      detail,
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (backendType === 'tmux') {
      try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root }, stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const committed = (ctx: ScenarioContext, turnId: string) =>
  ctx.messages.some(m => m.type === 'turn_input_committed' && m.turnId === turnId);
const submissions = (ctx: ScenarioContext) => ctx.events().filter(line => line.startsWith('submitted:'));
const inputsThatReachedThePicker = (ctx: ScenarioContext) =>
  ctx.events().filter(line => line.startsWith('paste-into-picker:') || line.startsWith('picker-input:'));
const unresolvedNotices = (ctx: ScenarioContext) =>
  ctx.messages.filter(m => m.type === 'user_notify' && String(m.message).includes('Use existing model'));

for (const backendType of ['pty', 'tmux'] as const) {
  for (const paint of ['stream', 'screen-only'] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `keeps the configured model and submits the first message once after the migration picker (${backendType}, ${paint})`,
      () => runScenario({ backendType, fake: { paint, banner: 'skeleton', picker: 'normal', history: false } }, async ctx => {
        await ctx.waitFor(() => ctx.events().some(line => line.startsWith('choice:')));
        await ctx.waitFor(() => committed(ctx, 'om_test'));
        expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
        // Keep the user's configured model: never confirm "Try new model".
        expect(ctx.events().filter(line => line.startsWith('choice:')), ctx.detail()).toEqual(['choice:use-existing-model']);
        const submitted = submissions(ctx);
        expect(submitted, ctx.detail()).toHaveLength(1);
        expect(submitted[0]!.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
      }),
      60_000,
    );
  }
}

it(`holds input past the 90s first-prompt hard timeout while the picker stays open (${productionBackend})`,
  () => runScenario({ backendType: productionBackend, fake: { paint: 'stream', banner: 'skeleton', picker: 'sticky', history: false } }, async ctx => {
    // Automatic attempts are exhausted and the user is told to resolve it.
    await ctx.waitFor(() => unresolvedNotices(ctx).length > 0);
    // Cross the hard cap. Before the fix the timeout cleared startup state and
    // force-flushed the queued message straight into the menu.
    await ctx.waitFor(
      () => /First prompt (?:hard )?timeout[^\n]*(?:picker still open|forcing queued message flush)/.test(ctx.logs.join('')),
      110_000,
    );
    await new Promise(r => setTimeout(r, 2_000));
    expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
    expect(ctx.events().filter(line => line.startsWith('choice:')), ctx.detail()).toEqual([]);
    expect(committed(ctx, 'om_test'), ctx.detail()).toBe(false);
    expect(unresolvedNotices(ctx), ctx.detail()).toHaveLength(1);

    // The operator resolves the picker; the held message is delivered once.
    ctx.releasePicker();
    await ctx.waitFor(() => committed(ctx, 'om_test'));
    expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
    expect(submissions(ctx), ctx.detail()).toHaveLength(1);
    expect(submissions(ctx)[0]!.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
  }),
  150_000,
);

for (const backendType of ['pty', 'tmux'] as const) {
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`holds a type-ahead message while the picker stays open (${backendType})`,
    () => runScenario({ backendType, fake: { paint: 'stream', banner: 'loaded-box', picker: 'sticky', history: false } }, async ctx => {
      await ctx.waitFor(() => ctx.logs.join('').includes('Codex model-migration picker detected'));
      // The boxed banner proved startup, so type-ahead routes this straight into
      // flushPending (no idle edge involved).
      ctx.child.send({ type: 'message', content: 'follow-up-while-picker-open', turnId: 'om_follow' } satisfies DaemonToWorker);
      await new Promise(r => setTimeout(r, 3_000));
      expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
      expect(ctx.events().filter(line => line.startsWith('choice:')), ctx.detail()).toEqual([]);

      ctx.releasePicker();
      await ctx.waitFor(() => committed(ctx, 'om_test'));
      await ctx.waitFor(() => submissions(ctx).some(line => line.includes('follow-up-while-picker-open')));
      expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
      const delivered = submissions(ctx).join('\n');
      expect(delivered.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
      expect(delivered.match(/follow-up-while-picker-open/g), ctx.detail()).toHaveLength(1);
    }),
    60_000,
  );
}

for (const backendType of ['pty', 'tmux'] as const) {
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`holds a raw slash-command passthrough while the picker stays open (${backendType})`,
    () => runScenario({ backendType, fake: { paint: 'stream', banner: 'loaded-box', picker: 'sticky', history: false } }, async ctx => {
      await ctx.waitFor(() => ctx.logs.join('').includes('Codex model-migration picker detected'));
      // Raw passthrough writes literally, even while the CLI is busy.
      ctx.child.send({ type: 'raw_input', content: '/status', turnId: 'om_status' } satisfies DaemonToWorker);
      await new Promise(r => setTimeout(r, 3_000));
      expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
      expect(ctx.events().filter(line => line.startsWith('choice:')), ctx.detail()).toEqual([]);

      ctx.releasePicker();
      // The queue resumes after the release. Which held item goes first is queue
      // policy; the fake never finishes a turn, so only the first one lands.
      await ctx.waitFor(() => ctx.composerInput().includes('/status') || committed(ctx, 'om_test'));
      expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
      expect((ctx.composerInput().match(/\/status/g) ?? []).length, ctx.detail()).toBeLessThanOrEqual(1);
    }),
    60_000,
  );
}

// A reattached owned session whose composer draft holds the two menu rows,
// above the ordinary status footer (no picker confirm footer anywhere).
it(`never injects picker keys into a composer draft that starts with the menu rows (${productionBackend})`,
  () => runScenario({ backendType: productionBackend, fake: { paint: 'stream', banner: 'skeleton', picker: 'none', history: false, draft: 'menu-first' } }, async ctx => {
    await ctx.waitFor(() => ctx.events().includes('started'));
    // The stream sees both numbered rows, so the startup observer re-checks the
    // screen ~400ms later; give it several retry periods.
    await new Promise(r => setTimeout(r, 5_000));
    expect(ctx.child.exitCode, ctx.detail()).toBeNull();
    expect(ctx.messages.filter(m => m.type === 'error'), ctx.detail()).toEqual([]);
    // Down+Enter here would submit the user's draft.
    expect(ctx.composerInput(), ctx.detail()).not.toMatch(/\x1b\[B|\x1bOB|\x1b\[A|\x1bOA|\r/);
    expect(ctx.logs.join(''), ctx.detail()).not.toContain('Codex model-migration picker');
    expect(unresolvedNotices(ctx), ctx.detail()).toEqual([]);
  }),
  60_000,
);

it(`does not hold input for a composer draft whose guidance text precedes the menu rows (${productionBackend})`,
  () => runScenario({ backendType: productionBackend, fake: { paint: 'stream', banner: 'skeleton', picker: 'none', history: false, draft: 'guided' } }, async ctx => {
    await ctx.waitFor(() => ctx.events().includes('started'));
    await ctx.waitFor(() => committed(ctx, 'om_test'));
    expect(ctx.composerInput(), ctx.detail()).not.toMatch(/\x1b\[B|\x1bOB|\x1b\[A|\x1bOA/);
    expect(ctx.logs.join(''), ctx.detail()).not.toContain('Codex model-migration picker');
    expect(unresolvedNotices(ctx), ctx.detail()).toEqual([]);
    expect(submissions(ctx), ctx.detail()).toHaveLength(1);
    expect(submissions(ctx)[0]!.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
  }),
  60_000,
);

// The retry after a crash-loop park respawns through spawnCli() without
// killCli(): the previous process's picker-cleared cache must not leak into it.
it(`re-arms the picker guard for a CLI respawned after a crash-loop park (${productionBackend})`,
  () => runScenario({ backendType: productionBackend, fake: { paint: 'stream', banner: 'skeleton', picker: 'none', history: false, relaunchPicker: true } }, async ctx => {
    await ctx.waitFor(() => committed(ctx, 'om_test'));
    await ctx.waitFor(() => ctx.messages.some(m => m.type === 'claude_exit'));
    ctx.child.send({ type: 'park_diagnostic' } satisfies DaemonToWorker);
    await new Promise(r => setTimeout(r, 500));
    ctx.child.send({ type: 'message', content: 'second-message-after-crash-retry', turnId: 'om_retry' } satisfies DaemonToWorker);
    await ctx.waitFor(() => ctx.events().includes('launch:2'));
    await ctx.waitFor(() => committed(ctx, 'om_retry'), 30_000);
    expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
    expect(ctx.events().filter(line => line.startsWith('choice:')), ctx.detail()).toEqual(['choice:use-existing-model']);
    expect(submissions(ctx).filter(line => line.includes('second-message-after-crash-retry')), ctx.detail()).toHaveLength(1);
  }),
  90_000,
);

// A workflow worker never starts the chat screen-update loop. A PTY workflow
// worker has no screen source at all (no renderer) and keeps the previous
// behaviour, so this needs the production tmux backend.
it.skipIf(!tmuxAvailable)('retries, notifies and delivers once in a v3 workflow worker (tmux)',
  () => runScenario({ backendType: 'tmux', workflow: true, fake: { paint: 'stream', banner: 'skeleton', picker: 'sticky', history: false } }, async ctx => {
    await ctx.waitFor(() => ctx.logs.join('').includes('Workflow worker mode'));
    await ctx.waitFor(() => ctx.logs.join('').includes('(Down+Enter, attempt 3/3)'), 15_000);
    await ctx.waitFor(() => unresolvedNotices(ctx).length > 0, 10_000);
    expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
    expect(committed(ctx, 'om_test'), ctx.detail()).toBe(false);

    ctx.releasePicker();
    await ctx.waitFor(() => committed(ctx, 'om_test'));
    expect(inputsThatReachedThePicker(ctx), ctx.detail()).toEqual([]);
    expect(submissions(ctx), ctx.detail()).toHaveLength(1);
    expect(submissions(ctx)[0]!.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
  }),
  60_000,
);

it(`does not treat menu rows quoted in a resumed transcript above the composer as the picker (${productionBackend})`,
  () => runScenario({ backendType: productionBackend, fake: { paint: 'stream', banner: 'skeleton', picker: 'none', history: true } }, async ctx => {
    await ctx.waitFor(() => committed(ctx, 'om_test'));
    // No navigation was synthesized into the live composer and nothing held.
    expect(ctx.composerInput(), ctx.detail()).not.toMatch(/\x1b\[B|\x1bOB|\x1b\[A|\x1bOA/);
    expect(ctx.logs.join(''), ctx.detail()).not.toContain('Codex model-migration picker');
    expect(unresolvedNotices(ctx), ctx.detail()).toEqual([]);
    expect(submissions(ctx), ctx.detail()).toHaveLength(1);
    expect(submissions(ctx)[0]!.match(new RegExp(FIRST_PROMPT, 'g')), ctx.detail()).toHaveLength(1);
  }),
  60_000,
);
