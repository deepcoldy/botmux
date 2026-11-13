import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { sessionKey, storedSessionAnchorId, type DaemonSession } from '../src/core/types.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';
import { sameWorker } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

type Scope = 'chat' | 'thread';
const SCOPES: Scope[] = ['chat', 'thread'];

// Both /repo switch paths build the replacement with sessionStore.createSession
// on the owner's chatId and the old root (chat scope) or the same thread root
// (thread scope). Predecessor and replacement therefore share one routing
// anchor, i.e. one durable primary lane.
const CHAT_ID = 'oc_repo_switch';
const ROOT_ID = 'om_repo_switch_root';

// One app id per test: primary registrations are process-global per app and
// cannot be unregistered, so a fresh id keeps each test's lanes isolated.
let appSeq = 0;
let app: string;

function makeSession(sessionId: string, scope: Scope = 'chat') {
  return {
    sessionId,
    larkAppId: app,
    status: 'active' as const,
    scope,
    chatId: CHAT_ID,
    rootMessageId: ROOT_ID,
  };
}

function makeDs(sessionId: string, scope: Scope = 'chat'): DaemonSession {
  return {
    larkAppId: app,
    scope,
    chatId: CHAT_ID,
    session: makeSession(sessionId, scope),
    initConfig: {},
  } as unknown as DaemonSession;
}

function closeSessionContract(controller: SessionController) {
  const { operation } = controller.beginControl('close');
  controller.controlResult(operation.operationId, 'confirmed');
  expect(controller.store.read(controller.ref)!.lifecycle).toBe('closed');
}

type HoldPoint = 'before-read' | 'after-commit';

/** In-memory primary lanes keyed exactly like production. The production
 * commitPrimarySessionContract closure still performs the session-id/revision
 * CAS and invokes fence on mismatch; this fake only owns the durable rows and
 * can hold one write in flight at a chosen point. */
function laneFacade() {
  const lanes = new Map<string, { type: string; session: any }>();
  const writes: string[] = [];
  const fences: string[] = [];
  const keyOf = (session: any) => sessionKey(storedSessionAnchorId(session), session.larkAppId);
  let hold: { at: HoldPoint; enter: () => void; gate: Promise<void> } | undefined;
  registerSessionContractPrimary(app, {
    writeExactFromCurrent: async (key: string, update: (current: unknown) => unknown) => {
      const held = hold; hold = undefined;
      if (held?.at === 'before-read') { held.enter(); await held.gate; }
      const current = lanes.has(key) ? { value: structuredClone(lanes.get(key)) } : undefined;
      const next = update(current) as { type: string; session: any };
      lanes.set(key, structuredClone(next));
      writes.push(key);
      if (held?.at === 'after-commit') { held.enter(); await held.gate; }
      return { kind: 'written', value: next } as never;
    },
  } as never, (sessionId: string) => { fences.push(sessionId); });
  return {
    lanes, writes, fences,
    /** sessionStore persisting a record into its anchor's primary lane. */
    seed: (session: any) => {
      lanes.set(keyOf(session), { type: 'botmux.session.primary', session: structuredClone(session) });
    },
    lane: (session: any) => lanes.get(keyOf(session)),
    /** Hold the next durable write. `before-read`: the write is queued but has
     * not read the lane yet. `after-commit`: the row is written but the ack is
     * delayed. `entered` resolves once the write reaches that point. */
    holdNextWrite(at: HoldPoint) {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      hold = { at, enter, gate };
      return { entered, release };
    },
  };
}

let dataDir: string;
let previousDataDir: string;
let opened: SessionController[];

/** The /repo switch as card-handler / command-handler perform it: swap a
 * replacement record into the same DaemonSession object, persist it into the
 * shared anchor lane, then forkWorker resolves the controller again. */
function repoSwitch(ds: DaemonSession, primary?: ReturnType<typeof laneFacade>) {
  const previous = ds.session;
  ds.session = makeSession('session-b', previous.scope as Scope) as DaemonSession['session'];
  primary?.seed(ds.session);
  const next = controllerForSession(ds, true)!;
  opened.push(next);
  return { previous, next };
}

beforeEach(() => {
  app = `cli_repo_switch_${++appSeq}`;
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-repo-switch-'));
  config.session.dataDir = dataDir;
  opened = [];
});

afterEach(() => {
  for (const controller of opened.splice(0)) {
    try { controller.store.close(); } catch { /* contract store is shared per app */ }
  }
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('controller cache across the /repo same-object session replacement', () => {
  it('rebuilds the controller when the owner object keeps its identity but the session id changes', () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    expect(first.ref).toEqual({ appId: app, sessionId: 'session-a' });
    closeSessionContract(first);

    const { next: second } = repoSwitch(ds);

    expect(second).not.toBe(first);
    expect(second.ref).toEqual({ appId: app, sessionId: 'session-b' });
    expect(second.store.read(second.ref)!.lifecycle).toBe('active');
    // The predecessor contract stays closed; its state must not be resurrected.
    expect(first.store.read(first.ref)!.lifecycle).toBe('closed');
  });

  it('keeps returning the same controller while the session id is unchanged', () => {
    const ds = makeDs('session-keep');
    const first = controllerForSession(ds, true)!;
    opened.push(first);

    expect(controllerForSession(ds, true)).toBe(first);
    // A same-id record swap (principal-lane source hydration) is not a switch.
    ds.session = JSON.parse(JSON.stringify(ds.session));
    expect(controllerForSession(ds, true)).toBe(first);
  });

  it('stops a detached predecessor controller from projecting closed state onto the replacement session', () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    closeSessionContract(first);

    const { next: second } = repoSwitch(ds);
    expect(second).not.toBe(first);

    // A late IPC callback on the dying predecessor must not write the old
    // contract's closed lifecycle onto the replacement session record.
    first.refresh();
    expect(ds.session.status).toBe('active');
    expect(ds.session.sessionLifecycle).not.toBe('closed');
  });

  it.each(SCOPES)('never checkpoints the closed predecessor onto the shared %s anchor lane', async scope => {
    const ds = makeDs('session-a', scope);
    const primary = laneFacade();
    primary.seed(ds.session);
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    closeSessionContract(first);

    const { next: second } = repoSwitch(ds, primary);
    // Predecessor and replacement really share one lane.
    expect(primary.lanes.size).toBe(1);
    expect(primary.lane(ds.session)!.session.sessionId).toBe('session-b');

    // Late callbacks on the predecessor: the replacement lane already holds
    // session-b, so an unguarded flush would pass the session-id CAS and
    // overwrite it with the closed predecessor contract.
    first.refresh();
    await first.flushPrimary();
    expect(primary.writes).toHaveLength(0);
    expect(primary.fences).toEqual([]);
    expect(primary.lane(ds.session)!.session).toMatchObject({ sessionId: 'session-b', status: 'active' });
    expect(primary.lane(ds.session)!.session.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.status).toBe('active');

    // The live replacement controller still checkpoints its own lane normally.
    second.bindWorker(1);
    await second.flushPrimary();
    expect(primary.writes).toHaveLength(1);
    expect(primary.fences).toEqual([]);
    const saved = primary.lane(ds.session)!.session;
    expect(saved.sessionRuntimeContract!.session.ref).toEqual(second.ref);
    expect(saved.status).toBe('active');
  });

  it.each(SCOPES)('drops a queued predecessor flush and leaves both records untouched when an in-flight write is acknowledged after the %s switch', async scope => {
    const ds = makeDs('session-a', scope);
    const primary = laneFacade();
    primary.seed(ds.session);
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    first.bindWorker(1);

    // The predecessor's row is committed, but the ack is still in flight.
    const held = primary.holdNextWrite('after-commit');
    const inFlight = first.flushPrimary();
    await held.entered;
    // A second revision queues another flush behind the in-flight one.
    first.bindWorker(2);
    const queued = first.flushPrimary();

    const { previous: sessionA, next: second } = repoSwitch(ds, primary);
    expect(second).not.toBe(first);

    held.release();
    await Promise.all([inFlight, queued]);

    // Only the already-committed predecessor write happened. The queued flush
    // was dropped by the ownership check at the queued callback's entry, so it
    // neither overwrote the replacement row nor fenced the replacement.
    expect(primary.writes).toHaveLength(1);
    expect(primary.fences).toEqual([]);
    expect(primary.lane(ds.session)!.session).toMatchObject({ sessionId: 'session-b', status: 'active' });
    expect(primary.lane(ds.session)!.session.sessionRuntimeContract).toBeUndefined();
    // A detached controller is fully quiescent: the late ack mirrors onto
    // neither the predecessor record nor the replacement.
    expect(sessionA.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.status).toBe('active');

    second.bindWorker(1);
    await second.flushPrimary();
    expect(primary.fences).toEqual([]);
    expect(primary.lane(ds.session)!.session.sessionRuntimeContract!.session.ref).toEqual(second.ref);
  });

  it.each(SCOPES)('fences only the predecessor id when its in-flight write meets the %s replacement row', async scope => {
    const ds = makeDs('session-a', scope);
    const primary = laneFacade();
    primary.seed(ds.session);
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    first.bindWorker(1);

    // The predecessor's write is queued in the durable lane but has not read
    // the row yet; the switch persists the replacement first.
    const held = primary.holdNextWrite('before-read');
    const inFlight = first.flushPrimary().then(() => 'ok', (error: Error) => error.message);
    await held.entered;
    first.bindWorker(2);
    const queued = first.flushPrimary();

    const { previous: sessionA, next: second } = repoSwitch(ds, primary);

    held.release();
    // The session-id CAS refuses the stale write and fences the closed
    // predecessor id only; the queued flush is still dropped at its entry.
    expect(await inFlight).toBe('canonical_contract_session_changed');
    await queued;
    expect(primary.writes).toHaveLength(0);
    expect(primary.fences).toEqual(['session-a']);
    expect(primary.lane(ds.session)!.session).toMatchObject({ sessionId: 'session-b', status: 'active' });
    expect(sessionA.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.sessionRuntimeContract).toBeUndefined();

    // The replacement is unaffected and keeps checkpointing its lane.
    second.bindWorker(1);
    await second.flushPrimary();
    expect(primary.writes).toHaveLength(1);
    expect(primary.fences).toEqual(['session-a']);
    expect(primary.lane(ds.session)!.session.sessionRuntimeContract!.session.ref).toEqual(second.ref);
  });

  it('mirrors an in-flight checkpoint onto the live record after a same-id record swap', async () => {
    const ds = makeDs('session-a');
    const primary = laneFacade();
    primary.seed(ds.session);
    const controller = controllerForSession(ds, true)!;
    opened.push(controller);
    controller.bindWorker(1);
    await controller.flushPrimary();

    const held = primary.holdNextWrite('after-commit');
    controller.bindWorker(2);
    const pending = controller.flushPrimary();
    await held.entered;
    // Principal-lane source hydration replaces ds.session with a freshly
    // parsed object carrying the same sessionId while the write is in flight.
    const pinned = ds.session;
    ds.session = JSON.parse(JSON.stringify(pinned));
    expect(controllerForSession(ds, true)).toBe(controller);

    held.release();
    await pending;

    const committed = primary.lane(ds.session)!.session.sessionRuntimeContract!.session.revision;
    expect(committed).toBe(controller.store.snapshot(controller.ref).session.revision);
    // The live record carries the committed checkpoint, not the stale one it
    // was hydrated with.
    expect(ds.session.sessionRuntimeContract!.session.revision).toBe(committed);
    expect(primary.fences).toEqual([]);
  });

  it.each(SCOPES)('grants the replacement worker its start through the daemon reservation handshake on the shared %s lane', async scope => {
    const ds = makeDs('session-a', scope);
    const primary = laneFacade();
    primary.seed(ds.session);
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    first.bindWorker(1);
    closeSessionContract(first);

    // forkWorker for the replacement: resolve the controller and bind the
    // worker generation it hands to the new worker process.
    const { next: controller } = repoSwitch(ds, primary);
    const bootstrap = controller.bindWorker(2);
    expect(bootstrap.session).toEqual({ appId: app, sessionId: 'session-b' });

    // Real worker-side envelope and real daemon-side handler.
    const workerScope = new WorkerSessionEventScope(bootstrap.session, bootstrap.worker);
    const binding = workerScope.beginRuntime();
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: workerScope });
    const worker = { send: vi.fn() };
    ds.worker = worker as unknown as DaemonSession['worker'];
    const warn = vi.fn();
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', {
      sessionController: controller, contractWorker: bootstrap.worker, ds, worker, sameWorker,
      logger: { warn, debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn(),
    });

    await host(workerScope.run(binding, () => metadata({ type: 'runtime_binding_started', bindingId: binding.bindingId })));

    expect(warn).not.toHaveBeenCalled();
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime_contract_reserved', bindingId: binding.bindingId, mayStart: true,
    }));
    // The reservation landed on the replacement contract and its lane, never
    // on the closed predecessor, and nothing was fenced.
    expect(first.store.binding(first.ref, binding.bindingId)).toBeUndefined();
    expect(first.store.read(first.ref)!.lifecycle).toBe('closed');
    expect(primary.fences).toEqual([]);
    const saved = primary.lane(ds.session)!.session;
    expect(saved).toMatchObject({ sessionId: 'session-b', status: 'active' });
    expect(saved.sessionRuntimeContract!.session.ref).toEqual(controller.ref);
  });
});
