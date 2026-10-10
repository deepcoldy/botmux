/**
 * Worker side of the structured turn-idle channel.
 *
 * A `turn_idle` IPC may only settle the turn THIS worker believes is in flight:
 * accepting a stale/foreign report would mark a busy CLI idle and flush queued
 * input into it. These cases drive a real worker (fake CLI, PTY backend) through
 * the whole path — IPC → fence → idleDetector.fireIdle() → prompt_ready — and
 * pin the rejections as observable behaviour, not as source text.
 *
 * Steered (type-ahead) turns are therefore NOT a "newer turn is already
 * published" situation any more. Since #1781 a type-ahead write only holds the
 * attribution (`src/worker.ts:13817-13843`) and the held turn is promoted by the
 * running turn's own ready edge (`src/worker.ts:12804-12814`), so a report
 * frozen on the running turn is accepted inside that window — that is upstream
 * semantics (the idle edge is source-agnostic: `src/utils/idle-detector.ts:447-461`,
 * `:581-589`, `:665-691`). What stays guarded is the expensive direction: a
 * stale report is dropped once the newer turn IS active. See the last case.
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const TURN_ID = 'turn-idle-under-test';
const NEXT_TURN_ID = 'turn-idle-steered-next';
const STALE_TURN_ID = 'turn-idle-someone-else';

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  /** SESSION_DATA_DIR of this worker — where it publishes the active-turn
   *  marker the in-CLI reporter freezes its turn identity from. */
  root: string;
}

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

async function waitFor(
  harness: Harness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function readyCount(harness: Harness): number {
  return harness.messages.filter(message => message.type === 'prompt_ready').length;
}

/** The active-turn marker the worker publishes for the in-CLI reporter
 *  (`.botmux-cli-pids/<cli pid>`): `currentBotmuxTurnId` plus the type-ahead
 *  attributions the write path is holding on its behalf. */
interface CliPidMarker {
  sessionId?: string;
  turnId?: string;
  dispatchAttempt?: number | null;
  queuedTurnId?: string;
  queuedTurns?: Array<{ turnId?: string }>;
}

function readCliPidMarker(harness: Harness): CliPidMarker | undefined {
  const dir = join(harness.root, '.botmux-cli-pids');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as CliPidMarker;
      if (parsed?.turnId) return parsed;
    } catch { /* not a marker we can read */ }
  }
  return undefined;
}

/** The worker's own view of the active turn — `writeCliPidMarker()` publishes
 *  exactly `currentBotmuxTurnId` into this file. */
function activeTurnId(harness: Harness): string | undefined {
  return readCliPidMarker(harness)?.turnId;
}

/** Turn ids the worker still holds as un-promoted type-ahead attributions (the
 *  `queuedTurnId` / `queuedTurns` pair it writes into the same marker). */
function queuedTurnIds(harness: Harness): string[] {
  const marker = readCliPidMarker(harness);
  return [...new Set([
    ...(marker?.queuedTurnId ? [marker.queuedTurnId] : []),
    ...(marker?.queuedTurns ?? [])
      .map(entry => entry.turnId)
      .filter((id): id is string => !!id),
  ])];
}

/** `turnId` of the last `managed_turn_origin` the worker published; the daemon
 *  mirrors that one as the session's active turn identity. */
function lastManagedOriginTurnId(harness: Harness): string | undefined {
  const origins = harness.messages.filter(message => message.type === 'managed_turn_origin');
  return origins.length > 0 ? origins[origins.length - 1]!.turnId : undefined;
}

function startWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-'));
  tempDirs.add(root);
  // A CLI that boots, renders nothing and stays alive: dsh-tui's readyPattern
  // (`❯`) is therefore never seen, so the PTY-quiescence IdleDetector can never
  // fire on its own — every prompt_ready in this file must come from the
  // structured channel under test.
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(fakeCli, 0o755);

  const sessionId = `turnidle${Date.now().toString(36)}${process.pid.toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_turn_idle',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_turn_idle',
    rootMessageId: 'om_turn_idle',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: 'turn-idle-init',
    larkAppId: 'app_turn_idle',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, logs, messages, root };
}

/** Boot the worker, release the ready gate, then write one real turn so the
 *  worker is genuinely waiting on `TURN_ID` (isPromptReady=false). */
async function startWorkerWaitingOnTurn(dispatchAttempt?: number): Promise<Harness> {
  const harness = startWorker();
  await waitFor(
    harness,
    () => harness.messages.some(message => message.type === 'ready'),
    'worker readiness',
  );
  harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
  // dsh-tui is not Claude-family, so the gate release marks the CLI ready and
  // publishes prompt_ready (after its PTY-quiescence settle). Drain that edge
  // BEFORE the probe turn, so the only prompt_ready this test can observe later
  // is the structured one.
  await waitFor(
    harness,
    () => readyCount(harness) > 0,
    'ready-gate release to publish its own prompt_ready',
  );
  harness.child.send({
    type: 'message',
    content: 'structured turn idle probe',
    turnId: TURN_ID,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
  } satisfies DaemonToWorker);
  await waitFor(
    harness,
    () => harness.messages.some(
      message => message.type === 'managed_turn_origin'
        && message.turnId === TURN_ID
        && message.dispatchAttempt === dispatchAttempt,
    ),
    'the worker to publish the probe turn as its active turn',
  );
  return harness;
}

/** Assert the worker produces NO ready edge on its own in the current state, so
 *  a later prompt_ready can only have come from the structured report. The fake
 *  CLI renders nothing, so the quiescence detector has no way to fire. */
async function expectNoAutonomousReadyEdge(harness: Harness, before: number): Promise<void> {
  await delay(1200);
  expect(readyCount(harness)).toBe(before);
}

describe('worker turn-idle channel', () => {
  it('settles the matching turn (IPC → fireIdle → prompt_ready)', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);
    await expectNoAutonomousReadyEdge(harness, before);

    harness.child.send({
      type: 'turn_idle',
      turnId: TURN_ID,
      seq: 1,
      pid: process.pid,
    } satisfies DaemonToWorker);

    await waitFor(
      harness,
      () => readyCount(harness) > before,
      'prompt_ready from the structured turn-idle report',
    );
  }, 60_000);

  it('rejects a report for a different turn instead of settling the active one', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);

    harness.child.send({
      type: 'turn_idle',
      turnId: STALE_TURN_ID,
      seq: 1,
    } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (turn-mismatch)');

    // The real turn still settles afterwards — a rejected report never strands it.
    harness.child.send({ type: 'turn_idle', turnId: TURN_ID, seq: 2 } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => readyCount(harness) > before,
      'prompt_ready for the real turn after the stale report was dropped',
    );
  }, 60_000);

  it('rejects a report without a turn identity', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);

    harness.child.send({ type: 'turn_idle', seq: 1 } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (missing-turn)');
  }, 60_000);

  it('rejects a report whose dispatch attempt differs from the active turn', async () => {
    const harness = await startWorkerWaitingOnTurn(7);
    const before = readyCount(harness);

    harness.child.send({
      type: 'turn_idle',
      turnId: TURN_ID,
      dispatchAttempt: 6,
      seq: 1,
    } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (attempt-mismatch)');

    // A retry/restart of the same turn id under the NEW generation may settle:
    // the fence is on the generation, not on the turn id alone.
    harness.child.send({
      type: 'turn_idle',
      turnId: TURN_ID,
      dispatchAttempt: 7,
      seq: 2,
    } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => readyCount(harness) > before,
      'prompt_ready for the report naming the current generation',
    );
  }, 60_000);

  it('rejects a report that omits the dispatch attempt while the active turn has one', async () => {
    const harness = await startWorkerWaitingOnTurn(7);
    const before = readyCount(harness);

    harness.child.send({ type: 'turn_idle', turnId: TURN_ID, seq: 1 } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (missing-attempt)');
  }, 60_000);

  /**
   * The blocker this channel shipped with, restated for the post-#1781 worker.
   *
   * Original hazard: the turn identity was read LATER, inside the detached
   * `botmux __turn-idle-v2` child, off the worker's MUTABLE active-turn marker —
   * dsh-tui steers busy-period input, so that read could name turn B while the
   * report was about turn A. Freezing the identity inside the `agent/status`
   * callback (see the file header) is what closed it.
   *
   * What #1781 changed is WHEN a steered turn becomes the published active turn.
   * A type-ahead write no longer publishes its turn: it only holds the
   * attribution (`src/worker.ts:13817-13843`, log "Queuing type-ahead turn
   * attribution"), and the marker/capability written right after the write still
   * name the RUNNING turn (`src/worker.ts:13858-13859`). The held turn is
   * promoted by the running turn's own ready edge: `markPromptReady()` →
   * `syncQueuedTurnsFromMarkerDisk()` → `advanceQueuedTypeAheadTurn('prompt_ready')`
   * (`src/worker.ts:12804-12814`, `:4042-4058`).
   *
   * Inside that A→B window A is therefore still the worker's active turn, and
   * accepting A's frozen report is upstream semantics rather than a hole this
   * channel opened. The worker's idle edge is source-agnostic:
   * `IdleDetector.fireIdle()` → `markIdle('external')`
   * (`src/utils/idle-detector.ts:447-461`) and the OSC-7501/screen sources
   * (`:665-691`) share the single `markIdle` → `idleCallback` path (`:581-589`,
   * registered at `src/worker.ts:19560`, reaching `markPromptReady()` at
   * `:12668`/`:19678`), so any of them promotes B at that point.
   *
   * The expensive direction is what must stay pinned: once B IS the active turn,
   * a stale report still frozen on A (duplicate or delayed delivery from the
   * detached child) must be dropped before it can settle B early. That is the
   * last step below.
   */
  it('settles A inside the steer window, then drops a stale A report once B is active', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);

    // A is the published, in-flight turn: marker, daemon-visible origin and the
    // type-ahead queue all agree.
    expect(activeTurnId(harness)).toBe(TURN_ID);
    expect(lastManagedOriginTurnId(harness)).toBe(TURN_ID);
    expect(queuedTurnIds(harness)).toEqual([]);

    // Steer turn B while A is in flight. The write is type-ahead: B must NOT be
    // published — the worker keeps naming A and only holds B as an attribution.
    harness.child.send({
      type: 'message',
      content: 'steered follow-up',
      turnId: NEXT_TURN_ID,
    } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.logs.join('').includes(
        `Queuing type-ahead turn attribution: active=${TURN_ID.slice(0, 12)}, queued=${NEXT_TURN_ID.slice(0, 12)}`,
      ),
      'the worker to hold the steered turn as a type-ahead attribution',
    );
    // Give a late publish a chance to appear before asserting its absence.
    await delay(1500);
    expect(activeTurnId(harness)).toBe(TURN_ID);
    expect(lastManagedOriginTurnId(harness)).toBe(TURN_ID);
    expect(queuedTurnIds(harness)).toEqual([NEXT_TURN_ID]);
    expect(readyCount(harness)).toBe(before);

    // Turn A's idle event, frozen at the moment A ended, now reaches the worker.
    // A is still the active turn, so the fence accepts it and the ready edge it
    // produces promotes the held B — upstream's own promotion path.
    harness.child.send({ type: 'turn_idle', turnId: TURN_ID, seq: 2 } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => readyCount(harness) > before,
      "prompt_ready from turn A's frozen report inside the steer window",
    );
    expect(harness.logs.join('')).toContain(`Turn-idle report accepted (turn=${TURN_ID} seq=2`);
    expect(harness.logs.join('')).toContain(
      `Advanced active turn (prompt_ready): ${TURN_ID.slice(0, 12)} -> ${NEXT_TURN_ID.slice(0, 12)} (remaining queued: 0)`,
    );
    expect(activeTurnId(harness)).toBe(NEXT_TURN_ID);
    expect(lastManagedOriginTurnId(harness)).toBe(NEXT_TURN_ID);
    expect(queuedTurnIds(harness)).toEqual([]);

    // B was retired by that same edge, so B's own end-of-turn report is a no-op:
    // the fence refuses it as `already-ready` once `promptReady` is set
    // (src/utils/turn-idle-report.ts:99) and `fireIdle()` is idempotent
    // (src/utils/idle-detector.ts:447-448) — no second ready edge.
    const afterPromotion = readyCount(harness);
    harness.child.send({ type: 'turn_idle', turnId: NEXT_TURN_ID, seq: 3 } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.logs.join('').includes(
        `Ignoring turn-idle report (already-ready) turn=${NEXT_TURN_ID}`,
      ),
      "the worker to treat B's own report as already settled",
    );
    expect(readyCount(harness)).toBe(afterPromotion);

    // The original blocker, in its post-#1781 form: B is the active turn now, so
    // a stale report still frozen on A must be dropped — it must not settle B or
    // publish any further ready edge.
    harness.child.send({ type: 'turn_idle', turnId: TURN_ID, seq: 4 } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.logs.join('').includes(
        `Ignoring turn-idle report (turn-mismatch) turn=${TURN_ID}`,
      ),
      'the worker to drop the stale A report once B is active',
    );
    await delay(1500);
    expect(readyCount(harness)).toBe(afterPromotion);
    expect(activeTurnId(harness)).toBe(NEXT_TURN_ID);
    expect(lastManagedOriginTurnId(harness)).toBe(NEXT_TURN_ID);
  }, 60_000);
});
