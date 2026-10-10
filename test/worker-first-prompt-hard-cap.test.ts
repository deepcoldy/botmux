/**
 * The first-prompt HARD CAP is a real deadline — executed, not modelled.
 *
 * The ready-gate's fallback for a deferring adapter is aligned WITH that cap
 * (resolveReadySignalTimeoutMs), so both timers land in the same tick: the gate
 * release starts a PTY-quiescence settle, `flushPending()` honours
 * `isSettlingFirstFlush`, and the promised "90s hard cap" really held the first
 * queued message for 90–96s until `cancelFirstFlushSettle()` was called at the
 * cap (worker.ts, `if (forced) cancelFirstFlushSettle();`).
 *
 * test/ready-gate.test.ts only MODELS that timeline (its own `Math.min(release +
 * settle, cap)`) plus a source pin. This file runs the REAL chain instead:
 * a real worker (src/worker.ts) + PTY backend + the real dsh-tui adapter + the
 * real ready gate / settle / flushPending / adapter writeInput, against a fake
 * CLI that timestamps every input line it receives on the PTY. The assertion is
 * therefore on the observable production effect — WHEN the held first prompt is
 * actually written — not on worker state or source text.
 *
 * Three scenarios, one per promise (run concurrently; each is an independent
 * worker, so the whole file costs ~one cap instead of three):
 *   A  no signal at all, quiet PTY      → write at the cap
 *   B  no signal, PTY NEVER goes quiet  → the settle could never finish early,
 *                                          so only the cap can release the write
 *   C  a REAL ready signal at 88s, PTY never quiet → the settle it starts would
 *      run to 94s; the cap must cut it at 90s
 *
 * The pre-fix behaviour lands all three at ~96s (cap + READY_FLUSH_SETTLE_CAP_MS)
 * and the window below fails loudly on it.
 *
 * The cap itself is a compiled constant (CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS =
 * 90_000, src/utils/codex-app-control.ts) and is NOT env-scalable — `BOTMUX_TIME_SCALE`
 * only affects adapter delays — so this file pays the real wall clock.
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

/** Production constant under test (worker.ts: FIRST_PROMPT_HARD_TIMEOUT_MS). */
const HARD_CAP_MS = 90_000;
/** Lower bound: nothing may release the held prompt before the cap (the aligned
 *  gate fallback and the hard timer are the only clocks left). */
const WRITE_NOT_BEFORE_MS = 89_000;
/** Upper bound: the cap may not grow by the settle. The pre-fix value is
 *  cap + READY_FLUSH_SETTLE_CAP_MS (6s) ≈ 96.2s, so this clearly separates. */
const WRITE_NOT_AFTER_MS = 93_500;

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

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

interface Scenario {
  name: string;
  /** Continuously repaint the PTY so the post-release settle can never finish
   *  early (dsh-tui's own blinking cell is exactly this shape). */
  chattyPty: boolean;
  /** Send the real `session_ready` signal this many ms after the gate was armed. */
  signalAtMs?: number;
}

interface ScenarioRun {
  name: string;
  /** Epoch ms the fake CLI received the line carrying the probe prompt. */
  firstProbeWriteAtMs: number;
  /** Epoch ms the test observed the worker's "Ready gate armed" log line. */
  gateArmedAtMs: number;
  offsetMs: number;
  logs: string;
  child: ChildProcess;
}

/** Fake dsh-tui: records every input LINE with a receipt timestamp, so the
 *  instant the worker's first prompt reached the PTY is observable. `chatty`
 *  keeps repainting (its blinking cursor) so quiescence is never reached. */
function fakeCliScript(): string {
  return [
    '#!/bin/sh',
    'if [ "$CHATTY" = 1 ]; then',
    "  ( while :; do printf '\\033[?25l .'; sleep 0.2; done ) &",
    'fi',
    'while IFS= read -r line; do',
    '  printf \'%s %s\\n\' "$(date +%s%3N)" "$line" >> "$HOME/cli-input.log"',
    'done',
    'wait',
    '',
  ].join('\n');
}

const PROBE_TIMEOUT_MS = 150_000;

async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const root = mkdtempSync(join(tmpdir(), 'botmux-hard-cap-'));
  tempDirs.add(root);
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, fakeCliScript());
  chmodSync(fakeCli, 0o755);
  const inputLog = join(root, 'cli-input.log');
  const probe = `hard-cap-probe-${scenario.name.split(':')[0]!.trim()}`;

  const logs: string[] = [];
  const sessionId = `hardcap${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  // Node, not "whatever runs this file": the whole point here is a real PTY, and
  // node-pty's `tty.ReadStream` closes the master on the first EAGAIN read under
  // Bun — the kernel then SIGHUPs the fake CLI ~5ms after spawn, so the held
  // prompt could never be received by it. See `nodeTsRunnerPrefix` in
  // test/helpers/ts-runner.ts.
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_CHATTY: scenario.chattyPty ? '1' : '0',
      LARK_APP_ID: 'app_hard_cap',
      LARK_APP_SECRET: 'secret',
      CHATTY: scenario.chattyPty ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => logs.push(chunk));
  }
  const messages: WorkerToDaemon[] = [];
  child.on('message', raw => messages.push(raw as WorkerToDaemon));

  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_hard_cap',
    rootMessageId: 'om_hard_cap',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: `turn-${scenario.name}-init`,
    larkAppId: 'app_hard_cap',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  const logHas = (needle: string): boolean => logs.join('').includes(needle);
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`[${scenario.name}] worker exited early\n${logs.join('')}`);
    }
    if (logHas('Ready gate armed') && messages.some(message => message.type === 'ready')) break;
    await delay(25);
  }
  if (!logHas('Ready gate armed')) {
    throw new Error(`[${scenario.name}] the ready gate was never armed\n${logs.join('')}`);
  }
  const gateArmedAtMs = Date.now();

  // The first queued prompt: held by the gate until the cap (or the signal).
  child.send({
    type: 'message',
    content: probe,
    turnId: `turn-${scenario.name.split(':')[0]!.trim()}`,
  } satisfies DaemonToWorker);
  if (scenario.signalAtMs !== undefined) {
    void (async () => {
      await delay(Math.max(0, gateArmedAtMs + scenario.signalAtMs! - Date.now()));
      child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
    })();
  }

  // Wait for the probe to actually land on the PTY, then read its receipt stamp.
  let firstProbeWriteAtMs: number | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`[${scenario.name}] worker exited before the first write\n${logs.join('')}`);
    }
    if (existsSync(inputLog)) {
      const line = readFileSync(inputLog, 'utf8').split('\n').find(entry => entry.includes(probe));
      if (line) {
        firstProbeWriteAtMs = Number(line.slice(0, line.indexOf(' ')));
        break;
      }
    }
    await delay(50);
  }
  if (firstProbeWriteAtMs === undefined || !Number.isFinite(firstProbeWriteAtMs)) {
    throw new Error(`[${scenario.name}] the held first prompt was never written\n${logs.join('')}`);
  }
  return {
    name: scenario.name,
    firstProbeWriteAtMs,
    gateArmedAtMs,
    offsetMs: firstProbeWriteAtMs - gateArmedAtMs,
    logs: logs.join(''),
    child,
  };
}

describe('worker first-prompt hard cap — real chain (worker + PTY + dsh-tui adapter)', () => {
  it('writes the held first prompt at the 90s cap in every gate scenario', async () => {
    const runs = await Promise.all([
      runScenario({ name: 'A: no signal, quiet PTY', chattyPty: false }),
      runScenario({ name: 'B: no signal, PTY never quiet', chattyPty: true }),
      runScenario({ name: 'C: real ready signal at 88s, PTY never quiet', chattyPty: true, signalAtMs: 88_000 }),
    ]);

    for (const run of runs) {
      // Raw evidence for the report (also captured in the redirected log).
      console.info(`[hard-cap] ${run.name}: first PTY write at cap + ${run.offsetMs - HARD_CAP_MS}ms`
        + ` (offset ${run.offsetMs}ms)`);

      // ① The write really happened, at the cap. Nothing released the held
      // prompt earlier, and the cap did not grow by the settle (pre-fix ≈96.2s).
      expect(run.offsetMs, `${run.name}: held prompt released before the cap`).toBeGreaterThanOrEqual(WRITE_NOT_BEFORE_MS);
      expect(run.offsetMs, `${run.name}: the cap grew by the settle (pre-fix = 96s)`).toBeLessThanOrEqual(WRITE_NOT_AFTER_MS);
      // ② …and the worker really held it: the prompt was queued, never written
      // before the cap (measured above), and the release needed the cap's branch.
      expect(run.logs, `${run.name}: the first prompt was never queued`).toContain('Queued message (1 pending)');
      expect(run.logs, `${run.name}: the cap's own path never ran`).toMatch(
        /Ready gate released \((?:signal timeout fallback|SessionStart hook)\)|First prompt hard timeout — releasing ready gate before the hard-cap flush/,
      );
    }

    const [quiet, chatty, lateSignal] = runs;
    // A (quiet PTY): at the cap the PTY has already been silent for > the
    // settle's quiescence window, so the settle completes in the same tick —
    // this scenario pins "the cap is still a real 90s release" but NOT the
    // cancellation. Only a PTY that keeps repainting (or an earlier signal)
    // leaves a settle pending at the cap; that is what B and C assert.
    expect(quiet!.logs, 'A: the quiet-PTY release must not need the cancellation').not.toContain(
      'First prompt hard timeout — cancelling the pending ready-gate settle (cap is the deadline)',
    );

    // B: the settle would have run to its full 6s cap — the only way to write at
    // the cap is the cancellation under test.
    expect(chatty!.logs, 'B: pending settle was not cancelled at the cap').toContain(
      'First prompt hard timeout — cancelling the pending ready-gate settle (cap is the deadline)',
    );
    expect(chatty!.offsetMs, 'B: continuous PTY output pushed the write past the cap').toBeLessThanOrEqual(WRITE_NOT_AFTER_MS);

    // C: the real signal DID release the gate at ~88s, and its settle was then
    // cut by the cap instead of running to ~94s.
    expect(lateSignal!.logs, 'C: the real ready signal never released the gate').toContain('Ready gate released (SessionStart hook');
    expect(lateSignal!.logs, 'C: the cap did not cancel the signal-started settle').toContain(
      'First prompt hard timeout — cancelling the pending ready-gate settle (cap is the deadline)',
    );
    expect(lateSignal!.offsetMs, 'C: the settle started by the real signal outlived the cap').toBeLessThanOrEqual(WRITE_NOT_AFTER_MS);
  }, 200_000);
});
