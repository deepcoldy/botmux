/**
 * Opt-in real-worker e2e: TRAE CLI (traex) startup blocker screens with the
 * operator-disabled hook-trust bypass, driven through the real botmux worker
 * (src/worker.ts over daemon IPC) on the real tmux backend (private fenced
 * TMUX_TMPDIR from the e2e project's tmux fence). No Feishu traffic (apiOnly).
 *
 * Scenarios
 *   A. `dashboard.bypassCodexHookTrust=false` + SessionStart/PreToolUse `echo`
 *      hooks in an isolated TRAE_HOME → traex opens on "Hooks need review"
 *      (footer `enter confirm  |  esc go back`).
 *   B. Legacy data (`traecli.yaml`, no `.coco-migrated`) → "> Legacy TRAE CLI
 *      data detected" menu (Esc = Skip for now). Hook-trust bypass left at
 *      its default (ON) so the legacy menu is the only blocker.
 *
 * Desired contract (asserted on IPC/screen facts only):
 *   1. While the blocker menu is on screen the worker never types the IM
 *      message into it and never advances it by itself (A: no Enter into
 *      "Review hooks" → Hooks browser; B: the menu is not answered).
 *   2. Exactly one `stuck_warning` with a non-empty `matchedPattern`
 *      arrives within 60s of the message.
 *   3. A card click simulated as `tui_keys` Escape (stuckNonce /
 *      stuckCliLifetime / stuckPageType from that warning) gets
 *      `tui_keys_delivered`, and the held message then reaches TRAE
 *      (`<TRAE_HOME>/cli/history.jsonl` records it).
 *
 * Run: BOTMUX_E2E_REAL_CLI=1 bunx vitest run --project e2e test/traex-hook-review-card.e2e.ts
 * Needs a logged-in host traex (`~/.trae/cli/auth.json`); a real model turn runs
 * after delivery. Evidence timelines are written to
 * /tmp/stuckcard-repro/e2e-traex/evidence-<scenario>.log.
 */
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { killWorkerTmuxSession, workerTmuxArgs } from './helpers/worker-tmux-session.js';

const SCRATCH = '/tmp/stuckcard-repro/e2e-traex';
const HOST_TRAE = join(homedir(), '.trae');
const HOST_AUTH = join(HOST_TRAE, 'cli', 'auth.json');

function traexBin(): string | undefined {
  const r = spawnSync('sh', ['-c', 'command -v traex'], { encoding: 'utf8' });
  const bin = r.stdout.trim();
  return r.status === 0 && bin ? bin : undefined;
}
const TRAEX = traexBin();
const enabled = process.env.BOTMUX_E2E_REAL_CLI === '1' && !!TRAEX && existsSync(HOST_AUTH);

/** Worker first-prompt hard cap (worker.ts FIRST_PROMPT_HARD_TIMEOUT_MS = 90s,
 *  measured from spawn) plus margin: the observation window must outlive it,
 *  otherwise a worker that types into the menu only at the hard cap would pass. */
const OBSERVE_FROM_SPAWN_MS = 110_000;
const STUCK_WARNING_BUDGET_MS = 60_000;

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const children: ChildProcess[] = [];
const tmuxSessions: string[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
      await pause(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const name of tmuxSessions.splice(0)) killWorkerTmuxSession(name);
  // Symlinked auth/model-provider entries are removed as links, never followed.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmuxCapture(sessionName: string): string {
  try {
    return execFileSync('tmux', [...workerTmuxArgs(), 'capture-pane', '-p', '-t', sessionName], { encoding: 'utf8', timeout: 3000 });
  } catch { return ''; }
}

/** Copy only `model` / `model_provider` from the host config (never printed). */
function hostModelLines(): string {
  try {
    return readFileSync(join(HOST_TRAE, 'traecli.toml'), 'utf8')
      .split('\n').filter(l => /^(model|model_provider) = /.test(l)).join('\n');
  } catch { return ''; }
}

type Scenario = 'hooks' | 'legacy';

function buildTraeHome(root: string, cwd: string, scenario: Scenario): string {
  const traeHome = join(root, 'home', '.trae');
  mkdirSync(join(traeHome, 'cli'), { recursive: true });
  symlinkSync(HOST_AUTH, join(traeHome, 'cli', 'auth.json'));
  if (existsSync(join(HOST_TRAE, 'model-provider'))) symlinkSync(join(HOST_TRAE, 'model-provider'), join(traeHome, 'model-provider'));
  let toml = `${hostModelLines()}\n\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`;
  if (scenario === 'hooks') {
    for (const m of ['.coco-migrated', '.coco-rollouts-migrated', '.coco-rollouts-sanitized-v3', '.coco-rollouts-state-indexed', '.personality_migration', '.trae-cn-resources-migrated']) {
      if (existsSync(join(HOST_TRAE, m))) copyFileSync(join(HOST_TRAE, m), join(traeHome, m));
      else writeFileSync(join(traeHome, m), '');
    }
    toml += [
      '', '[[hooks.SessionStart]]', '[[hooks.SessionStart.hooks]]', 'type = "command"', 'command = "echo botmux-e2e-sessionstart"',
      '', '[[hooks.PreToolUse]]', '[[hooks.PreToolUse.hooks]]', 'type = "command"', 'command = "echo botmux-e2e-pretooluse"', '',
    ].join('\n');
  } else {
    writeFileSync(join(traeHome, 'traecli.yaml'), 'model:\n  name: placeholder\n');
  }
  writeFileSync(join(traeHome, 'traecli.toml'), toml);
  return traeHome;
}

const isHookMenu = (s: string) => /Hooks need review/.test(s) && /enter confirm\s+\|\s+esc go back/.test(s);
const isHookBrowser = (s: string) => /Lifecycle hooks from config/.test(s) || /t trust all\s+\|\s+enter review hooks/.test(s);
const isHookDetail = (s: string) => /t trust\s+\|\s+esc go back/.test(s);
const isLegacyMenu = (s: string) => /Legacy TRAE CLI data detected/.test(s) && /Skip for now/.test(s);
const isComposer = (s: string) => /TRAE CLI \(v/.test(s) && /Context \d+% left/.test(s)
  && !isHookMenu(s) && !isHookBrowser(s) && !isHookDetail(s) && !isLegacyMenu(s);

function summarize(m: WorkerToDaemon): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (k === 'type') continue;
    o[k] = typeof v === 'string' ? (v.length > 140 ? `${v.slice(0, 140).replace(/\n/g, '⏎')}…(${v.length})` : v) : v;
  }
  return `${m.type} ${JSON.stringify(o)}`;
}

function startWorker(scenario: Scenario) {
  const root = join(SCRATCH, `${scenario}-${randomUUID().slice(0, 8)}`);
  roots.push(root);
  const cwd = join(root, 'work', 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const traeHome = buildTraeHome(root, cwd, scenario);
  const globalConfig = join(root, 'botmux-config.json');
  // A: operator turned the hook-trust bypass OFF (config.ts bypassCodexHookTrust)
  // — the real-user configuration of the reported topics. B keeps the default
  // (ON): with it OFF the worker's own launch-layer PreToolUse hook puts
  // "Hooks need review" in front of the legacy menu, masking scenario B.
  writeFileSync(globalConfig, JSON.stringify(scenario === 'hooks' ? { dashboard: { bypassCodexHookTrust: false } } : {}));

  const evidencePath = join(SCRATCH, `evidence-${scenario}.log`);
  writeFileSync(evidencePath, '');
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const evidence = (line: string) => appendFileSync(evidencePath, `${stamp()} ${line}\n`);

  const sessionId = randomUUID();
  const tmuxName = TmuxBackend.sessionName(sessionId);
  tmuxSessions.push(tmuxName);
  const env: NodeJS.ProcessEnv = {
    ...process.env, // already fenced: private TMUX_TMPDIR, TMUX unset
    HOME: join(root, 'home'),
    TRAE_HOME: traeHome,
    BOTMUX_GLOBAL_CONFIG_FILE: globalConfig,
    SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
    LARK_APP_ID: 'app_traex_e2e', LARK_APP_SECRET: 'test-secret',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  // The tmux pane inherits the SERVER's global env, not the worker's: start
  // the (fenced, private) server here with the isolated HOME/TRAE_HOME so the
  // CLI can never fall back to the host ~/.trae. The anchor also keeps the
  // server alive so a missing pane is a definite `missing`.
  const anchor = `traex-anchor-${randomUUID()}`;
  execFileSync('tmux', [...workerTmuxArgs(env), 'new-session', '-d', '-s', anchor, 'sleep', '900'], { timeout: 5000, env });
  tmuxSessions.push(anchor);

  const messages: Array<{ at: number; m: WorkerToDaemon }> = [];
  const logs: string[] = [];
  const screens: Array<{ at: number; text: string }> = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  child.on('message', raw => {
    const m = raw as WorkerToDaemon;
    messages.push({ at: Date.now(), m });
    if (m.type !== 'screen_update') evidence(`IPC ${summarize(m)}`);
  });
  const onLog = (b: Buffer) => {
    const s = b.toString();
    logs.push(s);
    for (const line of s.split('\n')) if (line.trim()) evidence(`LOG ${line.slice(0, 1500)}`);
  };
  child.stdout?.on('data', onLog);
  child.stderr?.on('data', onLog);

  let lastScreen = '';
  const poller = setInterval(() => {
    const text = tmuxCapture(tmuxName);
    if (!text.trim()) return;
    screens.push({ at: Date.now(), text });
    if (text !== lastScreen) {
      lastScreen = text;
      evidence(`SCREEN\n${text.split('\n').filter(l => l.trim()).map(l => `    | ${l.slice(0, 160)}`).join('\n')}`);
    }
  }, 500);
  child.on('exit', () => clearInterval(poller));

  const spawnAt = Date.now();
  child.send({
    type: 'init', sessionId, chatId: 'oc_traex_e2e', chatType: 'group', rootMessageId: 'om_root',
    workingDir: cwd, cliId: 'traex', backendType: 'tmux', prompt: '', apiOnly: true,
    larkAppId: 'app_traex_e2e', larkAppSecret: 'test-secret',
    // Per-bot env is the channel that reaches the pane (`/usr/bin/env` prefix),
    // exactly how a fleet bot with its own TRAE_HOME is configured.
    env: { TRAE_HOME: traeHome },
  } satisfies DaemonToWorker);

  const listTraeHome = () => {
    let ls = '<unreadable>';
    try { ls = readdirSync(traeHome).sort().join(' '); } catch { /* gone */ }
    // Section headers only — values (model/provider) are never logged.
    let sections = '';
    try { sections = readFileSync(join(traeHome, 'traecli.toml'), 'utf8').split('\n').filter(l => /^\[/.test(l)).join(' '); } catch { /* none */ }
    return `${ls} | traecli.toml sections: ${sections}`;
  };
  const waitFor = async (cond: () => boolean, what: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() >= deadline || child.exitCode != null) {
        evidence(`TIMEOUT ${what}; TRAE_HOME root: ${listTraeHome()}`);
        return false;
      }
      await pause(250);
    }
    return true;
  };
  const of = <T extends WorkerToDaemon['type']>(type: T) =>
    messages.filter((e): e is { at: number; m: Extract<WorkerToDaemon, { type: T }> } => e.m.type === type);
  return { child, root, traeHome, listTraeHome, tmuxName, spawnAt, messages, logs, screens, evidence, evidencePath, waitFor, of, stop: () => clearInterval(poller) };
}

async function runScenario(scenario: Scenario) {
  const w = startWorker(scenario);

  const isBlocker = scenario === 'hooks' ? isHookMenu : isLegacyMenu;
  const ready = await w.waitFor(() => w.of('ready').length > 0, 'worker ready', 45_000);
  expect(ready, `worker never sent ready; see ${w.evidencePath}`).toBe(true);
  // Isolation guard: the real CLI process (our own descendant, pid from the
  // worker's attestation) must run on the scratch TRAE_HOME, never ~/.trae.
  await w.waitFor(() => w.of('local_process_attestation').length >= 2, 'real CLI pid attested', 15_000);
  const cliPid = w.of('local_process_attestation').at(-1)!.m.cliPid;
  let cliEnv = '';
  try { cliEnv = readFileSync(`/proc/${cliPid}/environ`, 'utf8'); } catch { /* exited */ }
  const cliTraeHome = cliEnv.split('\0').find(kv => kv.startsWith('TRAE_HOME='))?.slice('TRAE_HOME='.length);
  w.evidence(`CLI pid=${cliPid} TRAE_HOME=${cliTraeHome ?? '<unset>'}`);
  expect(cliTraeHome, 'traex must run on the isolated TRAE_HOME').toBe(w.traeHome);
  w.evidence(`TRAE_HOME root at ready: ${w.listTraeHome()}`);
  const blockerShown = await w.waitFor(() => w.screens.some(s => isBlocker(s.text)), 'blocker menu visible', 60_000);
  expect(blockerShown, `traex never showed the ${scenario} menu; see ${w.evidencePath}`).toBe(true);

  const marker = `TRXHK${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const content = `Reply with just OK. ${marker}`;
  const sentAt = Date.now();
  w.evidence(`SEND message turnId=om_turn_1 content=${JSON.stringify(content)}`);
  w.child.send({ type: 'message', content, turnId: 'om_turn_1' } satisfies DaemonToWorker);

  // Observe past the worker's first-prompt hard cap AND the stuck budget.
  const observeUntil = Math.max(w.spawnAt + OBSERVE_FROM_SPAWN_MS, sentAt + STUCK_WARNING_BUDGET_MS + 5_000);
  while (Date.now() < observeUntil && w.child.exitCode == null) await pause(500);
  w.evidence(`OBSERVATION WINDOW END; TRAE_HOME root: ${w.listTraeHome()}`);

  const windowScreens = w.screens.filter(s => s.at >= sentAt);
  const typed = windowScreens.find(s => s.text.includes(marker) || s.text.includes('Reply with just'));
  // B: printable keystrokes reach the picker as commands (space toggles the
  // checkbox, digits pick a row), so "typed into" shows as a changed selection
  // rather than as visible text.
  const legacySelection = (t: string) => /Selected (\d+) of \d+ item/.exec(t)?.[1];
  // The menu frame that was up when the message went out (same-millisecond
  // capture counts as "before": blockerShown already proved the menu is up).
  const selectionBefore = legacySelection(w.screens.filter(s => s.at <= sentAt && isLegacyMenu(s.text)).at(-1)?.text ?? '');
  const advanced = windowScreens.find(s => scenario === 'hooks'
    ? (isHookBrowser(s.text) || isHookDetail(s.text) || isComposer(s.text))
    : (!isLegacyMenu(s.text) || legacySelection(s.text) !== selectionBefore));
  const stuck = w.of('stuck_warning');
  const stuckInBudget = stuck.filter(e => e.at - sentAt <= STUCK_WARNING_BUDGET_MS && typeof e.m.matchedPattern === 'string' && e.m.matchedPattern.length > 0);

  // Contract 1: nothing typed into / no self-advance of the blocker menu.
  expect.soft(typed ? `+${((typed.at - sentAt) / 1000).toFixed(1)}s after send:\n${typed.text}` : null,
    'IM message text was typed into the blocker screen').toBeNull();
  expect.soft(advanced ? `+${((advanced.at - sentAt) / 1000).toFixed(1)}s after send:\n${advanced.text}` : null,
    'blocker menu advanced without a card click').toBeNull();
  // Contract 2: exactly one stuck_warning naming the page type within budget.
  expect.soft(stuck.length, `stuck_warning count (got ${stuck.map(e => summarize(e.m)).join(' | ') || 'none'})`).toBe(1);
  expect.soft(stuckInBudget.length, 'stuck_warning with non-empty matchedPattern within 60s of the message').toBe(1);

  // Contract 3: simulated card click (Esc), repeated until the composer is back.
  const warning = stuckInBudget[0]?.m ?? stuck[0]?.m;
  expect(warning, `no stuck_warning to click; evidence ${w.evidencePath}`).toBeTruthy();
  if (!warning) return;
  let nonce = 1;
  for (; nonce <= 4; nonce++) {
    const latest = w.of('stuck_warning').at(-1)!.m;
    w.evidence(`SEND tui_keys Escape nonce=${nonce} page=${latest.matchedPattern}`);
    w.child.send({
      type: 'tui_keys', keys: ['Escape'], isFinal: true, stuckNonce: nonce,
      stuckCliLifetime: latest.cliLifetime, stuckPageType: latest.matchedPattern ?? '',
    } satisfies DaemonToWorker);
    const n = nonce;
    await w.waitFor(() => w.messages.some(e => (e.m.type === 'tui_keys_delivered' && e.m.nonce === n)
      || (e.m.type === 'stuck_warning_expired' && e.m.nonce === n)), `tui_keys reply nonce=${n}`, 10_000);
    await pause(3000);
    if (isComposer(w.screens.at(-1)?.text ?? '')) break;
  }
  expect(w.of('tui_keys_delivered').some(e => e.m.nonce === 1), 'tui_keys_delivered for the first card click').toBe(true);

  const historyPath = join(w.traeHome, 'cli', 'history.jsonl');
  const delivered = await w.waitFor(() => {
    try { return readFileSync(historyPath, 'utf8').includes(marker); } catch { return false; }
  }, 'held message recorded in history.jsonl', 60_000);
  expect(delivered, `held message never reached TRAE history; evidence ${w.evidencePath}`).toBe(true);
}

describe.runIf(enabled)('traex blocker screens with hook-trust bypass off (real worker)', () => {
  it('A: Hooks need review — holds the message, raises one stuck card, Esc delivers', async () => {
    await runScenario('hooks');
  }, 420_000);

  it('B: Legacy TRAE CLI data detected — holds the message, raises one stuck card, Esc delivers', async () => {
    await runScenario('legacy');
  }, 420_000);
});
