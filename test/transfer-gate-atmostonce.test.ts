import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'bun:test';

// codex #818 P1-5 — transfer-gate atMostOnce forwarding behavioral proof.
//
// When a routing transfer holds the input gate open, forkWorker reroutes the
// opening through sendWorkerInput (worker-pool ~5786). A KEYED (at-most-once)
// follow-up fork must forward `resumeOrTurnId.atMostOnce` into that hop, or the
// replacement CLI's buffered input is replayable and a crash after the daemon
// terminalized the turn re-runs it. This drives a REAL open transfer gate and
// forks THROUGH it, asserting the buffered→replayed worker `message` IPC carries
// `atMostOnce` when the fork requested it — and does NOT when it didn't.
//
// Deleting the `...(gatedAtMostOnce ? { atMostOnce: true } : {})` line in
// worker-pool's transfer-gate branch turns the positive case RED.

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR =
    `${process.env.TMPDIR ?? '/tmp'}/botmux-transfer-gate-atmostonce-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return { replyMessage: vi.fn(async () => 'om_reply'), updateSession: vi.fn() };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, replyMessage: (...args: any[]) => mocks.replyMessage(...args) };
});
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, updateSession: (...args: any[]) => mocks.updateSession(...args) };
});
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: { larkAppId: 'app-transfer-gate-amo', cliId: 'claude-code' },
      botName: 'TestBot', botOpenId: 'ou_bot', resolvedAllowedUsers: [],
    })),
  };
});

import {
  forkWorker,
  isSessionTransferring,
  setActiveSessionsRegistry,
  transferSession,
} from '../src/core/worker-pool.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ForkResumeOrTurnId } from '../src/core/worker-pool.js';

function makeTransferringSession(sessionId: string): DaemonSession {
  return {
    session: {
      sessionId, chatId: 'oc_source', rootMessageId: 'om_source', title: 'transfer-gate amo',
      status: 'active', createdAt: new Date().toISOString(), scope: 'thread', chatType: 'group',
      larkAppId: 'app-transfer-gate-amo', ownerOpenId: 'ou_owner', workingDir: '/tmp', cliId: 'claude-code',
    },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'app-transfer-gate-amo',
    chatId: 'oc_source', chatType: 'group', scope: 'thread', spawnedAt: Date.now(),
    cliVersion: '1.0.0', lastMessageAt: Date.now(), hasHistory: true, workingDir: '/tmp',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

/** Hold a transfer gate open, fork the opening THROUGH it with `resumeOrTurnId`,
 * release, and return the replayed worker `message` IPC. */
async function forkThroughOpenTransferGate(
  ds: DaemonSession,
  resumeOrTurnId: ForkResumeOrTurnId,
): Promise<any> {
  const registry = new Map<string, DaemonSession>([[sessionKey('om_source', ds.larkAppId), ds]]);
  setActiveSessionsRegistry(registry);

  let releaseDetach!: (completed: boolean) => void;
  const detach = vi.fn(() => new Promise<boolean>((resolve) => { releaseDetach = resolve; }));
  const replacementSend = vi.fn();
  const replacement = Object.assign(new EventEmitter(), {
    killed: false, connected: true, exitCode: null, signalCode: null, send: replacementSend, kill: vi.fn(),
  }) as any;
  const replacementFork = vi.fn(() => { ds.worker = replacement; });

  const moving = transferSession(
    ds.session.sessionId, 'oc_target', 'om_target', 'group', 'chat',
    { detachWorkerImpl: detach, forkWorkerImpl: replacementFork as any },
  );
  await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
  expect(isSessionTransferring(ds)).toBe(true);
  expect(ds.worker).toBeNull();

  const forked = forkWorker(ds, 'keyed follow-up routed through transfer', resumeOrTurnId);
  expect(forked).toBe(true);
  expect(replacementSend).not.toHaveBeenCalled(); // buffered behind the gate

  releaseDetach(true);
  await expect(moving).resolves.toEqual({ ok: true });

  return replacementSend.mock.calls.map((c) => c[0] as any).find((m) => m?.type === 'message');
}

describe('transfer-gate atMostOnce forwarding (codex #818 P1-5)', () => {
  it('forwards atMostOnce through the open transfer gate → replayed worker IPC carries it', async () => {
    const ds = makeTransferringSession('session-transfer-gate-amo-true');
    const message = await forkThroughOpenTransferGate(ds, {
      resume: true, turnId: 'turn-amo-true', atMostOnce: true,
    });
    expect(message).toBeTruthy();
    expect(message.content).toContain('keyed follow-up');
    // The at-most-once flag survives the fork→sendWorkerInput reroute: without it
    // the replacement CLI would replay the keyed input after a crash+terminalize.
    expect(message.atMostOnce).toBe(true);
  });

  it('does NOT set atMostOnce when the fork did not request it (ordinary follow-up stays replayable)', async () => {
    const ds = makeTransferringSession('session-transfer-gate-amo-false');
    const message = await forkThroughOpenTransferGate(ds, {
      resume: true, turnId: 'turn-amo-false',
    });
    expect(message).toBeTruthy();
    expect(message.content).toContain('keyed follow-up');
    expect(message.atMostOnce).toBeUndefined();
  });
});
