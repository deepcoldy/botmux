import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// R7 gate1 — transfer-gate steer authorization behavioral proof.
//
// forkWorker reads steer authorization from the CliTurnPayload and, when a
// routing transfer holds the input gate open, must forward it through
// sendWorkerInput's OPTS (not the payload). The R6-B3 sibling fix (worker-pool
// 4554) added `...(gatedPrompt.codexAppSteerable === true ? {codexAppSteerable}
// : {})` to that hop. This test drives a REAL open transfer gate (via a pending
// detach in transferSession) and forks a codex-app opening THROUGH it, then
// asserts the buffered→replayed worker message AND the accepted dispatch ledger
// both carry the flag when the payload is steerable — and neither does when it
// is false/missing.

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR =
    `${process.env.TMPDIR ?? '/tmp'}/botmux-transfer-gate-steer-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    updateSession: vi.fn(),
  };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...args: any[]) => mocks.replyMessage(...args),
  };
});

vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return {
    ...actual,
    updateSession: (...args: any[]) => mocks.updateSession(...args),
  };
});

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: {
        larkAppId: 'app-transfer-gate-steer',
        cliId: 'codex-app',
        codexAppCleanInput: true,
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
      resolvedAllowedUsers: [],
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
import type { CliTurnPayload } from '../src/types.js';

function makeTransferringSession(sessionId: string): DaemonSession {
  return {
    session: {
      sessionId,
      chatId: 'oc_source',
      rootMessageId: 'om_source',
      title: 'transfer-gate steer',
      status: 'active',
      createdAt: new Date().toISOString(),
      scope: 'thread',
      chatType: 'group',
      larkAppId: 'app-transfer-gate-steer',
      ownerOpenId: 'ou_owner',
      workingDir: '/tmp',
      cliId: 'codex-app',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app-transfer-gate-steer',
    chatId: 'oc_source',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: '/tmp',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

/** Hold a transfer gate open with a pending detach, fork `payload` through the
 * gate (the R6-B3 hop), then release so the buffered message replays onto the
 * replacement worker. Returns the replayed worker `message` IPC and the ds so
 * callers can also inspect its accepted dispatch ledger. */
async function forkThroughOpenTransferGate(
  ds: DaemonSession,
  payload: string | CliTurnPayload,
): Promise<{ message: any; ds: DaemonSession }> {
  const registry = new Map<string, DaemonSession>([
    [sessionKey('om_source', ds.larkAppId), ds],
  ]);
  setActiveSessionsRegistry(registry);

  let releaseDetach!: (completed: boolean) => void;
  const detach = vi.fn(() => new Promise<boolean>((resolve) => {
    releaseDetach = resolve;
  }));
  const replacementSend = vi.fn();
  const replacement = Object.assign(new EventEmitter(), {
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: replacementSend,
    kill: vi.fn(),
  }) as any;
  const replacementFork = vi.fn(() => {
    ds.worker = replacement;
  });

  const moving = transferSession(
    ds.session.sessionId,
    'oc_target',
    'om_target',
    'group',
    'chat',
    { detachWorkerImpl: detach, forkWorkerImpl: replacementFork as any },
  );
  await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
  expect(isSessionTransferring(ds)).toBe(true);
  expect(ds.worker).toBeNull();

  // Fork the opening THROUGH the open gate: forkWorker sees the transfer gate,
  // routes the payload via sendWorkerInput, which buffers it (worker is null).
  const forked = forkWorker(ds, payload);
  expect(forked).toBe(true);
  // Nothing delivered yet — still buffered behind the gate.
  expect(replacementSend).not.toHaveBeenCalled();

  releaseDetach(true);
  await expect(moving).resolves.toEqual({ ok: true });

  const message = replacementSend.mock.calls
    .map((c) => c[0] as any)
    .find((m) => m?.type === 'message');
  return { message, ds };
}

describe('R7 gate1 — transfer-gate steer authorization', () => {
  it('forwards a STEERABLE codex-app opening through the open transfer gate — worker IPC AND ledger keep the flag', async () => {
    const ds = makeTransferringSession('session-transfer-gate-steer-true');
    const payload: CliTurnPayload = {
      content: 'steerable opening routed through transfer',
      codexAppInput: { text: 'steerable opening routed through transfer', clientUserMessageId: 'om_gate_true' },
      turnId: 'turn-gate-true',
      codexAppSteerable: true,
    } as CliTurnPayload;

    const { message, ds: settled } = await forkThroughOpenTransferGate(ds, payload);

    expect(message).toBeTruthy();
    expect(message.content).toContain('steerable opening');
    // Worker IPC carries the steer authorization (R6-B3 hop).
    expect(message.codexAppSteerable).toBe(true);

    // And the accepted dispatch ledger froze it too (acceptCodexAppDispatch).
    // The transfer-gate branch auto-generates the dispatch turnId, so match the
    // single accepted entry by content rather than by a caller-chosen turnId.
    const ledger = settled.session.codexAppDispatchLedger ?? [];
    const entry = ledger.find((e) => e.content?.includes('steerable opening'));
    expect(entry).toBeTruthy();
    expect(entry!.codexAppSteerable).toBe(true);
  });

  it('does NOT forward steer authorization when the payload is NOT steerable — forced serial through the gate', async () => {
    const ds = makeTransferringSession('session-transfer-gate-steer-false');
    // Explicit false — a non-human/control-rewrite/special-sink opening.
    const payload: CliTurnPayload = {
      content: 'non-steerable opening routed through transfer',
      codexAppInput: { text: 'non-steerable opening routed through transfer', clientUserMessageId: 'om_gate_false' },
      turnId: 'turn-gate-false',
    } as CliTurnPayload;

    const { message, ds: settled } = await forkThroughOpenTransferGate(ds, payload);

    expect(message).toBeTruthy();
    expect(message.content).toContain('non-steerable opening');
    // No steer authorization on the worker IPC …
    expect(message.codexAppSteerable).toBeUndefined();
    // … nor on the accepted dispatch ledger.
    const ledger = settled.session.codexAppDispatchLedger ?? [];
    const entry = ledger.find((e) => e.content?.includes('non-steerable opening'));
    expect(entry).toBeTruthy();
    expect(entry!.codexAppSteerable).toBeUndefined();
  });
});
