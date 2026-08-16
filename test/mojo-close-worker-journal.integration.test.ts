/**
 * REAL worker -> real IPC -> real daemon -> durable journal, for the close
 * prepare fences.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The existing mojo close coverage (test/mojo-explicit-close.test.ts) starts at
 * the DAEMON message: its fake worker is an EventEmitter that synthesizes
 * `close_result` payloads, `recovery` field included. That is fine for the
 * daemon's decision, but it means the entire PRODUCER side is unverified — the
 * test hands the daemon the very field the worker is supposed to compute. Four
 * separate regressions therefore survived the whole suite:
 *
 *   1. worker.ts, thrown destroySession:   recovery 'uncertain' -> 'retryable'
 *   2. destroy-result.ts, the send site:   drop `recovery` from the payload
 *   3. worker-pool.ts, worker exited:      recovery 'uncertain' -> 'retryable'
 *   4. worker-pool.ts, close timeout:      recovery 'uncertain' -> 'retryable'
 *
 * Each of those turns an UNKNOWN teardown outcome back into a rollback: the
 * daemon sends `close_abort`, write admission re-opens, and the durable journal
 * is cleared — on a session whose remote cancellation may already have
 * completed (irreversible) or may still be in flight under an id we never
 * learned (an unnamed orphan still holding the injected credential).
 *
 * The assertions below are deliberately made on the two OBSERVABLE consequences
 * rather than on the enum value, because the caller-visible return
 * (`ok:false, error:'mojo_cancel_failed', retryable:true`) is identical either
 * way:
 *   - was `close_abort` sent over the real IPC channel?
 *   - is the durable journal ON DISK still there after closeSession() returns?
 *     (a fenced verdict retains it; a rollback clears it — see
 *     expectDurableFence for why the phase is matched as a set)
 *
 * Run:  pnpm vitest run test/mojo-close-worker-journal.integration.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker } from '../src/types.js';

const { getBotMock, cancelMojoMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
  cancelMojoMock: vi.fn(async () => ({ kind: 'cancelled' as const })),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

// Daemon-side only: the live worker owns the real cancellation. Stubbed so a
// workerless fallback can never reach the network from a unit-test process.
vi.mock('../src/adapters/backend/mojo-backend.js', () => ({
  cancelMojoSessionById: cancelMojoMock,
  MojoBackend: class {},
}));

// A REAL worker streams status/card traffic, unlike the synthetic fixtures — so
// these must return promises. `vi.fn()` yields undefined and the production
// `updateMessage(...).catch(...)` then throws an unhandled TypeError that has
// nothing to do with the close path.
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => undefined),
  deleteMessage: vi.fn(async () => undefined),
  sendEphemeralCard: vi.fn(async () => undefined),
  sendUserMessage: vi.fn(async () => 'om_sent'),
  addReaction: vi.fn(async () => undefined),
  removeReaction: vi.fn(async () => undefined),
  getMessageChatId: vi.fn(async () => 'oc_mojo'),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

// The real budget is 75s (it must sit above mojo's own bounded cancel phases).
// Shrunk here so the timeout FENCE is testable; the daemon logic under test is
// untouched, and this mock lives in the daemon process only — the worker child
// imports the real module.
vi.mock('../src/adapters/backend/mojo-budgets.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS: 4_000,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import {
  __testOnly_setupWorkerHandlers,
  closeSession,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const APP_ID = 'app';
const HOOK = resolve('test/fixtures/mojo-e2e-destroy-hook.ts');

/**
 * Does this tree carry the split `admission` contract (review note 3)?
 *
 * The two cases below assert a field that only exists once close_result reports
 * `admission` separately from `recovery`. Detected instead of assumed so this
 * file stays honest when run on a tree that predates it: a hard failure there
 * would say "the fence is broken" when the truth is "the contract is not in this
 * tree yet", and silently deleting the cases would hide the gap entirely.
 */
/**
 * Does the DURABLE journal persist the exact verdict (review note 4)?
 *
 * Keyed on `commitOnly`, which only the journal block declares. An earlier
 * attempt matched `recovery?:` and silently hit the pre-existing close_result
 * IPC type instead, so the guard read "present" on a tree where the journal has
 * no verdict at all — a guard that lies is worse than no guard.
 */
const HAS_JOURNAL_VERDICT = readFileSync(
  resolve('src/types.ts'),
  'utf-8',
).includes('commitOnly?: boolean');
const HAS_ADMISSION_CONTRACT = readFileSync(
  resolve('src/adapters/backend/types.ts'),
  'utf-8',
).includes("admission?: 'restorable' | 'fenced'");

/**
 * Did the daemon try to ROLL BACK? This is the one observable that stays sharp
 * across the whole review series.
 *
 * `close_abort` on the wire is not enough on its own: when the worker is already
 * gone, abortLiveRemoteWorkerClose() short-circuits before `send()`, so a
 * rollback decision produces no IPC at all. The durable phase is not enough
 * either — a rollback whose abort could not be delivered also lands on
 * `uncertain`, which is exactly what the fence writes.
 *
 * `finishMojoCloseAbort` is reached ONLY from the rollback branch, so it
 * separates the two decisions in every case, dead worker included.
 */
let finishAbortSpy: ReturnType<typeof vi.spyOn>;

let dataDir: string;
let previousDataDir: string;
let workerRoot: string;
let child: ChildProcess | undefined;
const workerLogs: string[] = [];
/** Every message the DAEMON put on the real IPC channel, in order. */
let sentToWorker: string[] = [];

interface CloseResultWire {
  type: 'close_result';
  requestId: string;
  ok: boolean;
  taskId?: string;
  error?: string;
  recovery?: 'retryable' | 'uncertain' | 'irreversible';
  admission?: 'restorable' | 'fenced';
}
/**
 * Every close_result the WORKER put on the real IPC channel.
 *
 * Read raw, on purpose: asserting a field here proves it SURVIVED the process
 * boundary, independently of how the daemon chose to interpret it.
 */
let closeResults: CloseResultWire[] = [];

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(r => setTimeout(r, 50));
  }
  throw new Error(describeFailure());
}

/**
 * Boot a REAL `src/worker.ts` child with a mojo backend, run one turn so the
 * lineage exists, and wire it into the daemon's worker pool exactly as
 * forkWorker would.
 */
async function bootRealWorker(opts: {
  /** Injected trigger, or `none` for a 100% production verdict. */
  mode: 'throw' | 'hang' | 'exit' | 'none';
  /**
   * `false` makes the fake mojo accept the turn and exit WITHOUT emitting
   * `system/init`, which is the real `mojo_lineage_not_materialized` state: a
   * remote session may exist under an id we never learned.
   */
  lineage?: boolean;
}): Promise<{
  ds: DaemonSession;
  registry: Map<string, DaemonSession>;
  sessionId: string;
}> {
  const withLineage = opts.lineage ?? true;
  const started = join(workerRoot, 'started');
  const botsPath = join(workerRoot, 'bots.json');
  writeFileSync(botsPath, JSON.stringify([{
    larkAppId: APP_ID,
    larkAppSecret: 'secret',
    cliId: 'mojo',
    backendType: 'mojo',
    mojo: { cloud: true },
  }]));

  // A fake mojo that emits a real lineage (`system/init`) and then keeps the
  // turn open, so the close lands while a session id is known.
  const bin = join(workerRoot, 'mojo');
  writeFileSync(bin, withLineage
    ? `#!/usr/bin/env bash
if [ "$1" = "session" ]; then exit 0; fi
: > "${started}"
echo '{"type":"system","subtype":"init","session_id":"mojo-sid-e2e"}'
sleep 30
`
    // Accepts the turn, then dies before publishing a lineage.
    : `#!/usr/bin/env bash
if [ "$1" = "session" ]; then exit 0; fi
: > "${started}"
exit 0
`);
  chmodSync(bin, 0o755);

  // --import tsx first so the .ts hook below can be loaded at all.
  child = spawn(process.execPath, [
    '--import', 'tsx',
    '--import', pathToFileURL(HOOK).href,
    resolve('src/worker.ts'),
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: workerRoot,
      SESSION_DATA_DIR: workerRoot,
      BOTS_CONFIG: botsPath,
      BOTMUX_SESSION_ID: 'sid-mojo-e2e',
      LARK_APP_ID: APP_ID,
      LARK_APP_SECRET: 'secret',
      PATH: `${workerRoot}:${process.env.PATH ?? ''}`,
      BOTMUX_E2E_DESTROY_MODE: opts.mode,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', c => workerLogs.push(c.toString()));
  child.stderr?.on('data', c => workerLogs.push(c.toString()));

  const session = sessionStore.createSession('oc_mojo', 'om_mojo', 'mojo close', 'group');
  session.larkAppId = APP_ID;
  session.scope = 'chat';
  session.backendType = 'mojo';
  // No lineage on the row either: the id genuinely never materialised.
  if (withLineage) session.riffParentTaskId = 'mojo-sid-e2e';
  // A frozen identity is what makes the lineage cancellable.
  session.mojoIdentity = { cloud: true };
  sessionStore.updateSession(session);

  child.send({
    type: 'init',
    sessionId: session.sessionId,
    chatId: 'oc_mojo',
    rootMessageId: 'om_mojo',
    workingDir: workerRoot,
    cliId: 'mojo',
    backendType: 'mojo',
    backendConfig: { cloud: true },
    prompt: 'turn before close',
    larkAppId: APP_ID,
    larkAppSecret: 'secret',
  } as DaemonToWorker);

  await waitFor(
    () => existsSync(started),
    30_000,
    () => `the mojo turn never crossed the worker boundary\n${workerLogs.join('')}`,
  );

  child.on('message', raw => {
    const msg = raw as { type?: string };
    if (msg?.type === 'close_result') closeResults.push(raw as CloseResultWire);
  });

  // Record what the daemon actually sends, without replacing the channel: the
  // real child.send still delivers it.
  const realSend = child.send.bind(child);
  (child as unknown as { send: ChildProcess['send'] }).send = ((message: unknown, ...rest: unknown[]) => {
    sentToWorker.push((message as { type?: string })?.type ?? 'unknown');
    return (realSend as (...args: unknown[]) => boolean)(message, ...rest);
  }) as ChildProcess['send'];

  const ds = {
    larkAppId: APP_ID,
    chatId: 'oc_mojo',
    chatType: 'group',
    scope: 'chat',
    worker: child,
    session,
    initConfig: { backendType: 'mojo' },
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, child);
  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  return { ds, registry, sessionId: session.sessionId };
}

/**
 * The journal as a RESTARTING DAEMON would read it: re-init the store so the row
 * comes back off disk through the production load path, instead of from the
 * in-memory object this test also holds a reference to.
 *
 * WHY NOT readFileSync -- this was a real hole, not a style preference
 * -------------------------------------------------------------------
 * This helper used to parse the projection file directly, with a comment
 * claiming it saw "exactly what a restarting daemon would". That claim was
 * false, and it cost coverage: deleting the save() inside
 * mutateMojoCloseJournal left every assertion here GREEN, because
 * closeSession's path has other writers (updateSession via
 * reserveWorkerGeneration / persistStreamCardState) that flush the very same
 * shared Session object. The row really was in the file -- just not because the
 * journal mutation put it there. Textbook coincidental coverage.
 *
 * Re-initialising the store fixes it for a concrete reason: it drops the
 * in-memory map and replays the on-disk projection, so a field that was only
 * ever set on the shared object -- and flushed by a foreign writer that ran
 * BEFORE the journal was written -- is simply absent on reload. The no-save
 * mutant is therefore killed here (verified 3/3 on the `recovery` assertion in
 * the thrown-teardown case), where the raw read let it through.
 *
 * Credit: Journal found the original hole by mutating save() and noticing that
 * neither his suite nor this one went red.
 */
function durableJournal(sessionId: string): Record<string, unknown> | undefined {
  // Re-init from the same dataDir: this discards the in-memory map and replays
  // the on-disk projection, so a row that failed to serialize would not survive.
  sessionStore.init(APP_ID);
  return sessionStore.getSession(sessionId)?.mojoCloseJournal as
    Record<string, unknown> | undefined;
}

/**
 * The durable fence survived: a rollback is what CLEARS this row, so its mere
 * retention is the observable difference between `retryable` and every
 * unknown-outcome verdict.
 *
 * The phase is asserted as a SET on purpose. `preparing` is what an
 * uncertain/irreversible prepare leaves behind today, because the daemon
 * deliberately does not touch the journal on that path; the durable-phase work
 * (review note 4) makes the daemon write the verdict down explicitly as
 * `uncertain`. Both are fenced and neither is a rollback, so pinning one exact
 * string here would turn an intended improvement into a false regression while
 * proving nothing extra about the behaviour under test.
 */
function expectDurableFence(sessionId: string): void {
  const journal = durableJournal(sessionId);
  expect(journal, 'the durable close journal must not be cleared by a fenced verdict')
    .toBeDefined();
  expect(['preparing', 'uncertain']).toContain(journal?.phase);
  // The decisive one: no rollback was even attempted.
  expect(finishAbortSpy, 'a fenced verdict must not commit a close abort')
    .not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  workerLogs.length = 0;
  sentToWorker = [];
  closeResults = [];
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-mojo-e2e-'));
  workerRoot = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-e2e-worker-')));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  sessionStore.init(APP_ID);
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { mojo: { cloud: true } },
  });
  finishAbortSpy = vi.spyOn(sessionStore, 'finishMojoCloseAbort');
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => workerRoot,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  vi.restoreAllMocks();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workerRoot, { recursive: true, force: true });
});

describe('mojo close: real worker -> IPC -> daemon -> durable journal', () => {
  it('fences a THROWN destroySession instead of rolling it back', async () => {
    // Mutant killed: worker.ts's catch returning `recovery: 'retryable'`.
    // Nothing else can see this — the daemon-side fixture supplies `recovery`
    // itself, so the worker's own verdict is never exercised there.
    const { sessionId } = await bootRealWorker({ mode: 'throw' });

    const result = await closeSession(sessionId);

    expect(result.ok).toBe(false);
    // The abort is what re-opens write admission. It must not have been sent.
    expect(sentToWorker).toContain('close');
    expect(sentToWorker).not.toContain('close_abort');
    expect(sentToWorker).not.toContain('close_commit');
    // Durable proof: an unknown outcome keeps the fence on disk, so a daemon
    // crash right here still fails closed.
    expectDurableFence(sessionId);
    // The EXACT verdict must be persisted, not just "some fence". A restart
    // reads this row to decide whether re-cancelling is required, forbidden or
    // merely useless, so recording a thrown teardown as `retryable` tells the
    // next daemon it may re-open admission on a lineage whose remote cancel may
    // already have completed. Guarded because `recovery` is only persisted once
    // the durable-verdict work (review note 4) is in the tree.
    if (HAS_JOURNAL_VERDICT) {
      expect(durableJournal(sessionId)).toMatchObject({ recovery: 'uncertain' });
    }
    // The row stays active, which is what keeps its device-isolation blocker.
    expect(sessionStore.getSession(sessionId)?.status).toBe('active');
  }, 60_000);

  it('fences a close prepare whose worker DIED mid-prepare', async () => {
    // Mutant killed: worker-pool.ts's `worker_exited_before_close_result`
    // returning `recovery: 'retryable'`. The worker exits without ever sending
    // close_result, so only a real child process reaches this branch.
    const { sessionId } = await bootRealWorker({ mode: 'exit' });

    const result = await closeSession(sessionId);

    expect(result.ok).toBe(false);
    expect(sentToWorker).not.toContain('close_abort');
    expectDurableFence(sessionId);
    expect(sessionStore.getSession(sessionId)?.status).toBe('active');
  }, 60_000);

  it('fences a close prepare that TIMED OUT with no result', async () => {
    // Mutant killed: worker-pool.ts's `worker_close_result_timeout` returning
    // `recovery: 'retryable'`. The prepare may still be running remotely, so
    // the outcome is unknown and admission must stay fenced.
    const { sessionId } = await bootRealWorker({ mode: 'hang' });

    const result = await closeSession(sessionId);

    expect(result.ok).toBe(false);
    // Matched as a SET, for the same reason the phase is: today an unknown
    // outcome is reported as a (misleadingly) retryable `mojo_cancel_failed`;
    // the durable-phase work (review note 4) reports it as
    // `mojo_close_reconciliation_required` with `retryable:false`. Both are
    // fenced refusals — what must never happen is the ROLLBACK asserted below.
    expect(['mojo_cancel_failed', 'mojo_close_reconciliation_required'])
      .toContain(result.error);
    expect(sentToWorker).not.toContain('close_abort');
    expectDurableFence(sessionId);
    expect(sessionStore.getSession(sessionId)?.status).toBe('active');
    // The worker is still alive and still fenced: the daemon gave up waiting,
    // it did not prove anything about the remote side.
    expect(child?.exitCode).toBeNull();
  }, 60_000);

  it('carries the backend\'s OWN uncertain verdict across the IPC boundary', async () => {
    // Zero injection: the fake mojo accepts the turn and dies before publishing
    // a lineage, so the REAL MojoBackend returns
    // `mojo_lineage_not_materialized` / `uncertain` on its own. The whole chain
    // is production code — backend verdict, worker send site, IPC, daemon
    // decision, durable journal.
    //
    // Mutant killed: dropping `recovery` from buildCloseResultMessage(). The
    // field is the ONLY thing that tells the daemon a rollback is illegal, and
    // every other test in the tree hands it to the daemon by hand.
    const { sessionId } = await bootRealWorker({ mode: 'none', lineage: false });

    const result = await closeSession(sessionId);

    expect(result.ok).toBe(false);
    // No id to hand back: there is nothing to cancel and nothing to prove gone.
    expect(result.taskId).toBeUndefined();
    expect(sentToWorker).toContain('close');
    expect(sentToWorker).not.toContain('close_abort');
    expectDurableFence(sessionId);
    expect(sessionStore.getSession(sessionId)?.status).toBe('active');
  }, 60_000);

  it.skipIf(!HAS_ADMISSION_CONTRACT)('keeps writes fenced when recovery says retryable but admission says fenced', async () => {
    // The case where the two answers legitimately DISAGREE, and the only one
    // that can catch a daemon which re-derives `admission` from `recovery`.
    //
    // No verdict is injected: `procRoot` points at a missing directory, so the
    // REAL subtree scan cannot prove quiescence and the REAL backend returns
    // mojo_local_child_termination_unproven + recovery:'retryable' +
    // admission:'fenced'. The remote cancel never ran (so a retry is legal) but
    // a credentialed process may still be alive (so writes must stay fenced).
    const { sessionId } = await bootRealWorker({ mode: 'unscannable' });

    const result = await closeSession(sessionId);

    expect(result.ok).toBe(false);
    // Proof both fields crossed the process boundary independently, i.e. that
    // `admission` is NOT a function of `recovery`.
    const wire = closeResults.at(-1);
    expect(wire?.recovery).toBe('retryable');
    expect(wire?.admission).toBe('fenced');
    // The decisive consequence: a retryable close whose admission is fenced must
    // NOT be rolled back. Deriving admission from recovery sends close_abort
    // here and re-opens writes on a possibly-live credentialed subtree.
    expect(sentToWorker).toContain('close');
    expect(sentToWorker).not.toContain('close_abort');
    expect(finishAbortSpy, 'a fenced admission must not commit a close abort')
      .not.toHaveBeenCalled();
    expect(sessionStore.getSession(sessionId)?.status).toBe('active');
  }, 60_000);

  it('does not let a clean subtree scan mint a boundary proof', async () => {
    // The back door the scanner contract exists to close: a scan that finds
    // nothing is DIAGNOSTIC, never a credential-boundary proof. If a clean scan
    // could mint boundaryProof, an escaped process that scrubbed its own environ
    // would silently clear the device-isolation blocker.
    //
    // Observed through the production close path on the real worker, rather than
    // on a unit-level scan result.
    const { sessionId } = await bootRealWorker({ mode: 'none' });

    await closeSession(sessionId);

    const logs = workerLogs.join('');
    // `contained-proven` / boundaryProof:true may ONLY come from Containment's
    // cgroup.procs check; no scanner path is allowed to mint one.
    expect(logs).not.toContain('contained-proven');
    expect(logs).not.toMatch(/boundaryProof['"]?\s*[:=]\s*true/);
  }, 60_000);
});
