import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession, FrozenCard } from '../src/core/types.js';
import { activeSessionKey } from '../src/core/types.js';

const pinMessageMock = vi.fn(async () => true);
const unpinMessageMock = vi.fn(async () => true);

vi.mock('../src/im/lark/client.js', () => ({
  pinMessage: (...args: any[]) => pinMessageMock(...args),
  unpinMessage: (...args: any[]) => unpinMessageMock(...args),
  deleteMessage: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } })),
  getAllBots: vi.fn(() => []),
  resolveUsageDisplay: vi.fn(() => 'streaming'),
}));
vi.mock('../src/services/frozen-card-store.js', () => ({ loadFrozenCards: vi.fn(() => new Map()), saveFrozenCards: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({ persistStreamCardState: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/config.js', () => ({ config: { web: { externalHost: 'localhost' }, session: { dataDir: '/tmp' } } }));
vi.mock('../src/global-config.js', () => ({ isRemoteAccessEnabled: vi.fn(() => false) }));
vi.mock('../src/platform/binding.js', () => ({ platformMachineBaseUrl: vi.fn(() => null), publicReverseProxyBaseUrl: vi.fn(() => null) }));
vi.mock('../src/services/session-store.js', () => ({ registerSessionBridgeSendMarkerCleanupFence: vi.fn(), cleanupSessionBridgeSendMarkers: vi.fn(), cleanupSessionBridgeSendMarkersNow: vi.fn(), closeSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn() }));
vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));
vi.mock('../src/im/lark/card-builder.js', () => ({ buildStreamingCard: vi.fn(() => '{}'), buildSessionCard: vi.fn(() => '{}'), buildTuiPromptCard: vi.fn(() => '{}'), buildTuiPromptResolvedCard: vi.fn(() => '{}'), getCliDisplayName: vi.fn(() => 'Claude') }));

import {
  __testOnly_resetPinStreamingCardReconcileQueue,
  __testOnly_waitForPinStreamingCardIdle,
  CARD_POSTING_SENTINEL,
  pinStreamingCardIfEnabled,
  reconcileBotStreamingCardPins,
  reconcileStreamingCardPins,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { getBot } from '../src/bot-registry.js';

const getBotMock = getBot as ReturnType<typeof vi.fn>;

async function drainMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeDs(
  card = 'om_current',
  frozenCards?: Map<string, FrozenCard>,
  sessionId = 'pin-session',
  rootMessageId = 'om_root',
): DaemonSession {
  return { session: { sessionId, rootMessageId, chatId: 'oc_chat', title: 'pin', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group' }, worker: null, workerPort: null, workerToken: null, larkAppId: 'app-pin', chatId: 'oc_chat', chatType: 'group', spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: true, scope: 'thread', streamCardId: card, frozenCards } as any;
}
function withChat(ds: DaemonSession, chatId: string): DaemonSession {
  return {
    ...ds,
    chatId,
    session: { ...ds.session, chatId },
  } as DaemonSession;
}
function activate(ds: DaemonSession) { setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]])); }

describe('streaming-card pin policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetPinStreamingCardReconcileQueue();
    setActiveSessionsRegistry(new Map());
    pinMessageMock.mockResolvedValue(true);
    unpinMessageMock.mockResolvedValue(true);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
  });
  it('does nothing when disabled, sentinel, inactive, displaced, or changed', async () => {
    const ds = makeDs(); activate(ds);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: false } } as any);
    expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
    ds.streamCardId = CARD_POSTING_SENTINEL; expect(await pinStreamingCardIfEnabled(ds, CARD_POSTING_SENTINEL)).toBe(false);
    ds.streamCardId = 'om_current'; ds.session.status = 'closed'; expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    ds.session.status = 'active'; setActiveSessionsRegistry(new Map()); expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    expect(pinMessageMock).not.toHaveBeenCalled();
  });

  it('does not pin when the chat is opted out even if the bot-level master switch is on', async () => {
    const ds = makeDs();
    activate(ds);
    getBotMock.mockReturnValue({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: ['oc_chat'],
      },
    } as any);

    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('fails closed when the active session registry is unavailable', async () => {
    const ds = makeDs();
    setActiveSessionsRegistry(undefined as any);

    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });
  it('pins only the active owned current card and compensates a stale success', async () => {
    const ds = makeDs(); activate(ds);
    let resolvePin!: (value: boolean) => void; pinMessageMock.mockImplementation(() => new Promise(resolve => { resolvePin = resolve; }));
    const pending = pinStreamingCardIfEnabled(ds, 'om_current');
    await drainMicrotasks(1);
    ds.streamCardId = 'om_new'; resolvePin(true);
    expect(await pending).toBe(false);
    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
  });
  it('reconciles enabled in pin-then-session-wide-frozen-unpin order and disable unpins every unique real id', async () => {
    const frozen = new Map<string, FrozenCard>([['a', { messageId: 'om_same_topic', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'one' }], ['b', { messageId: 'om_other_topic', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'two' }], ['c', { messageId: 'om_current', content: '', title: '', displayMode: 'hidden' }]]);
    const ds = makeDs('om_current', frozen); activate(ds);
    await reconcileStreamingCardPins(ds, true);
    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock.mock.calls.map(c => c[1])).toEqual(['om_same_topic', 'om_other_topic']);
    pinMessageMock.mockClear(); unpinMessageMock.mockClear();
    await reconcileStreamingCardPins(ds, false);
    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(new Set(unpinMessageMock.mock.calls.map(c => c[1]))).toEqual(new Set(['om_current']));
  });

  it('default-off with no feature-owned ids is zero-call and leaves manual pins untouched', async () => {
    const ds = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
    );
    activate(ds);

    await reconcileStreamingCardPins(ds, false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('explicit on-to-off toggle cleans known current and frozen ids after provenance reset', async () => {
    const ds = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
    );
    activate(ds);
    let pinStreamingCard = true;
    getBotMock.mockImplementation(() => ({
      config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard },
    } as any));

    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(true);

    __testOnly_resetPinStreamingCardReconcileQueue();
    activate(ds);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    pinStreamingCard = false;
    reconcileBotStreamingCardPins('app-pin', false);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(new Set(unpinMessageMock.mock.calls.map(call => call[1]))).toEqual(new Set([
      'om_current',
      'om_frozen',
    ]));
  });

  it('reconcile is a zero-call no-op for apiOnly and HTTP virtual transports', async () => {
    const ds = makeDs();
    activate(ds);
    getBotMock.mockReturnValue({
      config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true, apiOnly: true },
    } as any);

    await reconcileStreamingCardPins(ds, true);
    await reconcileStreamingCardPins(ds, false);

    getBotMock.mockReturnValue({
      config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true },
    } as any);
    ds.chatId = 'http_async_pin_reconcile';
    activate(ds);
    await reconcileStreamingCardPins(ds, true);
    await reconcileStreamingCardPins(ds, false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('forgets ownership only after a successful Unpin so a failed cleanup can retry', async () => {
    const ds = makeDs();
    activate(ds);
    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(true);
    unpinMessageMock.mockResolvedValueOnce(false);

    await reconcileStreamingCardPins(ds, false);
    await reconcileStreamingCardPins(ds, false);

    expect(unpinMessageMock.mock.calls.map(call => call[1])).toEqual(['om_current', 'om_current']);
  });

  it('retains ownership after a thrown Unpin so a later cleanup retries', async () => {
    const ds = makeDs();
    activate(ds);
    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(true);
    unpinMessageMock.mockRejectedValueOnce(new Error('transport reset'));

    await reconcileStreamingCardPins(ds, false);
    await reconcileStreamingCardPins(ds, false);

    expect(unpinMessageMock.mock.calls.map(call => call[1])).toEqual(['om_current', 'om_current']);
  });

  it('serializes a close cleanup Unpin before a same-card resume Pin', async () => {
    const ds = makeDs();
    activate(ds);
    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(true);
    const releaseUnpin = deferred<boolean>();
    const unpinStarted = deferred<void>();
    const calls: string[] = [];
    unpinMessageMock.mockImplementationOnce(() => {
      calls.push('unpin');
      unpinStarted.resolve();
      return releaseUnpin.promise;
    });
    pinMessageMock.mockImplementation(() => { calls.push('pin'); return Promise.resolve(true); });

    const closing = reconcileStreamingCardPins(ds, false);
    // This explicit test barrier proves the queued Unpin has been issued
    // before resuming; no timing-sensitive microtask or timer flushing.
    await unpinStarted.promise;
    expect(calls).toEqual(['unpin']);
    const resuming = pinStreamingCardIfEnabled(ds, 'om_current');
    expect(calls).toEqual(['unpin']);

    releaseUnpin.resolve(true);
    await closing;
    await expect(resuming).resolves.toBe(true);
    expect(calls).toEqual(['unpin', 'pin']);
  });

  it('does not let a pre-reset deferred Unpin forget replacement provenance', async () => {
    const original = makeDs();
    activate(original);
    await expect(pinStreamingCardIfEnabled(original, 'om_current')).resolves.toBe(true);
    const unpinStarted = deferred<void>();
    const releaseUnpin = deferred<boolean>();
    unpinMessageMock.mockImplementationOnce(() => {
      unpinStarted.resolve();
      return releaseUnpin.promise;
    });
    const retiring = reconcileStreamingCardPins(original, false);
    await unpinStarted.promise;

    __testOnly_resetPinStreamingCardReconcileQueue();
    const replacement = makeDs();
    activate(replacement);
    await expect(pinStreamingCardIfEnabled(replacement, 'om_current')).resolves.toBe(true);
    releaseUnpin.resolve(true);
    await retiring;

    unpinMessageMock.mockClear();
    await reconcileStreamingCardPins(replacement, false);
    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
  });

  it('reconciles all active sessions for the matching bot, ignores other bots, and isolates one session failure', async () => {
    const first = makeDs('om_first', undefined, 'pin-session-1', 'om_root_1');
    const second = makeDs('om_second', undefined, 'pin-session-2', 'om_root_2');
    const otherBot = { ...makeDs('om_other', undefined, 'pin-session-3', 'om_root_3'), larkAppId: 'app-other' } as DaemonSession;
    const inactive = { ...makeDs('om_inactive', undefined, 'pin-session-4', 'om_root_4'), session: { ...makeDs('om_inactive', undefined, 'pin-session-4', 'om_root_4').session, status: 'closed' } } as DaemonSession;
    const displaced = makeDs('om_displaced', undefined, 'pin-session-5', 'om_root_shared');
    const winner = makeDs('om_winner', undefined, 'pin-session-6', 'om_root_shared');
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
      [activeSessionKey(otherBot), otherBot],
      [activeSessionKey(inactive), inactive],
      [activeSessionKey(displaced), displaced],
      [activeSessionKey(winner), winner],
    ]));

    pinMessageMock.mockImplementation(async (_appId: string, messageId: string) => {
      if (messageId === 'om_first') throw new Error('pin failed');
      return true;
    });

    reconcileBotStreamingCardPins('app-pin', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(pinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_first'],
      ['app-pin', 'om_second'],
      ['app-pin', 'om_winner'],
    ]);
    expect(pinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_inactive');
    expect(pinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_displaced');
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-other', 'om_other');
  });

  it('bounds bot-wide reconciliation to at most 20 concurrent sessions', async () => {
    const sessions = Array.from({ length: 45 }, (_, index) =>
      makeDs(`om_card_${index}`, undefined, `pin-session-${index}`, `om_root_${index}`));
    setActiveSessionsRegistry(new Map(sessions.map(ds => [activeSessionKey(ds), ds])));
    const releasePins = deferred<void>();
    let concurrent = 0;
    let maxConcurrent = 0;
    pinMessageMock.mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await releasePins.promise;
      concurrent -= 1;
      return true;
    });

    reconcileBotStreamingCardPins('app-pin', true);
    await drainMicrotasks(5);
    const observedBeforeRelease = maxConcurrent;
    releasePins.resolve();
    await __testOnly_waitForPinStreamingCardIdle();

    expect(observedBeforeRelease).toBeGreaterThan(0);
    expect(observedBeforeRelease).toBeLessThanOrEqual(20);
    expect(pinMessageMock).toHaveBeenCalledTimes(45);
  });

  it('serializes bot-wide disable then enable and reruns the latest desired state after deferred unpin completes', async () => {
    const first = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
      'pin-session-1',
      'om_root_1',
    );
    const second = makeDs('om_second', undefined, 'pin-session-2', 'om_root_2');
    activate(first);
    await reconcileStreamingCardPins(first, true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();
    let resolveCurrentUnpin!: (value: boolean) => void;
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_current') {
        return new Promise<boolean>(resolve => { resolveCurrentUnpin = resolve; });
      }
      return Promise.resolve(true);
    });

    setActiveSessionsRegistry(new Map([[activeSessionKey(first), first]]));
    reconcileBotStreamingCardPins('app-pin', false);
    await drainMicrotasks();

    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(pinMessageMock).not.toHaveBeenCalled();

    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    reconcileBotStreamingCardPins('app-pin', true);
    await drainMicrotasks(1);

    expect(pinMessageMock).not.toHaveBeenCalled();

    resolveCurrentUnpin(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_current'],
      ['app-pin', 'om_second'],
    ]);
  });

  it('serializes bot-wide enable then disable and ends at the latest off state after deferred pin completes', async () => {
    const ds = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
    );
    activate(ds);
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_current') {
        return new Promise<boolean>(resolve => { resolvePin = resolve; });
      }
      return Promise.resolve(true);
    });

    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
    reconcileBotStreamingCardPins('app-pin', true);
    await drainMicrotasks();

    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock).not.toHaveBeenCalled();

    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: false } } as any);
    reconcileBotStreamingCardPins('app-pin', false);
    await drainMicrotasks(1);

    expect(unpinMessageMock).not.toHaveBeenCalled();

    resolvePin(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock).toHaveBeenCalledTimes(1);
    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_current'],
      ['app-pin', 'om_current'],
      ['app-pin', 'om_frozen'],
    ]);
  });

  it('chat-scoped opt-out reconciles only matching chat sessions while another chat remains enabled', async () => {
    const first = makeDs('om_chat_one', undefined, 'pin-session-1', 'om_root_1');
    const second = { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2'), chatId: 'oc_chat_2', session: { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2').session, chatId: 'oc_chat_2' } } as DaemonSession;
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    await expect(pinStreamingCardIfEnabled(first, 'om_chat_one')).resolves.toBe(true);
    await expect(pinStreamingCardIfEnabled(second, 'om_chat_two')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    getBotMock.mockImplementation(((larkAppId: string) => ({
      config: {
        larkAppId,
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: ['oc_chat'],
      },
    })) as any);

    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat', false);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_chat_one'],
    ]);
    expect(pinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_chat_two');
  });

  it('rapid mixed bot/chat writes converge in serialized order to the live effective policy', async () => {
    const first = makeDs('om_chat_one', undefined, 'pin-session-1', 'om_root_1');
    const second = { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2'), chatId: 'oc_chat_2', session: { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2').session, chatId: 'oc_chat_2' } } as DaemonSession;
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    const desiredStates: Array<{ master: boolean; disabledChats?: string[] }> = [
      { master: false },
      { master: true, disabledChats: ['oc_chat'] },
      { master: true },
    ];
    let index = 0;
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: desiredStates[index]?.master === true,
        noPinStreamingCardChats: desiredStates[index]?.disabledChats,
      },
    }) as any);

    reconcileBotStreamingCardPins('app-pin', false);
    index = 1;
    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat', false);
    index = 2;
    reconcileBotStreamingCardPins('app-pin', true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock.mock.calls.map(c => c[1])).toContain('om_chat_one');
    expect(pinMessageMock.mock.calls.map(c => c[1])).toContain('om_chat_two');
  });

  it('preserves authoritative cleanup for each deferred chat-scope effective on-to-off while coalescing later chat requests', async () => {
    const first = makeDs('om_chat_one', undefined, 'pin-session-1', 'om_root_1');
    const second = {
      ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2'),
      chatId: 'oc_chat_2',
      session: { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2').session, chatId: 'oc_chat_2' },
    } as DaemonSession;
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    await expect(pinStreamingCardIfEnabled(first, 'om_chat_one')).resolves.toBe(true);
    await expect(pinStreamingCardIfEnabled(second, 'om_chat_two')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    let disabledChats: string[] = ['oc_chat'];
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    const releaseFirstUnpin = deferred<boolean>();
    const firstUnpinStarted = deferred<void>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_chat_one') {
        firstUnpinStarted.resolve();
        return releaseFirstUnpin.promise;
      }
      return Promise.resolve(true);
    });

    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat', false);
    await firstUnpinStarted.promise;

    disabledChats = ['oc_chat', 'oc_chat_2'];
    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat_2', false);
    await drainMicrotasks(1);
    expect(unpinMessageMock.mock.calls.map(c => c[1])).toEqual(['om_chat_one']);

    releaseFirstUnpin.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_chat_one'],
      ['app-pin', 'om_chat_two'],
    ]);
    expect(pinMessageMock).not.toHaveBeenCalled();
  });

  it('does not grant broad cleanup to chats already effectively off across global off/on with existing opt-outs', async () => {
    const first = makeDs('om_chat_one', undefined, 'pin-session-1', 'om_root_1');
    const second = {
      ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2'),
      chatId: 'oc_chat_2',
      session: { ...makeDs('om_chat_two', undefined, 'pin-session-2', 'om_root_2').session, chatId: 'oc_chat_2' },
    } as DaemonSession;
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    await expect(pinStreamingCardIfEnabled(first, 'om_chat_one')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    const desiredStates: Array<{ master: boolean; disabledChats?: string[] }> = [
      { master: false, disabledChats: ['oc_chat_2'] },
      { master: true, disabledChats: ['oc_chat_2'] },
    ];
    let index = 0;
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: desiredStates[index]?.master === true,
        noPinStreamingCardChats: desiredStates[index]?.disabledChats,
      },
    }) as any);

    reconcileBotStreamingCardPins('app-pin', false);
    index = 1;
    reconcileBotStreamingCardPins('app-pin', true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_chat_one'],
    ]);
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_chat_two');
    expect(pinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_chat_one'],
    ]);
  });

  it('global-off later-batch cleanup keeps transition-time authority even if master-off opt-out mutates live noPin afterwards', async () => {
    const leading = Array.from({ length: 20 }, (_, index) =>
      makeDs(`om_leading_${index}`, undefined, `pin-leading-${index}`, `om_root_leading_${index}`));
    const target = withChat(
      makeDs('om_target_late', undefined, 'pin-target-late', 'om_root_target_late'),
      'oc_target_late',
    );
    setActiveSessionsRegistry(new Map([
      ...leading.map(ds => [activeSessionKey(ds), ds] as const),
      [activeSessionKey(target), target] as const,
    ]));

    let masterEnabled = true;
    let disabledChats: string[] | undefined;
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: masterEnabled,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    await expect(pinStreamingCardIfEnabled(target, 'om_target_late')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    const firstBatchStarted = deferred<void>();
    const releaseFirstBatch = deferred<boolean>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_leading_0') {
        firstBatchStarted.resolve();
        return releaseFirstBatch.promise;
      }
      return Promise.resolve(true);
    });

    masterEnabled = false;
    reconcileBotStreamingCardPins('app-pin', false);
    await firstBatchStarted.promise;

    disabledChats = ['oc_target_late'];
    await drainMicrotasks(1);
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_late');

    releaseFirstBatch.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_target_late');
  });

  it('global-off later-batch cleanup does not gain authority when a previously opted-out chat is re-enabled under master-off', async () => {
    const leading = Array.from({ length: 20 }, (_, index) =>
      makeDs(`om_leading_${index}`, undefined, `pin-leading-${index}`, `om_root_leading_${index}`));
    const target = withChat(
      makeDs('om_target_manual', undefined, 'pin-target-manual', 'om_root_target_manual'),
      'oc_target_manual',
    );
    setActiveSessionsRegistry(new Map([
      ...leading.map(ds => [activeSessionKey(ds), ds] as const),
      [activeSessionKey(target), target] as const,
    ]));

    let masterEnabled = true;
    let disabledChats: string[] | undefined = ['oc_target_manual'];
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: masterEnabled,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    const firstBatchStarted = deferred<void>();
    const releaseFirstBatch = deferred<boolean>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_leading_0') {
        firstBatchStarted.resolve();
        return releaseFirstBatch.promise;
      }
      return Promise.resolve(true);
    });

    masterEnabled = false;
    reconcileBotStreamingCardPins('app-pin', false);
    await firstBatchStarted.promise;

    disabledChats = undefined;
    await drainMicrotasks(1);
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_manual');

    releaseFirstBatch.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_manual');
  });

  it('chat-off authority applies only to sessions active at that transition, not newer same-chat sessions', async () => {
    const first = withChat(
      makeDs('om_chat_old', undefined, 'pin-session-old', 'om_root_old'),
      'oc_chat_shared',
    );
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
    ]));
    await expect(pinStreamingCardIfEnabled(first, 'om_chat_old')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    let disabledChats: string[] | undefined = ['oc_chat_shared'];
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    const releaseOldUnpin = deferred<boolean>();
    const oldUnpinStarted = deferred<void>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_chat_old') {
        oldUnpinStarted.resolve();
        return releaseOldUnpin.promise;
      }
      return Promise.resolve(true);
    });

    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat_shared', false);
    await oldUnpinStarted.promise;

    const replacement = withChat(
      makeDs('om_chat_new', undefined, 'pin-session-new', 'om_root_new'),
      'oc_chat_shared',
    );
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(replacement), replacement],
    ]));

    releaseOldUnpin.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_chat_old'],
    ]);
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_chat_new');
  });

  it('chat-off queued cleanup snapshots exact transition-time ids, not a later replacement current card on the same session', async () => {
    const leading = Array.from({ length: 20 }, (_, index) =>
      withChat(
        makeDs(`om_leading_${index}`, undefined, `pin-leading-${index}`, `om_root_leading_${index}`),
        'oc_target_shared',
      ));
    const target = withChat(
      makeDs(
        'om_target_old',
        new Map<string, FrozenCard>([['frozen', { messageId: 'om_target_frozen', content: '', title: '', displayMode: 'hidden' }]]),
        'pin-target-shared',
        'om_root_target_shared',
      ),
      'oc_target_shared',
    );
    setActiveSessionsRegistry(new Map([
      ...leading.map(ds => [activeSessionKey(ds), ds] as const),
      [activeSessionKey(target), target] as const,
    ]));

    let disabledChats: string[] | undefined;
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    await expect(pinStreamingCardIfEnabled(leading[0]!, 'om_leading_0')).resolves.toBe(true);
    await expect(pinStreamingCardIfEnabled(target, 'om_target_old')).resolves.toBe(true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();

    const firstBatchStarted = deferred<void>();
    const releaseFirstBatch = deferred<boolean>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_leading_0') {
        firstBatchStarted.resolve();
        return releaseFirstBatch.promise;
      }
      return Promise.resolve(true);
    });

    disabledChats = ['oc_target_shared'];
    reconcileBotStreamingCardPins('app-pin', true, 'oc_target_shared', false);
    await firstBatchStarted.promise;

    target.streamCardId = 'om_target_new_manual';
    await drainMicrotasks(1);
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_old');
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_new_manual');

    releaseFirstBatch.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_target_old');
    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_target_frozen');
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_target_new_manual');
  });

  it('chat-off drains captured later-batch ids after their queued session vanishes from the active registry', async () => {
    const leading = Array.from({ length: 20 }, (_, index) =>
      withChat(
        makeDs(`om_vanished_leading_${index}`, undefined, `pin-vanished-leading-${index}`, `om_root_vanished_leading_${index}`),
        'oc_vanished',
      ));
    const target = withChat(
      makeDs('om_vanished_target_old', undefined, 'pin-vanished-target', 'om_root_vanished_target'),
      'oc_vanished',
    );
    setActiveSessionsRegistry(new Map([
      ...leading.map(ds => [activeSessionKey(ds), ds] as const),
      [activeSessionKey(target), target] as const,
    ]));

    let disabledChats: string[] | undefined;
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    const firstReconcileStarted = deferred<void>();
    const releaseFirstReconcile = deferred<boolean>();
    pinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_vanished_leading_0') {
        firstReconcileStarted.resolve();
        return releaseFirstReconcile.promise;
      }
      return Promise.resolve(true);
    });

    reconcileBotStreamingCardPins('app-pin', true);
    await firstReconcileStarted.promise;

    disabledChats = ['oc_vanished'];
    reconcileBotStreamingCardPins('app-pin', true, 'oc_vanished', false);

    setActiveSessionsRegistry(new Map([
      ...leading.map(ds => [activeSessionKey(ds), ds] as const),
    ]));

    releaseFirstReconcile.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_vanished_target_old');
  });

  it('does not unpin captured authoritative ids for an apiOnly session', async () => {
    const ds = makeDs('om_api_only_captured');
    activate(ds);
    getBotMock.mockReturnValue({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        apiOnly: true,
        noPinStreamingCardChats: ['oc_chat'],
      },
    } as any);

    reconcileBotStreamingCardPins('app-pin', true, 'oc_chat', false);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('does not unpin captured authoritative ids when transport becomes apiOnly before queued drain', async () => {
    const leading = withChat(
      makeDs('om_transport_drift_leading', undefined, 'pin-transport-drift-leading', 'om_transport_drift_leading_root'),
      'oc_transport_leading',
    );
    const target = withChat(
      makeDs('om_transport_drift', undefined, 'pin-transport-drift-target', 'om_transport_drift_target_root'),
      'oc_transport_target',
    );
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(leading), leading],
      [activeSessionKey(target), target],
    ]));
    let apiOnly = false;
    let disabledChats: string[] | undefined = ['oc_transport_leading'];
    getBotMock.mockImplementation(() => ({
      config: {
        larkAppId: 'app-pin',
        cliId: 'claude-code',
        pinStreamingCard: true,
        apiOnly,
        noPinStreamingCardChats: disabledChats,
      },
    }) as any);

    const firstReconcileStarted = deferred<void>();
    const releaseFirstReconcile = deferred<boolean>();
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_transport_drift_leading') {
        firstReconcileStarted.resolve();
        return releaseFirstReconcile.promise;
      }
      return Promise.resolve(true);
    });

    reconcileBotStreamingCardPins('app-pin', true, 'oc_transport_leading', false);
    await firstReconcileStarted.promise;

    disabledChats = ['oc_transport_leading', 'oc_transport_target'];
    reconcileBotStreamingCardPins('app-pin', true, 'oc_transport_target', false);
    apiOnly = true;
    releaseFirstReconcile.resolve(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_transport_drift');
  });
});
