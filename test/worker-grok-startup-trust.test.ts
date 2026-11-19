/**
 * Grok Build ≥1.0.64 stops on "Do you trust the contents of this directory?"
 * in an untrusted folder. On 2026-10-24 a scheduled Grok task sat on that
 * dialog: botmux had not pre-trusted the folder, the structured bridge gave up
 * 20s after spawn with "sent to Grok Build but the transcript never showed this
 * turn", and the 90s hard cap would have forced queued input into the dialog.
 *
 * Real chain, not a model of it: the real worker (src/worker.ts) on a real PTY
 * with the real Grok adapter, against a fake `grok` that applies Grok's own
 * rule — read $GROK_HOME/trusted_folders.toml for its realpath'd cwd at
 * startup, show the trust dialog unless it says `trusted = true`, and only
 * then open a composer (here: once the "human" answers, i.e. a marker file
 * appears). Every input line the fake receives is timestamped.
 *
 * Wall clock is real (the 15s soft / 90s hard first-prompt timers are compiled
 * constants), so the scenarios run concurrently.
 */
import { type ChildProcess } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const delay = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/** Fake Grok: Grok's trust rule, its dialog text, then a `❯` composer. */
function fakeGrokScript(): string {
  return [
    '#!/bin/sh',
    'case "$1" in --version|-v) echo "1.0.67 (fake)"; exit 0;; esac',
    'cwd=$(pwd -P)',
    // Background reader: every input line, timestamped, from the first byte on.
    // Without job control an async list's stdin is /dev/null (and `<&0` would
    // dup that), so hand it the PTY through a saved descriptor.
    'exec 3<&0',
    '( while IFS= read -r line; do printf \'%s %s\\n\' "$(date +%s%3N)" "$line" >> "$HOME/cli-input.log"; done ) <&3 &',
    'state=$(awk -v key="[folders.\\"$cwd\\"]" \'$0==key{f=1;next} /^\\[/{f=0} f && $1=="trusted"{print $3; exit}\' "$GROK_HOME/trusted_folders.toml" 2>/dev/null)',
    'echo "${state:-missing}" > "$HOME/trust-at-start"',
    // Stuck somewhere no rule knows (e.g. a slow plugin load): never a composer.
    'if [ "$FAKE_STUCK_LOADING" = 1 ]; then printf \'  Loading workspace plugins\\n\'; wait; exit 0; fi',
    'if [ "$state" != "true" ]; then',
    '  printf \'%s\\n\' "          Do you trust the contents of this directory?" "          $cwd" \\',
    '    "          Grok Build may run or modify contents in this directory," "          posing security risks." \\',
    '    "          Yes, proceed                 y" "          No, quit                     n"',
    '  while [ ! -f "$HOME/answer-yes" ]; do sleep 0.2; done',
    '  printf \'\\033[2J\\033[H\'',
    'fi',
    "printf '\\n  ╭──────────────╮\\n  │ ❯            │\\n  ╰──────────────╯\\n'",
    'wait',
    '',
  ].join('\n');
}

const OTHER_ENTRIES = '# kept verbatim\n[folders."/root/iserver"]\ntrusted = true\ndecided_at = 1789661312\n';

interface Run {
  root: string;
  work: string;
  store: string;
  child: ChildProcess;
  logs: string[];
  notices: string[];
  logText: () => string;
}

function startWorker(
  name: string,
  storeText: (work: string) => string,
  init: Partial<Extract<DaemonToWorker, { type: 'init' }>>,
  extraEnv: Record<string, string> = {},
): Run {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `bmx-grok-startup-${name}-`)));
  tempDirs.add(root);
  const work = join(root, 'ec-apply-access');
  mkdirSync(work);
  const grokHome = join(root, 'grok-home');
  mkdirSync(grokHome);
  const store = join(grokHome, 'trusted_folders.toml');
  writeFileSync(store, storeText(work), { mode: 0o600 });
  const fake = join(root, 'grok');
  writeFileSync(fake, fakeGrokScript());
  chmodSync(fake, 0o755);

  const logs: string[] = [];
  const notices: string[] = [];
  const sessionId = `grokstartup${name}${Date.now().toString(36)}`;
  // Node, not the current runtime: node-pty under Bun closes the master on the
  // first EAGAIN (see test/helpers/ts-runner.ts nodeTsRunnerPrefix).
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GROK_HOME: grokHome,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_grok_startup',
      LARK_APP_SECRET: 'secret',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => logs.push(chunk));
  }
  child.on('message', raw => {
    const message = raw as WorkerToDaemon;
    if (message.type === 'user_notify') notices.push(message.message);
  });
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_grok_startup',
    rootMessageId: 'om_grok_startup',
    workingDir: work,
    cliId: 'grok',
    cliPathOverride: fake,
    backendType: 'pty',
    prompt: '',
    larkAppId: 'app_grok_startup',
    larkAppSecret: 'secret',
    locale: 'zh',
    ...init,
  } satisfies DaemonToWorker);
  return { root, work, store, child, logs, notices, logText: () => logs.join('') };
}

async function waitFor(run: Run, what: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`worker exited while waiting for ${what}\n${run.logText()}`);
    }
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}\n${run.logText()}`);
}

const inputLines = (run: Run): string[] => {
  const path = join(run.root, 'cli-input.log');
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean) : [];
};

describe('worker × Grok folder trust — real chain (worker + PTY + Grok adapter)', () => {
  it('pre-trusts before spawn, never overrides trusted = false, and reports why startup stalled', async () => {
    // A: an ordinary new folder — must already be trusted when Grok reads the store.
    const fresh = startWorker('fresh', () => OTHER_ENTRIES, {});
    // B: the user said no — keep it, say so, report the dialog, hold the input.
    const denied = startWorker(
      'denied',
      work => `${OTHER_ENTRIES}\n[folders."${work}"]\ntrusted = false\ndecided_at = 1792810000\n`,
      {
        prompt: 'daily report probe',
        turnId: 'schedule:344c6318:probe',
        cliUpgrade: { from: '1.0.62', to: '1.0.67' },
      },
    );
    const deniedStoreBefore = readFileSync(denied.store, 'utf-8');
    // D: a store this conservative reader will not edit → pre-trust is skipped,
    // the dialog appears, and the soft timeout names the real cause.
    const unreadable = startWorker(
      'unreadable',
      () => 'folders = { "/root/iserver" = { trusted = true } }\n',
      { prompt: 'daily report probe', turnId: 'schedule:344c6318:unreadable', cliUpgrade: { from: '1.0.62', to: '1.0.67' } },
    );
    // C: trusted, but stuck on a screen no rule recognizes — no positive
    // evidence, so the normal lease and wording stay; the first-turn notice
    // names the recent upgrade.
    const stuck = startWorker(
      'stuck',
      work => `[folders."${work}"]\ntrusted = true\ndecided_at = 1\n`,
      { prompt: 'daily report probe', turnId: 'schedule:344c6318:stuck', cliUpgrade: { from: '1.0.62', to: '1.0.67' } },
      { FAKE_STUCK_LOADING: '1' },
    );

    await Promise.all([fresh, denied, unreadable, stuck].map(run => waitFor(
      run, 'the fake grok to start', () => existsSync(join(run.root, 'trust-at-start')), 60_000,
    )));

    // ── A ──────────────────────────────────────────────────────────────────
    expect(readFileSync(join(fresh.root, 'trust-at-start'), 'utf-8').trim(), 'Grok started before botmux trusted its folder').toBe('true');
    const freshStore = readFileSync(fresh.store, 'utf-8');
    expect(freshStore.startsWith(OTHER_ENTRIES), 'existing entries were rewritten').toBe(true);
    expect(freshStore.slice(OTHER_ENTRIES.length).replace(/decided_at = \d+/, 'decided_at = N'))
      .toBe(`\n[folders."${fresh.work}"]\ntrusted = true\ndecided_at = N\n`);
    expect(fresh.logText()).toContain(`[grok-trust] Pre-accepted folder trust for ${fresh.work}`);

    // ── B: at spawn ─────────────────────────────────────────────────────────
    expect(readFileSync(join(denied.root, 'trust-at-start'), 'utf-8').trim()).toBe('false');
    await waitFor(denied, 'the explicit-untrust notice', () => denied.notices.some(n => n.includes('trusted = false')), 15_000);
    expect(denied.notices.find(n => n.includes('trusted = false'))).toContain(denied.work);

    // A follow-up arrives while the dialog is up. `n…` typed into Grok's trust
    // dialog would answer "No, quit".
    const queuedAtMs = Date.now();
    denied.child.send({ type: 'message', content: 'no-thanks-followup-probe', turnId: 'turn-followup' } satisfies DaemonToWorker);

    // ── D: the soft first-prompt timeout names the real cause ───────────────
    expect(unreadable.logText()).toContain('[grok-trust] pre-trust skipped');
    await waitFor(unreadable, 'the startup-blocker notice', () => unreadable.notices.some(n => n.includes('卡在目录信任确认')), 30_000);
    expect(unreadable.notices).toHaveLength(1);
    expect(unreadable.notices[0]).toContain(unreadable.work);
    expect(unreadable.notices[0]).toContain('1.0.67');
    expect(unreadable.notices[0]).toContain('1.0.62');
    expect(readFileSync(unreadable.store, 'utf-8')).toBe('folders = { "/root/iserver" = { trusted = true } }\n');

    // ── C: unchanged timing (well inside the hard cap), plus the upgrade ────
    await waitFor(stuck, 'the transcript notice', () => stuck.notices.length > 0, 40_000);
    expect(stuck.notices).toHaveLength(1);
    expect(stuck.notices[0]).toContain('采集不到本轮回复');
    expect(stuck.notices[0]).toContain('刚升级到 1.0.67');

    // ── B: same dialog, already explained at spawn → recognized, not re-told ─
    await waitFor(denied, 'the dialog to be recognized', () => denied.logText().includes('startup is blocked on folder_trust'), 30_000);

    // ── B: past the old 20s pre-start lease, and past the 90s hard cap ──────
    await delay(Math.max(0, queuedAtMs + 95_000 - Date.now()));
    expect(denied.child.exitCode, denied.logText()).toBeNull();
    expect(
      denied.notices.filter(n => n.includes('会话记录')),
      'concluded "missing from the transcript" while Grok had never become ready',
    ).toEqual([]);
    expect(inputLines(denied), 'queued input was typed into the trust dialog').toEqual([]);
    expect(readFileSync(denied.store, 'utf-8'), 'botmux rewrote an explicit trusted = false').toBe(deniedStoreBefore);
    // One notice for one cause, and no lease-expiry conclusion while it is up.
    expect(denied.notices, 'extra notices while blocked').toHaveLength(1);
    expect(unreadable.notices, 'blocker reported more than once').toHaveLength(1);

    // ── B: someone answers in the Web terminal → held input is delivered ────
    const answeredAtMs = Date.now();
    writeFileSync(join(denied.root, 'answer-yes'), '');
    await waitFor(denied, 'the held follow-up to be delivered', () => inputLines(denied).some(l => l.includes('no-thanks-followup-probe')), 30_000);
    const deliveredAt = Number(inputLines(denied).find(l => l.includes('no-thanks-followup-probe'))!.split(' ')[0]);
    expect(deliveredAt).toBeGreaterThanOrEqual(answeredAtMs);
  }, 200_000);
});
