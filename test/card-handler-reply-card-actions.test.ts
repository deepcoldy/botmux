/**
 * Unit tests for the reply-card overflow action menu (reply_card_menu):
 *   - live toggle re-check (menu + close confirm), session-gone handling
 *   - terminal option → private writable-link card delivery
 *   - close option → two-step confirm card; confirm button rides the native
 *     `close` action and re-checks the toggle
 *   - model option → model picker card; reply_model_pick injects
 *     `/model <slug>` with whitelist + idle gating
 *
 * Mock surface follows card-handler-stop-compact.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const platformTerminalBaseUrlMock = vi.fn(() => null as string | null);
vi.mock('../src/platform/binding.js', () => ({
  platformTerminalBaseUrl: () => platformTerminalBaseUrlMock(),
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

const readableTerminalUrlMock = vi.fn(() => 'https://example.com/term');
const liveReadableTerminalUrlMock = vi.fn(() => 'https://example.com/term');
const topicReasoningControlMock = vi.fn((..._a: any[]) => undefined as any);
const setTopicReasoningEffortMock = vi.fn((..._a: any[]) => 'saved');
const isSessionRestartInFlightMock = vi.fn((..._a: any[]) => false);
const requestSessionRestartMock = vi.fn((..._a: any[]) => ({ attemptId: 'topic-restart', joined: false }));
const isSessionTransferringMock = vi.fn(() => false);
const sessionAcceptsDirectCommandMock = vi.fn(() => true);
const closeSessionMock = vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false }));
const deliverWriteLinkCardMock = vi.fn();
const deliverEphemeralOrReplyMock = vi.fn(async (_ds: any, _who: string, card: string) => card);

vi.mock('../src/core/worker-pool.js', () => ({
  topicReasoningControl: (...a: any[]) => topicReasoningControlMock(...a),
  setTopicReasoningEffort: (...a: any[]) => setTopicReasoningEffortMock(...a),
  isSessionRestartInFlight: (...a: any[]) => isSessionRestartInFlightMock(...a),
  setSessionReasoningEffort: vi.fn(),
  forkWorker: vi.fn(),
  sendWorkerInput: vi.fn(),
  sendWorkerSessionInput: vi.fn(),
  killWorker: vi.fn(),
  closeSession: (...args: any[]) => closeSessionMock(...args),
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  scheduleCardPatch: vi.fn(),
  parkStreamCard: vi.fn(),
  clearUsageLimitState: vi.fn(),
  cardUsageLimit: vi.fn(() => undefined),
  writableTerminalLinkFor: vi.fn(() => undefined),
  workerHasInitialized: vi.fn(() => true),
  sessionSupportsWebTerminal: vi.fn(() => true),
  readableTerminalUrlFor: (...args: any[]) => readableTerminalUrlMock(...args),
  liveReadableTerminalUrlFor: (...args: any[]) => liveReadableTerminalUrlMock(...args),
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: (...args: any[]) => deliverWriteLinkCardMock(...args),
  deliverEphemeralOrReply: (...args: any[]) => deliverEphemeralOrReplyMock(...args),
  CARD_POSTING_SENTINEL: '__posting__',
  requestSessionRestart: (...a: any[]) => requestSessionRestartMock(...a),
  isSessionTransferring: (...args: any[]) => isSessionTransferringMock(...args),
  sessionAcceptsDirectCommand: (...args: any[]) => sessionAcceptsDirectCommandMock(...args),
  getDaemonStreamingCardUsageSnapshot: vi.fn(() => undefined),
  withActiveSessionKeyLock: vi.fn(async (_m: any, _k: string, action: () => any) => action()),
  buildStreamingCardJson: vi.fn(() => '{"elements":[]}'),
  idleCardLabel: vi.fn(() => undefined),
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

const remoteAccessEnabledMock = vi.fn(() => false);
vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({})),
  isRemoteAccessEnabled: () => remoteAccessEnabledMock(),
  // Model probes compose the session env overlay (no global layer here).
  readRawGlobalSessionEnv: () => undefined,
}));

const staticModelChoicesMock = vi.fn(() => ['fable', 'opus', 'sonnet', 'haiku']);
const detectModelsMock = vi.fn(async () => null);
vi.mock('../src/services/model-catalog.js', () => ({
  staticModelChoices: (...args: any[]) => staticModelChoicesMock(...args),
  detectModels: (...args: any[]) => detectModelsMock(...args),
  // Mirror the real helper: a non-empty live catalogue wins; static is only
  // the fallback when live probing returns null/empty.
  mergeModelChoices: (stat: string[], live: string[] | null) => ({ models: live && live.length ? [...live] : [...stat] }),
  runtimeExecutableForBotSelection: () => undefined,
}));

import { buildDefaultModelPickerCard, showSessionModelPicker } from '../src/im/lark/session-model-picker.js';
import { handleCommand } from '../src/core/command-handler.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { setTerminalProxyPort, resetTerminalProxy } from '../src/core/terminal-url.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { getBot } from '../src/bot-registry.js';
import { findConfigField, applyConfigField, coerceConfigValue } from '../src/services/bot-config-store.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const LARK_APP_ID = 'cli_app_1';
const OWNER = 'ou_owner_user';
const ROOT = 'om_root_menu';
const SID = 'sess-menu-1';

function makeDs(overrides: Partial<DaemonSession> & { sessionOverrides?: Partial<Session> } = {}): DaemonSession {
  const { sessionOverrides, ...dsOverrides } = overrides;
  const session: Session = {
    sessionId: SID,
    chatId: 'oc_chat',
    rootMessageId: ROOT,
    title: 'menu task',
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
    lastScreenStatus: 'idle',
    workerReady: true,
    ...dsOverrides,
  } as DaemonSession;
}

function menuData(option: string, extraValue: Record<string, unknown> = {}): any {
  return {
    operator: { open_id: OWNER },
    action: {
      value: { action: 'reply_card_menu', root_id: ROOT, session_id: SID, lark_app_id: LARK_APP_ID, chat_id: 'oc_chat', ...extraValue },
      option,
    },
    context: { open_message_id: 'om_reply_card' },
  };
}

function pickData(slug: string): any {
  return {
    operator: { open_id: OWNER },
    action: {
      value: { action: 'reply_model_pick', root_id: ROOT, session_id: SID, lark_app_id: LARK_APP_ID, chat_id: 'oc_chat' },
      option: slug,
    },
    context: { open_message_id: 'om_picker_card' },
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

function enableMenu(cliId = 'claude-code') {
  vi.mocked(getBot).mockReturnValue({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId, replyCardActions: true },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  } as any);
}

beforeEach(() => {
  topicReasoningControlMock.mockReset().mockReturnValue(undefined);
  setTopicReasoningEffortMock.mockReset().mockReturnValue('saved');
  isSessionRestartInFlightMock.mockReset().mockReturnValue(false);
  requestSessionRestartMock.mockClear();

  vi.mocked(canOperate).mockReset().mockReturnValue(true);
  vi.mocked(getBot).mockReset().mockReturnValue({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  } as any);
  vi.mocked(findConfigField).mockReset();
  vi.mocked(applyConfigField).mockReset();
  vi.mocked(coerceConfigValue).mockReset();
  isSessionTransferringMock.mockReset().mockReturnValue(false);
  readableTerminalUrlMock.mockReset().mockReturnValue('https://example.com/term');
  liveReadableTerminalUrlMock.mockReset().mockReturnValue('https://example.com/term');
  sessionAcceptsDirectCommandMock.mockReset().mockReturnValue(true);
  closeSessionMock.mockClear();
  deliverWriteLinkCardMock.mockClear();
  deliverEphemeralOrReplyMock.mockClear();
  staticModelChoicesMock.mockReset().mockImplementation(() => ['fable', 'opus', 'sonnet', 'haiku']);
  detectModelsMock.mockReset().mockResolvedValue(null);
  remoteAccessEnabledMock.mockReset().mockReturnValue(false);
  platformTerminalBaseUrlMock.mockReset().mockReturnValue(null);
  resetTerminalProxy();
});

// ─── toggle gate ──────────────────────────────────────────────────────────

describe('reply_card_menu toggle gate', () => {
  it.each(['terminal', 'model', 'close'])('refuses option %s with a toast when the toggle is off', async (option) => {
    const ds = makeDs();
    const result = await handleCardAction(menuData(option), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('菜单已关闭');
    expect(deliverWriteLinkCardMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
  });

  it('reports session gone when the session no longer exists', async () => {
    enableMenu();
    const result = await handleCardAction(menuData('terminal'), depsWith(undefined), LARK_APP_ID);
    expect(result.toast.content).toContain('会话已结束');
  });

  it('is blocked for non-operators behind the sensitive gate', async () => {
    enableMenu();
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(result).toBeUndefined();
    expect(deliverWriteLinkCardMock).not.toHaveBeenCalled();
  });
});

// ─── terminal ─────────────────────────────────────────────────────────────

describe('reply_card_menu terminal option', () => {
  it('privately delivers the writable terminal card and returns a toast', async () => {
    enableMenu();
    const ds = makeDs({ workerPort: 9000, workerToken: 'tok' } as any);
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverWriteLinkCardMock).toHaveBeenCalledTimes(1);
    const [gotDs, who, cardJson] = deliverWriteLinkCardMock.mock.calls[0];
    expect(gotDs).toBe(ds);
    expect(who).toBe(OWNER);
    expect(cardJson).toContain('http://localhost:9000?token=tok');
    expect(result.toast.type).toBe('success');
  });

  it('sends an unsupported notice when the backend has no web terminal', async () => {
    enableMenu();
    const ds = makeDs();
    const { sessionSupportsWebTerminal } = await import('../src/core/worker-pool.js');
    vi.mocked(sessionSupportsWebTerminal).mockReturnValueOnce(false);
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverWriteLinkCardMock).not.toHaveBeenCalled();
    expect(result.toast).toBeUndefined();
  });
});

// ─── close two-step confirm ───────────────────────────────────────────────

describe('reply_card_menu close option', () => {
  it('sends a confirm card whose confirm button is a native close action carrying the binding', async () => {
    enableMenu();
    const ds = makeDs();
    const result = await handleCardAction(menuData('close'), depsWith(ds), LARK_APP_ID);
    expect(result.toast).toBeUndefined();
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    const buttons = sent.elements.find((e: any) => e.tag === 'action').actions;
    const confirm = buttons.find((b: any) => b.value?.action === 'close');
    expect(confirm.type).toBe('danger');
    expect(confirm.value.menu_reply_card).toBe('1');
    expect(confirm.value.session_id).toBe(SID);
    expect(confirm.value.root_id).toBe(ROOT);
    const cancel = buttons.find((b: any) => b.value?.action === 'reply_menu_cancel');
    expect(cancel).toBeTruthy();
  });

  it('refuses the confirm button when the toggle was turned off meanwhile', async () => {
    const ds = makeDs();
    // toggle stays OFF (default getBot mock)
    const data = {
      operator: { open_id: OWNER },
      action: { value: { action: 'close', menu_reply_card: '1', root_id: ROOT, session_id: SID, lark_app_id: LARK_APP_ID } },
      context: { open_message_id: 'om_confirm_card' },
    };
    const result = await handleCardAction(data, depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('菜单已关闭');
    expect(closeSessionMock).not.toHaveBeenCalled();
  });
});

// ─── model picker ─────────────────────────────────────────────────────────

describe('reply_card_menu model option', () => {
  it('posts a model picker card after ACK with the current model initialised', async () => {
    enableMenu();
    const ds = makeDs({ activeModel: 'sonnet' } as any);
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    expect(typeof result.afterAck).toBe('function');
    expect(result.toast.content).toContain('读取可用模型');
    await result.afterAck();
    const sent = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    const select = sent.elements.find((e: any) => e.tag === 'action').actions[0];
    expect(select.tag).toBe('select_static');
    expect(select.value.action).toBe('reply_model_pick');
    expect(select.value.session_id).toBe(SID);
    expect(select.initial_option).toBe('sonnet');
    const values = select.options.map((o: any) => o.value);
    expect(values).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(select.options.find((o: any) => o.value === 'sonnet').text.content).toContain('当前');
  });

  it('prefers a non-empty live catalogue over the curated list', async () => {
    enableMenu();
    detectModelsMock.mockResolvedValue(['claude-sonnet-5', 'custom-x']);
    const ds = makeDs();
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    await result.afterAck();
    const select = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2])
      .elements.find((e: any) => e.tag === 'action').actions[0];
    // Live non-empty is authoritative; static curated entries are the fallback only.
    expect(select.options.map((o: any) => o.value)).toEqual(['claude-sonnet-5', 'custom-x']);
  });

  it('posts an empty-catalogue notice when the CLI has no enumerated models', async () => {
    enableMenu();
    staticModelChoicesMock.mockReturnValue([]);
    const ds = makeDs();
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    await result.afterAck();
    const sent = deliverEphemeralOrReplyMock.mock.calls[0][2];
    expect(sent).toContain('没有可用的模型枚举');
  });
});

describe('reply_model_pick action', () => {
  it('injects /model <slug> through the passthrough dep and toasts the sent command', async () => {
    enableMenu();
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('sonnet'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toBe('/model sonnet');
    expect(deliver.mock.calls[0][2].anchor).toBeTruthy();
    expect(result.toast.type).toBe('success');
    expect(result.toast.content).toContain('/model sonnet');
  });

  it('refuses a slug missing from the catalogue even if character-legal', async () => {
    enableMenu();
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('not-a-real-model'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.toast.type).toBe('warning');
  });

  it('refuses a malformed slug with a warning (PTY injection defence)', async () => {
    enableMenu();
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('sonnet\nrm -rf /'), depsWith(ds, deliver), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses while the session is busy', async () => {
    enableMenu();
    sessionAcceptsDirectCommandMock.mockReturnValue(false);
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('sonnet'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.toast.content).toContain('执行任务');
  });

  it('refuses for CLIs without a raw passthrough surface', async () => {
    enableMenu('codex-app');
    const ds = makeDs({ sessionOverrides: { cliId: 'codex-app' } as any });
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('gpt-5.6-sol'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.toast.content).toContain('终端内使用 /model');
  });

  it('refuses when the worker is dead', async () => {
    enableMenu();
    const ds = makeDs({ worker: { killed: true } as any });
    const result = await handleCardAction(pickData('sonnet'), depsWith(ds, vi.fn()), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
  });

  it('respects the canOperate gate', async () => {
    enableMenu();
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(pickData('sonnet'), depsWith(ds, deliver), LARK_APP_ID);
    expect(result).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('/models shortcut', () => {
  it('opens a session-bound picker through the real command handler while reply menus are disabled', async () => {
    const ds = makeDs({ activeModel: 'sonnet' });
    const deps = depsWith(ds);
    await handleCommand('/models', ROOT, { messageId: 'om_models', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    const card = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    const select = card.elements.find((e: any) => e.tag === 'action').actions[0];
    expect(select.value).toMatchObject({ action: 'session_model_pick', session_id: SID, lark_app_id: LARK_APP_ID, root_id: ROOT, chat_id: 'oc_chat' });
    expect(select.initial_option).toBe('sonnet');
    expect(select.options.map((o: any) => o.value)).toContain('sonnet');
    expect(ds.activeModel).toBe('sonnet');
  });

  it('does not create or start a session when no session exists', async () => {
    const deps = depsWith(undefined);
    await handleCommand('/models', ROOT, { messageId: 'om_models', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    expect(deps.sessionReply).toHaveBeenCalledTimes(1);
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
    expect(deps.activeSessions.size).toBe(0);
  });

  it('rechecks operator permission before probing models', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const reply = vi.fn(async () => 'om_reply');
    await showSessionModelPicker(makeDs(), ROOT, OWNER, undefined, reply, 'zh');
    expect(reply).toHaveBeenCalled();
    expect(detectModelsMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
  });

  it.each(['codex-app', 'minimax', 'mira'])('does not offer a raw model picker for %s', async cliId => {
    const reply = vi.fn(async () => 'om_reply');
    await showSessionModelPicker(makeDs({ sessionOverrides: { cliId } as any }), ROOT, OWNER, undefined, reply, 'zh');
    expect(reply).toHaveBeenCalled();
    expect(detectModelsMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
  });

  it('uses the session CLI after the bot defaults change', async () => {
    enableMenu('codex-app');
    const ds = makeDs();
    await showSessionModelPicker(ds, ROOT, OWNER, undefined, vi.fn(async () => 'om_reply'), 'zh');
    expect(detectModelsMock).toHaveBeenCalledWith('claude-code', expect.anything());
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
  });

  it('shows a notice instead of an empty select when no usable model slugs exist', async () => {
    detectModelsMock.mockResolvedValue(['bad model', 'bad\nmodel']);
    await showSessionModelPicker(makeDs(), ROOT, OWNER, undefined, vi.fn(async () => 'om_reply'), 'zh');
    const card = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    expect(card.elements.some((e: any) => e.tag === 'action')).toBe(false);
  });

  function shortcutPick(slug: string) {
    const data = pickData(slug);
    data.action.value.action = 'session_model_pick';
    return data;
  }

  it('selecting the shortcut sends the chosen model while reply menus are disabled', async () => {
    const deliver = vi.fn();
    const result = await handleCardAction(shortcutPick('sonnet'), depsWith(makeDs(), deliver), LARK_APP_ID);
    expect(deliver).toHaveBeenCalledWith(expect.anything(), '/model sonnet', expect.objectContaining({ senderOpenId: OWNER, senderIsBot: false }));
    expect(result.toast.type).toBe('success');
  });

  it.each(['permission', 'busy', 'replacement', 'dead', 'transfer', 'generation'])('revalidates after model discovery: %s', async reason => {
    let resolve!: (models: string[] | null) => void;
    detectModelsMock.mockImplementation(() => new Promise<string[] | null>(r => { resolve = r; }));
    const ds = makeDs();
    const deliver = vi.fn();
    const deps = depsWith(ds, deliver);
    const pending = handleCardAction(shortcutPick('sonnet'), deps, LARK_APP_ID);
    // Detection is reached synchronously before the handler's first await.
    if (reason === 'permission') vi.mocked(canOperate).mockReturnValue(false);
    if (reason === 'busy') sessionAcceptsDirectCommandMock.mockReturnValue(false);
    if (reason === 'replacement') deps.activeSessions.set(sessionKey(ROOT, LARK_APP_ID), makeDs({ sessionOverrides: { sessionId: 'replacement' } }));
    if (reason === 'dead') ds.worker = { killed: true } as any;
    if (reason === 'transfer') isSessionTransferringMock.mockReturnValue(true);
    if (reason === 'generation') ds.workerGeneration = 2;
    resolve(null);
    const result = await pending;
    expect(deliver).not.toHaveBeenCalled();
    expect(result.toast.type).toBe('warning');
  });

  it('refuses a second concurrent model choice once the first starts a turn', async () => {
    let resolve!: (models: string[] | null) => void;
    const probe = new Promise<string[] | null>(r => { resolve = r; });
    detectModelsMock.mockImplementation(() => probe);
    const ds = makeDs();
    const deliver = vi.fn(() => { sessionAcceptsDirectCommandMock.mockReturnValue(false); return true; });
    const deps = depsWith(ds, deliver);
    const first = handleCardAction(shortcutPick('sonnet'), deps, LARK_APP_ID);
    const second = handleCardAction(shortcutPick('opus'), deps, LARK_APP_ID);
    resolve(null);
    const results = await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(results.map(r => r.toast.type)).toEqual(['success', 'warning']);
  });

  it('gives later selections from the same card distinct turn identifiers', async () => {
    const ds = makeDs();
    const deliver = vi.fn(() => true);
    const deps = depsWith(ds, deliver);
    await handleCardAction(shortcutPick('sonnet'), deps, LARK_APP_ID);
    await handleCardAction(shortcutPick('opus'), deps, LARK_APP_ID);
    const ids = deliver.mock.calls.map((c: any) => c[2].turnId);
    expect(new Set(ids).size).toBe(2);
    expect(deliver.mock.calls.map((c: any) => c[2].messageId)).toEqual(['om_picker_card', 'om_picker_card']);
  });

  it('reports a rejected worker enqueue as a warning', async () => {
    const result = await handleCardAction(shortcutPick('sonnet'), depsWith(makeDs(), vi.fn(() => false)), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
  });

  it('does not invite a retry when bookkeeping throws after the worker accepted the command', async () => {
    const deliver = vi.fn((_ds: any, _cmd: string, opts: any) => { opts.onDelivered(); throw new Error('bookkeeping failed'); });
    const result = await handleCardAction(shortcutPick('sonnet'), depsWith(makeDs(), deliver), LARK_APP_ID);
    expect(result.toast.type).toBe('success');
  });

  it('does not pass a chat id as the reply message when switching in a flat group session', async () => {
    const ds = makeDs({ scope: 'chat', sessionOverrides: { scope: 'chat' } });
    const deliver = vi.fn();
    const data = shortcutPick('sonnet');
    data.action.value.root_id = 'oc_chat';
    await handleCardAction(data, depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2].replyRootId).toBeUndefined();
  });

  it.each(['busy', 'permission', 'invalid', 'unsupported', 'dead', 'transfer'])('retains the existing model switch guard: %s', async reason => {
    const ds = makeDs();
    if (reason === 'busy') sessionAcceptsDirectCommandMock.mockReturnValue(false);
    if (reason === 'permission') vi.mocked(canOperate).mockReturnValue(false);
    if (reason === 'unsupported') ds.session.cliId = 'codex-app';
    if (reason === 'dead') ds.worker = { killed: true } as any;
    if (reason === 'transfer') isSessionTransferringMock.mockReturnValue(true);
    const deliver = vi.fn();
    await handleCardAction(shortcutPick(reason === 'invalid' ? 'sonnet\n/clear' : 'sonnet'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('/models bot defaults at top level', () => {
  function adminBot() {
    const bot = getBot(LARK_APP_ID) as any;
    bot.resolvedAllowedUsers = [OWNER];
    bot.config.model = 'opus';
    return bot;
  }
  function defaultPick(model = 'haiku', extra = {}) {
    return { operator: { open_id: OWNER },
      action: { value: { action: 'models_default_pick', lark_app_id: LARK_APP_ID, selection_key: 'claude-code', ...extra }, option: model },
      context: { open_message_id: 'om_defaults' } };
  }
  const modelSpec = { key: 'model', kind: 'string', configKey: 'model', clearable: true } as any;

  it.each([false, true])('top-level /models shows bot defaults with an existing flat session: %s', async existing => {
    adminBot();
    const ds = makeDs({ scope: 'chat', sessionOverrides: { model: 'session-model' } });
    const deps = depsWith(existing ? ds : undefined);
    deps.invocationContext = 'new-topic';
    await handleCommand('/models', ROOT, { messageId: 'om_top', chatId: 'oc_chat', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    const card = JSON.parse(deps.sessionReply.mock.calls[0][1]);
    const select = card.elements.find((e: any) => e.tag === 'action').actions[0];
    expect(select.value).toMatchObject({ action: 'models_default_pick', lark_app_id: LARK_APP_ID, selection_key: 'claude-code' });
    expect(select.initial_option).toBe('opus');
    expect(select.value.session_id).toBeUndefined();
    expect(ds.session.model).toBe('session-model');
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
  });

  it('topic replies keep selecting the session model', async () => {
    adminBot();
    const deps = depsWith(makeDs());
    deps.invocationContext = 'thread';
    await handleCommand('/models', ROOT, { messageId: 'om_in_topic', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    const card = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    expect(card.elements.find((e: any) => e.tag === 'action').actions[0].value.action).toBe('session_model_pick');
  });

  it('chat-level operate permission does not allow opening bot defaults', async () => {
    vi.mocked(canOperate).mockReturnValue(true);
    const deps = depsWith(undefined);
    deps.invocationContext = 'new-topic';
    await handleCommand('/models', ROOT, { messageId: 'om_top', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    expect(detectModelsMock).not.toHaveBeenCalled();
    expect(deps.sessionReply.mock.calls[0][2]).not.toBe('interactive');
  });

  it('updates only this bot model default through the existing config store', async () => {
    const bot = adminBot();
    const ds = makeDs({ activeModel: 'session-model', sessionOverrides: { model: 'session-model' } });
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'haiku' } as any);
    vi.mocked(applyConfigField).mockImplementation(async (_app, _spec, model) => {
      bot.config.model = model;
      return { ok: true, newText: 'haiku', effect: 'next-session' } as any;
    });
    const result = await handleCardAction(defaultPick('haiku', { field: 'cli' }), depsWith(ds), LARK_APP_ID);
    expect(applyConfigField).toHaveBeenCalledWith(LARK_APP_ID, modelSpec, 'haiku', { selectionKey: 'claude-code', requireLaunchModelSupport: true, actorOpenId: OWNER });
    expect(bot.config.model).toBe('haiku');
    expect(ds.session.model).toBe('session-model');
    expect(ds.activeModel).toBe('session-model');
    expect(result.toast.type).toBe('success');
    expect(result.card.data.elements.find((e: any) => e.tag === 'action').actions[0].initial_option).toBe('haiku');
  });

  it.each(['permission', 'wrong-app', 'changed-cli', 'bad-model', 'unsupported'])('rejects a default model selection: %s', async reason => {
    const bot = adminBot();
    const data = defaultPick();
    if (reason === 'permission') bot.resolvedAllowedUsers = [];
    if (reason === 'wrong-app') data.action.value.lark_app_id = 'other-app';
    if (reason === 'changed-cli') bot.config.cliId = 'codex';
    if (reason === 'bad-model') data.action.option = 'haiku\n/clear';
    if (reason === 'unsupported') bot.config.backendType = 'riff';
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    const result = await handleCardAction(data, depsWith(makeDs()), LARK_APP_ID);
    expect(applyConfigField).not.toHaveBeenCalled();
    expect(result.toast.type).not.toBe('success');
  });

  it.each(['cli', 'backend'])('does not stamp old model choices with changed defaults after saving: %s', async change => {
    const bot = adminBot();
    let resolve!: (models: string[] | null) => void;
    let started!: () => void;
    const detectionStarted = new Promise<void>(r => { started = r; });
    detectModelsMock.mockImplementation(() => { started(); return new Promise(r => { resolve = r; }); });
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'haiku' } as any);
    vi.mocked(applyConfigField).mockImplementation(async () => { bot.config.model = 'haiku'; return { ok: true, newText: 'haiku', effect: 'next-session' } as any; });
    const pending = handleCardAction(defaultPick(), depsWith(undefined), LARK_APP_ID);
    await detectionStarted;
    if (change === 'cli') bot.config.cliId = 'codex';
    else bot.config.backendType = 'riff';
    resolve(['opus', 'sonnet']);
    const result = await pending;
    expect(result.toast.type).toBe('success');
    expect(result.card).toBeUndefined();
    expect(bot.config.model).toBe('haiku');
  });

  it.each([
    ['traex', 'GPT-6.1-Sol', ['low', 'medium', 'high', 'xhigh']],
    ['claude-code', 'sonnet', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-code', 'haiku', []],
  ])('offers model-supported effort choices for %s / %s', (cliId, model, expected) => {
    const card = JSON.parse(buildDefaultModelPickerCard(LARK_APP_ID, [model as string], model as string, 'zh', cliId as string, { cliId: cliId as string, effort: 'high' }));
    const select = card.elements.filter((e: any) => e.tag === 'action')[1].actions[0];
    expect(select.value).toMatchObject({ action: 'models_default_effort_pick', expected_model: model, selection_key: cliId });
    expect(select.options.map((o: any) => o.value)).toEqual(['__unset__', ...expected as string[]]);
    expect(select.initial_option).toBe((expected as string[]).includes('high') ? 'high' : '__unset__');
  });

  function effortPick(effort = 'high', model = 'opus') {
    const data = defaultPick(effort, { field: 'model' });
    data.action.value.action = 'models_default_effort_pick';
    (data.action.value as any).expected_model = model;
    return data;
  }
  const effortSpec = { key: 'reasoningEffort', kind: 'enum', configKey: 'reasoningEffort', clearable: true } as any;

  it('writes default effort with a model precondition and keeps active session effort', async () => {
    const bot = adminBot();
    const ds = makeDs({ sessionOverrides: { reasoningEffort: 'low' } });
    vi.mocked(findConfigField).mockReturnValue(effortSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'high' } as any);
    vi.mocked(applyConfigField).mockImplementation(async (_app, _spec, effort) => {
      bot.config.reasoningEffort = effort;
      return { ok: true, newText: 'high', effect: 'next-session' } as any;
    });
    const result = await handleCardAction(effortPick(), depsWith(ds), LARK_APP_ID);
    expect(applyConfigField).toHaveBeenCalledWith(LARK_APP_ID, effortSpec, 'high', { selectionKey: 'claude-code', model: 'opus', requireLaunchModelSupport: true, actorOpenId: OWNER });
    expect(ds.session.reasoningEffort).toBe('low');
    const select = result.card.data.elements.filter((e: any) => e.tag === 'action')[1].actions[0];
    expect(select.initial_option).toBe('high');
  });

  it('clears default effort without changing the model', async () => {
    const bot = adminBot();
    bot.config.reasoningEffort = 'high';
    vi.mocked(findConfigField).mockReturnValue(effortSpec);
    vi.mocked(applyConfigField).mockImplementation(async () => { bot.config.reasoningEffort = undefined; return { ok: true, newText: 'default' } as any; });
    const result = await handleCardAction(effortPick('__unset__'), depsWith(undefined), LARK_APP_ID);
    expect(applyConfigField).toHaveBeenCalledWith(LARK_APP_ID, effortSpec, null, { selectionKey: 'claude-code', model: 'opus', requireLaunchModelSupport: true, actorOpenId: OWNER });
    expect(bot.config.model).toBe('opus');
    expect(result.toast.type).toBe('success');
  });

  it('rejects an effort card after the default model changed', async () => {
    const bot = adminBot();
    bot.config.model = 'sonnet';
    const result = await handleCardAction(effortPick('high', 'opus'), depsWith(undefined), LARK_APP_ID);
    expect(applyConfigField).not.toHaveBeenCalled();
    expect(result.toast.type).toBe('warning');
  });

  it('turns a locked selection conflict into a refresh prompt without a success card', async () => {
    adminBot();
    vi.mocked(findConfigField).mockReturnValue(effortSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'high' } as any);
    vi.mocked(applyConfigField).mockResolvedValue({ ok: false, reason: 'config_selection_changed' } as any);
    const result = await handleCardAction(effortPick(), depsWith(undefined), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.card).toBeUndefined();
  });

  it('keeps the old model and exposes an effort reset when a model pairing is incompatible', async () => {
    const bot = adminBot();
    bot.config.reasoningEffort = 'max';
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'haiku' } as any);
    vi.mocked(applyConfigField).mockResolvedValue({ ok: false, reason: 'reasoning_effort_not_supported_by_model' } as any);
    const result = await handleCardAction(defaultPick(), depsWith(undefined), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(bot.config.model).toBe('opus');
    const effort = result.card.data.elements.filter((e: any) => e.tag === 'action')[1].actions[0];
    expect(effort.options[0].value).toBe('__unset__');
  });

  it('keeps the current default selectable when the catalogue exceeds the Lark option limit', () => {
    const models = Array.from({ length: 75 }, (_, i) => `model-${i}`);
    const card = JSON.parse(buildDefaultModelPickerCard(LARK_APP_ID, models, 'model-74', 'zh', 'claude-code'));
    const select = card.elements.find((e: any) => e.tag === 'action').actions[0];
    expect(select.options.length).toBeLessThanOrEqual(50);
    expect(select.initial_option).toBe('model-74');
    expect(select.options.map((o: any) => o.value)).toContain('model-74');
  });

  it('clears the default through the same model field', async () => {
    const bot = adminBot();
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    vi.mocked(applyConfigField).mockImplementation(async (_app, _spec, model) => {
      bot.config.model = model ?? undefined;
      return { ok: true, newText: 'default', effect: 'next-session' } as any;
    });
    const result = await handleCardAction(defaultPick('__unset__'), depsWith(undefined), LARK_APP_ID);
    expect(applyConfigField).toHaveBeenCalledWith(LARK_APP_ID, modelSpec, null, { selectionKey: 'claude-code', requireLaunchModelSupport: true, actorOpenId: OWNER });
    expect(result.toast.type).toBe('success');
  });

  it('reports default persistence failure without changing the active session', async () => {
    adminBot();
    const ds = makeDs({ sessionOverrides: { model: 'session-model' } });
    vi.mocked(findConfigField).mockReturnValue(modelSpec);
    vi.mocked(coerceConfigValue).mockReturnValue({ ok: true, value: 'haiku' } as any);
    vi.mocked(applyConfigField).mockResolvedValue({ ok: false, reason: 'disk full' } as any);
    const result = await handleCardAction(defaultPick(), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('error');
    expect(ds.session.model).toBe('session-model');
  });
});

describe('/models topic reasoning effort', () => {
  function setup() {
    const ds = makeDs({ activeModel: 'sonnet', activeReasoningEffort: 'high', sessionOverrides: { cliId: 'traex', cliSessionId: 'native-topic' } });
    topicReasoningControlMock.mockImplementation(() => ({ model: 'sonnet', choices: ['low', 'medium', 'high'],
      selected: ds.session.topicReasoningEffort?.effort ?? 'high', active: 'high',
      pending: !!ds.session.topicReasoningEffort && ds.session.topicReasoningEffort.effort !== 'high' }));
    setTopicReasoningEffortMock.mockImplementation((_ds: any, effort: any) => {
      ds.session.topicReasoningEffort = { model: 'sonnet', effort }; return 'saved';
    });
    return ds;
  }
  async function panel(ds: DaemonSession) {
    const deps = depsWith(ds);
    await handleCommand('/models', ROOT, { messageId: 'om_topic_models', senderId: OWNER, content: '/models' } as any, deps, LARK_APP_ID);
    return JSON.parse(deliverEphemeralOrReplyMock.mock.calls.at(-1)![2]);
  }
  function action(value: any, option?: string) {
    return { operator: { open_id: OWNER }, action: { value, ...(option ? { option } : {}) }, context: { open_message_id: 'om_topic_panel' } };
  }
  it('renders effort choices in a topic and saves its preference without restarting or changing bot defaults', async () => {
    const ds = setup(); const card = await panel(ds);
    const effort = card.elements.filter((e: any) => e.tag === 'action')[1].actions[0];
    expect(effort.value).toMatchObject({ action: 'session_effort_pick', session_id: SID, expected_model: 'sonnet' });
    expect(effort.options.map((o: any) => o.value)).toEqual(['low', 'medium', 'high']);
    const result = await handleCardAction(action(effort.value, 'low'), depsWith(ds), LARK_APP_ID);
    expect(setTopicReasoningEffortMock).toHaveBeenCalledWith(ds, 'low');
    expect(requestSessionRestartMock).not.toHaveBeenCalled();
    expect(applyConfigField).not.toHaveBeenCalled();
    expect(result.card.data.elements.some((e: any) => e.tag === 'action' && e.actions.some((a: any) => a.value?.action === 'session_effort_apply'))).toBe(true);
  });
  it('only applies the saved effort after the explicit reload button', async () => {
    const ds = setup(); ds.session.topicReasoningEffort = { model: 'sonnet', effort: 'low' };
    const card = await panel(ds); const button = card.elements.find((e: any) => e.tag === 'action' && e.actions[0].value?.action === 'session_effort_apply').actions[0];
    const result = await handleCardAction(action(button.value), depsWith(ds), LARK_APP_ID);
    expect(requestSessionRestartMock).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'card' }), {
      topicEffort: { model: 'sonnet', effort: 'low', nativeSessionId: 'native-topic' },
    });
    expect(result.toast.type).toBe('info');
  });
  it.each(['model', 'chat', 'worker-generation', 'cli-generation', 'preference', 'permission'])('rejects a stale topic effort card: %s', async kind => {
    const ds = setup(); const card = await panel(ds); const value = card.elements.filter((e: any) => e.tag === 'action')[1].actions[0].value;
    if (kind === 'model') topicReasoningControlMock.mockReturnValue({ model: 'other-model', choices: ['low'] });
    if (kind === 'chat') value.chat_id = 'other-chat';
    if (kind === 'worker-generation') ds.workerGeneration = 2;
    if (kind === 'cli-generation') ds.cliReadyGeneration = 2;
    if (kind === 'preference') ds.session.topicReasoningEffort = { model: 'sonnet', effort: 'medium' };
    if (kind === 'permission') vi.mocked(canOperate).mockReturnValue(false);
    await handleCardAction(action(value, 'low'), depsWith(ds), LARK_APP_ID);
    expect(setTopicReasoningEffortMock).not.toHaveBeenCalled();
    expect(requestSessionRestartMock).not.toHaveBeenCalled();
  });
  it('does not reload while business input owns the session', async () => {
    const ds = setup(); ds.session.topicReasoningEffort = { model: 'sonnet', effort: 'low' };
    const card = await panel(ds); const button = card.elements.find((e: any) => e.tag === 'action' && e.actions[0].value?.action === 'session_effort_apply').actions[0];
    sessionAcceptsDirectCommandMock.mockReturnValue(false);
    await handleCardAction(action(button.value), depsWith(ds), LARK_APP_ID);
    expect(requestSessionRestartMock).not.toHaveBeenCalled();
  });
});

describe('reply menu misc', () => {
  it('cancel button is an empty ACK with no side effects', async () => {
    enableMenu();
    const ds = makeDs();
    const data = {
      operator: { open_id: OWNER },
      action: { value: { action: 'reply_menu_cancel', root_id: ROOT, session_id: SID } },
      context: { open_message_id: 'om_confirm_card' },
    };
    const result = await handleCardAction(data, depsWith(ds), LARK_APP_ID);
    expect(result).toEqual({});
    expect(closeSessionMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
  });

});

// ─── durable-primary close fencing ────────────────────────────────────────

describe('reply_card_menu under durable-primary coordination', () => {
  it('guides the user to /close instead of sending a doomed confirm card', async () => {
    enableMenu();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    try {
      const ds = makeDs();
      const result = await handleCardAction(menuData('close'), depsWith(ds), LARK_APP_ID);
      expect(result.toast.type).toBe('warning');
      expect(result.toast.content).toContain('/close');
      expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ─── CLI without raw passthrough: model entry precheck ────────────────────

describe('model option precheck', () => {
  it('posts an unsupported notice instead of a picker for codex-app', async () => {
    enableMenu('codex-app');
    const ds = makeDs({ sessionOverrides: { cliId: 'codex-app' } as any });
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    expect(result.toast).toBeUndefined();
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverEphemeralOrReplyMock.mock.calls[0][2]).toContain('终端内使用 /model');
  });
});

describe('model picker option sanitisation', () => {
  it('drops live-detected slugs that fail the inject pattern', async () => {
    enableMenu();
    detectModelsMock.mockResolvedValue(['good-model', 'has space', '../evil', 'x'.repeat(130)]);
    const ds = makeDs();
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    await result.afterAck();
    const select = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2])
      .elements.find((e: any) => e.tag === 'action').actions[0];
    const values = select.options.map((o: any) => o.value);
    expect(values).toContain('good-model');
    expect(values).not.toContain('has space');
    expect(values).not.toContain('../evil');
    expect(values).not.toContain('x'.repeat(130));
  });
});

// ─── P2-b: model catalogue key must carry wrapper/launch mode ─────────────

describe('model catalogue selection key', () => {
  it('probes with the wrapper-composed key, not the bare frozen cliId', async () => {
    enableMenu();
    const seenKeys: string[] = [];
    staticModelChoicesMock.mockImplementation((key: string) => { seenKeys.push(key); return ['glm-5.1']; });
    detectModelsMock.mockResolvedValue([]);
    const ds = makeDs({ sessionOverrides: { cliId: 'codex', wrapperCli: 'ttadk codex' } as any });
    const result = await handleCardAction(menuData('model'), depsWith(ds), LARK_APP_ID);
    await result.afterAck();
    expect(seenKeys.length).toBeGreaterThan(0);
    expect(seenKeys.every(k => k === 'ttadk-x-codex')).toBe(true);
  });

  it('submission whitelist uses the same wrapper-composed key', async () => {
    enableMenu();
    const seenKeys: string[] = [];
    staticModelChoicesMock.mockImplementation((key: string) => { seenKeys.push(key); return ['glm-5.1']; });
    detectModelsMock.mockResolvedValue([]);
    const ds = makeDs({ sessionOverrides: { cliId: 'codex', wrapperCli: 'ttadk codex' } as any });
    const deliver = vi.fn();
    // A native-codex slug must NOT pass for a gateway session.
    await handleCardAction(pickData('gpt-5.6-sol'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).not.toHaveBeenCalled();
    // The gateway slug passes and is injected.
    const deliver2 = vi.fn();
    const ok = await handleCardAction(pickData('glm-5.1'), depsWith(ds, deliver2), LARK_APP_ID);
    expect(deliver2).toHaveBeenCalledTimes(1);
    expect(deliver2.mock.calls[0][1]).toBe('/model glm-5.1');
    expect(ok.toast.type).toBe('success');
    expect(seenKeys.every(k => k === 'ttadk-x-codex')).toBe(true);
  });
});

// ─── P2-c: bound-to-platform deployments get the read-only front door ──────

describe('reply_card_menu terminal option under a bound platform', () => {
  it('offers the session recovery link from the menu when there is no live worker', async () => {
    enableMenu();
    remoteAccessEnabledMock.mockReturnValue(true);
    platformTerminalBaseUrlMock.mockReturnValue('https://t-m1.example.com');
    setTerminalProxyPort(9100);
    const ds = makeDs({ worker: null, workerReady: false, workerPort: null,
      sessionOverrides: { webPort: 9000 } });
    const recoveryUrl = 'https://t-m1.example.com/s/sess-menu-1?viewToken=recovery-view';
    readableTerminalUrlMock.mockReturnValue(recoveryUrl);
    liveReadableTerminalUrlMock.mockReturnValue('');
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverWriteLinkCardMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
    const card = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    const open = card.elements.find((e: any) => e.tag === 'action').actions.find((b: any) => b.multi_url);
    expect(open.multi_url.url).toBe(recoveryUrl);
    expect(result.toast).toBeUndefined();
  });

  it('delivers a read-only card (no write token, manage buttons off) and no write-link toast', async () => {
    enableMenu();
    remoteAccessEnabledMock.mockReturnValue(true);
    platformTerminalBaseUrlMock.mockReturnValue('https://t-m1.example.com');
    setTerminalProxyPort(9100);
    const ds = makeDs({ workerPort: 9000, workerToken: 'write-tok', workerViewToken: 'view-tok' } as any);
    readableTerminalUrlMock.mockReturnValue('https://t-m1.example.com/s/sess-menu-1?viewToken=view-tok');
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverWriteLinkCardMock).not.toHaveBeenCalled();
    expect(deliverEphemeralOrReplyMock).toHaveBeenCalledTimes(1);
    const card = JSON.parse(deliverEphemeralOrReplyMock.mock.calls[0][2]);
    const buttons = card.elements.find((e: any) => e.tag === 'action').actions;
    const open = buttons.find((b: any) => b.multi_url);
    expect(JSON.stringify(open.multi_url)).toContain('viewToken=view-tok');
    expect(JSON.stringify(open.multi_url)).not.toContain('write-tok');
    expect(JSON.stringify(open.multi_url)).toContain('t-m1.example.com');
    // Explicit write-link fallback survives as a gated callback button.
    expect(buttons.some((b: any) => b.value?.action === 'get_write_link')).toBe(true);
    expect(buttons.some((b: any) => b.value?.action === 'close')).toBe(true);
    expect(buttons.some((b: any) => b.value?.action === 'restart')).toBe(false);
    // No "write link sent" toast on the read-only path.
    expect(result.toast).toBeUndefined();
  });

  it('keeps the private write-link path on riff sessions even when platform-bound', async () => {
    enableMenu();
    remoteAccessEnabledMock.mockReturnValue(true);
    platformTerminalBaseUrlMock.mockReturnValue('https://t-m1.example.com');
    const ds = makeDs({ riffAccessUrl: 'https://aio.example/x', workerPort: null, workerToken: null } as any);
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverWriteLinkCardMock).toHaveBeenCalledTimes(1);
    expect(deliverEphemeralOrReplyMock).not.toHaveBeenCalled();
    const cardJson = deliverWriteLinkCardMock.mock.calls[0][2];
    expect(cardJson).toContain('https://aio.example/x');
    expect(result.toast.type).toBe('success');
  });

  it('keeps the private write-link path when the machine is not platform-bound', async () => {
    enableMenu();
    // remote access off / no binding: mocks reset to false/null in beforeEach.
    const ds = makeDs({ workerPort: 9000, workerToken: 'tok' } as any);
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    expect(deliverWriteLinkCardMock).toHaveBeenCalledTimes(1);
    expect(result.toast.type).toBe('success');
  });

  it('does not claim the platform read entry when the terminal proxy is not up', async () => {
    enableMenu();
    remoteAccessEnabledMock.mockReturnValue(true);
    platformTerminalBaseUrlMock.mockReturnValue('https://t-m1.example.com');
    resetTerminalProxy(); // bound + remote access on, but no proxy → not a real platform front door
    const ds = makeDs({ workerPort: 9000, workerToken: 'tok' } as any);
    const result = await handleCardAction(menuData('terminal'), depsWith(ds), LARK_APP_ID);
    // Falls back to the original private write-link path, never a fake read card.
    expect(deliverWriteLinkCardMock).toHaveBeenCalledTimes(1);
    expect(result.toast.type).toBe('success');
  });
});
