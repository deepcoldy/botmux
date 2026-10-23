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
const isSessionTransferringMock = vi.fn(() => false);
const sessionAcceptsDirectCommandMock = vi.fn(() => true);
const closeSessionMock = vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false }));
const deliverWriteLinkCardMock = vi.fn();
const deliverEphemeralOrReplyMock = vi.fn(async (_ds: any, _who: string, card: string) => card);

vi.mock('../src/core/worker-pool.js', () => ({
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
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: (...args: any[]) => deliverWriteLinkCardMock(...args),
  deliverEphemeralOrReply: (...args: any[]) => deliverEphemeralOrReplyMock(...args),
  CARD_POSTING_SENTINEL: '__posting__',
  requestSessionRestart: vi.fn(),
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

import { handleCardAction } from '../src/im/lark/card-handler.js';
import { setTerminalProxyPort, resetTerminalProxy } from '../src/core/terminal-url.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { getBot } from '../src/bot-registry.js';
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
  vi.mocked(canOperate).mockReset().mockReturnValue(true);
  vi.mocked(getBot).mockReset().mockReturnValue({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  } as any);
  isSessionTransferringMock.mockReset().mockReturnValue(false);
  readableTerminalUrlMock.mockReset().mockReturnValue('https://example.com/term');
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
