/**
 * Unit tests for the per-group substitute toggle card action
 * (`toggle_substitute`):
 *
 *   - explicit desired on/off writes the real per-bot + per-chat store;
 *   - stale / cross-chat / transferred / closed cards are rejected;
 *   - live config, allow-list, excludedChats, topicGroups and strict chat mode
 *     are re-checked before the final write;
 *   - permission stays behind the canOperate sensitive-action gate;
 *   - slow rejections surface a visible DM through afterAck.
 *
 * Harness follows card-handler-stop-compact.test.ts.
 *
 * Run: pnpm vitest run test/card-handler-substitute-toggle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks (before importing the module under test) ───────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
  getMessageDetail: vi.fn(),
  getChatModeStrict: vi.fn(async () => 'group'),
  getCachedChatModeStrict: vi.fn(() => 'group'),
  isHumanOpenId: vi.fn(() => true),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  getBotClient: vi.fn(),
}));

vi.mock('../src/services/bot-config-store.js', () => ({
  findConfigField: vi.fn(),
  applyConfigField: vi.fn(async () => ({ ok: true, newText: 'on' })),
  coerceConfigValue: vi.fn(),
  getConfigCardData: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

const sendWorkerSessionInputMock = vi.fn();
const isSessionTransferringMock = vi.fn(() => false);

vi.mock('../src/core/worker-pool.js', async () => {
  const { supportsIdleAutoCompact } = await vi.importActual<typeof import('../src/core/idle-auto-compact.js')>('../src/core/idle-auto-compact.js');
  return {
  // Same projection as the real helper, over the pure support predicate.
  sessionSupportsIdleAutoCompact: (ds: any) => supportsIdleAutoCompact({
    cliId: ds.session.cliId ?? 'claude-code',
    backendType: ds.initConfig?.backendType ?? ds.session.backendType,
    codexRpcInput: ds.initConfig?.codexRpcInput === true,
    adopted: !!ds.adoptedFrom || !!ds.session.adoptedFrom,
    headless: !!ds.session.headless,
    vcMeetingReceiver: !!ds.session.vcMeetingReceiver,
  }),
  setSessionReasoningEffort: vi.fn(() => 'saved'),
  sessionReasoningControl: vi.fn(() => ({ choices: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] })),
  updateCodexCliEffort: vi.fn(async () => ({ status: 'future_only', reason: 'cli_next_turn' })),
  forkWorker: vi.fn(),
  sendWorkerInput: vi.fn(),
  sendWorkerSessionInput: (...args: any[]) => sendWorkerSessionInputMock(...args),
  killWorker: vi.fn(),
  closeSession: vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false })),
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  scheduleCardPatch: vi.fn(),
  parkStreamCard: vi.fn(),
  clearUsageLimitState: vi.fn(),
  cardUsageLimit: vi.fn(() => undefined),
  writableTerminalLinkFor: vi.fn(() => undefined),
  workerHasInitialized: vi.fn(() => true),
  sessionSupportsWebTerminal: vi.fn(() => true),
  readableTerminalUrlFor: vi.fn(() => 'https://example.com/term'),
  liveReadableTerminalUrlFor: vi.fn(() => 'https://example.com/term'),
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: vi.fn(),
  deliverEphemeralOrReply: vi.fn(),
  CARD_POSTING_SENTINEL: '__posting__',
  requestSessionRestart: vi.fn(),
  isSessionTransferring: (...args: any[]) => isSessionTransferringMock(...args),
  getDaemonStreamingCardUsageSnapshot: vi.fn(() => undefined),
  withActiveSessionKeyLock: vi.fn(async (_map: any, _key: string, action: () => any) => action()),
  buildStreamingCardJson: vi.fn(() => '{"elements":[]}'),
  substituteCardControlFor: vi.fn(() => undefined),
  silentIdleCardFlag: vi.fn(() => false),
  idleCardLabel: vi.fn(() => undefined),
  streamCardLabel: vi.fn(() => undefined),
  dshRuntimeForSession: vi.fn(() => undefined),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicCliInput: vi.fn(() => ({ content: 'mock-prompt' })),
  getAvailableBots: vi.fn(async () => []),
  persistStreamCardState: vi.fn(),
  resumeSession: vi.fn(),
  rememberLastCliInput: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
}));

vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  canOperate: vi.fn(() => true),
  canTalk: vi.fn(() => true),
}));

vi.mock('../src/core/session-activity.js', () => ({
  publishAttentionPatch: vi.fn(),
  publishClosedSessionPatch: vi.fn(),
  announcePendingRepoSession: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/services/local-cli-opener.js', () => ({
  isLocalCliOpenCapable: vi.fn(() => false),
  isLocalCliOpenConfigured: vi.fn(() => false),
  isLocalCliOpenReady: vi.fn(() => false),
  isLocalCliOpenEnabled: vi.fn(() => false),
  localCliOpenMode: vi.fn(),
  openLocalCliInIterm: vi.fn(),
  preflightLocalCliOpen: vi.fn(() => ({ ok: false })),
}));

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({})),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────

import { handleCardAction } from '../src/im/lark/card-handler.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { getBot } from '../src/bot-registry.js';
import { sessionKey, sessionAnchorId, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import { sensitiveCardActionMeta } from '../src/im/lark/card-action-routes.js';

const LARK_APP_ID = 'cli_app_1';
const OWNER = 'ou_owner_user';
const ROOT = 'om_root_stop';
const SID = 'sess-stop-1';

function makeDs(overrides: Partial<DaemonSession> & { sessionOverrides?: Partial<Session> } = {}): DaemonSession {
  const { sessionOverrides, ...dsOverrides } = overrides;
  const session: Session = {
    sessionId: SID,
    chatId: 'oc_chat',
    rootMessageId: ROOT,
    title: 'stop task',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: LARK_APP_ID,
    ownerOpenId: OWNER,
    workingDir: '/tmp/proj',
    cliId: 'claude-code',
    ...sessionOverrides,
  } as Session;
  return {
    session,
    worker: { killed: false },
    workerPort: null,
    workerToken: null,
    larkAppId: LARK_APP_ID,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: session.workingDir,
    streamCardId: 'om_stream_card',
    displayMode: 'hidden',
    ...dsOverrides,
  } as DaemonSession;
}

function actionData(action: string): any {
  return {
    operator: { open_id: OWNER },
    action: { value: { action, root_id: ROOT, session_id: SID } },
    context: { open_message_id: 'om_clicked' },
  };
}

function depsWith(ds: DaemonSession | undefined, deliver?: any) {
  const activeSessions = new Map<string, DaemonSession>();
  if (ds) activeSessions.set(sessionKey(ROOT, LARK_APP_ID), ds);
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'om_reply'),
    lastRepoScan: new Map(),
    ...(deliver ? { deliverPassthroughCommand: deliver } : {}),
  } as any;
}

beforeEach(() => {
  sendWorkerSessionInputMock.mockReset();
  isSessionTransferringMock.mockReset();
  isSessionTransferringMock.mockReturnValue(false);
  vi.mocked(canOperate).mockReset();
  vi.mocked(canOperate).mockReturnValue(true);
});


// ─── Per-group substitute toggle ──────────────────────────────────────────

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { getMessageDetail, getChatModeStrict, getCachedChatModeStrict, sendUserMessage } from '../src/im/lark/client.js';
import { buildStreamingCardJson } from '../src/core/worker-pool.js';
import {
  isSubstituteEnabledForChat,
  setSubstituteEnabledForChat,
} from '../src/services/substitute-chat-toggle-store.js';
import { withBotTurnMutation } from '../src/core/bot-turn-mutation-gate.js';

const CHAT = 'oc_chat';

function substituteBotConfig(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      larkAppId: LARK_APP_ID,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      cardActionAckTimeoutMs: 500,
      substituteMode: {
        enabled: true,
        targets: [{ openId: 'ou_sub' }],
        topicGroups: true,
        ...overrides,
      },
    },
    resolvedAllowedUsers: [OWNER],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  } as any;
}

function toggleData(desired: 'on' | 'off', opts: { cardId?: string; operator?: string } = {}): any {
  return {
    operator: { open_id: opts.operator ?? OWNER },
    action: { value: { action: 'toggle_substitute', desired, root_id: ROOT, session_id: SID } },
    context: { open_message_id: opts.cardId ?? 'om_clicked' },
  };
}

describe('toggle_substitute card action', () => {
  let tmpDir: string;
  let prevDataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'botmux-subst-handler-'));
    prevDataDir = config.session.dataDir;
    (config.session as any).dataDir = tmpDir;
    vi.mocked(getBot).mockReturnValue(substituteBotConfig());
    vi.mocked(getChatModeStrict).mockResolvedValue('group');
    vi.mocked(getCachedChatModeStrict).mockReturnValue('group');
    vi.mocked(getMessageDetail).mockResolvedValue({ items: [{ chat_id: CHAT }] } as any);
    vi.mocked(buildStreamingCardJson).mockImplementation((ds: any) => JSON.stringify({
      substituteEnabled: isSubstituteEnabledForChat(ds.larkAppId, ds.chatId),
    }));
  });

  afterEach(() => {
    (config.session as any).dataDir = prevDataDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('turns the group off, persists it, and returns the rebuilt card', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast).toEqual(expect.objectContaining({ type: 'success' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(false);
    expect(result.card.data.substituteEnabled).toBe(false);
  });

  it('turns the group back on and returns the rebuilt card', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, false);

    const result = await handleCardAction(toggleData('on'), depsWith(ds), LARK_APP_ID);

    expect(result.toast).toEqual(expect.objectContaining({ type: 'success' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
    expect(result.card.data.substituteEnabled).toBe(true);
  });

  it('is idempotent for a repeated explicit target', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);

    await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);
    await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(false);
  });

  it('does not widen permissions beyond canOperate', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(canOperate).mockReturnValue(false);

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast).toEqual(expect.objectContaining({ type: 'warning' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects a stale card instead of toggling', async () => {
    const ds = makeDs({ streamCardId: 'om_current' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);

    const result = await handleCardAction(toggleData('off', { cardId: 'om_old' }), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('最新卡片');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects when Lark says the card lives in another chat', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getMessageDetail).mockResolvedValue({ items: [{ chat_id: 'oc_other' }] } as any);

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('最新卡片');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects a configured excludedChats group', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getBot).mockReturnValue(substituteBotConfig({ excludedChats: [CHAT] }));

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('黑名单');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects a chat outside the configured allow-list', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getBot).mockReturnValue(substituteBotConfig({ chats: ['oc_other'] }));

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('替身生效范围');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects a topic chat when topicGroups support is off', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getBot).mockReturnValue(substituteBotConfig({ topicGroups: false }));
    vi.mocked(getChatModeStrict).mockResolvedValue('topic');

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('话题群');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects an unknown chat mode instead of assuming group', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getChatModeStrict).mockResolvedValue('unknown');

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('群类型');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects p2p', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getChatModeStrict).mockResolvedValue('p2p');

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast).toEqual(expect.objectContaining({ type: 'warning' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects when the card changes during the async lookups', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    let resolveDetail!: (value: any) => void;
    vi.mocked(getMessageDetail).mockReturnValue(new Promise(resolve => { resolveDetail = resolve; }) as any);

    const pending = handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);
    ds.streamCardId = 'om_newer';
    resolveDetail({ items: [{ chat_id: CHAT }] });

    const result = await pending;
    expect(result.toast.content).toContain('最新卡片');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects when the session starts transferring during the async lookups', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    let resolveDetail!: (value: any) => void;
    vi.mocked(getMessageDetail).mockReturnValue(new Promise(resolve => { resolveDetail = resolve; }) as any);

    const pending = handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);
    isSessionTransferringMock.mockReturnValue(true);
    resolveDetail({ items: [{ chat_id: CHAT }] });

    const result = await pending;
    expect(result.toast.content).toContain('最新卡片');
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('rejects when the live config changes during the async lookups', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    let resolveDetail!: (value: any) => void;
    vi.mocked(getMessageDetail).mockReturnValue(new Promise(resolve => { resolveDetail = resolve; }) as any);

    const pending = handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);
    vi.mocked(getBot).mockReturnValue(substituteBotConfig({ enabled: false }));
    resolveDetail({ items: [{ chat_id: CHAT }] });

    const result = await pending;
    expect(result.toast).toEqual(expect.objectContaining({ type: 'warning' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });

  it('reports a visible failure when the store write fails', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    const fileAsDataDir = join(tmpDir, 'not-a-directory');
    writeFileSync(fileAsDataDir, 'x');
    (config.session as any).dataDir = fileAsDataDir;

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast.content).toContain('保存本群替身模式失败');
  });

  it('uses the real ACK timeout state instead of estimating a local deadline', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(sendUserMessage).mockClear();
    vi.mocked(getMessageDetail).mockResolvedValue({ items: [{ chat_id: 'oc_other' }] } as any);

    const result = await handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);

    expect(result.toast).toEqual(expect.objectContaining({ type: 'warning' }));
    expect(result.afterAck).toBeTypeOf('function');

    // Fast path: the wrapper did not time out → the toast was returned
    // synchronously, so afterAck must not duplicate it as a DM.
    await result.afterAck(false);
    expect(sendUserMessage).not.toHaveBeenCalled();

    // Timeout path: the wrapper already ACKed → one visible DM.
    await result.afterAck(true);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      LARK_APP_ID,
      OWNER,
      expect.stringContaining('最新卡片'),
      'text',
    );
  });

  it('rejects when the strict cache becomes topic while waiting for the mutation gate', async () => {
    const ds = makeDs({ streamCardId: 'om_clicked' });
    setSubstituteEnabledForChat(LARK_APP_ID, CHAT, true);
    vi.mocked(getBot).mockReturnValue(substituteBotConfig({ topicGroups: false }));
    vi.mocked(getCachedChatModeStrict).mockReturnValue('group');

    let startHold!: () => void;
    const holdStarted = new Promise<void>(resolve => { startHold = resolve; });
    let releaseHold!: () => void;
    const hold = new Promise<void>(resolve => { releaseHold = resolve; });
    const gate = withBotTurnMutation(LARK_APP_ID, async () => { startHold(); await hold; });
    await holdStarted;

    let queried!: () => void;
    const strictQueried = new Promise<void>(resolve => { queried = resolve; });
    vi.mocked(getChatModeStrict).mockImplementation(async () => { queried(); return 'group'; });
    const pending = handleCardAction(toggleData('off'), depsWith(ds), LARK_APP_ID);
    await strictQueried;

    // Another confirmed chat.get flips the shared cache to topic before this
    // mutation acquires the gate.
    vi.mocked(getCachedChatModeStrict).mockReturnValue('topic');
    releaseHold();
    await gate;

    const result = await pending;
    expect(result.toast).toEqual(expect.objectContaining({ type: 'warning' }));
    expect(isSubstituteEnabledForChat(LARK_APP_ID, CHAT)).toBe(true);
  });
});
