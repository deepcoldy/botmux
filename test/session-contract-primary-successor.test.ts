// 第一个 import：测试围栏没生效时整个文件直接拒跑（本文件在 homedir()/temp 下建 SQLite 临时目录）。
import { isInsideDir } from './helpers/require-fenced-data-dir.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { sessionKey, storedSessionAnchorId, type DaemonSession } from '../src/core/types.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import {
  commitPrimarySessionContract,
  registerSessionContractPrimary,
} from '../src/core/session-contract-primary.js';
import { createDurableSessionFacade, type DurableSessionFacade } from '../src/services/durable-session-facade.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  admitDurableLarkSession,
  commitDurableLarkSessionControl,
  parseDurablePrimarySessionRecord,
  successorPrimarySessionValue,
} from '../src/services/durable-session-primary.js';
import type { Session } from '../src/types.js';

if (!isInsideDir(homedir(), process.env.__TEST_DATA_DIR_FENCE)) {
  throw new Error(`refusing to run: HOME ${homedir()} is not inside the test fence`);
}

type Scope = 'chat' | 'thread';
const SCOPES: Scope[] = ['chat', 'thread'];
const CHAT_ID = 'oc_primary_successor';
const ROOT_ID = 'om_primary_successor_root';
const LEASE_MS = 1_000;

// Primary registrations are process-global per app and cannot be removed, so
// every test registers a fresh app id against its own SQLite store.
let appSeq = 0;
let app: string;
let root: string;
let dataDir: string;
let previousDataDir: string;
let store: SqliteDurableCoordinationStore;
let facade: DurableSessionFacade;
let fences: string[];
let opened: SessionController[];
let now: number;

function makeSession(sessionId: string, scope: Scope): Session {
  return {
    sessionId,
    larkAppId: app,
    status: 'active',
    scope,
    chatId: CHAT_ID,
    chatType: 'group',
    rootMessageId: ROOT_ID,
    title: 'primary successor',
    createdAt: '2026-11-13T00:00:00.000Z',
    lastMessageAt: '2026-11-13T00:00:00.000Z',
  } as Session;
}

function message(messageId: string): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: `im.message.receive_v1:${app}:${messageId}`,
    partitionKey: `lark-message-routing:${app}:${CHAT_ID}`,
    larkAppId: app,
    messageId,
    attempts: 1,
    data: {},
  };
}

function laneKey(session: Session): string {
  return sessionKey(storedSessionAnchorId(session), app);
}

async function lane(session: Session) {
  const record = await store.readSession(laneKey(session));
  if (!record) throw new Error('expected a canonical primary row');
  return { record, ...parseDurablePrimarySessionRecord(record) };
}

function controllerFor(ds: DaemonSession): SessionController {
  const controller = controllerForSession(ds, true)!;
  opened.push(controller);
  return controller;
}

function closeContract(controller: SessionController): void {
  const { operation } = controller.beginControl('close');
  controller.controlResult(operation.operationId, 'confirmed');
}

/**
 * The predecessor as primary mode leaves it right before a /repo switch: its
 * message was admitted, its controller checkpointed, a lifecycle control was
 * committed on the row, and closeSession checkpointed the closed contract.
 */
async function closedPredecessor(scope: Scope) {
  const ds = {
    larkAppId: app, scope, chatId: CHAT_ID, session: makeSession('session-a', scope), initConfig: {},
  } as unknown as DaemonSession;
  await admitDurableLarkSession({ facade, message: message('om_first'), session: ds.session });
  const predecessor = controllerFor(ds);
  predecessor.bindWorker(1);
  await predecessor.flushPrimary();
  await commitDurableLarkSessionControl({
    facade,
    control: {
      operationId: `card.action.trigger:${app}:evt_toggle`,
      partitionKey: `lark-session-control:${app}:session-a`,
      larkAppId: app,
      action: 'toggle_display',
      sessionId: 'session-a',
      rootId: ROOT_ID,
      operatorOpenId: 'ou_operator',
      cardMessageId: 'om_card',
      attempts: 1,
      data: {},
    },
    session: ds.session,
    result: { status: 'applied' },
  });
  closeContract(predecessor);
  await predecessor.flushPrimary();
  const before = await lane(ds.session);
  expect(before.session).toMatchObject({ sessionId: 'session-a', status: 'closed' });
  expect(before.controls).toHaveLength(1);
  return { ds, predecessor, before };
}

/** What both /repo switch paths do to the owner object before forkWorker:
 * swap a brand-new record on the same anchor in. Nothing in that path admits a
 * message, so the durable lane is not touched here. */
function repoSwitch(ds: DaemonSession) {
  ds.session = { ...makeSession('session-b', ds.scope as Scope),
    durablePrimaryPredecessorSessionId: ds.session.sessionId };
  return controllerFor(ds);
}

beforeEach(() => {
  app = `cli_primary_successor_${++appSeq}`;
  mkdirSync(join(homedir(), 'temp'), { recursive: true });
  root = mkdtempSync(join(homedir(), 'temp', 'primary-successor-'));
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-primary-successor-'));
  config.session.dataDir = dataDir;
  now = 1_000_000;
  store = new SqliteDurableCoordinationStore(join(root, 'coordination.db'), { now: () => now });
  facade = createDurableSessionFacade({ store, ownerId: `owner-${app}`, leaseDurationMs: LEASE_MS });
  fences = [];
  registerSessionContractPrimary(app, facade, sessionId => { fences.push(sessionId); });
  opened = [];
});

afterEach(async () => {
  for (const controller of opened.splice(0)) {
    try { controller.store.close(); } catch { /* contract store is shared per app */ }
  }
  await facade.stop();
  await store.close();
  config.session.dataDir = previousDataDir;
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable primary lane after a same-anchor /repo replacement', () => {
  it.each(SCOPES)('lets the replacement claim the closed %s predecessor row with its first checkpoint', async scope => {
    const { ds } = await closedPredecessor(scope);
    const replacement = repoSwitch(ds);

    // forkWorker binds the new generation and its first IPC send flushes.
    replacement.bindWorker(2);
    await expect(replacement.flushPrimary()).resolves.toBeUndefined();

    expect(fences).toEqual([]);
    const claimed = await lane(ds.session);
    expect(claimed.session).toMatchObject({ sessionId: 'session-b', status: 'active' });
    expect(claimed.session.sessionRuntimeContract!.session.ref).toEqual(replacement.ref);
    // The predecessor's session-bound control history does not follow it; its
    // latest admission only anchors the envelope.
    expect(claimed.controls).toEqual([]);
    expect(claimed.admissions.map(entry => entry.messageId)).toEqual(['om_first']);
    expect(ds.session.sessionRuntimeContract!.session.revision)
      .toBe(claimed.session.sessionRuntimeContract!.session.revision);

    // The replacement's first business message is admitted onto its own row
    // without losing the checkpoint.
    const admitted = await admitDurableLarkSession({ facade, message: message('om_next'), session: ds.session });
    expect(admitted.kind).toBe('committed');
    const afterAdmission = await lane(ds.session);
    expect(afterAdmission.session.sessionId).toBe('session-b');
    expect(afterAdmission.admissions.map(entry => entry.messageId)).toEqual(['om_first', 'om_next']);
    expect(afterAdmission.session.sessionRuntimeContract!.session.revision)
      .toBe(claimed.session.sessionRuntimeContract!.session.revision);

    // Later checkpoints, including its own close, take the ordinary path.
    replacement.bindWorker(3);
    await replacement.flushPrimary();
    closeContract(replacement);
    await replacement.flushPrimary();
    expect(fences).toEqual([]);
    expect((await lane(ds.session)).session).toMatchObject({ sessionId: 'session-b', status: 'closed' });
  });

  it('still fences the replacement while the predecessor row is active', async () => {
    const ds = {
      larkAppId: app, scope: 'thread', chatId: CHAT_ID, session: makeSession('session-a', 'thread'), initConfig: {},
    } as unknown as DaemonSession;
    await admitDurableLarkSession({ facade, message: message('om_first'), session: ds.session });
    const before = await lane(ds.session);
    const replacement = repoSwitch(ds);
    replacement.bindWorker(2);

    await expect(replacement.flushPrimary()).rejects.toThrow('canonical_contract_session_changed');

    expect(fences).toEqual(['session-b']);
    expect((await lane(ds.session)).record).toEqual(before.record);
  });

  it('still fences a replacement whose own contract is already closed', async () => {
    const { ds, before } = await closedPredecessor('thread');
    const replacement = repoSwitch(ds);
    replacement.bindWorker(2);
    closeContract(replacement);

    await expect(replacement.flushPrimary()).rejects.toThrow('canonical_contract_session_changed');

    expect(fences).toEqual(['session-b']);
    expect((await lane(ds.session)).record).toEqual(before.record);
  });

  it('only lets a first checkpoint take the closed row over', async () => {
    const { ds, before } = await closedPredecessor('thread');
    const replacement = repoSwitch(ds);
    replacement.bindWorker(2);
    const snapshot = replacement.store.snapshot(replacement.ref);

    // A controller that already committed a revision elsewhere is stale here.
    await expect(commitPrimarySessionContract(ds.session, snapshot, 1))
      .rejects.toThrow('canonical_contract_session_changed');

    expect(fences).toEqual(['session-b']);
    expect((await lane(ds.session)).record).toEqual(before.record);
  });

  it('requires a recorded predecessor instead of claiming any closed row', async () => {
    const { ds, before } = await closedPredecessor('thread');
    const replacement = repoSwitch(ds);
    delete ds.session.durablePrimaryPredecessorSessionId;
    replacement.bindWorker(2);

    await expect(replacement.flushPrimary()).rejects.toThrow('canonical_contract_session_changed');

    expect(fences).toEqual(['session-b']);
    expect((await lane(ds.session)).record).toEqual(before.record);
  });

  it('restores the recorded predecessor when a new controller retries before any checkpoint', async () => {
    const { ds } = await closedPredecessor('thread');
    repoSwitch(ds).bindWorker(2);
    // A restart only has the serialized Session; no cached predecessor controller.
    const restored = { larkAppId: app, scope: 'thread', chatId: CHAT_ID,
      session: JSON.parse(JSON.stringify(ds.session)), initConfig: {} } as DaemonSession;
    const replacement = controllerFor(restored);
    replacement.bindWorker(3);

    await replacement.flushPrimary();

    expect(fences).toEqual([]);
    expect((await lane(restored.session)).session.sessionId).toBe('session-b');
  });

  it('fences a delayed first checkpoint after another replica replaces and closes its predecessor', async () => {
    const { ds } = await closedPredecessor('thread');
    const replacement = repoSwitch(ds);
    replacement.bindWorker(2);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquire = store.acquireSessionLease.bind(store);
    const paused = vi.spyOn(store, 'acquireSessionLease').mockImplementationOnce(async input => {
      enter();
      await held;
      return acquire(input);
    });
    const initial = replacement.flushPrimary();
    // Keep teardown safe even when a regression changes the rejection timing.
    const settled = initial.catch(() => {});
    const otherStore = new SqliteDurableCoordinationStore(join(root, 'coordination.db'), { now: () => now });
    const otherFacade = createDurableSessionFacade({ store: otherStore, ownerId: 'other-replica', leaseDurationMs: LEASE_MS });
    try {
      await entered;
      now += LEASE_MS + 1;
      const other = { larkAppId: app, scope: 'thread', chatId: CHAT_ID,
        session: makeSession('session-c', 'thread'), initConfig: {} } as DaemonSession;
      await admitDurableLarkSession({ facade: otherFacade, message: message('om_later'), session: other.session });
      registerSessionContractPrimary(app, otherFacade, id => { fences.push(id); });
      const later = controllerFor(other);
      later.bindWorker(3);
      await later.flushPrimary();
      const { operation } = later.beginControl('close');
      later.controlStarted(operation.operationId);
      await later.flushPrimary();
      later.controlResult(operation.operationId, 'confirmed');
      await later.flushPrimary();
      const closed = await lane(other.session);
      expect(closed.session).toMatchObject({ sessionId: 'session-c', status: 'closed' });
      await otherFacade.releaseLease(laneKey(other.session));

      release();
      await expect(initial).rejects.toThrow('canonical_contract_session_changed');

      expect(fences).toEqual(['session-b']);
      expect((await lane(other.session)).record).toEqual(closed.record);
    } finally {
      release();
      await settled;
      paused.mockRestore();
      registerSessionContractPrimary(app, facade, id => { fences.push(id); });
      await otherFacade.stop();
      await otherStore.close();
    }
  });

  it('refuses to write a successor row under another anchor', async () => {
    const { before } = await closedPredecessor('thread');
    const elsewhere = { ...makeSession('session-b', 'thread'), rootMessageId: 'om_other_root',
      durablePrimaryPredecessorSessionId: 'session-a' };

    expect(() => successorPrimarySessionValue(before.record, elsewhere)).toThrow('does not belong');
  });
});
