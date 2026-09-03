/**
 * Unit tests for the `retry_turn` failure-card action.
 *
 * The safety property under test is the ONE-SHOT INTERLOCK. The pre-existing
 * `retry_last_task` button gets that property for free: it requires
 * `ds.usageLimit`, which is consumed (`clearUsageLimitState`) on success, so a
 * second click finds no state and refuses. A failure card has no such
 * throwaway state, so `retry_turn` derives the same guarantee from
 * `lastFailedTurn.turnId`:
 *
 *   - the clicked card carries the turnId it was built for;
 *   - the handler resubmits only if that id still matches the session's
 *     current failed turn.
 *
 * Both directions matter and both are tested: a matching id must actually
 * resubmit (or the button is decorative), and a non-matching / absent id must
 * refuse (or a stale card can re-run a task whose side effects already landed).
 *
 * Mocked surface follows card-handler-stop-compact.test.ts.
 *
 * Run: npx vitest run test/card-handler-retry-turn.test.ts
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

const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...a: any[]) => updateSessionMock(...a),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

const sendWorkerInputMock = vi.fn(() => true);
const forkWorkerMock = vi.fn();
const isSessionTransferringMock = vi.fn(() => false);
const hasProtectedOwnershipMock = vi.fn(() => false);

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  sendWorkerInput: (...a: any[]) => sendWorkerInputMock(...a),
  sendWorkerSessionInput: vi.fn(),
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
  isSessionTransferring: (...a: any[]) => isSessionTransferringMock(...a),
  getDaemonStreamingCardUsageSnapshot: vi.fn(() => undefined),
  withActiveSessionKeyLock: vi.fn(async (_m: any, _k: string, action: () => any) => action()),
  buildStreamingCardJson: vi.fn(),
  silentIdleCardFlag: vi.fn(() => false),
}));

const rememberLastCliInputMock = vi.fn();
vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicCliInput: vi.fn(() => ({ content: 'mock-prompt' })),
  getAvailableBots: vi.fn(async () => []),
  persistStreamCardState: vi.fn(),
  resumeSession: vi.fn(),
  rememberLastCliInput: (...a: any[]) => rememberLastCliInputMock(...a),
  ensureSessionWhiteboard: vi.fn(),
}));

vi.mock('../src/core/session-mutation-guard.js', () => ({
  hasProtectedSessionMutationOwnership: (...a: any[]) => hasProtectedOwnershipMock(...a),
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
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session, FailedTurnRecord } from '../src/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LARK_APP_ID = 'cli_app_1';
const OWNER = 'ou_owner_user';
const ROOT = 'om_root_retry';
const SID = 'sess-retry-1';
const TURN = 'turn-aaaaaaaa-bbbb';

function makeFailedTurn(over: Partial<FailedTurnRecord> = {}): FailedTurnRecord {
  return {
    turnId: TURN,
    userPrompt: 'do the thing',
    cliInput: 'wrapped: do the thing',
    failedAt: new Date().toISOString(),
    errorCode: 'cli_exit',
    status: 'ambiguous',
    retryCount: 0,
    ...over,
  };
}

function makeDs(over: Partial<DaemonSession> & { sessionOverrides?: Partial<Session> } = {}): DaemonSession {
  const { sessionOverrides, ...dsOver } = over;
  const session: Session = {
    sessionId: SID,
    chatId: 'oc_chat',
    rootMessageId: ROOT,
    title: 'retry task',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: LARK_APP_ID,
    ownerOpenId: OWNER,
    workingDir: '/tmp/proj',
    cliId: 'claude-code',
    lastFailedTurn: makeFailedTurn(),
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
    ...dsOver,
  } as DaemonSession;
}

/** `turnId === null` omits turn_id entirely (an old card built before the pin). */
function actionData(turnId: string | null = TURN, mode: string | null = 'resend'): any {
  return {
    operator: { open_id: OWNER },
    action: {
      value: {
        action: 'retry_turn',
        root_id: ROOT,
        session_id: SID,
        ...(turnId === null ? {} : { turn_id: turnId }),
        ...(mode === null ? {} : { mode }),
      },
    },
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

beforeEach(() => {
  sendWorkerInputMock.mockReset();
  sendWorkerInputMock.mockReturnValue(true);
  forkWorkerMock.mockReset();
  updateSessionMock.mockReset();
  rememberLastCliInputMock.mockReset();
  isSessionTransferringMock.mockReset();
  isSessionTransferringMock.mockReturnValue(false);
  hasProtectedOwnershipMock.mockReset();
  hasProtectedOwnershipMock.mockReturnValue(false);
  vi.mocked(canOperate).mockReset();
  vi.mocked(canOperate).mockReturnValue(true);
});

describe('retry_turn — happy path', () => {
  it('re-injects the recorded CLI input verbatim in resend mode', async () => {
    // resend is only offered when the input provably never reached the CLI, so
    // restating the request verbatim is the cleanest thing we can do.
    const ds = makeDs();
    const res = await handleCardAction(actionData(TURN, 'resend'), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    expect(sendWorkerInputMock.mock.calls[0][1]).toMatchObject({
      content: 'wrapped: do the thing',
    });
    expect(res?.toast?.type).toBe('success');
  });

  it('submits a short continue instruction in continue mode', async () => {
    // The turn may have half-executed. Replaying the original prompt verbatim
    // would risk repeating side effects, so the CLI is told to continue and
    // explicitly not redo finished work.
    const ds = makeDs();
    const res = await handleCardAction(actionData(TURN, 'continue'), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    const sent = sendWorkerInputMock.mock.calls[0][1].content as string;
    expect(sent).toContain('[BOTMUX_CONTINUE]');
    expect(sent).toContain('不要重复已完成的操作');
    // The fork resumes the transcript, so the task text is already available to
    // the model. Re-sending it here would just burn tokens.
    expect(sent).not.toContain('do the thing');
    expect(sent).not.toContain('wrapped:');
    expect(res?.toast?.type).toBe('success');
  });

  it('treats a card with no mode as continue (fail-safe for older cards)', async () => {
    // Defaulting to resend would blindly replay a possibly-executed turn.
    const ds = makeDs();
    await handleCardAction(actionData(TURN, null), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock.mock.calls[0][1].content).toContain('[BOTMUX_CONTINUE]');
  });

  it('forks a worker when the session has none alive', async () => {
    const ds = makeDs({ worker: undefined });
    await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
  });

  it('strips clientUserMessageId so a resend cannot be deduped away', async () => {
    const ds = makeDs({
      sessionOverrides: {
        lastFailedTurn: makeFailedTurn({
          codexAppInput: { clientUserMessageId: 'prior-id', items: [] } as any,
        }),
      },
    });
    await handleCardAction(actionData(TURN, 'resend'), depsWith(ds), LARK_APP_ID);
    const sent = sendWorkerInputMock.mock.calls[0][1];
    expect(sent.codexAppInput).toBeDefined();
    expect(sent.codexAppInput.clientUserMessageId).toBeUndefined();
  });

  it('drops the codex-app sidecar in continue mode', async () => {
    // The sidecar describes "replay THIS structured input". A continue turn is
    // a different instruction, so carrying it would hand the CLI a structured
    // payload that contradicts the text.
    const ds = makeDs({
      sessionOverrides: {
        lastFailedTurn: makeFailedTurn({
          codexAppInput: { clientUserMessageId: 'prior-id', items: [] } as any,
        }),
      },
    });
    await handleCardAction(actionData(TURN, 'continue'), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock.mock.calls[0][1].codexAppInput).toBeUndefined();
  });

  it('stamps the retry attempt and persists it', async () => {
    const ds = makeDs();
    await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(ds.session.lastFailedTurn?.retryCount).toBe(1);
    expect(ds.session.lastFailedTurn?.lastRetryAt).toBeTruthy();
    expect(updateSessionMock).toHaveBeenCalled();
  });
});

describe('retry_turn — the one-shot interlock', () => {
  it('refuses a click whose turnId no longer matches the session', async () => {
    // The session failed again after this card was posted; its record now
    // points at a different turn. Resubmitting the OLD prompt here would run
    // work the user has already moved past.
    const ds = makeDs({
      sessionOverrides: { lastFailedTurn: makeFailedTurn({ turnId: 'turn-newer-one' }) },
    });
    const res = await handleCardAction(actionData(TURN), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(res?.toast?.content).toMatch(/过期/);
  });

  it('refuses a click that carries no turnId at all', async () => {
    // Fail closed: an unpinned click cannot be proven to belong to this turn.
    const ds = makeDs();
    const res = await handleCardAction(actionData(null), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(res?.toast?.content).toMatch(/过期/);
  });

  it('blocks a second click on the same card via the cooldown', async () => {
    // This is the double-submit case the usageLimit state used to prevent for
    // retry_last_task. First click succeeds and stamps lastRetryAt; the second
    // must be refused rather than running the task twice.
    const ds = makeDs();
    const first = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(first?.toast?.type).toBe('success');
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);

    const second = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1); // still 1 — not resent
    expect(second?.toast?.content).toMatch(/冷却/);
  });

  it('allows a retry again once the cooldown has elapsed', async () => {
    // The interlock must not become a permanent lockout: a genuinely stuck
    // session has to remain retryable.
    const ds = makeDs({
      sessionOverrides: {
        lastFailedTurn: makeFailedTurn({
          retryCount: 1,
          lastRetryAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    });
    const res = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).toHaveBeenCalledTimes(1);
    expect(res?.toast?.type).toBe('success');
  });
});

describe('retry_turn — refusal branches', () => {
  it('refuses when the session has no failed-turn record', async () => {
    const ds = makeDs({ sessionOverrides: { lastFailedTurn: undefined } });
    const res = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(res?.toast?.content).toMatch(/找不到/);
  });

  it('refuses while a session transfer is in flight', async () => {
    isSessionTransferringMock.mockReturnValue(true);
    const res = await handleCardAction(actionData(), depsWith(makeDs()), LARK_APP_ID);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(res?.toast?.type).toBe('warning');
  });

  it('refuses to fork over a protected session backing', async () => {
    hasProtectedOwnershipMock.mockReturnValue(true);
    const ds = makeDs({ worker: undefined });
    const res = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(res?.toast?.content).toMatch(/提交失败/);
  });

  it('reports a rejected submission instead of claiming success', async () => {
    sendWorkerInputMock.mockReturnValue(false);
    const ds = makeDs();
    const res = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(res?.toast?.content).toMatch(/提交失败/);
    // A rejected click must NOT burn the one-shot — the user can try again.
    expect(ds.session.lastFailedTurn?.retryCount).toBe(0);
    expect(ds.session.lastFailedTurn?.lastRetryAt).toBeUndefined();
  });

  it('does not burn the one-shot when submission throws', async () => {
    sendWorkerInputMock.mockImplementation(() => { throw new Error('ipc dead'); });
    const ds = makeDs();
    const res = await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(res?.toast?.content).toMatch(/提交失败/);
    expect(ds.session.lastFailedTurn?.retryCount).toBe(0);
  });
});

describe('retry_turn — permission gate', () => {
  it('is registered as a sensitive action in the source gate', () => {
    // Source-lock: the isSensitive allowlist is a plain string array with no
    // type-level enforcement, so an action dropped from it silently becomes
    // clickable by anyone in the chat. Pin membership here.
    const src = readFileSync(resolve(__dirname, '../src/im/lark/card-handler.ts'), 'utf8');
    const line = src.split('\n').find(l => l.includes('const isSensitive'));
    expect(line).toBeTruthy();
    expect(line).toContain("'retry_turn'");
  });

  it('does not resubmit when canOperate denies the operator', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    await handleCardAction(actionData(), depsWith(ds), LARK_APP_ID);
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });
});
