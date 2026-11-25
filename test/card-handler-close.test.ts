/**
 * Unit tests for the `close` streaming-card action's session-owner exception:
 *
 *   The human who opened a thread-scope session (session.ownerOpenId) may close
 *   it from the card with talk-only access. Everyone else without operate
 *   permission stays behind the silent canOperate block, sessions that are not
 *   "their own" (chat-scope sessions shared by the whole group, ownerless
 *   sessions) stay operator-only, and the exception covers no other action.
 *
 * Mocked surface follows card-handler-stop-compact.test.ts.
 *
 * Run: bun run test -- test/card-handler-close.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks (before importing the module under test) ───────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
  getMessageDetail: vi.fn(),
  isHumanOpenId: vi.fn(() => true),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'cli_app_1', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_admin'),
  getBotClient: vi.fn(),
}));

vi.mock('../src/services/bot-config-store.js', () => ({
  findConfigField: vi.fn(),
  applyConfigField: vi.fn(),
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

const closeSessionMock = vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false }));
const deliverEphemeralOrReplyMock = vi.fn(async (_ds: any, _who: string, card: string) => card);
const requestSessionRestartMock = vi.fn();

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killWorker: vi.fn(),
  closeSession: (...args: any[]) => closeSessionMock(...(args as [])),
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  scheduleCardPatch: vi.fn(),
  parkStreamCard: vi.fn(),
  clearUsageLimitState: vi.fn(),
  cardUsageLimit: vi.fn(() => undefined),
  cachedStreamingCardStatus: vi.fn(() => 'idle'),
  cachedStreamCardLabel: vi.fn(() => undefined),
  streamingCardPresentationImageKey: vi.fn(() => undefined),
  writableTerminalLinkFor: vi.fn(() => undefined),
  workerHasInitialized: vi.fn(() => true),
  sessionSupportsWebTerminal: vi.fn(() => true),
  readableTerminalUrlFor: vi.fn(() => 'https://example.com/term'),
  liveReadableTerminalUrlFor: vi.fn(() => 'https://example.com/term'),
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: vi.fn(),
  deliverEphemeralOrReply: (...args: any[]) => deliverEphemeralOrReplyMock(...(args as [])),
  CARD_POSTING_SENTINEL: '__posting__',
  requestSessionRestart: (...args: any[]) => requestSessionRestartMock(...(args as [])),
  getDaemonStreamingCardUsageSnapshot: vi.fn(() => undefined),
  withActiveSessionKeyLock: vi.fn(async (_map: any, _key: string, action: () => any) => action()),
  buildStreamingCardJson: vi.fn(() => '{"elements":[]}'),
  substituteCardControlFor: vi.fn(() => undefined),
  dshRuntimeForSession: vi.fn(() => undefined),
}));

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
import { canOperate, canTalk } from '../src/im/lark/event-dispatcher.js';
import { getBot } from '../src/bot-registry.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const LARK_APP_ID = 'cli_app_1';
const BOT_CONFIG = { larkAppId: LARK_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' };
const ADMIN = 'ou_admin_user';
const OWNER = 'ou_owner_user';
const BYSTANDER = 'ou_other_member';
const ROOT = 'om_root_close';
const SID = 'sess-close-1';

function makeDs(overrides: Partial<DaemonSession> & { sessionOverrides?: Partial<Session> } = {}): DaemonSession {
  const { sessionOverrides, ...dsOverrides } = overrides;
  const session: Session = {
    sessionId: SID,
    chatId: 'oc_chat',
    rootMessageId: ROOT,
    title: 'close task',
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

function actionData(action: string, clicker: string): any {
  return {
    operator: { open_id: clicker },
    action: { value: { action, root_id: ROOT, session_id: SID } },
    context: { open_message_id: 'om_clicked' },
  };
}

function depsWith(ds: DaemonSession | undefined) {
  const activeSessions = new Map<string, DaemonSession>();
  if (ds) activeSessions.set(sessionKey(ROOT, LARK_APP_ID), ds);
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'om_reply'),
    lastRepoScan: new Map(),
  } as any;
}

function botWith(extraConfig: Record<string, unknown>) {
  vi.mocked(getBot).mockReturnValue({
    config: { ...BOT_CONFIG, ...extraConfig },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  } as any);
}

beforeEach(() => {
  closeSessionMock.mockClear();
  deliverEphemeralOrReplyMock.mockClear();
  requestSessionRestartMock.mockClear();
  botWith({});
  vi.mocked(canTalk).mockReset();
  vi.mocked(canTalk).mockReturnValue(true);
  vi.mocked(canOperate).mockReset();
  // Only the admin has operate permission; everyone else is talk-only.
  vi.mocked(canOperate).mockImplementation((_app, _chat, openId) => openId === ADMIN);
});

// ─── close ────────────────────────────────────────────────────────────────

describe('close card action', () => {
  it('closes the session for a talk-only session owner and hands them the closed card', async () => {
    const ds = makeDs();
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(closeSessionMock).toHaveBeenCalledTimes(1);
    expect(closeSessionMock.mock.calls[0][0]).toBe(SID);
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledWith(ds, OWNER, expect.any(String), 'interactive', expect.any(Function));
    expect(result).toBeUndefined();
  });

  it('closes the session for an operator who is not the owner', async () => {
    const ds = makeDs();
    await handleCardAction(actionData('close', ADMIN), depsWith(ds), LARK_APP_ID);

    expect(closeSessionMock).toHaveBeenCalledWith(SID, expect.anything());
  });

  it('lets a direct-message user close the session they opened', async () => {
    const ds = makeDs({
      sessionOverrides: { chatType: 'p2p' },
      chatType: 'p2p',
    });
    await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(closeSessionMock).toHaveBeenCalledWith(SID, expect.anything());
  });

  it('stays operator-only for a direct-message chat shared across the whole conversation', async () => {
    const ds = makeDs({
      sessionOverrides: { chatType: 'p2p', scope: 'chat' },
      chatType: 'p2p',
      scope: 'chat',
    });
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('does not re-check talk permission: an owner who can no longer talk can still close their own session', async () => {
    vi.mocked(canTalk).mockReturnValue(false);
    await handleCardAction(actionData('close', OWNER), depsWith(makeDs()), LARK_APP_ID);

    expect(canTalk).not.toHaveBeenCalled();
    expect(closeSessionMock).toHaveBeenCalledWith(SID, expect.anything());
  });

  it('closes through the reply-card menu confirm button for the session owner', async () => {
    botWith({ replyCardActions: true });
    const data = actionData('close', OWNER);
    data.action.value.menu_reply_card = '1';
    await handleCardAction(data, depsWith(makeDs()), LARK_APP_ID);

    expect(closeSessionMock).toHaveBeenCalledWith(SID, expect.anything());
  });

  it('is silently blocked for a talk-only member who did not open the session', async () => {
    const result = await handleCardAction(actionData('close', BYSTANDER), depsWith(makeDs()), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('stays operator-only for a chat-scope session shared by the whole group', async () => {
    const ds = makeDs({
      sessionOverrides: { scope: 'chat' },
      scope: 'chat',
    });
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('stays operator-only when the live session is chat-scope but the stored row still says thread', async () => {
    const ds = makeDs({ scope: 'chat', sessionOverrides: { scope: 'thread' } });
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('falls back to the stored row when the live session carries no scope', async () => {
    const ds = makeDs({ scope: undefined, sessionOverrides: { scope: 'thread' } });
    await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(closeSessionMock).toHaveBeenCalledWith(SID, expect.anything());
  });

  it('stays operator-only for a shared adopt session, where close means disconnecting an external CLI', async () => {
    const ds = makeDs({ adoptedFrom: 'tmux:botmux-src' });
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('stays operator-only for a session without a human owner', async () => {
    const ds = makeDs({ sessionOverrides: { ownerOpenId: undefined } });
    const result = await handleCardAction(actionData('close', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach the session owner exception through a card whose session is already gone', async () => {
    const result = await handleCardAction(actionData('close', OWNER), depsWith(undefined), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(closeSessionMock).not.toHaveBeenCalled();
  });

  it('keeps restart operator-only for the session owner', async () => {
    const ds = makeDs();
    const result = await handleCardAction(actionData('restart', OWNER), depsWith(ds), LARK_APP_ID);

    expect(result).toBeUndefined();
    expect(requestSessionRestartMock).not.toHaveBeenCalled();
  });
});
