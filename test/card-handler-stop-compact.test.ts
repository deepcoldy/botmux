/**
 * Unit tests for the stop_turn / compact_session streaming-card actions:
 *
 *   - stop_turn: forwards term_action ctrlc over the existing worker IPC
 *     (session kept alive) and re-renders the card as the transient
 *     'interrupted' state; refusal branches for gone sessions, RPC-input /
 *     codex-app modes, dead workers, and in-flight transfers.
 *   - compact_session: delegates to deps.deliverPassthroughCommand (daemon
 *     wires it to deliverPassthroughToExistingSession — /compact passthrough).
 *   - both actions sit behind the isSensitive canOperate gate.
 *
 * Mocked surface follows card-handler-repo-select.test.ts.
 *
 * Run: pnpm vitest run test/card-handler-stop-compact.test.ts
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

vi.mock('../src/core/worker-pool.js', () => ({
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
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: vi.fn(),
  deliverEphemeralOrReply: vi.fn(),
  CARD_POSTING_SENTINEL: '__posting__',
  requestSessionRestart: vi.fn(),
  isSessionTransferring: (...args: any[]) => isSessionTransferringMock(...args),
  getDaemonStreamingCardUsageSnapshot: vi.fn(() => undefined),
  withActiveSessionKeyLock: vi.fn(async (_map: any, _key: string, action: () => any) => action()),
  buildStreamingCardJson: vi.fn(),
  silentIdleCardFlag: vi.fn(() => false),
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
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { getBot } from '../src/bot-registry.js';
import { sessionKey, sessionAnchorId, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

// ─── stop_turn ────────────────────────────────────────────────────────────

describe('stop_turn card action', () => {
  it('sends term_action ctrlc to the worker and re-renders the card as interrupted', async () => {
    const ds = makeDs();
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);

    expect(sendWorkerSessionInputMock).toHaveBeenCalledTimes(1);
    expect(sendWorkerSessionInputMock).toHaveBeenCalledWith(ds, { type: 'term_action', key: 'ctrlc' });
    expect(result.toast.type).toBe('success');
    // 重渲染卡片：橙色 header + 「已中断」transient 状态。
    expect(result.card.type).toBe('raw');
    expect(result.card.data.header.template).toBe('orange');
    expect(result.card.data.header.title.content).toContain('已中断');
  });

  it('refuses with session_gone toast when the session is not active', async () => {
    const result = await handleCardAction(actionData('stop_turn'), depsWith(undefined), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('会话已不在线');
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });

  it('refuses codex RPC input mode (^C cannot reach the app-server)', async () => {
    const ds = makeDs({ initConfig: { codexRpcInput: true } as any });
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('不支持卡片停止');
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });

  it('refuses codex-app (App Runner has no PTY input channel)', async () => {
    const ds = makeDs({ sessionOverrides: { cliId: 'codex-app' } });
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('不支持卡片停止');
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });

  it('refuses when the worker is dead', async () => {
    const ds = makeDs({ worker: { killed: true } as any });
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('CLI 未运行');
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });

  it('refuses while a session transfer is in flight', async () => {
    isSessionTransferringMock.mockReturnValue(true);
    const ds = makeDs();
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('接力');
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });

  it('is silently blocked for non-operators (canOperate gate)', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    const result = await handleCardAction(actionData('stop_turn'), depsWith(ds), LARK_APP_ID);
    // 与 term_action/close 同款：敏感动作对非 operator 静默 block（仅日志）。
    expect(result).toBeUndefined();
    expect(sendWorkerSessionInputMock).not.toHaveBeenCalled();
  });
});

// ─── compact_session ──────────────────────────────────────────────────────

describe('compact_session card action', () => {
  it('delivers /compact via the wired passthrough dep with the session anchor', async () => {
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(actionData('compact_session'), depsWith(ds, deliver), LARK_APP_ID);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [gotDs, cmd, opts] = deliver.mock.calls[0];
    expect(gotDs).toBe(ds);
    expect(cmd).toBe('/compact');
    expect(opts.anchor).toBe(sessionAnchorId(ds));
    expect(opts.senderIsBot).toBe(false);
    expect(typeof opts.messageId).toBe('string');
    expect(result.toast.type).toBe('success');
    expect(result.toast.content).toContain('/compact');
  });

  it('falls back to an unsupported toast when the daemon did not wire the dep', async () => {
    const ds = makeDs();
    const result = await handleCardAction(actionData('compact_session'), depsWith(ds, undefined), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('不支持卡片压缩');
  });

  it('refuses when the worker is dead', async () => {
    const ds = makeDs({ worker: { killed: true } as any });
    const deliver = vi.fn();
    const result = await handleCardAction(actionData('compact_session'), depsWith(ds, deliver), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('无法压缩');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses with session_gone toast when the session is not active', async () => {
    const deliver = vi.fn();
    const result = await handleCardAction(actionData('compact_session'), depsWith(undefined, deliver), LARK_APP_ID);
    expect(result.toast.type).toBe('warning');
    expect(result.toast.content).toContain('会话已不在线');
    expect(deliver).not.toHaveBeenCalled();
  });

  // ── defense-in-depth: 按钮路径不得重新打开 router 故意关掉的通道 ──────────
  // /compact 走 raw_input 把**字面量**写进 PTY，绕过 runner 的
  // `::botmux-<id>:<base64>` 帧协议：dsh 打 `ignoring non-frame input` 静默丢弃，
  // mira/mir 把它当**普通用户消息**发给模型白烧一个 turn。router
  // （resolvePassthroughCommands）对这些 CLI 返回空集，handler 也必须拒——否则
  // 卡片侧闸门一旦再漏，这条路又会被打开（本次缺陷正是这么发生的）。
  it.each(['mira', 'mir', 'dsh', 'ebsd', 'codex-app'])(
    'refuses for %s (no raw passthrough surface) instead of writing a literal /compact',
    async (cliId) => {
      const ds = makeDs({ sessionOverrides: { cliId } as any });
      const deliver = vi.fn();
      const result = await handleCardAction(actionData('compact_session'), depsWith(ds, deliver), LARK_APP_ID);
      expect(result.toast.type).toBe('warning');
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  // dsh-tui 是 PTY 驱动的交互式 TUI，raw /compact 有效；它靠 bot 级 dshRuntime='tui'
  // 选中（cliId 仍是 'dsh'），所以 handler 必须把运行时一并喂给谓词，不能只看 cliId。
  it('still delivers for a dsh bot running the interactive TUI (dshRuntime=tui)', async () => {
    vi.mocked(getBot).mockReturnValueOnce({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'dsh', dshRuntime: 'tui' },
      resolvedAllowedUsers: [],
      botName: 'testbot',
      botOpenId: 'ou_bot',
    } as any);
    const ds = makeDs({ sessionOverrides: { cliId: 'dsh' } as any });
    const deliver = vi.fn();
    const result = await handleCardAction(actionData('compact_session'), depsWith(ds, deliver), LARK_APP_ID);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result.toast.type).toBe('success');
  });

  it('is silently blocked for non-operators (canOperate gate)', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    const deliver = vi.fn();
    const result = await handleCardAction(actionData('compact_session'), depsWith(ds, deliver), LARK_APP_ID);
    expect(result).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });
});

// ─── isSensitive source lock ──────────────────────────────────────────────

describe('stop_turn / compact_session permission gate (source lock)', () => {
  it('both actions are registered in the isSensitive canOperate gate', () => {
    // 防止后续重构把两个新 action 误移出权限闸（与 term_action/close 同档）。
    const source = readFileSync(resolve('src/im/lark/card-handler.ts'), 'utf8');
    const line = source.split('\n').find(l => l.includes('const isSensitive ='));
    expect(line).toBeTruthy();
    expect(line!).toContain('stop_turn');
    expect(line!).toContain('compact_session');
  });
});
