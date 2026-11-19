/**
 * The worker reports its identity decision (proven vs single, from the spawn's
 * real sandbox / loopback shape) from inside the reserved runtime binding,
 * right before it spawns the CLI. With session contracts on (v3.59.0, #2854)
 * that report travels through scoped-event admission like every other worker
 * event.
 *
 * Production (v3.59.0 / v3.59.1): when the worker starts with an opening turn
 * — a new topic's first message, a dormant session woken by a message, a
 * scheduled run — the report carried that still-queued turn's execution scope.
 * It was parked until the binding settled and then refused as
 * `execution_scope_unproven` (debug log only). Codex / TRAE in RPC input mode
 * send the report from engageCodexRpc, outside any binding, where it was
 * refused as `runtime_scope_missing` whether or not a turn was attached. The
 * daemon never learned the session was proven, the identity route refused
 * every managed wrapper (`bytedcli` exit 77, `current_execution_unverified`)
 * for the whole worker generation, while `botmux execution current` stayed
 * verified.
 *
 * A report made inside a binding still waits for that binding, so a start
 * that fails before its CLI exists cannot change the decision the surviving
 * CLI runs under.
 *
 * Real worker start path (spawnCli + sessionEventMetadata) against the real
 * daemon handler, controller and contract store; the CLI launch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameWorker } from '../src/services/session-contract.js';
import type { DaemonSession } from '../src/core/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

const decision = { type: 'session_identity_decision', sessionId: 'session-1', model: 'proven', sandboxEngaged: false, loopbackShared: true } as const;

/** A worker's CLI start wired to the daemon's real handler. The stubbed launch
 *  does what the real one does around the spawn: report the identity decision
 *  (with the turn it spawns for, as the real report does), then — once the
 *  process exists — publish the runtime identity. */
function world() {
  const data = mkdtempSync(join(tmpdir(), 'identity-decision-contract-')); directories.push(data); fixtureConfig.dataDir = data;
  const store = new SessionContractStore(data, 'cli_decision_test'); handles.push(store);
  const ref = { appId: 'cli_decision_test', sessionId: 'session-1' };
  const ds = { larkAppId: ref.appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: ref.appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store);
  const delivered: any[] = [];
  const warn = vi.fn();
  const workers = new Map<number, { send: (message: any) => void }>();
  const start = (generation: number) => {
    const worker = controller.bindWorker(generation).worker;
    const pending: Promise<void>[] = [];
    const env: any = { workerSessionEventScope: new WorkerSessionEventScope(ref, worker), pendingRuntimeReservations: new Map(),
      activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
      CliSpawnSupersededError: class extends Error {}, log: vi.fn(), currentBotmuxTurnId: undefined };
    let launch = async () => {
      env.send({ ...decision, ...(env.currentBotmuxTurnId ? { turnId: env.currentBotmuxTurnId } : {}) });
    };
    env.spawnCliBody = vi.fn(async () => launch());
    let pane = 0;
    env.publishRuntimeContract = vi.fn(async (binding: any) => {
      binding.identity = { backend: 'tmux', physicalId: `pane-${generation}-${++pane}`, proof: 'opaque' };
      env.send({ type: 'runtime_binding', bindingId: binding.bindingId, identity: binding.identity,
        ...(binding.operationId ? { operationId: binding.operationId } : {}) });
    });
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    const child = { send: vi.fn((message: any) => { void receive(message); }) };
    workers.set(generation, child);
    ds.worker = child as any;
    const hostScope: any = { sessionController: controller, contractWorker: worker, ds, worker: child, sameWorker,
      logger: { warn, debug: vi.fn() }, t: ref.sessionId,
      handleLegacyWorkerMessage: vi.fn(async (message: any) => { delivered.push({ ...message, generation }); }) };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
    env.send = (message: any) => { pending.push(host(metadata(message))); };
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
    return { env, worker, spawn, metadata, host, setLaunch: (next: () => Promise<void>) => { launch = next; },
      drain: async () => { while (pending.length) await Promise.all(pending.splice(0)); } };
  };
  return { ds, store, ref, controller, delivered, warn, start };
}

describe.each([
  ['a worker started without input (restore)', undefined],
  ['a new topic whose first message is already admitted', 'om_first'],
  ['a dormant session woken by a message', 'om_wake'],
  ['a scheduled run', 'schedule:daily:7b0c64b6-6a2f-4f8e-9a51-0e2c3b8c1d2e'],
])('session_identity_decision from the CLI start of %s', (_name, openingTurn) => {
  async function run() {
    const w = world();
    if (openingTurn?.startsWith('om_wake')) {
      // forkWorker's wake bootstrap: the session was suspended, the worker
      // starts under the resume operation with the message as its opening turn.
      const suspend = w.controller.beginControl('suspend').operation.operationId;
      w.controller.controlStarted(suspend); w.controller.controlResult(suspend, 'confirmed');
    }
    const restartAttemptId = w.controller.prepareWorkerStart();
    const g = w.start(1);
    g.env.activeRestartAttemptId = restartAttemptId;
    if (!openingTurn) await g.spawn({ prompt: '', resume: true });
    else {
      const execution = w.controller.admitInput(openingTurn);
      g.env.currentBotmuxTurnId = openingTurn;
      await g.spawn({ prompt: 'hello', resume: !!restartAttemptId, turnId: openingTurn, sessionCommand: { version: 2, execution } });
    }
    await g.drain();
    return { ...w, g };
  }

  it('reaches the daemon handler instead of being refused', async () => {
    const { delivered, warn } = await run();
    expect(delivered.filter(message => message.type === 'session_identity_decision')).toEqual([
      expect.objectContaining({ model: 'proven', sessionId: 'session-1', ...(openingTurn ? { turnId: openingTurn } : {}) }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

});

describe('session_identity_decision from the Codex / TRAE RPC engine, sent outside any runtime binding', () => {
  it.each([
    ['a worker started without input (restore)', undefined],
    ['a new topic whose first message is already admitted', 'om_first'],
    ['a scheduled run', 'schedule:daily:7b0c64b6-6a2f-4f8e-9a51-0e2c3b8c1d2e'],
  ])('reaches the daemon handler for %s', async (_name, openingTurn) => {
    const w = world();
    const g = w.start(1);
    if (openingTurn) {
      // The init command's execution is known before any CLI binding exists.
      g.env.workerSessionEventScope.rememberExecution(w.controller.admitInput(openingTurn));
      g.env.currentBotmuxTurnId = openingTurn;
    }
    expect(g.env.workerSessionEventScope.currentBinding()).toBeUndefined();
    g.env.send({ ...decision, ...(openingTurn ? { turnId: openingTurn } : {}) });
    await g.drain();
    expect(w.delivered.filter(message => message.type === 'session_identity_decision')).toEqual([
      expect.objectContaining({ model: 'proven', ...(openingTurn ? { turnId: openingTurn } : {}) }),
    ]);
    expect(w.warn).not.toHaveBeenCalled();
  });
});

describe('a replacement start that fails before its CLI exists', () => {
  it('does not change the decision the surviving CLI runs under', async () => {
    const w = world();
    const g = w.start(1);
    await g.spawn({ prompt: '', resume: true }); await g.drain();
    // The replacement reports a different spawn shape, then never launches.
    const restart = w.controller.beginControl('restart').operation.operationId; w.controller.controlStarted(restart);
    g.env.activeRestartAttemptId = restart;
    g.setLaunch(async () => {
      g.env.send({ ...decision, model: 'single', sandboxEngaged: true, loopbackShared: false });
      await new Promise(resolve => setTimeout(resolve, 0));
      throw new Error('spawn failed after the decision');
    });
    await expect(g.spawn({ prompt: '', resume: true })).rejects.toThrow('spawn failed after the decision');
    await g.drain();
    expect(w.delivered.filter(message => message.type === 'session_identity_decision').map(message => message.model)).toEqual(['proven']);
  });
});

describe('session_identity_decision admission keeps its source checks', () => {
  it('refuses a decision from a superseded worker generation', async () => {
    const w = world();
    const old = w.start(1);
    await old.spawn({ prompt: '', resume: true }); await old.drain();
    w.delivered.length = 0;
    w.start(2); // a newer worker generation now owns the session
    await old.host(old.metadata({ ...decision, model: 'single' }));
    expect(w.delivered.filter(message => message.type === 'session_identity_decision')).toEqual([]);
  });

  it('refuses a decision naming an execution the daemon never admitted, and says so', async () => {
    const w = world();
    const g = w.start(1);
    await g.spawn({ prompt: '', resume: true }); await g.drain();
    w.delivered.length = 0;
    const forged = g.metadata({ ...decision, turnId: 'om_forged' });
    forged.sessionContract.scope.execution = { executionId: 'forged-execution', turnId: 'om_forged' };
    await g.host(forged);
    expect(w.delivered.filter(message => message.type === 'session_identity_decision')).toEqual([]);
    expect(w.warn).toHaveBeenCalledWith(expect.stringMatching(/Dropped session_identity_decision from current worker turn=om_forged reason=\S+/));
  });
});
