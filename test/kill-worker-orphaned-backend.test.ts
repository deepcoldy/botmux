/**
 * Unit tests for killWorker's orphaned-backing-session teardown (worker-pool.ts).
 *
 * Bug: clicking 「关闭会话」/close does not kill the CLI running in tmux when the
 * session has no live worker. A persistent backend (tmux/herdr/zellij) keeps its
 * backing session + CLI alive across a worker exit BY DESIGN (idle-suspend and
 * lazy-restore resume into it later). killWorker used to early-return when
 * `ds.worker` was null, so the 'close' IPC — and the worker-side destroySession()
 * that tears the backing session down — never ran. The orphaned CLI kept living
 * in tmux and still replied after /close.
 *
 * Fix: when there is no live worker, killWorker destroys the backing session
 * directly via the deterministic session name. Adopt sessions are skipped (the
 * user's own pane must never be killed).
 *
 * Run:  pnpm vitest run test/kill-worker-orphaned-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const { tmuxKill, herdrKill, zellijKill, getBotMock } = vi.hoisted(() => ({
  tmuxKill: vi.fn(),
  herdrKill: vi.fn(),
  zellijKill: vi.fn(),
  getBotMock: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: tmuxKill },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: herdrKill },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: zellijKill },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { killWorker } from '../src/core/worker-pool.js';

const SID = 'abcd1234-0000-0000-0000-000000000000';
const EXPECTED_NAME = 'bmx-abcd1234';

// All stream-card fields left unset on both ds and ds.session so
// persistStreamCardState() early-returns (no disk write) during clearUsageLimitState.
const ds = (over: Partial<DaemonSession> = {}, initOver: any = {}): DaemonSession => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  scope: 'chat',
  worker: null,
  session: { sessionId: SID },
  initConfig: { backendType: 'tmux', ...initOver },
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  vi.clearAllMocks();
  getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: {} } as any);
});

describe('killWorker — orphaned backing session teardown (no live worker)', () => {
  it('destroys the tmux backing session by deterministic name', () => {
    const d = ds({ managedTurnOrigin: { capability: 'cap-stale', turnId: 'om-stale' } }, { backendType: 'tmux' });
    killWorker(d);
    expect(tmuxKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
    expect(d.managedTurnOrigin).toBeUndefined();
  });

  it('destroys the herdr backing session', () => {
    killWorker(ds({}, { backendType: 'herdr' }));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('destroys the zellij backing session', () => {
    killWorker(ds({}, { backendType: 'zellij' }));
    expect(zellijKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('does nothing for a non-persistent pty backend', () => {
    killWorker(ds({}, { backendType: 'pty' }));
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(herdrKill).not.toHaveBeenCalled();
    expect(zellijKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (initConfig.adoptMode) — never kills the user\'s own pane', () => {
    killWorker(ds({}, { backendType: 'tmux', adoptMode: true }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('SKIPS adopt sessions (ds.adoptedFrom set)', () => {
    killWorker(ds({ adoptedFrom: { source: 'tmux' } as any }, { backendType: 'tmux' }));
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it('falls back to the bot config backendType when initConfig is absent (lazy-restored session)', () => {
    getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: { backendType: 'herdr' } } as any);
    killWorker(ds({ initConfig: undefined } as any, {}));
    expect(herdrKill).toHaveBeenCalledWith(EXPECTED_NAME);
    expect(tmuxKill).not.toHaveBeenCalled();
  });
});

describe('killWorker — with a live worker (unchanged path)', () => {
  it('sends the close IPC to the worker and does NOT kill the backing session directly', () => {
    const send = vi.fn();
    const d = ds({
      worker: { killed: false, send, once: vi.fn() } as any,
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
    }, { backendType: 'tmux' });
    killWorker(d);
    expect(send).toHaveBeenCalledWith({ type: 'close' });
    // The live worker's own destroySession() handles teardown — daemon must not
    // double-kill here.
    expect(tmuxKill).not.toHaveBeenCalled();
    expect(d.worker).toBeNull();
    expect(d.managedTurnOrigin).toBeUndefined();
  });
});
