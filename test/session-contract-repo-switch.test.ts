import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { sessionKey, storedSessionAnchorId, type DaemonSession } from '../src/core/types.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';

const APP = 'cli_repo_switch_test';

function makeSession(sessionId: string) {
  return {
    sessionId,
    larkAppId: APP,
    status: 'active' as const,
    scope: 'chat' as const,
    chatId: `oc_${sessionId}`,
  };
}

function makeDs(sessionId: string): DaemonSession {
  return {
    larkAppId: APP,
    session: makeSession(sessionId),
    initConfig: {},
  } as unknown as DaemonSession;
}

function closeSessionContract(controller: SessionController) {
  const { operation } = controller.beginControl('close');
  controller.controlResult(operation.operationId, 'confirmed');
  expect(controller.store.read(controller.ref)!.lifecycle).toBe('closed');
}

/** In-memory primary lanes. The production commitPrimarySessionContract
 * closure still performs the session-id/revision CAS and invokes fence on
 * mismatch; this fake only owns the durable lane rows. */
function laneFacade() {
  const lanes = new Map<string, { type: string; session: any }>();
  const writes: string[] = [];
  const fences: string[] = [];
  const seed = (session: any) => {
    lanes.set(sessionKey(storedSessionAnchorId(session), session.larkAppId),
      { type: 'botmux.session.primary', session: structuredClone(session) });
  };
  registerSessionContractPrimary(APP, {
    writeExactFromCurrent: async (key: string, update: (current: unknown) => unknown) => {
      const current = lanes.has(key) ? { value: structuredClone(lanes.get(key)) } : undefined;
      const next = update(current) as { type: string; session: any };
      lanes.set(key, structuredClone(next));
      writes.push(key);
      return { kind: 'written', value: next } as never;
    },
  } as never, (sessionId: string) => { fences.push(sessionId); });
  return {
    lanes, writes, fences, seed,
    lane: (session: any) => lanes.get(sessionKey(storedSessionAnchorId(session), session.larkAppId)),
  };
}

let dataDir: string;
let previousDataDir: string;
let opened: SessionController[];

beforeEach(() => {
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
    expect(first.ref).toEqual({ appId: APP, sessionId: 'session-a' });
    closeSessionContract(first);

    // card-handler / command-handler keep the DaemonSession object and swap
    // the inner session record, then forkWorker re-enters this lookup.
    ds.session = makeSession('session-b') as DaemonSession['session'];
    const second = controllerForSession(ds, true)!;
    opened.push(second);

    expect(second).not.toBe(first);
    expect(second.ref).toEqual({ appId: APP, sessionId: 'session-b' });
    expect(second.store.read(second.ref)!.lifecycle).toBe('active');
    // The predecessor contract stays closed; its state must not be resurrected.
    expect(first.store.read(first.ref)!.lifecycle).toBe('closed');
  });

  it('keeps returning the same controller while the session id is unchanged', () => {
    const ds = makeDs('session-keep');
    const first = controllerForSession(ds, true)!;
    opened.push(first);

    expect(controllerForSession(ds, true)).toBe(first);
  });

  it('stops a detached predecessor controller from projecting closed state onto the replacement session', () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    closeSessionContract(first);

    ds.session = makeSession('session-b') as DaemonSession['session'];
    const second = controllerForSession(ds, true)!;
    opened.push(second);
    expect(second).not.toBe(first);

    // A late IPC callback on the dying predecessor must not write the old
    // contract's closed lifecycle onto the replacement session record.
    first.refresh();
    expect(ds.session.status).toBe('active');
    expect(ds.session.sessionLifecycle).not.toBe('closed');
  });

  it('never checkpoints a detached predecessor contract onto the replacement primary lane', async () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    closeSessionContract(first);

    const sessionA = ds.session;
    ds.session = makeSession('session-b') as DaemonSession['session'];
    const sessionB = ds.session;
    const second = controllerForSession(ds, true)!;
    opened.push(second);

    const primary = laneFacade();
    primary.seed(sessionA);
    primary.seed(sessionB);

    await first.flushPrimary();
    expect(primary.writes).toHaveLength(0);
    expect(primary.fences).toHaveLength(0);

    // The live replacement controller still checkpoints its own lane normally.
    second.bindWorker(1);
    await second.flushPrimary();
    expect(primary.writes).toHaveLength(1);
    expect(primary.fences).toHaveLength(0);
    expect(primary.lane(sessionB)!.session.sessionRuntimeContract!.session.ref).toEqual(second.ref);
    expect(primary.lane(sessionA)!.session.sessionRuntimeContract).toBeUndefined();
  });

  it('abandons in-flight and queued primary flushes once the controller is detached', async () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    first.bindWorker(1);

    const primary = laneFacade();
    primary.seed(ds.session);

    // Gate the durable write so the first flush stays in flight.
    let releaseWrite: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    registerSessionContractPrimary(APP, {
      writeExactFromCurrent: async (key: string, update: (current: unknown) => unknown) => {
        await writeGate;
        const current = primary.lanes.has(key) ? { value: structuredClone(primary.lanes.get(key)) } : undefined;
        const next = update(current) as { type: string; session: any };
        primary.lanes.set(key, structuredClone(next));
        primary.writes.push(key);
        return { kind: 'written', value: next } as never;
      },
    } as never, (sessionId: string) => { primary.fences.push(sessionId); });

    const inFlight = first.flushPrimary();
    // Yield until the chain has actually entered the blocking durable write.
    await new Promise(resolve => setImmediate(resolve));
    // A second revision queues another flush behind the in-flight one.
    first.bindWorker(2);
    const queued = first.flushPrimary();

    // Repo switch detaches the predecessor while one write is in flight and
    // another is queued.
    const sessionA = ds.session;
    ds.session = makeSession('session-b') as DaemonSession['session'];
    const second = controllerForSession(ds, true)!;
    opened.push(second);
    expect(second).not.toBe(first);

    releaseWrite!();
    await Promise.all([inFlight, queued]);

    // Only the already-entered write lands (on the predecessor lane); the
    // queued flush is dropped by the post-await ownership check, and neither
    // mismatch fences anything.
    expect(primary.writes).toHaveLength(1);
    expect(primary.fences).toHaveLength(0);
    expect(primary.lane(sessionA)!.session.sessionId).toBe('session-a');
    // A detached controller is fully quiescent: even the in-flight write does
    // not mirror its snapshot back onto the predecessor session object after
    // detach, and the replacement record is never touched.
    expect(sessionA.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.sessionRuntimeContract).toBeUndefined();
    expect(ds.session.status).toBe('active');
  });

  it('binds replacement worker reservations to the new contract instead of the closed predecessor', () => {
    const ds = makeDs('session-a');
    const first = controllerForSession(ds, true)!;
    opened.push(first);
    closeSessionContract(first);

    ds.session = makeSession('session-b') as DaemonSession['session'];
    const second = controllerForSession(ds, true)!;
    opened.push(second);

    second.bindWorker(7);
    const worker = second.store.read(second.ref)!.worker!;
    const runtime = second.reserveBinding('binding-replacement', worker);

    expect(second.store.binding(second.ref, 'binding-replacement')!.ref).toEqual(runtime);
    expect(first.store.binding(first.ref, 'binding-replacement')).toBeUndefined();
    expect(second.bindingMayStart('binding-replacement')).toBe(true);
    expect(second.store.read(second.ref)!.lifecycle).toBe('active');
  });
});
