/**
 * Real-worker e2e: Codex hook-review screen vs. an IM message (RED until fixed).
 *
 * Reproduces the reported topics: the operator turned the Codex hook-trust
 * bypass toggle OFF (`dashboard.bypassCodexHookTrust=false` in the global
 * config), so a new/changed hook makes codex ≥0.16x open its startup
 * "Hooks need review" three-choice menu — typically ~1–3 s AFTER the normal
 * composer was already drawn. The first IM message arrives as soon as the
 * topic exists.
 *
 * Real pieces: src/worker.ts over its daemon IPC, the real `codex` binary, the
 * real tmux backend (on the fenced private TMUX_TMPDIR, `-L botmux`).
 * No model traffic: the isolated $HOME/.codex points codex at a dead local
 * provider (127.0.0.1:9), so no login is needed and nothing leaves the host.
 * A submitted message is still recorded in CODEX_HOME/history.jsonl and, as a
 * user-role response_item, in the rollout under CODEX_HOME/sessions — that is
 * the delivery evidence.
 *
 * Desired contract (IPC-level; this file is expected to FAIL on current master):
 *   1. While a hook-review page is visible, the worker types nothing into it:
 *      the startup menu stays put (no message fragment on screen, it did not
 *      advance to the Hooks browser by itself).
 *   2. Exactly one `stuck_warning` with a non-empty `matchedPattern` (page
 *      type) within 60 s of the message.
 *   3. The simulated card click (`tui_keys` Escape with the stuck fields) is
 *      acknowledged with `tui_keys_delivered`, and the held message is then
 *      delivered exactly once (history.jsonl + rollout).
 *
 * Scratch root: $BOTMUX_E2E_SCRATCH_ROOT (default os.tmpdir()).
 * Run: bunx vitest run --project e2e test/codex-hook-review-card.e2e.ts
 * Evidence (IPC/log/screen timeline per case) is written under
 * $BOTMUX_E2E_EVIDENCE_DIR (default: <scratch>/evidence, deleted with the scratch
 * unless BOTMUX_E2E_KEEP_EVIDENCE=1).
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { killWorkerTmuxSession, workerTmuxArgs } from './helpers/worker-tmux-session.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

function codexVersion(): [number, number, number] | null {
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch { return null; }
}
const CODEX_VERSION = codexVersion();
// The startup "Hooks need review" menu with the `enter confirm · esc skip`
// footer is the codex ≥0.160 shape this file targets.
const CODEX_SUPPORTED = !!CODEX_VERSION && CODEX_VERSION[0] === 0 && CODEX_VERSION[1] >= 160;

const STUCK_DEADLINE_MS = 60_000;

// ─── Screen classifiers (test-side, from captured codex 0.164 screens) ──────

/** Bottom `n` non-blank-trailing lines (capture-pane pads the pane with blanks). */
const lastLines = (screen: string, n = 40) => {
  const lines = screen.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join('\n');
};
const isStartupMenu = (s: string) => /Hooks need review/.test(s)
  && /1\.\s+Review hooks/.test(s) && /enter confirm · esc skip/.test(lastLines(s));
const isHooksBrowser = (s: string) => /t trust all · enter review · esc close|t trust · esc back/.test(lastLines(s));
const isComposer = (s: string) => /Ask Codex to do anything/.test(lastLines(s, 12))
  && !isStartupMenu(s) && !isHooksBrowser(s);

/** Message text without digits (a `2` would pick "Trust all") or t/j/k/q. */
function makeMarker(): string {
  const alphabet = 'BCDFGHLMNPRSVWXZ';
  let tail = '';
  for (let i = 0; i < 10; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `HRPROBE${tail}`;
}
/** Any 5-char slice of the marker visible on screen = the worker typed into it. */
function screenHasMarkerFragment(screen: string, marker: string): boolean {
  for (let i = 0; i + 5 <= marker.length; i++) if (screen.includes(marker.slice(i, i + 5))) return true;
  return false;
}

interface Scenario { name: string; hookEvent: 'SessionStart' | 'PreToolUse'; timing: 'immediate' | 'after-prompt-ready' }
const SCENARIOS: Scenario[] = [
  { name: 'A1 SessionStart hook, message right after init', hookEvent: 'SessionStart', timing: 'immediate' },
  { name: 'A2 SessionStart hook, message after prompt_ready', hookEvent: 'SessionStart', timing: 'after-prompt-ready' },
  { name: 'B1 PreToolUse hook, message right after init', hookEvent: 'PreToolUse', timing: 'immediate' },
  { name: 'B2 PreToolUse hook, message after prompt_ready', hookEvent: 'PreToolUse', timing: 'after-prompt-ready' },
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

/** Kill only the codex app-server daemon THIS case's CODEX_HOME spawned: its
 * argv[0] lives under <CODEX_HOME>/packages, which is unique to this run. */
function killOwnCodexDaemons(codexHome: string): void {
  let out = '';
  try { out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5000 }); } catch { return; }
  const prefix = join(codexHome, 'packages') + '/';
  const pids = out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\S+)/))
    .filter((m): m is RegExpMatchArray => !!m && m[2].startsWith(prefix)).map(m => Number(m[1]));
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids) { try { process.kill(pid, sig); } catch { /* gone */ } }
    if (sig === 'SIGTERM') execFileSync('sleep', ['1.5']);
  }
}

function writeCodexHome(codexHome: string, project: string, hookEvent: Scenario['hookEvent']): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "gpt-6.1-sol"',
    'model_provider = "e2e_dead"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.e2e_dead]',
    'name = "botmux e2e dead provider"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[features]',
    'hooks = true',
    '',
    `[projects.${JSON.stringify(project)}]`,
    'trust_level = "trusted"',
    '',
    // Keep codex's one-shot model NUX/migration pickers out of the way; they
    // would otherwise also eat the first keystrokes.
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    '[notice.model_migrations]',
    '"gpt-5.5" = "gpt-6.1-sol"',
    '[tui.model_availability_nux]',
    '"gpt-5.5" = 4',
    '"gpt-5.6-sol" = 4',
    'gpt-6-astra = 4',
    '"gpt-6.1-sol" = 4',
    '',
  ].join('\n'));
  const hook = { type: 'command', command: `echo botmux-e2e-${hookEvent}-hook`, timeout: 5 };
  const entry = hookEvent === 'PreToolUse' ? { matcher: 'Bash', hooks: [hook] } : { hooks: [hook] };
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { [hookEvent]: [entry] } }, null, 2));
}

function codexDelivered(codexHome: string, marker: string): { history: number; rollout: number } {
  const historyPath = join(codexHome, 'history.jsonl');
  const history = existsSync(historyPath)
    ? readFileSync(historyPath, 'utf8').split('\n').filter(l => l.includes(marker)).length : 0;
  let rollout = 0;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        // The conversation item codex records for a submitted prompt is the
        // user-role `response_item/message`. The legacy `event_msg/user_message`
        // is not written by codex 0.164 for a turn that never reaches the model
        // (the dead provider here): the rollout carries the prompt only as that
        // response_item plus an `event_msg/item_completed`.
        rollout += readFileSync(p, 'utf8').split('\n').filter(l => {
          if (!l.includes(marker)) return false;
          try {
            const rec = JSON.parse(l) as { type?: string; payload?: { type?: string; role?: string } };
            return rec.type === 'response_item' && rec.payload?.type === 'message' && rec.payload.role === 'user';
          } catch { return false; }
        }).length;
      }
    }
  };
  walk(join(codexHome, 'sessions'));
  return { history, rollout };
}

/** One line per history/rollout record (file, record type, payload type) —
 *  evidence for where codex did / did not persist the delivered message. */
function codexRecordSummary(codexHome: string, marker: string): string[] {
  const out: string[] = [];
  const describe = (file: string) => {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } };
        const role = rec.payload?.role ? `(${rec.payload.role})` : '';
        out.push(`${file.slice(codexHome.length + 1)} ${rec.type ?? '?'}${rec.payload?.type ? `/${rec.payload.type}` : ''}${role}${line.includes(marker) ? ' [marker]' : ''}`);
      } catch { out.push(`${file.slice(codexHome.length + 1)} <unparsed ${line.length}B>`); }
    }
  };
  try {
    if (existsSync(join(codexHome, 'history.jsonl'))) describe(join(codexHome, 'history.jsonl'));
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) { out.push(`${p.slice(codexHome.length + 1)} (${readFileSync(p).length}B)`); describe(p); }
      }
    };
    walk(join(codexHome, 'sessions'));
  } catch (err) { out.push(`<unreadable: ${String(err)}>`); }
  return out;
}

function summarize(m: WorkerToDaemon): string {
  const o = m as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'type') continue;
    if (typeof v === 'string') parts.push(`${k}=${JSON.stringify(v.length > 160 ? `${v.slice(0, 160)}…(${v.length})` : v)}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    else if (v !== undefined) parts.push(`${k}=<${Array.isArray(v) ? 'array' : typeof v}>`);
  }
  return `${o.type} ${parts.join(' ')}`;
}

const LOG_KEYS = /Hook review menu|Holding|Quarantined input|Submit failure diagnosis|startup is blocked|StuckDetector|stuck|prompt ready|Prompt ready|first prompt|First prompt|flush|Writing|wrote|submit|TUI keys|hook/i;

describe.skipIf(!CODEX_SUPPORTED)('Codex hook-review screen through the real worker (bypassCodexHookTrust=false)', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const t0 = Date.now();
      const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
      const timeline: string[] = [];
      const note = (s: string) => timeline.push(`${ts()} ${s}`);

      const root = realpathSync(mkdtempSync(join(process.env.BOTMUX_E2E_SCRATCH_ROOT || tmpdir(), 'bmx-codex-hookrev-')));
      const home = join(root, 'home');
      // The worker scrubs CODEX_HOME at boot for non-isolated sessions, so codex
      // uses its stock default $HOME/.codex — exactly like a production bot.
      const codexHome = join(home, '.codex');
      const project = join(root, 'project');
      const dataDir = join(root, 'data');
      for (const d of [home, project, dataDir]) mkdirSync(d, { recursive: true });
      writeCodexHome(codexHome, project, sc.hookEvent);
      const globalConfig = join(root, 'botmux-config.json');
      // Exactly what the operator's dashboard toggle writes.
      writeFileSync(globalConfig, JSON.stringify({ dashboard: { bypassCodexHookTrust: false } }));

      const marker = makeMarker();
      const sessionId = randomUUID();
      const tmuxName = TmuxBackend.sessionName(sessionId);
      const { TMUX: _tmux, TMUX_PANE: _pane, ...inherited } = process.env;
      const env: NodeJS.ProcessEnv = {
        ...inherited,
        HOME: home,
        BOTMUX_GLOBAL_CONFIG_FILE: globalConfig,
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
        LARK_APP_ID: 'app_codex_hookrev_e2e', LARK_APP_SECRET: 'test-secret',
      };
      const tmuxArgs = workerTmuxArgs(env);
      const capture = (): string => {
        try {
          return execFileSync('tmux', [...tmuxArgs, 'capture-pane', '-p', '-t', tmuxName], { encoding: 'utf8', timeout: 3000, env });
        } catch { return ''; }
      };

      const messages: Array<{ at: number; m: WorkerToDaemon }> = [];
      const logBuf: string[] = [];
      const screens: Array<{ at: string; text: string }> = [];
      let lastScreen = '';
      const recordScreen = () => {
        const s = capture();
        const trimmed = s.split('\n').map(l => l.trimEnd()).filter(Boolean).join('\n');
        if (trimmed && trimmed !== lastScreen) {
          lastScreen = trimmed;
          const kind = isStartupMenu(s) ? 'STARTUP-MENU' : isHooksBrowser(s) ? 'HOOKS-BROWSER' : isComposer(s) ? 'COMPOSER' : 'OTHER';
          screens.push({ at: ts(), text: trimmed });
          note(`screen ${kind}: ${trimmed.split('\n').slice(-6).join(' | ').slice(0, 400)}`);
        }
        return s;
      };

      const child: ChildProcess = spawnTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let screenTimer: ReturnType<typeof setInterval> | undefined;
      const evidenceDir = process.env.BOTMUX_E2E_EVIDENCE_DIR || join(root, 'evidence');
      cleanups.push(async () => {
        if (screenTimer) clearInterval(screenTimer);
        try {
          mkdirSync(evidenceDir, { recursive: true });
          const file = join(evidenceDir, `${sc.name.split(' ')[0]}.txt`);
          writeFileSync(file, [
            `# ${sc.name} (codex ${CODEX_VERSION?.join('.')})`,
            '## timeline', ...timeline,
            '## screens', ...screens.map(s => `--- ${s.at}\n${s.text}`),
            '## codex records', ...codexRecordSummary(codexHome, marker),
            '## worker log', logBuf.join(''),
          ].join('\n'));
        } catch { /* evidence is best effort */ }
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(r => child.once('exit', () => r()));
          if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
          await Promise.race([exited, pause(3000)]);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        killWorkerTmuxSession(tmuxName, env);
        killOwnCodexDaemons(codexHome);
        // Evidence outside the scratch root survives; otherwise keep it only on request.
        if (process.env.BOTMUX_E2E_EVIDENCE_DIR || process.env.BOTMUX_E2E_KEEP_EVIDENCE !== '1') {
          rmSync(root, { recursive: true, force: true });
        } else {
          for (const d of [home, project, dataDir]) rmSync(d, { recursive: true, force: true });
        }
      });

      child.on('message', raw => {
        const m = raw as WorkerToDaemon;
        messages.push({ at: Date.now(), m });
        if (m.type !== 'screen_update') note(`ipc ${summarize(m)}`);
      });
      const onLog = (b: Buffer) => {
        const text = b.toString();
        logBuf.push(text);
        for (const line of text.split('\n')) if (line.trim() && LOG_KEYS.test(line)) note(`log ${line.trim().slice(0, 300)}`);
      };
      child.stdout?.on('data', onLog);
      child.stderr?.on('data', onLog);

      const waitFor = async (cond: () => boolean, what: string, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (!cond()) {
          if (Date.now() >= deadline || child.exitCode != null) { note(`wait-timeout: ${what}`); return false; }
          await pause(250);
        }
        return true;
      };
      const of = <T extends WorkerToDaemon['type']>(type: T) =>
        messages.filter(x => x.m.type === type).map(x => x.m as Extract<WorkerToDaemon, { type: T }>);
      const dump = () => `\n--- timeline (${sc.name}) ---\n${timeline.join('\n')}\n--- last screen ---\n${capture()}`;

      child.send({
        type: 'init', sessionId, chatId: 'oc_codex_hookrev_e2e', chatType: 'group', rootMessageId: 'om_root',
        workingDir: project, cliId: 'codex', backendType: 'tmux', prompt: '', apiOnly: true,
        larkAppId: 'app_codex_hookrev_e2e', larkAppSecret: 'test-secret',
      } satisfies DaemonToWorker);
      note('init sent');
      screenTimer = setInterval(recordScreen, 500);

      const sendMessage = () => {
        child.send({ type: 'message', content: marker, turnId: 'om_turn_1' } satisfies DaemonToWorker);
        note(`message sent (${marker})`);
      };
      if (sc.timing === 'immediate') sendMessage();
      expect(await waitFor(() => of('ready').length > 0, 'worker ready', 60_000), `worker never reported ready${dump()}`).toBe(true);
      // Follow-up shape: the daemon dispatches the next message once the worker
      // reports prompt_ready (which it does while the startup menu is up).
      if (sc.timing === 'after-prompt-ready') {
        expect(await waitFor(() => of('prompt_ready').length > 0, 'prompt_ready', 60_000), `worker never reported prompt_ready${dump()}`).toBe(true);
        sendMessage();
      }
      const sentAt = Date.now();

      // Precondition: codex really shows its startup hook-review menu.
      const menuSeen = await waitFor(() => isStartupMenu(recordScreen()), 'startup hook-review menu', 30_000);
      expect(menuSeen, `codex never showed "Hooks need review" — precondition not met${dump()}`).toBe(true);

      // ── 1. Nothing typed into the hook-review page ──────────────────────
      // Give the worker its full flush window (ready-settle + idle) to act.
      await pause(10_000);
      const afterHold = recordScreen();
      const preClick = codexDelivered(codexHome, marker);
      note(`check1 startupMenu=${isStartupMenu(afterHold)} browser=${isHooksBrowser(afterHold)} composer=${isComposer(afterHold)} fragment=${screenHasMarkerFragment(afterHold, marker)} history=${preClick.history} rollout=${preClick.rollout}`);
      expect.soft(isHooksBrowser(afterHold), `screen advanced to the Hooks browser by itself (an Enter landed on "Review hooks")${dump()}`).toBe(false);
      expect.soft(isStartupMenu(afterHold), `startup hook-review menu no longer visible after the message${dump()}`).toBe(true);
      expect.soft(screenHasMarkerFragment(afterHold, marker), `message text typed into the hook-review page${dump()}`).toBe(false);

      // ── 2. Exactly one stuck_warning with a page type, within 60 s ──────
      await waitFor(() => of('stuck_warning').length > 0, 'stuck_warning', Math.max(0, sentAt + STUCK_DEADLINE_MS - Date.now()));
      await pause(2_000); // a duplicate would arrive right behind the first
      const warnings = of('stuck_warning');
      expect.soft(warnings.length, `expected exactly one stuck_warning within ${STUCK_DEADLINE_MS / 1000}s of the message${dump()}`).toBe(1);
      const warning = warnings[0];
      if (!warning) throw new Error(`no stuck_warning — cannot simulate the card click${dump()}`);
      expect.soft(typeof warning.matchedPattern === 'string' && warning.matchedPattern.length > 0,
        `stuck_warning.matchedPattern must name the page type${dump()}`).toBe(true);

      // ── 3. Card click (Esc = continue without trusting) → delivery ──────
      let nonce = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = of('stuck_warning').at(-1)!;
        nonce += 1;
        const before = messages.length;
        child.send({
          type: 'tui_keys', keys: ['Escape'], isFinal: true,
          stuckNonce: nonce, stuckCliLifetime: latest.cliLifetime, stuckPageType: latest.matchedPattern,
        } satisfies DaemonToWorker);
        note(`card click #${nonce} Escape (page=${latest.matchedPattern}, lifetime=${latest.cliLifetime})`);
        await waitFor(() => messages.slice(before).some(x =>
          (x.m.type === 'tui_keys_delivered' || x.m.type === 'stuck_warning_expired') && (x.m as { nonce?: number }).nonce === nonce),
        `ack for click #${nonce}`, 10_000);
        await pause(2_000);
        if (isComposer(recordScreen())) break;
        // A deeper page needs its own card; give the detector its window.
        await waitFor(() => of('stuck_warning').length > nonce, `stuck_warning for click #${nonce + 1}`, STUCK_DEADLINE_MS);
      }
      expect(of('tui_keys_delivered').some(d => d.nonce === 1), `first card click was not delivered${dump()}`).toBe(true);
      expect(of('stuck_warning_expired').length, `a card click expired${dump()}`).toBe(0);

      const delivered = await waitFor(() => codexDelivered(codexHome, marker).history >= 1, 'message in history.jsonl', 30_000);
      await pause(2_000);
      const finalCount = codexDelivered(codexHome, marker);
      note(`final delivery history=${finalCount.history} rollout=${finalCount.rollout}`);
      expect(delivered, `held message never reached codex after the card click${dump()}`).toBe(true);
      expect(finalCount.history, `message delivered more than once${dump()}`).toBe(1);
      expect(finalCount.rollout, `rollout has no/duplicate user message item${dump()}`).toBe(1);
    }, 240_000);
  }
});
