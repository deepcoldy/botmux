/**
 * /idlecompact in command-handler: real idle-auto-compact module; daemon
 * collaborators mocked (same harness as command-rewind.test.ts).
 *
 * Run: bun run vitest run test/command-idlecompact.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock external modules ──────────────────────────────────────────────────



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
  getSessionPersistentBackendType: vi.fn(() => backendState.backingType),
  persistentBackendTargetForSession: vi.fn(() => (backendState.backingType
    ? { backendType: backendState.backingType, sessionName: 'bmx-sess-rw' }
    : undefined)),
  killPersistentBackendTarget: vi.fn(() => { if (backendState.killThrows) throw new Error('tmux kill failed'); }),
  probePersistentBackendTargetAfterKill: vi.fn(() => backendState.probe),
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
const { scheduleActiveRuntimePatch, sendWorkerInput, forkWorker, rememberLastCliInput, suspendWorker, killWorker, rewindState, backendState } = vi.hoisted(() => ({
  scheduleActiveRuntimePatch: vi.fn<(ds: any) => boolean>(),
  suspendWorker: vi.fn<(ds: any, reason?: string) => boolean>(),
  killWorker: vi.fn<(ds: any) => void>(),
  rewindState: { jsonl: '' as string, truncateError: '' as string },
  backendState: { backingType: undefined as string | undefined, probe: 'missing' as string, killThrows: false },
  sendWorkerInput: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  forkWorker: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  rememberLastCliInput: vi.fn<(ds: any, userPrompt: string, cliInput: any, opts?: any) => void>(),
}));

vi.mock('../src/core/worker-pool.js', async () => {
  const { supportsIdleAutoCompact } = await vi.importActual<typeof import('../src/core/idle-auto-compact.js')>('../src/core/idle-auto-compact.js');
  return {
  sessionSupportsIdleAutoCompact: (ds: any) => supportsIdleAutoCompact({
    cliId: ds.session.cliId ?? 'claude-code',
    backendType: ds.initConfig?.backendType ?? ds.session.backendType,
    codexRpcInput: ds.initConfig?.codexRpcInput === true,
    adopted: !!ds.adoptedFrom || !!ds.session.adoptedFrom,
    headless: !!ds.session.headless,
    vcMeetingReceiver: !!ds.session.vcMeetingReceiver,
  }),
  scheduleActiveRuntimePatch,
  sendWorkerInput,
  forkWorker,
  killWorker,
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  suspendWorker,
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
  };
});

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

vi.mock('../src/services/transcript-resolver.js', () => ({
  resolveSessionTranscriptPath: vi.fn(() => (rewindState.jsonl ? { path: rewindState.jsonl, kind: 'claude' } : null)),
}));

// Default-delegate to the real module; a test can arm rewindState.truncateError
// to make the truncation step itself throw (backup target occupied, …) so the
// pre-cut replay-state rollback can be asserted through the real handler.
vi.mock('../src/core/context-rewind.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/context-rewind.js')>();
  return {
    ...actual,
    rewindClaudeTranscript: (...args: Parameters<typeof actual.rewindClaudeTranscript>) => {
      if (rewindState.truncateError) throw new Error(rewindState.truncateError);
      return actual.rewindClaudeTranscript(...args);
    },
  };
});
vi.mock('../src/core/shared-adopt.js', () => ({ isSharedAdoptSession: vi.fn(() => false) }));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { handleCommand } from '../src/core/command-handler.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { updateSession } from '../src/services/session-store.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';

const LARK_APP_ID = 'app-1';
const ROOT_ID = 'om_root_ic';
const CHAT_ID = 'oc_chat_ic';

function makeDs(cliId: Session['cliId'] = 'claude-code'): DaemonSession {
  return {
    session: {
      sessionId: 'sess-ic', chatId: CHAT_ID, rootMessageId: ROOT_ID, title: 't', status: 'active',
      createdAt: new Date().toISOString(), cliId,
    },
    worker: { killed: false } as any, workerPort: null, workerToken: null, scope: 'thread', larkAppId: LARK_APP_ID,
    chatId: CHAT_ID, chatType: 'group', spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true,
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

function makeDeps(ds: DaemonSession | undefined) {
  const activeSessions = new Map<string, DaemonSession>(ds ? [[sessionKey(ROOT_ID, ds.larkAppId), ds]] : []);
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
    prewarmDocCommentSession: vi.fn(async () => {}),
  } satisfies CommandHandlerDeps & { sessionReply: unknown };
}

const msg = (content: string): LarkMessage => ({
  messageId: 'msg_ic', rootId: ROOT_ID, senderId: 'ou_sender', senderType: 'user', msgType: 'text', content, createTime: String(Date.now()),
});
const run = (deps: ReturnType<typeof makeDeps>, content: string) => handleCommand('/idlecompact', ROOT_ID, msg(content), deps, LARK_APP_ID);
const lastReply = (deps: ReturnType<typeof makeDeps>) => String(deps.sessionReply.mock.calls.at(-1)?.[1] ?? '');

beforeEach(() => {
  vi.mocked(updateSession).mockClear();
  vi.mocked(canOperate).mockReturnValue(true);
  scheduleActiveRuntimePatch.mockClear();
});

describe('/idlecompact', () => {
  it('reports off by default', async () => {
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/idlecompact');
    expect(lastReply(deps)).toContain('关');
    expect(ds.session.idleAutoCompact).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('on / <minutes> / off persist the per-session setting and refresh the live card', async () => {
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/idlecompact on');
    expect(ds.session.idleAutoCompact).toEqual({ enabled: true });
    await run(deps, '/idlecompact 20');
    expect(ds.session.idleAutoCompact).toEqual({ enabled: true, minutes: 20 });
    expect(lastReply(deps)).toContain('20');
    await run(deps, '/idlecompact off');
    expect(ds.session.idleAutoCompact).toEqual({ enabled: false, minutes: 20 });
    expect(updateSession).toHaveBeenCalledTimes(3);
    expect(scheduleActiveRuntimePatch).toHaveBeenCalledTimes(3);
    await run(deps, '/idlecompact');
    expect(lastReply(deps)).toContain('关');
  });

  it('rejects malformed / out-of-range arguments without changing anything', async () => {
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/idlecompact 90');
    expect(lastReply(deps)).toContain('/idlecompact');
    expect(ds.session.idleAutoCompact).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('refuses unsupported CLIs', async () => {
    const ds = makeDs('gemini' as Session['cliId']);
    const deps = makeDeps(ds);
    await run(deps, '/idlecompact on');
    expect(ds.session.idleAutoCompact).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('refuses callers who cannot operate the session', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/idlecompact on');
    expect(ds.session.idleAutoCompact).toBeUndefined();
  });

  it('without a session it only says there is none', async () => {
    const deps = makeDeps(undefined);
    await run(deps, '/idlecompact on');
    expect(deps.sessionReply).toHaveBeenCalledTimes(1);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
