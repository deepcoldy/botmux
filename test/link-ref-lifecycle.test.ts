import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  buildTurnFailedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app-lifecycle', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-link-ref-lifecycle' },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {},
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  __testOnly_setupWorkerHandlers,
  initWorkerPool,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import {
  createLinkRefRuntime,
  setLinkRefRuntime,
  type LinkRefRuntime,
} from '../src/services/link-ref-runtime.js';
import {
  LinkRefError,
  LINK_REF_RETENTION_MS,
  type LinkRefTurnKey,
} from '../src/services/link-ref-types.js';
import type { WorkerToDaemon } from '../src/types.js';

const roots: string[] = [];

function makeWorkerSession(): DaemonSession {
  const worker = new EventEmitter() as EventEmitter & {
    killed: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 99123;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'session-lifecycle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
    },
    worker: worker as never,
    workerPort: 0,
    workerToken: 'token',
    larkAppId: 'app-lifecycle',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: 'test',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as DaemonSession;
}

function terminal(
  turnId: string,
  status: Extract<WorkerToDaemon, { type: 'turn_terminal' }>['status'],
  dispatchAttempt: number,
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'session-lifecycle',
    turnId,
    dispatchAttempt,
    status,
  };
}

describe('LinkRef lifecycle wiring', () => {
  beforeEach(() => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as never);
  });

  afterEach(() => {
    setLinkRefRuntime(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['completed', 'failed', 'cancelled', 'ambiguous'] as const)(
    'settles the exact %s terminal turn',
    async (status) => {
      const settleTurn = vi.fn();
      setLinkRefRuntime({ settleTurn } as unknown as LinkRefRuntime);
      const ds = makeWorkerSession();
      __testOnly_setupWorkerHandlers(ds, ds.worker as never);
      const attempt = status.length;

      (ds.worker as unknown as EventEmitter).emit(
        'message',
        terminal(`turn-${status}`, status, attempt),
      );

      await vi.waitFor(() => expect(settleTurn).toHaveBeenCalledWith({
        appId: 'app-lifecycle',
        sessionId: 'session-lifecycle',
        turnId: `turn-${status}`,
        dispatchAttempt: attempt,
      }));
    },
  );

  it('keeps settled refs resolvable, rejects later registration, and prunes exact boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-lifecycle-'));
    roots.push(root);
    let now = 1_000;
    const key: LinkRefTurnKey = {
      appId: 'app-a', sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2,
    };
    const ledger = new LinkRefLedger(root, { now: () => now });
    ledger.openTurn(key);
    const ref = ledger.registerBatch(key, [{
      originalUrl: 'https://example.test/authorize#done',
      sourceType: 'tool',
    }]).registered[0]!;
    ledger.savePendingDraft(key, `open {{botmux_link:${ref.refId}}}`);
    ledger.settleTurn(key);

    expect(ledger.resolveBatch(key, [ref.refId]).get(ref.refId)).toBe(ref.originalUrl);
    expect(() => ledger.registerBatch(key, [{
      originalUrl: 'https://example.test/later', sourceType: 'tool',
    }])).toThrowError(expect.objectContaining({ code: 'link_ref_turn_not_open' }));
    expect(ledger.pruneExpired(now + LINK_REF_RETENTION_MS - 1)).toEqual({ expired: 0, removed: 0 });
    now += LINK_REF_RETENTION_MS;
    expect(ledger.pruneExpired(now)).toEqual({ expired: 0, removed: 1 });
    expect(ledger.readPendingDraft(key)).toBeUndefined();
    ledger.close();
  });

  it('deletes rows and drafts only for the exact app/session', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-delete-session-'));
    roots.push(root);
    const ledger = new LinkRefLedger(root);
    const appA = { appId: 'app-a', sessionId: 'shared', turnId: 'turn-a' };
    const appB = { appId: 'app-b', sessionId: 'shared', turnId: 'turn-b' };
    ledger.openTurn(appA);
    ledger.openTurn(appB);
    ledger.savePendingDraft(appA, 'private draft A');
    ledger.savePendingDraft(appB, 'private draft B');

    expect(ledger.deleteSession('app-a', 'shared')).toBe(1);
    expect(ledger.readTurn(appA)).toBeUndefined();
    expect(ledger.readPendingDraft(appA)).toBeUndefined();
    expect(ledger.readTurn(appB)).toBeDefined();
    expect(ledger.readPendingDraft(appB)).toBe('private draft B');
    ledger.close();
  });

  it('silently settles a turn without a LinkRef row after the ledger is open', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-missing-settle-'));
    roots.push(root);
    const runtime = createLinkRefRuntime(root);
    runtime.registerSources({
      key: { appId: 'app', sessionId: 'session', turnId: 'enabled-turn' },
      mode: 'enabled',
      sources: [],
    });

    expect(() => runtime.settleTurn({
      appId: 'app', sessionId: 'session', turnId: 'disabled-turn',
    })).not.toThrow();
    runtime.close();
  });

  it('still surfaces real ledger failures while settling a turn', () => {
    const fakeLedger = {
      openTurn: vi.fn(),
      registerBatch: vi.fn(() => ({ registered: [], deduplicated: 0, filteredByLimit: 0 })),
      settleTurn: vi.fn(() => { throw new LinkRefError('link_ref_ledger_unavailable'); }),
      pruneExpired: vi.fn(() => ({ expired: 0, removed: 0 })),
      close: vi.fn(),
    };
    const runtime = createLinkRefRuntime('/unused', {
      ledger: () => fakeLedger as unknown as LinkRefLedger,
    });
    runtime.registerSources({
      key: { appId: 'app', sessionId: 'session', turnId: 'enabled-turn' },
      mode: 'enabled',
      sources: [],
    });

    expect(() => runtime.settleTurn({
      appId: 'app', sessionId: 'session', turnId: 'broken-turn',
    })).toThrowError(expect.objectContaining({ code: 'link_ref_ledger_unavailable' }));
    runtime.close();
  });

  it('prunes immediately and daily only after the first enabled ledger use', async () => {
    vi.useFakeTimers();
    const pruneExpired = vi.fn(() => ({ expired: 0, removed: 0 }));
    const fakeLedger = {
      openTurn: vi.fn(),
      registerBatch: vi.fn(() => ({ registered: [], deduplicated: 0, filteredByLimit: 0 })),
      pruneExpired,
      close: vi.fn(),
    };
    const runtime = createLinkRefRuntime('/unused', {
      ledger: () => fakeLedger as unknown as LinkRefLedger,
    });
    const key = { appId: 'app', sessionId: 'session', turnId: 'turn' };

    runtime.registerSources({
      key,
      mode: 'observe',
      sources: [{ sourceType: 'tool', kind: 'text', text: 'https://observe.test/path' }],
    });
    expect(pruneExpired).not.toHaveBeenCalled();

    runtime.registerSources({
      key,
      mode: 'enabled',
      sources: [{ sourceType: 'tool', kind: 'text', text: 'https://enabled.test/path' }],
    });
    expect(pruneExpired).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(pruneExpired).toHaveBeenCalledTimes(2);
    runtime.close();
  });
});
