/**
 * Integration tests for the /retry command in command-handler.
 *
 * All external dependencies are mocked (same pattern as command-handler.test.ts);
 * the failed-turn-retry pure module and the i18n dictionaries stay real so the
 * cooldown math and reply strings are genuinely exercised.
 *
 * Run: pnpm vitest run test/command-retry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';

// ─── Mock external modules ──────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '{}'),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  writeFileSync: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    daemon: { workingDir: '~', backendType: 'pty', cliId: 'claude-code' },
    session: { dataDir: '/fake/data' },
  },
}));

vi.mock('../src/core/terminal-url.js', () => ({
  buildTerminalUrl: vi.fn(() => 'http://localhost/term'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn((id: string = 'app-1') => ({
    botName: 'Claude',
    config: {
      larkAppId: id,
      larkAppSecret: 'secret-1',
      cliId: 'claude-code' as const,
      workingDir: '~/projects',
      workingDirs: ['~/projects'],
    },
  })),
  getAllBots: vi.fn(() => []),
  getBotOpenId: vi.fn(),
  getOwnerOpenId: vi.fn(),
  findOncallChat: vi.fn(),
  effectiveDefaultWorkingDir: vi.fn(() => '~/projects'),
}));

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({})),
  repoPickerScanOptions: vi.fn(() => ({ includeWorktrees: true })),
  isWorkflowFeatureEnabled: vi.fn(() => false),
}));

vi.mock('../src/core/close-residual.js', () => ({
  closeResidualIsLocal: vi.fn(() => true),
  describeCloseResidual: vi.fn(() => ''),
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/services/schedule-store.js', () => ({}));
vi.mock('../src/core/scheduler.js', () => ({}));
vi.mock('../src/services/project-scanner.js', () => ({
  scanProjects: vi.fn(() => []),
  scanMultipleProjects: vi.fn(() => []),
  describeProjectDir: vi.fn(() => ''),
}));
vi.mock('../src/services/git-worktree.js', () => ({
  createRepoWorktree: vi.fn(),
  pushWorktreeBranch: vi.fn(),
}));
vi.mock('../src/services/worktree-slug-ai.js', () => ({
  worktreeSlugFromContextAI: vi.fn(),
}));
vi.mock('../src/core/persistent-backend.js', () => ({
  isRemoteBackendSession: vi.fn(() => false),
  resolvePairedSpawnBackendType: vi.fn(),
}));
vi.mock('../src/im/lark/card-builder.js', () => ({
  getCliDisplayName: vi.fn(() => 'Claude Code'),
  buildRepoSelectCard: vi.fn(),
  buildAdoptSelectCard: vi.fn(),
  buildCodexAppThreadSelectCard: vi.fn(),
  buildSlashListCard: vi.fn(),
  buildConfigCard: vi.fn(),
  buildForkPanelCard: vi.fn(),
  buildAdoptBlockedCard: vi.fn(),
}));
vi.mock('../src/core/dashboard-command/index.js', () => ({
  handleDashboardCommand: vi.fn(),
}));
vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(() => ({ defaultPassthroughCommands: [] })),
}));
vi.mock('../src/adapters/cli/runtime.js', () => ({
  resolveCliRuntime: vi.fn(),
  runtimeInstallationKey: vi.fn(() => 'claude-code'),
}));
vi.mock('../src/im/lark/client.js', () => ({
  deleteMessage: vi.fn(async () => true),
  sendMessage: vi.fn(async () => 'msg-id'),
  sendUserMessage: vi.fn(async () => 'msg-id'),
  replyMessage: vi.fn(async () => 'msg-id'),
  listChatBotMembers: vi.fn(async () => []),
  resolveUserUnionId: vi.fn(),
  getChatModeStrict: vi.fn(async () => 'topic'),
  getMessageThreadId: vi.fn(async () => 'omt_child'),
  uploadFile: vi.fn(),
  UserTokenMissingError: class UserTokenMissingError extends Error {},
}));
vi.mock('../src/im/lark/lark-hosts.js', () => ({
  chatAppLink: vi.fn(() => ''),
  threadAppLink: vi.fn(() => ''),
  normalizeBrand: vi.fn((b: string) => b),
}));
vi.mock('../src/services/pairing-store.js', () => ({ claimPairing: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/timezone.js', () => ({ scheduleTimeZone: vi.fn() }));

// vi.mock factories are hoisted above imports, so the shared fakes must be
// created with vi.hoisted to be referenceable inside the factories.
const { sendWorkerInput, forkWorker, rememberLastCliInput } = vi.hoisted(() => ({
  sendWorkerInput: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  forkWorker: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  rememberLastCliInput: vi.fn<(ds: any, userPrompt: string, cliInput: any, opts?: any) => void>(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  sendWorkerInput,
  forkWorker,
  killWorker: vi.fn(),
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  suspendWorker: vi.fn(() => false),
  forkAdoptWorker: vi.fn(),
  adoptSandboxBlocked: vi.fn(() => false),
  getCurrentCliVersion: vi.fn(() => '1.0.42'),
  postFreshStreamingCard: vi.fn(),
  postPrivateSnapshotCard: vi.fn(),
  resolvePrivateCardAudience: vi.fn(),
  deliverEphemeralOrReply: vi.fn(async (_ds: any, _op: any, _content: string, _type: string, reply: () => Promise<unknown>) => { await reply(); }),
  deliverWritableTerminalCardTo: vi.fn(async () => 'ephemeral'),
  closeSession: vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false })),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
  requestSessionRestart: vi.fn(),
  isSessionTransferring: vi.fn(() => false),
}));

vi.mock('../src/core/session-manager.js', () => ({
  expandHome: vi.fn((p: string) => p),
  getSessionWorkingDir: vi.fn(() => '/home/testuser/projects'),
  getProjectScanDir: vi.fn(() => '/home/testuser'),
  getProjectScanDirs: vi.fn(() => ['/home/testuser']),
  rememberLastCliInput,
  buildNewTopicCliInput: vi.fn((p: string) => ({ content: p })),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
}));

vi.mock('../src/core/initial-user-turn.js', () => ({ markInitialUserTurnPending: vi.fn() }));
vi.mock('../src/core/command-discovery.js', () => ({
  discoverSlashCommandsForAdapter: vi.fn(async () => []),
  listMcpServerNames: vi.fn(async () => []),
  supportsFilesystemCommandDiscovery: vi.fn(() => false),
}));
vi.mock('../src/core/working-dir.js', () => ({ validateWorkingDir: vi.fn() }));
vi.mock('../src/core/session-cwd.js', () => ({ repinSessionWorkingDir: vi.fn() }));
vi.mock('../src/core/session-discovery.js', () => ({
  validateAdoptTarget: vi.fn(() => true),
  adoptTargetKey: vi.fn(),
  adoptTargetLabel: vi.fn(),
}));
vi.mock('../src/core/zellij-adopt-discovery.js', () => ({
  validateZellijAdoptTarget: vi.fn(() => true),
}));
vi.mock('../src/services/codex-app-threads.js', () => ({ listCodexAppThreads: vi.fn(async () => []) }));
vi.mock('../src/utils/user-token.js', () => ({
  generateAuthUrl: vi.fn(),
  getTokenStatus: vi.fn(),
  resolveUserToken: vi.fn(),
  DOC_COMMENT_OAUTH_SCOPES: [],
  FEED_GROUP_OAUTH_SCOPES: [],
}));
vi.mock('../src/im/lark/doc-comment.js', () => ({
  DocSubscriptionPermissionError: class DocSubscriptionPermissionError extends Error {},
  listDocComments: vi.fn(),
  resolveDocFile: vi.fn(),
  subscribeDocFile: vi.fn(),
  unsubscribeDocFile: vi.fn(),
}));
vi.mock('../src/core/doc-watch-command.js', () => ({ parseDocWatchCommand: vi.fn() }));
vi.mock('../src/core/vc-meeting-prepare-command.js', () => ({ parseVcMeetingPrepareCommand: vi.fn() }));
vi.mock('../src/core/doc-comment-poller.js', () => ({ latestDocCommentPollCursor: vi.fn() }));
vi.mock('../src/services/doc-subs-store.js', () => ({
  putDocSubscription: vi.fn(),
  removeDocSubscription: vi.fn(),
  listDocSubscriptionsForSession: vi.fn(() => []),
  listAllDocSubscriptions: vi.fn(() => []),
  getDocSubscription: vi.fn(),
}));
vi.mock('../src/services/vc-meeting-preparations-store.js', () => ({
  findVcMeetingPreparationByChat: vi.fn(),
  getVcMeetingPreparation: vi.fn(),
  listVcMeetingPreparations: vi.fn(() => []),
  putVcMeetingPreparation: vi.fn(),
  removeVcMeetingPreparation: vi.fn(),
  removeVcMeetingPreparationsByChat: vi.fn(),
}));
vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: vi.fn(),
  unbindOncall: vi.fn(),
  getOncallStatus: vi.fn(),
}));
vi.mock('../src/services/bot-config-store.js', () => ({
  CONFIG_FIELDS: [],
  findConfigField: vi.fn(),
  settableFieldKeys: [],
  parseBooleanValue: vi.fn(),
  applyConfigField: vi.fn(),
  setBotAllowedUsers: vi.fn(),
  getConfigSnapshot: vi.fn(),
  getConfigCardData: vi.fn(),
  coerceConfigValue: vi.fn(),
}));
vi.mock('../src/setup/bot-config-editor.js', () => ({
  resolveCliId: vi.fn(),
  findInvalidAllowedUserEntries: vi.fn(() => []),
}));
vi.mock('../src/core/closed-session-card.js', () => ({ buildClosedSessionCard: vi.fn() }));
vi.mock('../src/setup/cli-selection.js', () => ({ ttadkConfigModelChoices: vi.fn(() => []) }));
vi.mock('../src/core/session-activity.js', () => ({
  publishAttentionPatch: vi.fn(),
  announcePendingRepoSession: vi.fn(),
}));
vi.mock('../src/services/card-mode-store.js', () => ({ setCardMode: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canOperate: vi.fn(() => true) }));
vi.mock('../src/services/insight/report.js', () => ({ buildSafeInsightReport: vi.fn() }));
vi.mock('../src/utils/working-dir.js', () => ({ invalidWorkingDirs: vi.fn(() => []) }));
vi.mock('../src/core/role-resolver.js', () => ({
  writeRoleFile: vi.fn(),
  deleteRoleFile: vi.fn(),
  resolveRole: vi.fn(),
  resolveRoleFile: vi.fn(),
  resolveTeamRoleFile: vi.fn(),
  writeTeamRoleFile: vi.fn(),
  deleteTeamRoleFile: vi.fn(),
  MAX_ROLE_BYTES: 32 * 1024,
}));
vi.mock('../src/services/bot-profile-store.js', () => ({
  getBotCapability: vi.fn(),
  setBotCapability: vi.fn(),
  clearBotCapability: vi.fn(),
}));
vi.mock('../src/services/role-profile-store.js', () => ({
  deleteRoleProfileEntry: vi.fn(),
  deleteRoleProfileIfEmpty: vi.fn(),
  isValidRoleProfileId: vi.fn(),
  listRoleProfileEntries: vi.fn(() => []),
  listRoleProfiles: vi.fn(() => []),
  MAX_ROLE_PROFILE_ENTRY_BYTES: 4096,
  readRoleProfileEntry: vi.fn(),
  writeRoleProfileEntry: vi.fn(),
}));
vi.mock('../src/core/skills/im-command.js', () => ({ runSkillsImCommand: vi.fn() }));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({ fetchDaemonIpc: vi.fn() }));
vi.mock('../src/core/session-title.js', () => ({ updateSessionTitle: vi.fn() }));
vi.mock('../src/core/session-rename.js', () => ({ requestAgentSessionRename: vi.fn() }));
vi.mock('../src/core/session-mutation-guard.js', () => ({ hasProtectedSessionMutationOwnership: vi.fn(() => false) }));
vi.mock('../src/core/bot-turn-mutation-gate.js', () => ({ withBotTurnMutation: vi.fn(async (_id: string, action: () => any) => action()) }));
vi.mock('../src/core/reply-target.js', () => ({ rehomeReplyTargetState: vi.fn() }));
vi.mock('../src/core/cli-runtime-display.js', () => ({
  configuredRuntimeDisplayName: vi.fn(() => undefined),
  sessionConfiguredRuntimeDisplayName: vi.fn(() => undefined),
}));
vi.mock('../src/services/session-groups-store.js', () => ({ isSessionGroup: vi.fn(() => false) }));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { handleCommand, DAEMON_COMMANDS } from '../src/core/command-handler.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session, FailedTurnRecord } from '../src/types.js';
import * as sessionStore from '../src/services/session-store.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LARK_APP_ID = 'app-1';
const ROOT_ID = 'om_root_abc123';
const CHAT_ID = 'oc_chat_xyz';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-001',
    chatId: CHAT_ID,
    rootMessageId: ROOT_ID,
    title: 'Test Session',
    status: 'active',
    createdAt: new Date().toISOString(),
    cliId: 'claude-code',
    ...overrides,
  };
}

function makeFailedTurn(overrides: Partial<FailedTurnRecord> = {}): FailedTurnRecord {
  return {
    turnId: 'turn-failed-1',
    userPrompt: 'fix the flaky test',
    cliInput: '<user-prompt>fix the flaky test</user-prompt>',
    failedAt: new Date().toISOString(),
    errorCode: 'provider_unexpected_eof',
    status: 'failed',
    retryCount: 0,
    ...overrides,
  };
}

function makeDaemonSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: makeSession(),
    worker: null,
    workerPort: null,
    workerToken: null,
    scope: 'thread',
    larkAppId: LARK_APP_ID,
    chatId: CHAT_ID,
    chatType: 'group',
    spawnedAt: Date.now() - 60_000,
    cliVersion: '1.0.42',
    lastMessageAt: Date.now() - 5_000,
    hasHistory: true,
    ...overrides,
  };
}

function makeLarkMessage(content: string): LarkMessage {
  return {
    messageId: 'msg_001',
    rootId: ROOT_ID,
    senderId: 'ou_sender',
    senderType: 'user',
    msgType: 'text',
    content,
    createTime: String(Date.now()),
  };
}

function makeDeps(ds?: DaemonSession): CommandHandlerDeps & { sessionReply: ReturnType<typeof vi.fn> } {
  const activeSessions = new Map<string, DaemonSession>();
  if (ds) activeSessions.set(sessionKey(ROOT_ID, ds.larkAppId), ds);
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
    prewarmDocCommentSession: vi.fn(async () => {}),
  };
}

function aliveWorker(): { killed: boolean } {
  return { killed: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendWorkerInput.mockReturnValue(true);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('/retry command', () => {
  it('replies no_session when the topic has no active session', async () => {
    const deps = makeDeps();
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('没有活跃的会话'), undefined, LARK_APP_ID, 'msg_001');
    expect(sendWorkerInput).not.toHaveBeenCalled();
  });

  it('replies no_failed_turn when the session has no failed turn recorded', async () => {
    const ds = makeDaemonSession({ worker: aliveWorker() as any });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('没有失败或被中断的 turn'), undefined, LARK_APP_ID, 'msg_001');
    expect(sendWorkerInput).not.toHaveBeenCalled();
  });

  it('re-injects via sendWorkerInput when the worker is alive and cooldown expired', async () => {
    const ds = makeDaemonSession({
      worker: aliveWorker() as any,
      session: makeSession({ lastFailedTurn: makeFailedTurn() }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);

    expect(sendWorkerInput).toHaveBeenCalledTimes(1);
    const [sentDs, payload] = sendWorkerInput.mock.calls[0];
    expect(sentDs).toBe(ds);
    expect(payload).toMatchObject({ content: '<user-prompt>fix the flaky test</user-prompt>' });
    expect(forkWorker).not.toHaveBeenCalled();
    // Cooldown/retry state stamped onto the persisted record.
    expect(ds.session.lastFailedTurn?.retryCount).toBe(1);
    expect(ds.session.lastFailedTurn?.lastRetryAt).toBeTruthy();
    // The re-injected input becomes the session's last CLI turn.
    expect(rememberLastCliInput).toHaveBeenCalledWith(ds, 'fix the flaky test', expect.objectContaining({
      content: '<user-prompt>fix the flaky test</user-prompt>',
    }));
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('已重新提交'), undefined, LARK_APP_ID, 'msg_001');
  });

  it('forks a fresh worker when the current one is dead', async () => {
    const ds = makeDaemonSession({
      worker: { killed: true } as any,
      session: makeSession({ lastFailedTurn: makeFailedTurn() }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);

    expect(sendWorkerInput).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(1);
    const [forkedDs, payload, hasHistory] = forkWorker.mock.calls[0];
    expect(forkedDs).toBe(ds);
    expect(payload).toMatchObject({ content: '<user-prompt>fix the flaky test</user-prompt>' });
    expect(hasHistory).toBe(true);
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('已重新提交'), undefined, LARK_APP_ID, 'msg_001');
  });

  it('replies cooldown and does not inject while the cooldown is active', async () => {
    const ds = makeDaemonSession({
      worker: aliveWorker() as any,
      session: makeSession({
        lastFailedTurn: makeFailedTurn({ lastRetryAt: new Date(Date.now() - 5_000).toISOString() }),
      }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);

    expect(sendWorkerInput).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('重试冷却中'), undefined, LARK_APP_ID, 'msg_001');
    // 10s cooldown, 5s elapsed → ceil(5s) = 5 seconds advertised.
    expect(deps.sessionReply.mock.calls[0][1]).toContain('5');
  });

  it('replies submit_failed when the worker rejects the input', async () => {
    sendWorkerInput.mockReturnValue(false);
    const ds = makeDaemonSession({
      worker: aliveWorker() as any,
      session: makeSession({ lastFailedTurn: makeFailedTurn() }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);

    expect(sendWorkerInput).toHaveBeenCalledTimes(1);
    expect(deps.sessionReply).toHaveBeenCalledWith(ROOT_ID, expect.stringContaining('重试提交失败'), undefined, LARK_APP_ID, 'msg_001');
    // Rejected attempt must not stamp the cooldown.
    expect(ds.session.lastFailedTurn?.retryCount).toBe(0);
    expect(ds.session.lastFailedTurn?.lastRetryAt).toBeUndefined();
  });

  it('passes the Codex App sidecar through but strips clientUserMessageId', async () => {
    const ds = makeDaemonSession({
      worker: aliveWorker() as any,
      session: makeSession({
        lastFailedTurn: makeFailedTurn({
          codexAppInput: { text: 'fix the flaky test', clientUserMessageId: 'client-msg-1' },
        }),
      }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/retry', ROOT_ID, makeLarkMessage('/retry'), deps, LARK_APP_ID);

    const payload = sendWorkerInput.mock.calls[0][1];
    expect(payload.codexAppInput).toBeDefined();
    expect(payload.codexAppInput.text).toBe('fix the flaky test');
    expect(payload.codexAppInput.clientUserMessageId).toBeUndefined();
  });

  it('is registered as a daemon command (anti-regression)', () => {
    expect(DAEMON_COMMANDS.has('/retry')).toBe(true);
  });

  it('appears in /help output', async () => {
    const ds = makeDaemonSession({ worker: aliveWorker() as any });
    const deps = makeDeps(ds);
    await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);
    const helpText = deps.sessionReply.mock.calls[0][1] as string;
    expect(helpText).toContain('/retry');
  });
});
