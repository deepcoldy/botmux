/**
 * Unit tests for command-handler: DAEMON_COMMANDS set and handleCommand routing.
 *
 * All external dependencies are mocked. Tests verify that each /slash command
 * dispatches to the correct handler logic and calls the right deps methods.
 *
 * Run:  pnpm vitest run test/command-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock external modules ──────────────────────────────────────────────────

// Mock node builtins that command-handler imports directly
// Global bot registry as seen via bots-info.json (the deployment-wide source the
// /group election reads). Two bots, distinct names — the realistic chat shape.
const BOTS_INFO = [
  { larkAppId: 'app-1', botOpenId: 'ou_claude', botName: 'Claude', cliId: 'claude-code' },
  { larkAppId: 'app-2', botOpenId: 'ou_codex', botName: 'Codex', cliId: 'codex' },
];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p.includes('bots-info.json')) return JSON.stringify(BOTS_INFO);
      return (actual.readFileSync as any)(p, ...rest);
    }),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => '/home/testuser') };
});

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    daemon: { workingDir: '~', backendType: 'pty', cliId: 'claude-code' },
    session: { dataDir: '/fake/data' },
  },
}));

// command-handler's cross-daemon calls are authenticated in production. These
// unit tests exercise relay orchestration with a stubbed global fetch, so keep
// that seam while bypassing host-secret filesystem setup.
vi.mock('../src/core/daemon-ipc-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon-ipc-auth.js')>();
  return {
    ...actual,
    fetchDaemonIpc: (port: number, path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, init),
  };
});

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({})),
  isRemoteAccessEnabled: vi.fn(() => false),
  // Workflow feature defaults ON (production default) so /help renders the
  // workflow section as before; the gate itself is covered in workflow-feature-gate.test.ts.
  isWorkflowFeatureEnabled: vi.fn(() => true),
  // repoPickerScanOptions is the shared helper command-handler depends on;
  // default to legacy (include worktrees), overridden per-test.
  repoPickerScanOptions: vi.fn(() => ({ includeWorktrees: true })),
}));

// Mock role/profile stores so /role routing tests assert on calls (no real FS).
vi.mock('../src/core/role-resolver.js', () => ({
  MAX_ROLE_BYTES: 32 * 1024,
  writeRoleFile: vi.fn(),
  deleteRoleFile: vi.fn(() => true),
  resolveRoleFile: vi.fn(() => null),
  resolveRole: vi.fn(() => ({ content: null, source: 'none' })),
  resolveTeamRoleFile: vi.fn(() => null),
  writeTeamRoleFile: vi.fn(),
  deleteTeamRoleFile: vi.fn(() => true),
}));
vi.mock('../src/services/bot-profile-store.js', () => ({
  getBotCapability: vi.fn(() => null),
  setBotCapability: vi.fn(),
  clearBotCapability: vi.fn(() => true),
}));
vi.mock('../src/services/role-profile-store.js', () => ({
  deleteRoleProfileEntry: vi.fn(() => true),
  deleteRoleProfileIfEmpty: vi.fn(() => true),
  isValidRoleProfileId: vi.fn((id: string) => /^[A-Za-z0-9._-]{1,64}$/.test(id)),
  listRoleProfileEntries: vi.fn(() => []),
  listRoleProfiles: vi.fn(() => []),
  MAX_ROLE_PROFILE_ENTRY_BYTES: 4096,
  readRoleProfileEntry: vi.fn(() => null),
  writeRoleProfileEntry: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn((id: string = 'app-1') => ({
    botName: id === 'app-2' ? 'Codex' : 'Claude',
    config: {
      larkAppId: id,
      larkAppSecret: 'secret-1',
      cliId: id === 'app-2' ? ('codex' as const) : ('claude-code' as const),
      workingDir: '~/projects',
      workingDirs: ['~/projects'],
    },
  })),
  findOncallChat: vi.fn(() => undefined),
  effectiveDefaultWorkingDir: vi.fn((cfg: any) =>
    cfg?.defaultWorkingDir
    || (cfg?.defaultOncall?.enabled ? cfg?.defaultOncall?.workingDir : undefined)
    || undefined),
  readBotSkillPolicy: vi.fn((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (Array.isArray(r.include)) out.include = r.include.filter((item) => typeof item === 'string' && item.startsWith('skill:'));
    return Object.keys(out).length ? out : undefined;
  }),
  getLoadedConfigPath: vi.fn(() => process.env.BOTS_CONFIG),
  // Provenance of the above (see core/config-dir.ts). A path resolved from
  // BOTS_CONFIG was really parsed, so it is 'loaded'; undefined when there is
  // no path at all.
  getLoadedConfigProvenance: vi.fn(() => (process.env.BOTS_CONFIG ? 'loaded' : undefined)),
  // Production runs ONE daemon per bot, so getAllBots() sees only this process's
  // own bot. Default to the Claude process; the split-brain test overrides this
  // to prove the /group election does NOT depend on getAllBots().
  getAllBots: vi.fn(() => [
    {
      botName: 'Claude',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'claude-code' as const,
        workingDir: '~/projects',
      },
    },
  ]),
  getBotOpenId: vi.fn((id: string = 'app-1') => (id === 'app-2' ? 'ou_codex' : 'ou_claude')),
  // /term (and /card) gate on this. Default owner is ou_owner; tests flip the
  // sender to ou_owner / a non-owner to exercise the gate.
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  createSession: vi.fn((_chatId: string, _rootId: string, title: string, chatType: string, scope?: 'thread' | 'chat') => ({
    sessionId: 'new-session-123',
    chatId: _chatId,
    rootMessageId: _rootId,
    scope,
    title,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    chatType,
  })),
  updateSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  getOwnedSession: vi.fn(() => undefined),
  listSessions: vi.fn(() => []),
  collectBotmuxSessionIdentities: vi.fn(() => new Set<string>()),
}));

vi.mock('../src/services/schedule-store.js', () => ({
  listTasks: vi.fn(() => []),
}));

vi.mock('../src/core/scheduler.js', () => ({
  removeTask: vi.fn(),
  enableTask: vi.fn(),
  disableTask: vi.fn(),
  runTaskNow: vi.fn(),
  parseNaturalSchedule: vi.fn().mockReturnValue(null),
  parseSchedule: vi.fn(),
  getNextRun: vi.fn(),
  addTask: vi.fn(),
  extractDeliveryMode: vi.fn((prompt: string) => ({ deliver: 'origin' as const, prompt })),
  extractScheduleModifiers: vi.fn((prompt: string) => ({ deliver: 'origin' as const, silent: false, prompt })),
}));

vi.mock('../src/services/project-scanner.js', () => ({
  scanProjects: vi.fn(() => []),
  scanMultipleProjects: vi.fn(() => []),
  describeProjectDir: vi.fn(() => null),
}));

vi.mock('../src/services/git-worktree.js', () => ({
  createRepoWorktree: vi.fn(),
  pushWorktreeBranch: vi.fn(async () => {}),
}));

vi.mock('../src/services/worktree-slug-ai.js', () => ({
  worktreeSlugFromContextAI: vi.fn(async (title?: string, firstPrompt?: string) => {
    const text = title?.trim() || firstPrompt?.trim();
    return text?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildRepoSelectCard: vi.fn(() => '{"card":"json"}'),
  buildAdoptSelectCard: vi.fn(() => '{"card":"adopt-select"}'),
  buildCodexAppThreadSelectCard: vi.fn(() => '{"card":"codex-app-thread-select"}'),
  buildAdoptBlockedCard: vi.fn((rootId: string, sessionId: string, cliId?: string) => JSON.stringify({
    header: { title: { content: '⚠️ adopt blocked' } },
    elements: [
      { tag: 'markdown', content: 'waiting for repository selection' },
      { tag: 'action', actions: [{ tag: 'button', type: 'danger', value: { action: 'close', root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' } }] },
    ],
  })),
  buildSessionClosedCard: vi.fn(
    (sid: string) =>
      `{"header":{"title":{"content":"🛑 会话已关闭"}},"action":"resume","cmd":"botmux resume ${sid.substring(0, 12)}"}`,
  ),
  buildForkPanelCard: vi.fn((children: any[]) => JSON.stringify({ children })),
  buildSlashListCard: vi.fn((params: any) => JSON.stringify(params)),
  buildRelayPickerCard: vi.fn(
    (entries: any[], targetChatId: string, rootMessageId: string, _invokerOpenId?: string, _locale?: any, _state?: any, targetScope?: string, targetChatType?: string, visibility?: string) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: entries.length === 0 ? [
          { tag: 'markdown', content: 'empty' },
        ] : entries.map((e: any) => ({
          tag: 'interactive_container',
          behaviors: [{
            type: 'callback',
            value: { action: 'relay_select', session_id: e.sessionId, target_chat_id: targetChatId, root_id: rootMessageId, target_scope: targetScope ?? 'chat', target_chat_type: targetChatType ?? 'group', visibility: visibility ?? 'public' },
          }],
          elements: [{ tag: 'markdown', content: `**${e.title}**\n${e.chatMode ?? 'group'}\n${e.chatLabel}` }],
        })),
      },
    }),
  ),
  getCliDisplayName: vi.fn((id: string) => {
    const names: Record<string, string> = {
      'claude-code': 'Claude',
      'aiden': 'Aiden',
    };
    return names[id] ?? id;
  }),
}));

vi.mock('../src/im/lark/client.js', () => ({
  UserTokenMissingError: class UserTokenMissingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UserTokenMissingError';
    }
  },
  deleteMessage: vi.fn(async () => true),
  sendMessage: vi.fn(async () => 'card-msg-id'),
  // /relay picker replies land anchored at the invocation message / 话题 via
  // replyMessage (reply-at-invocation), not sessionReply. Args mirror the
  // real signature: (appId, messageId, content, msgType, replyInThread).
  replyMessage: vi.fn(async () => 'picker-card-msg-id'),
  listChatBotMembers: vi.fn(async () => []),
  // Tests can override per-scenario via vi.mocked(getChatName).mockResolvedValue(...).
  // Default returns null so picker entries fall back to raw chatId.
  getChatName: vi.fn(async () => null),
  getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
  getChatModeStrict: vi.fn(async () => 'topic' as const),
  getMessageThreadId: vi.fn(async () => 'omt_child'),
  // privateCard /relay picker: chat-scope 普通群 sends the picker ephemeral
  // (visible-to-invoker) via this. Default resolves to a fake ephemeral id;
  // scenarios override with mockRejectedValueOnce to exercise the fallback.
  sendEphemeralCard: vi.fn(async () => 'eph_picker_msg_id'),
}));

vi.mock('../src/services/group-creator.js', () => ({
  createGroupWithBots: vi.fn(async (opts: any) => ({
    ok: true,
    chatId: 'oc_new_group',
    creator: opts.creatorLarkAppId,
    invalidBotIds: [],
    invalidUserIds: [],
    ownerTransferredTo: opts.transferOwnerTo ?? null,
    transferError: null,
    notifyMessageId: 'om_notify',
    notifyError: null,
    oncallBindings: [],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
  })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/core/worker-pool.js', () => ({
  killWorker: vi.fn(),
  teardownAuthoritativePersistentBackingBeforeClose: vi.fn(),
  suspendWorker: vi.fn(() => false),
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  adoptSandboxBlocked: vi.fn((botCfg, session) => botCfg?.sandbox === true || botCfg?.readIsolation === true || session?.sandbox === true || process.env.BOTMUX_SANDBOX === '1'),
  getCurrentCliVersion: vi.fn(() => '1.0.42'),
  requestSessionRestart: vi.fn((_ds: any, observer: any) => {
    void observer.notify('in_progress');
    return { attemptId: 'attempt-test', joined: false };
  }),
  isSessionTransferring: vi.fn(() => false),
  // /close routes the「会话已关闭」card through this: ephemeral (visible-to-you)
  // when the chat supports it, else the visible reply fallback. The stub just
  // invokes the fallback so the existing card-shape assertions (on sessionReply)
  // still hold — topic-group behaviour, where ephemeral is unavailable.
  deliverEphemeralOrReply: vi.fn(async (_ds: any, _op: any, _content: string, _type: string, reply: () => Promise<unknown>) => { await reply(); }),
  transferSession: vi.fn(async () => ({ ok: true })),
  forkSession: vi.fn(async () => ({ ok: true, childSessionId: 'child-sess-1' })),
  isForkCapableSession: vi.fn(() => true),
  // /relay --create empty-leader path closes the scratch via this; default
  // resolves as idempotent close so unrelated tests don't need to think
  // about it.
  closeSession: vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false })),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
  // `isRelayableRealSession(ds)` — true when ds.worker is set OR persisted
  // CLI markers exist (session.cliId / session.lastCliInput). The default
  // makeSession fixture sets cliId='claude-code' so most tests pass the
  // predicate; empty-leader tests override `cliId: undefined`. We use the
  // real implementation here (not a vi.fn stub) so the predicate's branch
  // logic is genuinely exercised in every /relay --create scenario.
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
  // /term payload. Default to the in-chat visible-to-you channel; tests override
  // per-scenario (dm / failed / not_ready).
  deliverWritableTerminalCardTo: vi.fn(async () => 'ephemeral'),
  // /card show path. postFreshStreamingCard returns false for sessions that
  // structurally can't post a live card (VC meeting-receiver among them); the
  // handler then picks an accurate reason. Default false so /card show tests
  // exercise the not-ready / vc-receiver branch; override per-scenario.
  postFreshStreamingCard: vi.fn(async () => false),
  postPrivateSnapshotCard: vi.fn(async () => ({ notReady: false, sent: 1, total: 1 })),
  resolvePrivateCardAudience: vi.fn(() => ['ou_owner']),
  reconcileBotStreamingCardPins: vi.fn(),
}));

vi.mock('../src/utils/daemon-discovery.js', () => ({
  findOnlineDaemon: vi.fn(() => null),
  listOnlineDaemons: vi.fn(() => []),
}));

vi.mock('../src/core/session-manager.js', () => ({
  expandHome: vi.fn((p: string) => p.replace(/^~/, '/home/testuser')),
  getSessionWorkingDir: vi.fn(() => '/home/testuser/projects'),
  getProjectScanDir: vi.fn(() => '/home/testuser'),
  getProjectScanDirs: vi.fn(() => ['/home/testuser']),
  rememberLastCliInput: vi.fn((ds: any, userPrompt: string, cliInput: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = cliInput;
  }),
  // Dynamically imported by the /repo pending-launch path (bare /repo + repo selection).
  buildNewTopicPrompt: vi.fn((prompt: string) => `WRAPPED:${prompt}`),
  buildNewTopicCliInput: vi.fn((prompt: string) => ({ content: `WRAPPED:${prompt}` })),
  ensureSessionWhiteboard: vi.fn((ds: any) => { ds.session.whiteboardId = 'wb_test'; }),
  getAvailableBots: vi.fn(async () => []),
  resumeSession: vi.fn(),
}));

// Only the two discovery/validation entrypoints are stubbed; keep the real
// pure helpers (adoptTargetLabel / adoptTargetKey, and any future exports)
// so the /adopt reply still surfaces the actual pane label and the mock can't
// silently drop newly-imported symbols.
vi.mock('../src/core/session-discovery.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../src/core/session-discovery.js');
  return {
    ...actual,
    discoverAdoptableSessions: vi.fn(() => []),
    validateAdoptTarget: vi.fn(() => true),
  };
});

// /adopt now merges tmux + zellij discovery; mock zellij so tests don't shell
// out to a real `zellij` on the host (would surface live sessions and flake).
vi.mock('../src/core/zellij-adopt-discovery.js', () => ({
  discoverAdoptableZellijSessions: vi.fn(() => []),
  validateZellijAdoptTarget: vi.fn(() => true),
}));

vi.mock('../src/services/codex-app-threads.js', () => ({
  listCodexAppThreads: vi.fn(async () => []),
}));

vi.mock('../src/core/command-discovery.js', () => ({
  discoverSlashCommandsForAdapter: vi.fn(() => [{ name: '/project-cmd', description: 'Project command' }]),
  supportsFilesystemCommandDiscovery: vi.fn((adapter: any) => !!(adapter?.claudeDataDir || adapter?.skillsDir || adapter?.pluginDir)),
  listMcpServerNames: vi.fn(() => []),
}));

vi.mock('../src/utils/user-token.js', () => ({
  generateAuthUrl: vi.fn(() => ({ authUrl: 'https://open.feishu.cn/auth/v1/test' })),
  getTokenStatus: vi.fn(() => 'User token: active'),
  resolveUserToken: vi.fn(async () => null),
  DOC_COMMENT_OAUTH_SCOPES: ['docs:document.comment:read'],
}));

vi.mock('../src/im/lark/doc-comment.js', () => {
  class DocSubscriptionPermissionError extends Error {
    readonly larkCode = 1069603;
    constructor(readonly details: { source: 'user' | 'tenant' | 'both' | 'unknown' }) {
      super(`订阅文档被飞书拒绝（source: ${details.source}）。`);
      this.name = 'DocSubscriptionPermissionError';
    }
    get source() {
      return this.details.source;
    }
  }
  return {
    DocSubscriptionPermissionError,
    resolveDocFile: vi.fn(async () => ({ fileToken: 'doc_token_12345678901234567890', fileType: 'docx' })),
    listDocComments: vi.fn(async () => []),
    subscribeDocFile: vi.fn(async () => {}),
    unsubscribeDocFile: vi.fn(async () => {}),
  };
});

vi.mock('../src/services/doc-subs-store.js', () => ({
  putDocSubscription: vi.fn(() => ({})),
  removeDocSubscription: vi.fn(),
  listDocSubscriptionsForSession: vi.fn(() => []),
  listAllDocSubscriptions: vi.fn(() => []),
  getDocSubscription: vi.fn(() => null),
}));

vi.mock('../src/services/vc-meeting-preparations-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/vc-meeting-preparations-store.js')>()),
  findVcMeetingPreparationByChat: vi.fn(() => undefined),
  getVcMeetingPreparation: vi.fn(() => undefined),
  listVcMeetingPreparations: vi.fn(() => []),
  putVcMeetingPreparation: vi.fn((_: string, input: any) => ({
    ...input,
    createdAt: 1,
    updatedAt: 1,
  })),
  removeVcMeetingPreparation: vi.fn(() => undefined),
  removeVcMeetingPreparationsByChat: vi.fn(() => 0),
}));
// The picker query helper now lives in services/relay-picker.ts — mock it so
// the /relay picker tests can control the entry list directly without
// patching activeSessions in lots of places.
vi.mock('../src/services/relay-picker.js', () => ({
  // Default returns whatever sessions are in the registry that match the
  // picker filter (same shape as the real impl). Tests can override.
  // MUST mirror the real predicate set in relay-picker.ts —
  // isRelayableRealSession added there as Codex review fix to filter out
  // daemon-command scratches (worker:null + no persisted CLI markers).
  // Skipping the same filter here would silently regress the picker-
  // scratch-exclusion test, which is exactly the bug Codex flagged.
  collectRelayPickerEntries: vi.fn(async (activeSessions: Map<string, any>, larkAppId: string, currentChatId: string, operatorOpenId: string) => {
    const out: any[] = [];
    for (const c of activeSessions.values()) {
      if (c.larkAppId !== larkAppId) continue;
      if (c.chatId === currentChatId) continue;
      if (c.session.ownerOpenId !== operatorOpenId) continue;
      if (c.session.adoptedFrom) continue;
      // Real-session filter (same predicate as production picker).
      if (!c.worker && !c.session?.cliId && !c.session?.lastCliInput) continue;
      out.push({
        sessionId: c.session.sessionId,
        chatLabel: c.chatId,
        title: c.session.title,
        workingDir: c.session.workingDir,
        cliId: c.session.cliId,
        lastMessageAt: c.lastMessageAt,
        chatMode: 'group',
      });
    }
    return out;
  }),
}));

vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: vi.fn(() => ({ ok: true, created: true })),
  unbindOncall: vi.fn(() => ({ ok: true })),
  getOncallStatus: vi.fn(() => undefined),
}));

// /card and /term gate on canOperate (the operator model). Default allow; tests
// flip the return per-scenario to exercise the gate without re-testing canOperate's
// own open-mode / allowlist / peer-bot logic (that lives in event-dispatcher).
vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  canOperate: vi.fn(() => true),
}));

vi.mock('../src/services/card-mode-store.js', () => ({
  setCardMode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/services/pin-streaming-card-mode-store.js', () => ({
  setChatStreamingCardPin: vi.fn(async () => ({ ok: true, changed: true })),
}));

vi.mock('../src/services/cot-mode-store.js', () => ({
  setCotMode: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/im/lark/cot-message.js', () => ({
  handleCotThinkingUpdate: vi.fn(() => true),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { DAEMON_COMMANDS, SESSIONLESS_DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, cliHasNoRawPassthroughSurface, resolvePassthroughCommands, resolveAdapterDefaultPassthroughCommands, handleCommand, handleCardCommand, handleCotCommand, handleTermLinkCommand, parseSlashCommandInvocation, parseForceTopicInvocation, startAdoptSession, startResumeImportSession, startCodexAppThreadSession, startForkSubtopicSession } from '../src/core/command-handler.js';
import { setCardMode } from '../src/services/card-mode-store.js';
import { setChatStreamingCardPin } from '../src/services/pin-streaming-card-mode-store.js';
import { setCotMode } from '../src/services/cot-mode-store.js';
import { handleCotThinkingUpdate } from '../src/im/lark/cot-message.js';
import { writeRoleFile, deleteRoleFile, writeTeamRoleFile, deleteTeamRoleFile, resolveRole, resolveRoleFile } from '../src/core/role-resolver.js';
import { setBotCapability, clearBotCapability } from '../src/services/bot-profile-store.js';
import {
  listRoleProfiles,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../src/services/role-profile-store.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import { setTerminalProxyPort } from '../src/core/terminal-url.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { type CloseSessionResult, closeSession, closeSession as closeWorkerPoolSession, killWorker, teardownAuthoritativePersistentBackingBeforeClose, suspendWorker, forkWorker, forkAdoptWorker, forkSession, isForkCapableSession, getCurrentCliVersion, deliverEphemeralOrReply, deliverWritableTerminalCardTo, requestSessionRestart, withActiveSessionKeyLock, postFreshStreamingCard, reconcileBotStreamingCardPins } from '../src/core/worker-pool.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { publishClosedSessionPatch } from '../src/core/session-activity.js';
import { getOwnerOpenId } from '../src/bot-registry.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { getSessionWorkingDir, buildNewTopicPrompt, buildNewTopicCliInput, ensureSessionWhiteboard, getAvailableBots, resumeSession } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import * as scheduler from '../src/core/scheduler.js';
import { deleteMessage, sendMessage, replyMessage, listChatBotMembers, getChatModeStrict, getMessageThreadId, UserTokenMissingError } from '../src/im/lark/client.js';
import { buildAdoptSelectCard, buildSlashListCard, buildSessionClosedCard } from '../src/im/lark/card-builder.js';
import { createGroupWithBots } from '../src/services/group-creator.js';
import { getAllBots, getBot, findOncallChat, effectiveDefaultWorkingDir } from '../src/bot-registry.js';
import { generateAuthUrl, getTokenStatus, resolveUserToken, DOC_COMMENT_OAUTH_SCOPES } from '../src/utils/user-token.js';
import { DocSubscriptionPermissionError, resolveDocFile, subscribeDocFile, unsubscribeDocFile } from '../src/im/lark/doc-comment.js';
import { putDocSubscription, removeDocSubscription, listAllDocSubscriptions, getDocSubscription } from '../src/services/doc-subs-store.js';
import { bindOncall } from '../src/services/oncall-store.js';
import { putVcMeetingPreparation } from '../src/services/vc-meeting-preparations-store.js';
import { existsSync, statSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHome } from '../src/services/codex-paths.js';
import { scanMultipleProjects, describeProjectDir } from '../src/services/project-scanner.js';
import { readGlobalConfig, repoPickerScanOptions } from '../src/global-config.js';
import { createRepoWorktree, pushWorktreeBranch } from '../src/services/git-worktree.js';
import { discoverAdoptableSessions, validateAdoptTarget } from '../src/core/session-discovery.js';
import { listCodexAppThreads } from '../src/services/codex-app-threads.js';
import { discoverSlashCommandsForAdapter } from '../src/core/command-discovery.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LARK_APP_ID = 'app-1';
const CODEX_APP_ID = 'app-codex-app';
const ROOT_ID = 'om_root_abc123';
const CHAT_ID = 'oc_chat_xyz';

function defaultGetBot(id: string = 'app-1') {
  return {
    botName: id === 'app-2' ? 'Codex' : 'Claude',
    config: {
      larkAppId: id,
      larkAppSecret: 'secret-1',
      cliId: id === 'app-2' ? ('codex' as const) : ('claude-code' as const),
      workingDir: '~/projects',
      workingDirs: ['~/projects'],
    },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-001',
    chatId: CHAT_ID,
    rootMessageId: ROOT_ID,
    title: 'Test Session',
    status: 'active',
    createdAt: new Date().toISOString(),
    // Default fixture represents a REAL session — a real CLI started here
    // at some point. `cliId` is a persisted marker that survives restart
    // (unlike runtime `hasHistory`); isRelayableRealSession reads it to
    // decide whether the session is safe to migrate. Tests simulating
    // daemon-command scratches (the worker:null + no-CLI-history case)
    // should explicitly override `cliId: undefined`.
    cliId: 'claude-code',
    ...overrides,
  };
}

function makeDaemonSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: makeSession(),
    worker: null,
    workerPort: null,
    workerToken: null,
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

function makeLarkMessage(content: string, overrides: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: 'msg_001',
    rootId: ROOT_ID,
    senderId: 'ou_sender',
    senderType: 'user',
    msgType: 'text',
    content,
    createTime: String(Date.now()),
    ...overrides,
  };
}

// The most-recently constructed deps' activeSessions map. In production
// `setActiveSessionsRegistry(activeSessions)` makes worker-pool's authoritative
// `closeSession` delete from this very map; the mock below models that same
// registry removal so /close tests can assert the session is gone.
let lastMadeActiveSessions: Map<string, DaemonSession> | undefined;

function makeDeps(ds?: DaemonSession): CommandHandlerDeps {
  const activeSessions = new Map<string, DaemonSession>();
  if (ds) {
    activeSessions.set(sessionKey(ROOT_ID, ds.larkAppId), ds);
  }
  lastMadeActiveSessions = activeSessions;
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
    prewarmDocCommentSession: vi.fn(async () => {}),
  };
}

function mockCodexAppBot(): void {
  vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
    if (id === CODEX_APP_ID) {
      return {
        botName: 'Codex APP',
        config: {
          larkAppId: CODEX_APP_ID,
          larkAppSecret: 'secret-1',
          cliId: 'codex-app' as const,
          cliPathOverride: '/opt/codex',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      };
    }
    return defaultGetBot(id);
  }) as any);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DAEMON_COMMANDS set', () => {
  it('should contain all expected commands', () => {
    const expected = ['/close', '/restart', '/status', '/retry', '/help', '/cd', '/repo', '/rename', '/schedule', '/role', '/botconfig', '/skills', '/pair', '/login', '/adopt', '/detach', '/disconnect', '/oncall', '/group', '/g', '/relay', '/fork', '/forklist', '/card', '/term', '/list-slash-command', '/slash', '/subscribe-lark-doc', '/watch-comment', '/vc', '/insight', '/dashboard', '/vc-auth'];
    for (const cmd of expected) {
      expect(DAEMON_COMMANDS.has(cmd), `Expected DAEMON_COMMANDS to contain ${cmd}`).toBe(true);
    }
  });

  it('should no longer contain the removed /skip command (folded into bare /repo)', () => {
    expect(DAEMON_COMMANDS.has('/skip')).toBe(false);
  });

  it('uses /vc for meeting preparation without changing the existing /vc-auth command', () => {
    expect(DAEMON_COMMANDS.has('/vc')).toBe(true);
    expect(DAEMON_COMMANDS.has('/vc-auth')).toBe(true);
    expect(DAEMON_COMMANDS.has('/meeting')).toBe(false);
  });

  it('keeps one /watch-comment command family instead of several /doc-* commands', () => {
    for (const removed of ['/doc-watch', '/doc-unwatch', '/doc-pending', '/doc-approve', '/doc-deny']) {
      expect(DAEMON_COMMANDS.has(removed), `${removed} should not remain a top-level slash command`).toBe(false);
    }
  });

  it('should not contain passthrough or unknown commands', () => {
    // These pass through to the CLI and are NOT handled by the daemon
    expect(DAEMON_COMMANDS.has('/clear')).toBe(false);
    expect(DAEMON_COMMANDS.has('/cost')).toBe(false);
    expect(DAEMON_COMMANDS.has('/compact')).toBe(false);
    expect(DAEMON_COMMANDS.has('/model')).toBe(false);
    expect(DAEMON_COMMANDS.has('/usage')).toBe(false);
    expect(DAEMON_COMMANDS.has('/unknown')).toBe(false);
  });

  it('should have the correct size', () => {
    // 36 = master 的 35 条（含 /forklist、/cot、/cli）+ /retry。
    // /fork 与 /issue 仍是一等 daemon 命令；/subscribe-lark-doc 保持原本的
    // 按文件 API 订阅命令语义，不做别名。
    expect(DAEMON_COMMANDS.size).toBe(36);
  });

  it('contains the /list-slash-command lister and its /slash alias', () => {
    expect(DAEMON_COMMANDS.has('/list-slash-command')).toBe(true);
    expect(DAEMON_COMMANDS.has('/slash')).toBe(true);
  });
});

describe('/cli session selection', () => {
  it('persists a pending CLI selection and allows pre-freeze reselection', async () => {
    const ds = makeDaemonSession({
      hasHistory: false,
      session: makeSession({ cliId: undefined, cliLaunchSnapshot: undefined }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli codex'), deps, LARK_APP_ID);
    expect(ds.session.cliLaunchSnapshot).toEqual(expect.objectContaining({
      state: 'pending', entryId: 'codex', cliId: 'codex', cliRuntime: expect.objectContaining({ id: 'codex' }), wrapperCli: null,
      cliPathOverride: null, launchShell: null, startupCommands: [],
    }));
    expect(ds.session.agentFrozen).toBeUndefined();
    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli hermes'), deps, LARK_APP_ID);
    expect(ds.session.cliLaunchSnapshot?.entryId).toBe('hermes');
  });

  it('rejects selection after history and does not mutate the snapshot', async () => {
    const snapshot = { version: 1 as const, state: 'pending' as const, entryId: 'codex', cliId: 'codex' as const, cliRuntime: null, cliPathOverride: null, wrapperCli: null, model: null, reasoningEffort: null, launchShell: null, startupCommands: [] };
    const ds = makeDaemonSession({ hasHistory: true, session: makeSession({ cliId: 'codex', cliLaunchSnapshot: snapshot }) });
    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli codex'), makeDeps(ds), LARK_APP_ID);
    expect(ds.session.cliLaunchSnapshot).toEqual(snapshot);
  });

  it('rejects bare /cli and unknown cli ids', async () => {
    const ds = makeDaemonSession({
      hasHistory: false,
      session: makeSession({ cliId: undefined }),
    });
    const deps = makeDeps(ds);
    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli'), deps, LARK_APP_ID);
    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli does-not-exist'), deps, LARK_APP_ID);
    expect(ds.session.cliLaunchSnapshot).toBeUndefined();
    expect(deps.sessionReply).toHaveBeenLastCalledWith(ROOT_ID, 'Usage: /cli <cliId>\nUnknown or invalid CLI.', undefined, LARK_APP_ID, 'msg_001');
  });

  it('rejects riff because it requires bot-level backend configuration', async () => {
    const ds = makeDaemonSession({
      hasHistory: false,
      session: makeSession({ cliId: undefined }),
    });
    const deps = makeDeps(ds);

    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli riff'), deps, LARK_APP_ID);

    expect(ds.session.cliLaunchSnapshot).toBeUndefined();
    expect(deps.sessionReply).toHaveBeenLastCalledWith(
      ROOT_ID,
      'CLI selection rejected: Riff requires bot-level backend configuration and cannot be selected per session',
      undefined,
      LARK_APP_ID,
      'msg_001',
    );
  });

  it('canonicalizes accepted CLI ids before persisting the selection', async () => {
    const ds = makeDaemonSession({
      hasHistory: false,
      session: makeSession({ cliId: undefined }),
    });

    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli CODEX'), makeDeps(ds), LARK_APP_ID);

    expect(ds.session.cliLaunchSnapshot?.cliId).toBe('codex');
    expect(ds.session.cliLaunchSnapshot?.entryId).toBe('codex');
  });

  it('rejects mixed-case Riff before persisting the selection', async () => {
    const ds = makeDaemonSession({
      hasHistory: false,
      session: makeSession({ cliId: undefined }),
    });
    const deps = makeDeps(ds);

    await handleCommand('/cli', ROOT_ID, makeLarkMessage('/cli RIFF'), deps, LARK_APP_ID);

    expect(ds.session.cliLaunchSnapshot).toBeUndefined();
    expect(deps.sessionReply).toHaveBeenLastCalledWith(
      ROOT_ID,
      'CLI selection rejected: Riff requires bot-level backend configuration and cannot be selected per session',
      undefined,
      LARK_APP_ID,
      'msg_001',
    );
  });
});

describe('/list-slash-command discovery', () => {
  beforeEach(() => {
    vi.mocked(discoverSlashCommandsForAdapter).mockClear();
    vi.mocked(buildSlashListCard).mockClear();
  });

  it('uses the Codex adapter directory instead of Claude .claude commands', async () => {
    const ds = makeDaemonSession({
      larkAppId: 'app-2',
      session: makeSession({ cliId: 'codex' }),
    });
    const deps = makeDeps(ds);

    await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), deps, 'app-2');

    expect(discoverSlashCommandsForAdapter).toHaveBeenCalledWith(
      '/home/testuser/projects',
      expect.objectContaining({ id: 'codex', skillsDir: join(codexHome(), 'skills') }),
    );
    expect(buildSlashListCard).toHaveBeenCalledWith(
      expect.objectContaining({
        cliName: 'codex',
        discovered: [{ name: '/project-cmd', description: 'Project command' }],
        discoverySupported: true,
      }),
      expect.anything(),
    );
  });

  it('uses the frozen compatible runtime name for an existing Codex session', async () => {
    vi.mocked(getBot).mockImplementation((() => ({
      botName: 'Vendor bot',
      config: {
        larkAppId: 'app-runtime',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        cliPathOverride: 'vendor-codex',
        cliRuntime: {
          id: 'vendor-codex',
          displayName: 'Live Vendor Name',
          executable: 'vendor-codex',
          update: { provider: 'auto' as const },
        },
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
    })) as any);
    try {
      const ds = makeDaemonSession({
        larkAppId: 'app-runtime',
        session: makeSession({
          cliId: 'codex',
          cliPathOverride: 'vendor-codex',
          cliRuntime: {
            id: 'vendor-codex',
            displayName: 'Frozen Vendor Codex',
            executable: 'vendor-codex',
            source: 'configured',
            update: { provider: 'auto' },
          },
        }),
      });
      await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), makeDeps(ds), 'app-runtime');

      expect(buildSlashListCard).toHaveBeenCalledWith(
        expect.objectContaining({ cliName: 'Frozen Vendor Codex' }),
        expect.anything(),
      );
    } finally {
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });

  it('mirrors the frozen CLI in the listing: Codex App shows NO passthrough, interactive Codex keeps /goal', async () => {
    mockCodexAppBot(); // bot CURRENT config.cliId = 'codex-app'

    // A session frozen as Codex App: the runner has no passthrough surface, so
    // builtin + adapter + custom must all render empty (matching the router's
    // early empty return) — never a fake `/model`/`/compact` passthrough list.
    const appDs = makeDaemonSession({
      larkAppId: CODEX_APP_ID,
      session: makeSession({ cliId: 'codex-app' }),
    });
    await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), makeDeps(appDs), CODEX_APP_ID);
    expect(buildSlashListCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ builtin: [], adapterDefaults: [], custom: [] }),
      expect.anything(),
    );

    // Inverse: bot flipped to Codex App but this session is frozen as
    // interactive Codex → listing keeps builtin + the adapter-scoped /goal.
    vi.mocked(buildSlashListCard).mockClear();
    const tuiDs = makeDaemonSession({
      larkAppId: CODEX_APP_ID,
      session: makeSession({ cliId: 'codex' }),
    });
    await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), makeDeps(tuiDs), CODEX_APP_ID);
    const call = vi.mocked(buildSlashListCard).mock.calls.at(-1)?.[0] as any;
    expect(call.builtin).toContain('/model');
    expect(call.adapterDefaults).toContain('/goal');
  });

  it.each(['codex-app', 'mira', 'mir', 'dsh'] as const)('shows NO passthrough for runner CLI %s', async (cliId) => {
    const ds = makeDaemonSession({
      larkAppId: LARK_APP_ID,
      session: makeSession({ cliId }),
    });
    await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), makeDeps(ds), LARK_APP_ID);
    expect(buildSlashListCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ builtin: [], adapterDefaults: [], custom: [] }),
      expect.anything(),
    );
  });

  it('shows only effective custom passthrough commands (drops daemon-shadow + junk, normalizes)', async () => {
    // 手写 bots.json 可能留下 `/status`（遮蔽 daemon 命令，parser 出于兼容会保留但
    // 路由会丢弃）、非法项、大小写不一；展示侧须与 resolvePassthroughCommands 同口径。
    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
      const b = defaultGetBot(id);
      (b.config as any).customPassthroughCommands = ['/status', '/b@d', '/GOAL', '/export', '/goal'];
      return b;
    }) as any);
    try {
      const deps = makeDeps(makeDaemonSession());
      await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), deps, LARK_APP_ID);
      expect(buildSlashListCard).toHaveBeenCalledWith(
        expect.objectContaining({ custom: ['/goal', '/export'] }),
        expect.anything(),
      );
    } finally {
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });

  it('keeps Claude-family filesystem discovery enabled', async () => {
    const deps = makeDeps(makeDaemonSession());

    await handleCommand('/slash', ROOT_ID, makeLarkMessage('/slash'), deps, LARK_APP_ID);

    expect(discoverSlashCommandsForAdapter).toHaveBeenCalledWith(
      '/home/testuser/projects',
      expect.objectContaining({ id: 'claude-code', claudeDataDir: expect.any(String) }),
    );
    expect(buildSlashListCard).toHaveBeenCalledWith(
      expect.objectContaining({
        cliName: 'Claude',
        discovered: [{ name: '/project-cmd', description: 'Project command' }],
        discoverySupported: true,
      }),
      expect.anything(),
    );
  });
});

describe('SESSIONLESS_DAEMON_COMMANDS set', () => {
  it('contains /group and its /g alias', () => {
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/group')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/g')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/skills')).toBe(true);
  });

  it('is a subset of DAEMON_COMMANDS (they are still daemon-handled)', () => {
    for (const cmd of SESSIONLESS_DAEMON_COMMANDS) {
      expect(DAEMON_COMMANDS.has(cmd), `${cmd} must also be a daemon command`).toBe(true);
    }
  });

  it('keeps the whole /watch-comment family session-less', () => {
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/watch-comment')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/subscribe-lark-doc')).toBe(false);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/vc')).toBe(false);
  });

  it('excludes conversation/state commands that need a session', () => {
    // These attach state to or operate on an active session, so they must
    // keep going through the session-creating path.
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/repo')).toBe(false);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/cd')).toBe(false);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/close')).toBe(false);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/card')).toBe(false);
  });
});

describe('/botconfig skills JSON text command', () => {
  it('persists skills as a parsed policy object, not a raw JSON string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-skills-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'codex',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'Codex',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);

    try {
      await handleCommand(
        '/botconfig',
        ROOT_ID,
        makeLarkMessage('/botconfig set skills {"include":["skill:deploy-runbook"],"delivery":"prompt","projectSkills":"all"}', { senderId: 'ou_sender' }),
        makeDeps(),
        'app-1',
      );

      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.skills).toEqual({ include: ['skill:deploy-runbook'] });
      expect(typeof stored.skills).toBe('object');
      expect(bot.config.skills).toEqual({ include: ['skill:deploy-runbook'] });
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });
});

describe('/botconfig canTalkDaemonCommands uses the field parser (not the passthrough one)', () => {
  it('persists daemon commands via the text command path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-ctdc-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'codex',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'Codex',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);

    try {
      await handleCommand(
        '/botconfig',
        ROOT_ID,
        // 默认 stringList 解析器（parseCustomPassthroughInput）会拒绝一切 daemon
        // 命令——本字段必须走 spec.parseList，否则这里被当成"空值"拒绝。
        makeLarkMessage('/botconfig set canTalkDaemonCommands status /Help', { senderId: 'ou_sender' }),
        makeDeps(),
        'app-1',
      );

      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.canTalkDaemonCommands).toEqual(['/status', '/help']);
      expect((bot.config as any).canTalkDaemonCommands).toEqual(['/status', '/help']);
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });
});

describe('/botconfig reasoningEffort compatibility validation', () => {
  it('rejects unsupported TraeX reasoning effort before writing bots.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-reasoning-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'traex',
      model: 'DeepSeek-V4-Pro',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'TraeX',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'traex' as const,
        model: 'DeepSeek-V4-Pro',
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);
    const deps = makeDeps();

    try {
      await handleCommand(
        '/botconfig',
        ROOT_ID,
        makeLarkMessage('/botconfig set reasoningEffort xhigh', { senderId: 'ou_sender' }),
        deps,
        'app-1',
      );

      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].reasoningEffort).toBeUndefined();
      expect((bot.config as any).reasoningEffort).toBeUndefined();
      expect(vi.mocked(deps.sessionReply).mock.calls[0]?.[1]).toContain('reasoning_effort_not_supported_by_model');
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });
});

describe('/botconfig set p2pOpen (私聊对话全开) via the real text command', () => {
  it('turns DMs on and off through `/botconfig set`, keeping bots.json tidy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-p2popen-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'codex',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'Codex',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);

    // 真实入口是带 set 子命令的形式（`/botconfig` 只认 get/set/unset/help），
    // 所以这里执行的是用户会打的那串字，而不是直接调 applyConfigField。
    const run = (text: string) => handleCommand('/botconfig', ROOT_ID, makeLarkMessage(text, { senderId: 'ou_sender' }), makeDeps(), 'app-1');
    const stored = () => JSON.parse(readFileSync(configPath, 'utf-8'))[0];

    try {
      await run('/botconfig set p2pOpen on');
      expect(stored().p2pOpen).toBe(true);
      expect((bot.config as any).p2pOpen).toBe(true);

      // off → 删 key（缺省即关），内存同步成 undefined；与 dashboard 通道同语义。
      await run('/botconfig set p2pOpen off');
      expect('p2pOpen' in stored()).toBe(false);
      expect((bot.config as any).p2pOpen).toBeUndefined();
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });
});

describe('/botconfig string field goes through coerceConfigValue (maxLen)', () => {
  it('persists pinStreamingCard and returns promptly even when hot reconciliation throws or hangs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-pinstreaming-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'codex',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'Codex',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);
    const run = (text: string) => handleCommand('/botconfig', ROOT_ID, makeLarkMessage(text, { senderId: 'ou_sender' }), makeDeps(), 'app-1');
    const stored = () => JSON.parse(readFileSync(configPath, 'utf-8'))[0];
    const change = await import('../src/services/pin-streaming-card-change.js');

    try {
      const disposeThrow = change.registerPinStreamingCardChangeHandler(() => {
        throw new Error('reconcile failed');
      });
      await expect(run('/botconfig set pinStreamingCard on')).resolves.toBeUndefined();
      disposeThrow();
      expect(stored().pinStreamingCard).toBe(true);
      expect((bot.config as any).pinStreamingCard).toBe(true);

      let release!: () => void;
      const disposePending = change.registerPinStreamingCardChangeHandler(() => {
        void new Promise<void>((resolve) => { release = resolve; });
      });
      await expect(run('/botconfig set pinStreamingCard off')).resolves.toBeUndefined();
      disposePending();
      expect('pinStreamingCard' in stored()).toBe(false);
      expect((bot.config as any).pinStreamingCard).toBeUndefined();
      release();
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });

  it('rejects an over-long displayName and persists a valid one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-botconfig-displayname-'));
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'codex',
      allowedUsers: ['ou_sender'],
    }]));
    const bot = {
      botName: 'Codex',
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'codex' as const,
        allowedUsers: ['ou_sender'],
        workingDir: '~/projects',
        workingDirs: ['~/projects'],
      },
      resolvedAllowedUsers: ['ou_sender'],
    };
    vi.mocked(getBot).mockReturnValue(bot as any);

    try {
      // 65 chars > spec maxLen 64 → the IM text entry point must reject too.
      await handleCommand(
        '/botconfig',
        ROOT_ID,
        makeLarkMessage(`/botconfig set displayName ${'x'.repeat(65)}`, { senderId: 'ou_sender' }),
        makeDeps(),
        'app-1',
      );
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].displayName).toBeUndefined();
      expect((bot.config as any).displayName).toBeUndefined();

      await handleCommand(
        '/botconfig',
        ROOT_ID,
        makeLarkMessage('/botconfig set displayName 小助手', { senderId: 'ou_sender' }),
        makeDeps(),
        'app-1',
      );
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].displayName).toBe('小助手');
      expect((bot.config as any).displayName).toBe('小助手');
    } finally {
      delete process.env.BOTS_CONFIG;
      rmSync(dir, { recursive: true, force: true });
      vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    }
  });
});

describe('/vc preparation command', () => {
  it('binds a regular chat-scope Agent session to the normalized meeting number', async () => {
    const ds = makeDaemonSession({
      scope: 'chat',
      session: makeSession({ scope: 'chat' }),
    });
    const deps = makeDeps(ds);

    await handleCommand(
      '/vc',
      ROOT_ID,
      makeLarkMessage('/vc prepare https://vc-my.larkoffice.com/j/688542737 --qa auto', { senderId: 'ou_owner' }),
      deps,
      LARK_APP_ID,
    );

    expect(putVcMeetingPreparation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        larkAppId: LARK_APP_ID,
        meetingNo: '688542737',
        prepChatId: CHAT_ID,
        agentAppId: LARK_APP_ID,
        agentSessionId: 'sess-001',
        qaMode: 'auto',
      }),
    );
    expect(deps.sessionReply).toHaveBeenCalledWith(
      ROOT_ID,
      expect.stringMatching(/688542737[\s\S]*当前会话未绑定项目目录/),
      undefined,
      LARK_APP_ID,
      'msg_001',
    );
  });

  it('reports the project already bound to the preparation session', async () => {
    const ds = makeDaemonSession({
      scope: 'chat',
      workingDir: '/work/ai-coding',
      session: makeSession({ scope: 'chat', workingDir: '/work/ai-coding' }),
    });
    const deps = makeDeps(ds);

    await handleCommand(
      '/vc',
      ROOT_ID,
      makeLarkMessage('/vc prepare 688542737', { senderId: 'ou_owner' }),
      deps,
      LARK_APP_ID,
    );

    expect(deps.sessionReply).toHaveBeenCalledWith(
      ROOT_ID,
      expect.stringContaining('已复用当前会话绑定的项目：/work/ai-coding'),
      undefined,
      LARK_APP_ID,
      'msg_001',
    );
  });
});

describe('PASSTHROUGH_COMMANDS set', () => {
  it('should contain expected slash commands forwarded to CLI', () => {
    for (const cmd of ['/compact', '/model', '/clear', '/plugin', '/usage', '/context', '/cost', '/mcp', '/diff', '/btw', '/effort']) {
      expect(PASSTHROUGH_COMMANDS.has(cmd), `Expected PASSTHROUGH_COMMANDS to contain ${cmd}`).toBe(true);
    }
  });

  it('every passthrough command is a slash command and unique', () => {
    for (const cmd of PASSTHROUGH_COMMANDS) {
      expect(cmd.startsWith('/'), `${cmd} should start with /`).toBe(true);
      expect(cmd, `${cmd} should be lowercase`).toBe(cmd.toLowerCase());
    }
  });

  it('should not overlap with DAEMON_COMMANDS', () => {
    for (const cmd of PASSTHROUGH_COMMANDS) {
      expect(DAEMON_COMMANDS.has(cmd), `${cmd} must not be in both sets`).toBe(false);
    }
  });

  it('keeps raw passthrough off structured/service CLIs while honoring a frozen interactive override', () => {
    mockCodexAppBot();

    // App Server turns must use the structured message lane; raw_input has no
    // matching dispatch reservation and would leave the session stuck after
    // the model final arrives.
    expect(resolvePassthroughCommands(CODEX_APP_ID).size).toBe(0);

    // Existing sessions freeze their CLI. A pre-switch interactive Codex
    // session must retain native slash passthrough even if the bot config now
    // points at Codex App, while the inverse must stay structured.
    expect(resolvePassthroughCommands(CODEX_APP_ID, 'codex').has('/model')).toBe(true);
    expect(resolvePassthroughCommands(LARK_APP_ID, 'codex-app').size).toBe(0);
    // Runner adapters (mira/mir/dsh) only accept framed input; raw slash
    // passthrough would be rejected by the runner and wedge the session.
    expect(resolvePassthroughCommands(LARK_APP_ID, 'mira').size).toBe(0);
    expect(resolvePassthroughCommands(LARK_APP_ID, 'mir').size).toBe(0);
    expect(resolvePassthroughCommands(LARK_APP_ID, 'dsh').size).toBe(0);
    // ebsd is interactive, but every external message must pass through the
    // service-user envelope and structured terminal-marker ledger.
    expect(cliHasNoRawPassthroughSurface('ebsd')).toBe(true);
    expect(resolvePassthroughCommands(LARK_APP_ID, 'ebsd').size).toBe(0);
  });

  it('threads the frozen CLI through the ADAPTER-SCOPED layer, not just the builtin set', () => {
    // Regression for the earlier miss: the override only guarded the codex-app
    // early return, so `resolveAdapterDefaultPassthroughCommands` still read the
    // bot's CURRENT config. When the bot default flips codex→codex-app, a frozen
    // interactive Codex session then LOST its adapter-scoped `/goal` (it fell
    // through as a plain message instead of raw_input). Builtin `/model` masked
    // this because it never touches the adapter layer — so assert `/goal`.
    mockCodexAppBot(); // bot CURRENT config.cliId = 'codex-app'

    // Frozen interactive Codex session (override='codex'): keeps native /goal.
    expect(resolvePassthroughCommands(CODEX_APP_ID, 'codex').has('/goal')).toBe(true);
    expect(resolveAdapterDefaultPassthroughCommands(CODEX_APP_ID, 'codex')).toContain('/goal');
    // No override → reads current codex-app config → adapter layer is empty.
    expect(resolveAdapterDefaultPassthroughCommands(CODEX_APP_ID)).not.toContain('/goal');
    // Inverse: a bot whose current CLI is codex, frozen as codex-app → nothing.
    expect(resolvePassthroughCommands('app-2', 'codex-app').size).toBe(0);
    expect(resolveAdapterDefaultPassthroughCommands('app-2', 'codex-app')).not.toContain('/goal');
  });

  it('keeps /goal out of the global passthrough list but enables it for Claude and Codex adapters', () => {
    expect(PASSTHROUGH_COMMANDS.has('/goal')).toBe(false);
    expect(resolvePassthroughCommands('app-1').has('/goal')).toBe(true);
    expect(resolvePassthroughCommands('app-2').has('/goal')).toBe(true);
  });

  it('forwards /fast as a global passthrough WITHOUT cold-start (not adapter-scoped)', () => {
    // /fast is a tier toggle, not "start a unit of work": it lives in the global
    // PASSTHROUGH_COMMANDS (forwarded to Codex on an existing session), and is
    // deliberately NOT in any adapter's defaultPassthroughCommands — so a bare
    // /fast in an empty topic must not cold-start a session (owner policy).
    // Regression guard: an earlier revision put /fast in the codex adapter
    // default, which both broke that no-cold-start policy and (before that) a
    // revision that removed /fast from every set left it never reaching Codex.
    expect(PASSTHROUGH_COMMANDS.has('/fast')).toBe(true);
    expect(resolvePassthroughCommands('app-2').has('/fast')).toBe(true); // codex
    expect(resolvePassthroughCommands('app-1').has('/fast')).toBe(true); // claude-code (harmless unknown-command)
    expect(resolvePassthroughCommands(undefined).has('/fast')).toBe(true);
    expect(resolveAdapterDefaultPassthroughCommands('app-2')).not.toContain('/fast'); // no cold-start
    expect(resolveAdapterDefaultPassthroughCommands('app-1')).not.toContain('/fast');
  });

  it('exposes /effort globally to every CLI (best-effort passthrough)', () => {
    // /effort 放在全局 PASSTHROUGH_COMMANDS,而非某个 adapter 的 defaultPassthroughCommands
    // ——所有 CLI 都尽力透传(Claude 家族 / Codex 原生支持;其它 CLI 认不得顶多回
    // unknown-command,不崩溃)。未来新 CLI 零改动自动继承。
    expect(PASSTHROUGH_COMMANDS.has('/effort')).toBe(true);
    expect(resolvePassthroughCommands('app-1').has('/effort')).toBe(true); // claude-code
    expect(resolvePassthroughCommands('app-2').has('/effort')).toBe(true); // codex
    // 无 bot 上下文时也回落到全局集合,仍含 /effort。
    expect(resolvePassthroughCommands(undefined).has('/effort')).toBe(true);
  });

  it('keeps /effort OUT of the adapter default layer so it never gains cold-start', () => {
    // 核心语义护栏:冷启动能力(空 topic 里发命令能否拉起新会话)只认 adapter 层的
    // defaultPassthroughCommands(见 daemon.ts 的 isInitialSessionPassthrough →
    // resolveAdapterDefaultPassthroughCommands),不认全局 PASSTHROUGH_COMMANDS。
    // /effort 是「调档」而非「开一段工作」的命令,必须留在全局层、绝不进 adapter 层,
    // 否则空话题单发 /effort 会凭空 spawn 一个没活干的会话。这条断言锁住该语义:
    // 即使有人日后误把 /effort 加回某个 adapter 的 default,resolvePassthroughCommands
    // 层的可见性测试仍会全绿(全局也有),唯有这里能抓住回归。
    expect(resolveAdapterDefaultPassthroughCommands('app-1')).not.toContain('/effort'); // claude-code
    expect(resolveAdapterDefaultPassthroughCommands('app-2')).not.toContain('/effort'); // codex
    // /goal 相反:它是「开启目标工作」的命令,刻意留在 adapter 层保留冷启动语义。
    expect(resolveAdapterDefaultPassthroughCommands('app-1')).toContain('/goal');
    expect(resolveAdapterDefaultPassthroughCommands('app-2')).toContain('/goal');
  });

  it('does not expose Codex interactive /title through the Lark channel', () => {
    expect(PASSTHROUGH_COMMANDS.has('/title')).toBe(false);
    expect(DAEMON_COMMANDS.has('/title')).toBe(false);
    expect(resolvePassthroughCommands('app-2').has('/title')).toBe(false);
  });
});

describe('parseSlashCommandInvocation', () => {
  it('parses a normal daemon command', () => {
    expect(parseSlashCommandInvocation('/adopt 0:2.0')).toEqual({
      cmd: '/adopt',
      content: '/adopt 0:2.0',
    });
  });

  it('ignores placeholder command examples', () => {
    expect(parseSlashCommandInvocation('/adopt <pane>')).toBeNull();
    expect(parseSlashCommandInvocation('/adopt --takeover [<pane>]')).toBeNull();
  });

  it('ignores multi-line slash command lists', () => {
    const content = [
      '/adopt <pane>',
      '/adopt --takeover [<pane>]',
      '/adopt --takeover --kill-origin <pane?>',
      '这三个没人会用的吧？',
    ].join('\n');
    expect(parseSlashCommandInvocation(content)).toBeNull();
  });

  it('allows multiline schedule commands without a second slash-command line', () => {
    const content = '/schedule add 明天 9 点\n生成昨天的 PR 总结';
    expect(parseSlashCommandInvocation(content)).toEqual({
      cmd: '/schedule',
      content,
    });
  });

  it('preserves multiline fork tasks as one daemon command', () => {
    const content = '/fork 调研这个问题\n补齐失败清理';
    expect(parseSlashCommandInvocation(content)).toEqual({
      cmd: '/fork',
      content,
    });
  });

  it('ignores non-command text', () => {
    expect(parseSlashCommandInvocation('请解释 /adopt 怎么设计')).toBeNull();
  });
});

describe('parseForceTopicInvocation', () => {
  it('parses /t with prompt', () => {
    expect(parseForceTopicInvocation('/t 帮我看看 X')).toEqual({ prompt: '帮我看看 X' });
  });

  it('parses /topic with prompt', () => {
    expect(parseForceTopicInvocation('/topic 帮我看看 Y')).toEqual({ prompt: '帮我看看 Y' });
  });

  it('parses bare /t (no args) with empty prompt', () => {
    expect(parseForceTopicInvocation('/t')).toEqual({ prompt: '' });
  });

  it('parses bare /topic (no args) with empty prompt', () => {
    expect(parseForceTopicInvocation('/topic')).toEqual({ prompt: '' });
  });

  it('is case-insensitive on the command itself', () => {
    expect(parseForceTopicInvocation('/T hello')).toEqual({ prompt: 'hello' });
    expect(parseForceTopicInvocation('/Topic hello')).toEqual({ prompt: 'hello' });
  });

  it('preserves multiline prompt content verbatim after the prefix', () => {
    const content = '/t line1\nline2\nline3';
    expect(parseForceTopicInvocation(content)).toEqual({ prompt: 'line1\nline2\nline3' });
  });

  it('does not match similar prefixes', () => {
    expect(parseForceTopicInvocation('/tea is good')).toBeNull();
    expect(parseForceTopicInvocation('/talk to me')).toBeNull();
    expect(parseForceTopicInvocation('/topical')).toBeNull();
  });

  it('only matches at the very start of content', () => {
    expect(parseForceTopicInvocation('hello /t world')).toBeNull();
    expect(parseForceTopicInvocation('  /t hello')).toEqual({ prompt: 'hello' }); // tolerate leading whitespace
  });

  it('returns null for non-slash text', () => {
    expect(parseForceTopicInvocation('hello world')).toBeNull();
    expect(parseForceTopicInvocation('')).toBeNull();
  });

  it('does not collide with parseSlashCommandInvocation outputs', () => {
    // /close, /restart, /repo etc. must NOT be claimed as force-topic invocations.
    expect(parseForceTopicInvocation('/close')).toBeNull();
    expect(parseForceTopicInvocation('/restart')).toBeNull();
    expect(parseForceTopicInvocation('/repo 1')).toBeNull();
  });
});

describe('handleCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeSession).mockImplementation(async (sessionId: string) => {
      // Model the authoritative close lifecycle's dashboard contract. The
      // command must delegate this side effect instead of publishing a second
      // patch itself.
      publishClosedSessionPatch(sessionId);
      // Model the authoritative registry removal too: in production
      // setActiveSessionsRegistry wires worker-pool's map to deps.activeSessions,
      // so closeSession deletes the closed session from it. /close no longer
      // deletes the key itself — it delegates to this lifecycle.
      if (lastMadeActiveSessions) {
        for (const [k, candidate] of lastMadeActiveSessions) {
          if (candidate.session.sessionId === sessionId) lastMadeActiveSessions.delete(k);
        }
      }
      return { ok: true, outcome: 'closed', alreadyClosed: false, known: true };
    });
    vi.mocked(teardownAuthoritativePersistentBackingBeforeClose).mockImplementation(() => undefined);
    vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    vi.mocked(listCodexAppThreads).mockResolvedValue([]);
    vi.mocked(resolveUserToken).mockResolvedValue(null);
    vi.mocked(resolveDocFile).mockResolvedValue({ fileToken: 'doc_token_12345678901234567890', fileType: 'docx' });
    vi.mocked(getDocSubscription).mockReturnValue(null);
    vi.mocked(putDocSubscription).mockReturnValue({});
    // NOTE: vi.clearAllMocks() only clears call history — it does NOT undo
    // mockReturnValue/mockImplementation overrides set inside individual
    // tests (verified on vitest 4; resetAllMocks is what restores factory
    // impls). Every mock that tests override must therefore be restored to
    // its default here, or the last override leaks into subsequent tests.
    vi.mocked(readGlobalConfig).mockReturnValue({});
    vi.mocked(repoPickerScanOptions).mockReturnValue({ includeWorktrees: true });
    vi.mocked(findOncallChat).mockReturnValue(undefined);
    vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue(null);
    vi.mocked(scheduler.extractDeliveryMode).mockImplementation((prompt: string) => ({ deliver: 'origin' as const, prompt }));
    vi.mocked(scheduler.extractScheduleModifiers).mockImplementation((prompt: string) => ({
      deliver: 'origin' as const,
      silent: false,
      prompt,
    }));
    // Shared fs mocks: other describes set existsSync=false / throwing statSync
    // without always restoring, and the schedule workingDir validation depends
    // on them — pin the factory defaults so tests pass in any order (shuffle).
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(deleteMessage).mockResolvedValue(true);
    vi.mocked(sendMessage).mockResolvedValue('card-msg-id');
    vi.mocked(replyMessage).mockResolvedValue('picker-card-msg-id');
    vi.mocked(getChatModeStrict).mockResolvedValue('topic');
    vi.mocked(getMessageThreadId).mockResolvedValue('omt_child');
    vi.mocked(forkSession).mockResolvedValue({ ok: true, childSessionId: 'child-sess-1' });
    vi.mocked(isForkCapableSession).mockReturnValue(true);
    vi.mocked(sessionStore.getSession).mockReturnValue(undefined);
    vi.mocked(sessionStore.getOwnedSession).mockReturnValue(undefined);
    vi.mocked(sessionStore.listSessions).mockReturnValue([]);
    vi.mocked(resumeSession).mockReset();
  });

  describe('/fork sub-topic', () => {
    it('creates a child topic and forwards the multiline task as the first fork turn', async () => {
      const ds = makeDaemonSession({
        scope: 'thread',
        lastScreenStatus: 'idle',
        session: makeSession({
          ownerOpenId: 'ou_sender',
          cliSessionId: 'cli-parent-1',
          scope: 'thread',
        }),
      });
      const deps = makeDeps(ds);
      const task = '调研这个问题\n补齐失败清理';

      await handleCommand(
        '/fork',
        ROOT_ID,
        makeLarkMessage(`/fork ${task}`, { threadId: 'omt_parent' }),
        deps,
        LARK_APP_ID,
      );

      expect(getChatModeStrict).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
      expect(sendMessage).toHaveBeenCalledWith(
        LARK_APP_ID,
        CHAT_ID,
        expect.stringContaining('调研这个问题'),
        'post',
      );
      expect(forkSession).toHaveBeenCalledWith(
        'sess-001',
        CHAT_ID,
        'card-msg-id',
        'group',
        'thread',
        expect.objectContaining({
          forkTaskText: task,
          larkThreadId: 'omt_child',
          turnId: 'msg_001',
        }),
      );
      const options = vi.mocked(forkSession).mock.calls[0][5]!;
      expect(options).toMatchObject({
        senderOpenId: 'ou_sender',
        senderIsBot: false,
      });
      expect(options.buildInitialPrompt?.('child-sess-1')).toEqual({
        content: expect.stringContaining(task),
      });
      const initialPromptCall = vi.mocked(buildNewTopicCliInput).mock.calls.at(-1)!;
      expect(initialPromptCall[10]).toEqual({ openId: 'ou_sender', type: 'user' });
      const actualSessionManager = await vi.importActual<typeof import('../src/core/session-manager.js')>(
        '../src/core/session-manager.js',
      );
      expect(actualSessionManager.renderSenderTag(initialPromptCall[10])).toContain('open_id="ou_sender"');
      expect(ds.session.forkChildSessionIds).toEqual(['child-sess-1']);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('omt_child'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('reports an orphan topic when fork creation and message recall both fail', async () => {
      vi.mocked(forkSession).mockResolvedValueOnce({ ok: false, error: 'worker_busy' });
      vi.mocked(deleteMessage).mockResolvedValueOnce(false);
      const ds = makeDaemonSession({
        scope: 'thread',
        session: makeSession({ cliSessionId: 'cli-parent-1', scope: 'thread' }),
      });

      const result = await startForkSubtopicSession(
        '继续排查',
        ds,
        makeLarkMessage('/fork 继续排查', { threadId: 'omt_parent' }),
        LARK_APP_ID,
      );

      expect(result).toEqual({ ok: false, error: 'worker_busy', orphanTopic: true });
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'card-msg-id');
    });

    it('turns a topic creation exception into a user-visible failure', async () => {
      vi.mocked(sendMessage).mockRejectedValueOnce(new Error('lark unavailable'));
      const ds = makeDaemonSession({
        scope: 'thread',
        lastScreenStatus: 'idle',
        session: makeSession({ cliSessionId: 'cli-parent-1', scope: 'thread' }),
      });
      const deps = makeDeps(ds);

      await handleCommand(
        '/fork',
        ROOT_ID,
        makeLarkMessage('/fork 继续排查', { threadId: 'omt_parent' }),
        deps,
        LARK_APP_ID,
      );

      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('topic_creation_failed'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
      expect(deleteMessage).not.toHaveBeenCalled();
    });

    it('recalls the created topic when forkSession throws unexpectedly', async () => {
      vi.mocked(forkSession).mockRejectedValueOnce(new Error('spawn exploded'));
      const ds = makeDaemonSession({
        scope: 'thread',
        session: makeSession({ cliSessionId: 'cli-parent-1', scope: 'thread' }),
      });

      const result = await startForkSubtopicSession(
        '继续排查',
        ds,
        makeLarkMessage('/fork 继续排查', { threadId: 'omt_parent' }),
        LARK_APP_ID,
      );

      expect(result).toEqual({ ok: false, error: 'fork_subtopic_failed', orphanTopic: false });
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'card-msg-id');
    });
  });

  describe('/fork --create lineage durability', () => {
    it('persists parent lineage even when the created-notice reply fails (expired root → 400)', async () => {
      // Regression for the ordering blocker: the "created" notice is a reply to
      // the parent session's root message — the same message whose expiry this
      // PR's other fix addresses. If that notice throws, control must NOT skip
      // the lineage write, or /forklist stays empty in the exact "root expired"
      // scenario the PR targets. We assert lineage is durable BEFORE the notice.
      vi.mocked(forkSession).mockResolvedValueOnce({ ok: true, childSessionId: 'child-create-1' });
      const ds = makeDaemonSession({
        scope: 'chat',
        lastScreenStatus: 'idle',
        session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat', cliId: 'codex' }),
      });
      const deps = makeDeps(ds);
      // First sessionReply (the created notice) rejects like a 400 on the
      // expired root; later calls (if any) resolve.
      let replyCall = 0;
      (deps.sessionReply as any).mockImplementation(async () => {
        replyCall += 1;
        if (replyCall === 1) throw new Error('Request failed with status code 400');
        return 'reply-msg-id';
      });

      await handleCommand(
        '/fork',
        ROOT_ID,
        makeLarkMessage('/fork --create 直播开发备份'),
        deps,
        LARK_APP_ID,
      );

      // forkSession ran for the new group and carried the group name as task text.
      expect(forkSession).toHaveBeenCalledWith(
        'sess-001',
        expect.any(String),
        expect.any(String),
        'group',
        'chat',
        expect.objectContaining({ forkTaskText: '直播开发备份' }),
      );
      // The load-bearing assertion: lineage persisted despite the notice throwing.
      expect(ds.session.forkChildSessionIds).toEqual(['child-create-1']);
      expect(sessionStore.updateSession).toHaveBeenCalledWith(
        expect.objectContaining({ forkChildSessionIds: ['child-create-1'] }),
      );
    });
  });

  describe('doc comment commands', () => {
    it('/subscribe-lark-doc keeps the original doc-scoped OAuth requirement', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/subscribe-lark-doc',
        ROOT_ID,
        makeLarkMessage('/subscribe-lark-doc https://example.feishu.cn/docx/AbCdEf12345678901234'),
        deps,
        LARK_APP_ID,
      );

      expect(generateAuthUrl).toHaveBeenCalledWith(
        LARK_APP_ID,
        'secret-1',
        'feishu',
        DOC_COMMENT_OAUTH_SCOPES,
      );
      expect(subscribeDocFile).not.toHaveBeenCalled();
      expect(putDocSubscription).not.toHaveBeenCalled();
    });

    it('/subscribe-lark-doc still calls the per-file API after doc OAuth', async () => {
      vi.mocked(resolveUserToken).mockResolvedValue('uat-doc');
      const ds = makeDaemonSession({ scope: 'thread' });
      const deps = makeDeps(ds);

      await handleCommand(
        '/subscribe-lark-doc',
        ROOT_ID,
        makeLarkMessage('/subscribe-lark-doc https://example.feishu.cn/docx/AbCdEf12345678901234'),
        deps,
        LARK_APP_ID,
      );

      expect(subscribeDocFile).toHaveBeenCalledWith(LARK_APP_ID, {
        fileToken: 'doc_token_12345678901234567890',
        fileType: 'docx',
      });
      expect(putDocSubscription).toHaveBeenCalledWith(
        expect.any(String),
        LARK_APP_ID,
        expect.objectContaining({ managedBy: 'subscribe-lark-doc' }),
      );
    });

    it.each([
      ['user', '当前用户身份'],
      ['tenant', '机器人应用身份'],
      ['both', '当前用户身份和机器人应用身份'],
      ['unknown', '调用身份'],
    ] as const)(
      '/subscribe-lark-doc reports the actual 1069603 identity source: %s',
      async (source, expectedIdentity) => {
        vi.mocked(resolveUserToken).mockResolvedValue('uat-doc');
        vi.mocked(subscribeDocFile).mockRejectedValueOnce(
          new DocSubscriptionPermissionError({ source }),
        );
        const deps = makeDeps(makeDaemonSession());

        await handleCommand(
          '/subscribe-lark-doc',
          ROOT_ID,
          makeLarkMessage('/subscribe-lark-doc https://example.feishu.cn/docx/AbCdEf12345678901234'),
          deps,
          LARK_APP_ID,
        );

        const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(replyContent).toContain(expectedIdentity);
        expect(replyContent).toContain('文档访问记录功能');
        expect(replyContent).toContain('1069603');
        expect(generateAuthUrl).not.toHaveBeenCalled();
      },
    );

    it('/subscribe-lark-doc still prompts document OAuth for a runtime-expired user token', async () => {
      vi.mocked(resolveUserToken).mockResolvedValue('uat-doc');
      vi.mocked(subscribeDocFile).mockRejectedValueOnce(new UserTokenMissingError('User Token 已失效'));
      const deps = makeDeps(makeDaemonSession());

      await handleCommand(
        '/subscribe-lark-doc',
        ROOT_ID,
        makeLarkMessage('/subscribe-lark-doc https://example.feishu.cn/docx/AbCdEf12345678901234'),
        deps,
        LARK_APP_ID,
      );

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('文档权限');
      expect(replyContent).toContain('https://open.feishu.cn/auth/v1/test');
      expect(generateAuthUrl).toHaveBeenCalledWith(
        LARK_APP_ID,
        'secret-1',
        'feishu',
        DOC_COMMENT_OAUTH_SCOPES,
      );
    });

    it('/watch-comment works without a User Token and records the comment watch', async () => {
      const ds = makeDaemonSession({
        scope: 'thread',
        workingDir: '/work/current-session',
        session: makeSession({ workingDir: '/work/current-session' }),
      });
      const deps = makeDeps(ds);

      await handleCommand(
        '/watch-comment',
        ROOT_ID,
        makeLarkMessage('/watch-comment https://example.feishu.cn/docx/AbCdEf12345678901234 --all', { senderId: 'ou_owner' }),
        deps,
        LARK_APP_ID,
      );

      expect(generateAuthUrl).not.toHaveBeenCalled();
      expect(resolveUserToken).not.toHaveBeenCalled();
      expect(subscribeDocFile).not.toHaveBeenCalled();
      expect(deps.prewarmDocCommentSession).toHaveBeenCalledWith(
        ds,
        expect.objectContaining({ fileToken: 'doc_token_12345678901234567890', commentTriggerMode: 'all' }),
      );
      expect(putDocSubscription).toHaveBeenCalledWith(
        expect.any(String),
        LARK_APP_ID,
        expect.objectContaining({
          fileToken: 'doc_token_12345678901234567890',
          sessionAnchor: ROOT_ID,
          sessionId: 'sess-001',
          scope: 'thread',
          commentTriggerMode: 'all',
          workingDir: '/work/current-session',
          managedBy: 'watch-comment',
        }),
      );
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('正在启动并预热 AI 会话'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('工作目录：/work/current-session'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('/watch-comment without a bound project asks whether to bind one and defaults to document-only', async () => {
      const ds = makeDaemonSession({ scope: 'chat', session: makeSession({ scope: 'chat' }) });
      const deps = makeDeps(ds);
      vi.mocked(getDocSubscription).mockReturnValueOnce({
        fileToken: 'doc_token_12345678901234567890',
        fileType: 'docx',
        sessionAnchor: 'old-anchor',
        scope: 'chat',
        chatId: 'old-chat',
        commentTriggerMode: 'all',
        managedBy: 'watch-comment',
        workingDir: '/work/old-binding',
        pollBaselineReady: true,
        pollCursorAt: 1,
        pollCursorReplyId: 'reply-1',
        createdAt: 1,
      } as any);

      await handleCommand(
        '/watch-comment',
        ROOT_ID,
        makeLarkMessage('/watch-comment https://example.feishu.cn/docx/AbCdEf12345678901234 --all', { senderId: 'ou_owner' }),
        deps,
        LARK_APP_ID,
      );

      expect(putDocSubscription).toHaveBeenCalledWith(
        expect.any(String),
        LARK_APP_ID,
        expect.objectContaining({ workingDir: undefined }),
      );
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('不操作则默认仅根据文档内容回答'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('/watch-comment without a session stores a doc-native lazy binding only', async () => {
      const deps = makeDeps();

      await handleCommand(
        '/watch-comment',
        ROOT_ID,
        makeLarkMessage('/watch-comment https://example.feishu.cn/docx/AbCdEf12345678901234 --dir /work/repo', { senderId: 'ou_owner' }),
        deps,
        LARK_APP_ID,
      );

      expect(forkWorker).not.toHaveBeenCalled();
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      expect(resolveUserToken).not.toHaveBeenCalled();
      expect(subscribeDocFile).not.toHaveBeenCalled();
      expect(putDocSubscription).toHaveBeenCalledWith(
        expect.any(String),
        LARK_APP_ID,
        expect.objectContaining({
          fileToken: 'doc_token_12345678901234567890',
          sessionAnchor: 'doc:doc_token_12345678901234567890',
          sessionId: undefined,
          scope: 'chat',
          chatId: 'doc:doc_token_12345678901234567890',
          workingDir: '/work/repo',
          managedBy: 'watch-comment',
        }),
      );
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('首条符合条件的评论到来时自动创建文档会话'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('/watch-comment list without a session lists all doc-native watches (owner-only command)', async () => {
      vi.mocked(listAllDocSubscriptions).mockReturnValue([
        {
          fileToken: 'doc-owned', fileType: 'docx', sessionAnchor: 'doc:doc-owned', scope: 'chat',
          chatId: 'doc:doc-owned', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
          ownerOpenId: 'ou_owner', createdAt: 1,
        },
        {
          fileToken: 'doc-other', fileType: 'docx', sessionAnchor: 'doc:doc-other', scope: 'chat',
          chatId: 'doc:doc-other', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
          ownerOpenId: 'ou_other', createdAt: 1,
        },
      ]);
      const deps = makeDeps();

      await handleCommand('/watch-comment', ROOT_ID, makeLarkMessage('/watch-comment list', { senderId: 'ou_owner' }), deps, LARK_APP_ID);

      // 命令已收归 owner-only，owner 应看到全部订阅（含非 owner 触发的 auto-sub）
      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] ?? '';
      expect(reply).toContain('doc-owned');
      expect(reply).toContain('doc-other');
    });

    it('/watch-comment off all without a session removes all watch records (owner-only command)', async () => {
      vi.mocked(listAllDocSubscriptions).mockReturnValue([
        {
          fileToken: 'doc-owned', fileType: 'docx', sessionAnchor: 'doc:doc-owned', scope: 'chat',
          chatId: 'doc:doc-owned', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
          ownerOpenId: 'ou_owner', createdAt: 1,
        },
        {
          fileToken: 'doc-other-user', fileType: 'docx', sessionAnchor: 'doc:doc-other-user', scope: 'chat',
          chatId: 'doc:doc-other-user', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
          ownerOpenId: 'ou_other', createdAt: 1,
        },
      ]);
      const deps = makeDeps();

      await handleCommand('/watch-comment', ROOT_ID, makeLarkMessage('/watch-comment off all', { senderId: 'ou_owner' }), deps, LARK_APP_ID);

      // owner off-all 应清除全部 watch 订阅（不再按 ownerOpenId 过滤）
      expect(removeDocSubscription).toHaveBeenCalledWith(expect.any(String), LARK_APP_ID, 'doc-owned');
      expect(removeDocSubscription).toHaveBeenCalledWith(expect.any(String), LARK_APP_ID, 'doc-other-user');
      expect(unsubscribeDocFile).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('2 个'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });
  });

  // ─── /close ─────────────────────────────────────────────────────────────

  describe('/close', () => {
    it('treats an existing App Server adopt as a BotMux-only disconnect', async () => {
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex' as any,
          cliSessionId: '019e-existing-app-server-thread',
          existingAppServerEndpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
        }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
      expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('App Server 和 Codex App 会话仍在运行'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('does not report a shared App Server disconnect as complete when close leaves a residual', async () => {
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex' as any,
          cliSessionId: '019e-existing-app-server-thread',
          existingAppServerEndpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
        }),
      });
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'local_subtree_boundary_unproven' },
        alreadyClosed: false,
        known: true,
      } as never);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] as string;
      expect(reply).toContain('未能确认完全断开');
      expect(reply).not.toContain('App Server 和 Codex App 会话仍在运行');
    });

    it.each([
      {
        command: '/detach',
        close: {
          ok: true,
          outcome: 'closed',
          alreadyClosed: false,
          known: true,
        },
        expected: 'App Server 和 Codex App 会话仍在运行',
      },
      {
        command: '/detach',
        close: {
          ok: false,
          alreadyClosed: false,
          error: 'remote_close_unproven',
          retryable: true,
        },
        expected: '未能安全断开',
      },
      {
        command: '/disconnect',
        close: {
          ok: true,
          outcome: 'closed_with_residual',
          residual: { reason: 'local_subtree_boundary_unproven' },
          alreadyClosed: false,
          known: true,
        },
        expected: '未能确认完全断开',
      },
    ])('maps shared $command close outcomes without claiming an unverified detach', async ({ command, close, expected }) => {
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex' as any,
          cliSessionId: '019e-existing-app-server-thread',
          existingAppServerEndpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
        }),
      });
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockResolvedValueOnce(close as never);

      await handleCommand(command, ROOT_ID, makeLarkMessage(command), deps, LARK_APP_ID);

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] as string;
      expect(reply).toContain(expected);
      if ((close as { outcome?: string }).outcome !== 'closed') {
        expect(reply).not.toContain('App Server 和 Codex App 会话仍在运行');
      }
    });

    it('closes through the authoritative worker-pool lifecycle and removes the session', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const events: DashboardEvent[] = [];
      const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));

      try {
        await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);
      } finally {
        unsubscribe();
      }

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      // The command must not bypass closeSession's verified ZMX teardown by
      // mutating worker/store state directly.
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
      expect(deps.activeSessions.has(sessionKey(ROOT_ID, LARK_APP_ID))).toBe(false);
      expect(events).toContainEqual({
        type: 'session.update',
        body: {
          sessionId: 'sess-001',
          patch: expect.objectContaining({
            status: 'closed',
            previewUserText: null,
            previewBotText: null,
            previewUserFullText: null,
            previewBotFullText: null,
            previewUserAt: null,
            previewBotAt: null,
            previewBotState: null,
          }),
        },
      });
      // The「会话已关闭」card is delivered「仅自己可见」-first: it routes through
      // deliverEphemeralOrReply targeting the user who ran /close (message.senderId),
      // so plain groups get an ephemeral (visible-to-you) card and topic groups
      // (ephemeral unsupported → 18053) fall back to the normal visible reply.
      expect(deliverEphemeralOrReply).toHaveBeenCalledWith(
        ds,
        'ou_sender',
        expect.stringContaining('会话已关闭'),
        'interactive',
        expect.any(Function),
        undefined,
      );
      // /close now replies with an interactive card carrying a Resume button
      // and a copyable `botmux resume <id>` command — assert on the card shape
      // rather than the legacy plain text. (Here via the visible-reply fallback.)
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('会话已关闭'),
        'interactive',
        LARK_APP_ID,
        'msg_001',
      );
      const replyArgs = (deps.sessionReply as any).mock.calls[0];
      const cardJson = replyArgs[1] as string;
      expect(cardJson).toContain('botmux resume');
      expect(cardJson).toContain('"action":"resume"');
    });

    it('keeps the active session and reports a visible failure when teardown is refused', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockRejectedValueOnce(new Error('ZMX ownership probe unavailable'));

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      expect(deps.activeSessions.get(sessionKey(ROOT_ID, LARK_APP_ID))).toBe(ds);
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
      expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('会话关闭失败'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
      expect(vi.mocked(deps.sessionReply).mock.calls[0]?.[1]).toContain('ZMX ownership probe unavailable');
    });

    it('reports a refused close instead of claiming the session was closed', async () => {
      // A remote backend that cannot prove its remote session was cancelled
      // RETURNS {ok:false} rather than throwing, and leaves the row active. This
      // path used to only inspect thrown errors, so it announced "已关闭" and sent
      // the closed-session card while the remote session was still running and
      // still holding the injected credential — the exact lie the daemon-side fix
      // exists to remove.
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockResolvedValueOnce({
        ok: false,
        alreadyClosed: false,
        error: 'mojo_cancel_failed',
        retryable: true,
        taskId: 'mojo-sid-123',
      } as never);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(closeSession).toHaveBeenCalledWith('sess-001');
      // Active record kept so the close is retryable.
      expect(deps.activeSessions.get(sessionKey(ROOT_ID, LARK_APP_ID))).toBe(ds);
      // The "session closed" card must NOT be delivered.
      expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] as string;
      expect(reply).toContain('会话关闭失败');
      expect(reply).toContain('mojo_cancel_failed');
      expect(reply).toContain('mojo-sid-123');
    });

    it('reports a residual instead of a plain closed card', async () => {
      // The row DID close, so this is not a failure — but a remote session was
      // deliberately left running, and the ordinary closed card would say
      // everything is gone.
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
        alreadyClosed: false,
        known: true,
      } as never);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      // No ordinary "closed" card.
      expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] as string;
      expect(reply).toContain('mojo-parked-9');
      expect(reply).toContain('未被取消');
    });

    it('a LOCAL-subtree residual on /close points at the host process, not a phantom remote (round-11 P1-2)', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      vi.mocked(closeSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'local_subtree_boundary_unproven' },
        alreadyClosed: false,
        known: true,
      } as never);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      const reply = vi.mocked(deps.sessionReply).mock.calls[0]?.[1] as string;
      expect(reply).toContain('本机');       // points at the host subtree
      expect(reply).not.toContain('undefined');
      expect(reply).not.toMatch(/远端会话.*未.*取消/);
    });

    it('does not delete a replacement session that wins the anchor while close awaits cleanup', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      let releaseClose!: (value: CloseSessionResult) => void;
      vi.mocked(closeSession).mockImplementationOnce(() => new Promise(resolve => {
        releaseClose = resolve;
      }));

      const closing = handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);
      await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('sess-001'));

      const replacement = makeDaemonSession();
      replacement.session = {
        ...replacement.session,
        sessionId: 'sess-replacement',
        title: 'replacement',
      };
      deps.activeSessions.set(sessionKey(ROOT_ID, LARK_APP_ID), replacement);
      releaseClose({ ok: true, outcome: 'closed', alreadyClosed: false, known: true });
      await closing;

      expect(deps.activeSessions.get(sessionKey(ROOT_ID, LARK_APP_ID))).toBe(replacement);
    });

    it('keeps ttadk non-interactive flags in the closed-card resume command', async () => {
      // A ttadk × Claude bot: the manual resume command on the closed card must
      // carry `-m <model> --skip-check`, else copy-pasting it hits ttadk's model
      // picker. Verifies the /close construction passes { ttadkModel: bot.model }
      // (not just the decorateResumeForWrapper helper in isolation).
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          wrapperCli: 'ttadk claude',
          model: 'glm-5.1',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      // 6th positional arg to buildSessionClosedCard is the cliResumeCommand.
      const resumeArg = vi.mocked(buildSessionClosedCard).mock.calls[0]?.[5];
      expect(resumeArg).toBe('ttadk claude -m glm-5.1 --skip-check --resume sess-001');
    });

    it('should reply with no-session message when session does not exist', async () => {
      const deps = makeDeps(); // no session

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('没有活跃的会话'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });
  });

  // ─── /restart ───────────────────────────────────────────────────────────

  describe('/restart', () => {
    it('rejects restart for adopted sessions without creating an attempt', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: { source: 'tmux', target: 'shared-pane' } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(requestSessionRestart).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('adopt'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should reject Riff sessions with close-and-recreate guidance', async () => {
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      ds.session.cliId = 'riff';
      ds.session.backendType = 'riff';
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(workerSend).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringMatching(/Riff.*不支持重启.*\/close/),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should reject Mojo restarts with the same remote guard (round-4 gate)', async () => {
      // Unlike riff (whose worker refuses the IPC), a mojo worker EXECUTES
      // restart — its teardown cancels the remote session and cold-boots a
      // context-less replacement. The riff-only guard made /restart a real
      // remote-destruction entry point for mojo.
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      ds.session.cliId = 'mojo';
      ds.session.backendType = 'mojo';
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(requestSessionRestart).not.toHaveBeenCalled();
      expect(workerSend).not.toHaveBeenCalled();
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringMatching(/Mojo.*不支持重启.*\/close/),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should send restart IPC when worker is alive', async () => {
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'slash' }));
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('正在重启'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('uses the frozen configured runtime name in restart feedback', async () => {
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex',
          agentFrozen: true,
          cliRuntime: {
            id: 'vendor-codex', displayName: 'Vendor Codex', executable: 'vendor-codex',
            source: 'configured', update: { provider: 'none' },
          },
        }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('Vendor Codex');
      expect(reply).not.toContain('Claude');
    });

    it('should kill dead worker and reply recovery message when worker is already killed', async () => {
      const ds = makeDaemonSession({
        worker: { killed: true, send: vi.fn() } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'slash' }));
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('正在重启'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should kill null worker and reply recovery message when no worker', async () => {
      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(requestSessionRestart).toHaveBeenCalledWith(ds, expect.objectContaining({ source: 'slash' }));
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('正在重启'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should reply no-session message when session does not exist', async () => {
      const deps = makeDeps();

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('没有活跃的会话'),
        undefined,
        LARK_APP_ID,
        'msg_001',
      );
    });
  });

  // ─── /status ────────────────────────────────────────────────────────────

  describe('/status', () => {
    it('should return session info when session exists with running worker', async () => {
      setTerminalProxyPort(8800);
      const ds = makeDaemonSession({
        worker: { killed: false } as any,
        workerPort: 8080,
      });
      const deps = makeDeps(ds);

      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), deps, LARK_APP_ID);

      const replyCall = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      const replyContent = replyCall[1] as string;
      expect(replyContent).toContain('sess-001');
      expect(replyContent).toContain('运行中');
      // Terminal link now goes through the per-daemon reverse proxy (sub-path by sessionId).
      expect(replyContent).toContain(':8800/s/sess-001');
      expect(replyContent).toContain('Uptime:');
      expect(replyContent).toContain('Active sessions:');
    });

    it('should show "等待中" when worker is null', async () => {
      const ds = makeDaemonSession({ worker: null, workerPort: null });
      const deps = makeDeps(ds);

      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('等待中');
      expect(replyContent).not.toContain('Uptime:');
    });

    it('should show fallback status when no session exists', async () => {
      const deps = makeDeps();

      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('没有活跃的会话');
      expect(replyContent).toContain('v1.0.42');
    });

    it('shows configured runtime identity but keeps legacy path copy as Codex', async () => {
      const configured = makeDaemonSession({
        session: makeSession({
          cliId: 'codex', agentFrozen: true,
          cliRuntime: {
            id: 'vendor-codex', displayName: 'Vendor Codex', executable: 'vendor-codex',
            source: 'configured', update: { provider: 'none' },
          },
        }),
      });
      const configuredDeps = makeDeps(configured);
      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), configuredDeps, LARK_APP_ID);
      expect((configuredDeps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Vendor Codex:');

      const legacy = makeDaemonSession({
        session: makeSession({
          cliId: 'codex', agentFrozen: true, cliPathOverride: '/opt/legacy/vendor-codex',
        }),
      });
      const legacyDeps = makeDeps(legacy);
      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), legacyDeps, LARK_APP_ID);
      const legacyReply = (legacyDeps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      // This suite's getCliDisplayName mock returns the raw id for Codex; the
      // compatibility invariant is that legacy uses that adapter copy rather
      // than its executable basename.
      expect(legacyReply).toContain('codex:');
      expect(legacyReply).not.toContain('vendor-codex:');
    });
  });

  // ─── /help ──────────────────────────────────────────────────────────────

  describe('/help', () => {
    it('should return help text with CLI name from session', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('/close');
      expect(replyContent).toContain('/restart');
      expect(replyContent).toContain('/cd');
      expect(replyContent).toContain('/repo');
      expect(replyContent).toContain('/rename');
      expect(replyContent).toContain('/status');
      expect(replyContent).toContain('/help');
      expect(replyContent).toContain('/schedule');
      expect(replyContent).toContain('/login');
      expect(replyContent).toContain('/workflow <目标>');
      expect(replyContent).toContain('/workflow run <名称>');
      expect(replyContent).toContain('/workflow save last');
      expect(replyContent).toContain('botmux template migrate-v3');
      expect(replyContent).toContain('archive-runs');
      expect(replyContent).toContain('botmux template migrate-v3');
      expect(replyContent).toContain('/compact'); // passthrough list
      expect(replyContent).toContain('/model');
      expect(replyContent).toContain('Claude'); // CLI display name
    });

    it('keeps the session-frozen compatible runtime name after bot config changes', async () => {
      vi.mocked(getBot).mockImplementation((() => ({
        botName: 'Vendor bot',
        config: {
          larkAppId: 'app-runtime',
          larkAppSecret: 'secret-1',
          cliId: 'codex' as const,
          cliPathOverride: 'new-vendor-codex',
          cliRuntime: {
            id: 'new-vendor-codex',
            displayName: 'New Live Name',
            executable: 'new-vendor-codex',
            update: { provider: 'none' as const },
          },
        },
      })) as any);
      try {
        const ds = makeDaemonSession({
          larkAppId: 'app-runtime',
          session: makeSession({
            cliId: 'codex',
            cliPathOverride: 'vendor-codex',
            cliRuntime: {
              id: 'vendor-codex',
              displayName: 'Frozen Vendor Codex',
              executable: 'vendor-codex',
              source: 'configured',
              update: { provider: 'auto' },
            },
          }),
        });
        const deps = makeDeps(ds);

        await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, 'app-runtime');

        const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(replyContent).toContain('Frozen Vendor Codex');
        expect(replyContent).not.toContain('New Live Name');
      } finally {
        vi.mocked(getBot).mockImplementation(defaultGetBot as any);
      }
    });

    it('renders the current bot effective passthrough list', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        const b = defaultGetBot(id);
        (b.config as any).customPassthroughCommands = ['/status', '/b@d', '/GOAL', '/export', '/goal'];
        return b;
      }) as any);
      try {
        const ds = makeDaemonSession();
        const deps = makeDeps(ds);

        await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);

        const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        const passthroughLine = replyContent.split('\n').find(line => line.startsWith('/compact ')) ?? '';
        expect(passthroughLine).toBe([...resolvePassthroughCommands(LARK_APP_ID)].join(' '));
        expect(passthroughLine).toContain('/goal');
        expect(passthroughLine).toContain('/export');
        expect(passthroughLine).not.toContain('/status');
      } finally {
        vi.mocked(getBot).mockImplementation(defaultGetBot as any);
      }
    });

    it('lists every fixed Feishu-executable slash command', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const fixedFeishuCommands = [
        ...DAEMON_COMMANDS,
        '/grant',
        '/revoke',
        '/introduce',
        '/reply-mode',
        '/workflow',
        '/t',
        '/topic',
      ];
      for (const cmd of fixedFeishuCommands) {
        expect(replyContent, `Expected /help to mention ${cmd}`).toContain(cmd);
      }
    });

    it('should return help text when no session exists', async () => {
      const deps = makeDeps();

      await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);

      expect(deps.sessionReply).toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('/close');
    });
  });

  // ─── /cd ────────────────────────────────────────────────────────────────

  describe('/cd', () => {
    it('should show usage when no path provided', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('用法');
      expect(replyContent).toContain('/cd <path>');
    });

    it('should reply no-session message when session does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const deps = makeDeps();

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /home/testuser/other'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('没有活跃的会话');
    });

    it('should auto-create the directory and switch when path does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /brand-new/path'), deps, LARK_APP_ID);

      expect(mkdirSync).toHaveBeenCalledWith('/brand-new/path', { recursive: true });
      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(ds.workingDir).toBe('/brand-new/path');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已自动创建并切换');
    });

    it('should reject before path creation while Codex App dispatch ownership is non-empty', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const ds = makeDaemonSession();
      ds.session.codexAppDispatchLedger = [
        { dispatchId: 'd-1', turnId: 't-1', state: 'accepted', content: 'owned' },
      ];
      const originalWorkingDir = ds.workingDir;
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /brand-new/owned'), deps, LARK_APP_ID);

      expect(mkdirSync).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe(originalWorkingDir);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('未结算');
    });

    it('should reject Riff cwd changes before creating or persisting the target', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const ds = makeDaemonSession();
      ds.session.backendType = 'riff';
      const originalWorkingDir = ds.workingDir;
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /brand-new/riff-role'), deps, LARK_APP_ID);

      expect(mkdirSync).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe(originalWorkingDir);
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('Riff');
      expect(replyContent).toContain('/close');
    });

    it('should reject Mojo cwd changes before creating or persisting the target (P1-a)', async () => {
      // killWorker refuses unprepared live retirement for every remote backend
      // (P0-2), so a /cd that repinned first left the live worker on the OLD
      // cwd while reporting success — the riff-only guard let mojo through
      // into exactly that split brain.
      vi.mocked(existsSync).mockReturnValue(false);
      const ds = makeDaemonSession();
      ds.session.backendType = 'mojo';
      const originalWorkingDir = ds.workingDir;
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /brand-new/mojo-role'), deps, LARK_APP_ID);

      expect(mkdirSync).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe(originalWorkingDir);
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('Mojo');
      expect(replyContent).toContain('/close');
    });

    it('should reject /cd when auto-create fails', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /brand-new/denied'), deps, LARK_APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('无法创建目录');
    });

    it('should switch working directory and kill worker when path is valid', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /home/testuser/other-project'), deps, LARK_APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(ds.workingDir).toBe('/home/testuser/other-project');
      expect(ds.session.workingDir).toBe('/home/testuser/other-project');
      expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('工作目录已切换');
    });

    it('should cold-suspend a persistent worker so cwd-scoped history can resume', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(suspendWorker).mockReturnValueOnce(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /home/testuser/other-project'), deps, LARK_APP_ID);

      expect(suspendWorker).toHaveBeenCalledWith(ds, 'working_dir_changed');
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe('/home/testuser/other-project');
    });

    it('should reject path that exists but is not a directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValueOnce({ isDirectory: () => false } as any);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /home/testuser/some-file.txt'), deps, LARK_APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('路径不是目录');
    });

    it('should accept any existing directory regardless of location', async () => {
      // No allowlist — owner explicitly chose the path; we trust them.
      vi.mocked(existsSync).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/cd',
        ROOT_ID,
        makeLarkMessage('/cd /data00/home/wanghao.muchen/ai-workspace/marketing_insight'),
        deps,
        LARK_APP_ID,
      );

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(ds.workingDir).toBe('/data00/home/wanghao.muchen/ai-workspace/marketing_insight');
    });
  });

  // ─── /rename ─────────────────────────────────────────────────────────────

  describe('/rename', () => {
    it('shows usage when no title is provided', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/rename', ROOT_ID, makeLarkMessage('/rename'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('/rename');
      expect(replyContent).toContain('新的会话标题');
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
    });

    it('reports when there is no active session', async () => {
      const deps = makeDeps();

      await handleCommand('/rename', ROOT_ID, makeLarkMessage('/rename Better label'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('没有活跃的会话');
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
    });

    it('updates and flattens title metadata without restarting the worker', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/rename', ROOT_ID, makeLarkMessage('/rename  ZMX 后端集成推进\n阶段二  '), deps, LARK_APP_ID);

      expect(ds.session.title).toBe('ZMX 后端集成推进 阶段二');
      expect(ds.session.titleSource).toBe('user');
      expect(ds.session.titleUpdatedAt).toEqual(expect.any(String));
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('会话标题已更新');
      expect(replyContent).toContain('ZMX 后端集成推进 阶段二');
      expect(replyContent).toContain('Agent 当前未运行');
    });

    it('requests native rename from a live Codex worker without restarting it', async () => {
      const send = vi.fn();
      const ds = makeDaemonSession({
        session: makeSession({ cliId: 'codex', cliPathOverride: '/bin/codex' }),
        worker: { killed: false, connected: true, send } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/rename', ROOT_ID, makeLarkMessage('/rename  Native 同步  '), deps, LARK_APP_ID);

      expect(send).toHaveBeenCalledWith({ type: 'rename_session', title: 'Native 同步' });
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.session.title).toBe('Native 同步');
      expect(ds.session.nativeSessionTitle).toBe('Native 同步');
      expect(ds.session.nativeSessionTitleUserDefined).toBe(true);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已向 codex 发送原生改名请求');
    });
  });

  // ─── /repo ──────────────────────────────────────────────────────────────

  describe('/repo', () => {
    it('refuses a repo switch over a live Riff generation before teardown or refork', async () => {
      const oldSession = makeSession({
        cliId: 'riff',
        backendType: 'riff',
        riffParentTaskId: 'task-live',
        workingDir: '/remote/riff',
      });
      const ds = makeDaemonSession({
        pendingRepo: false,
        workingDir: '/remote/riff',
        worker: { killed: false } as any,
        initConfig: { backendType: 'riff' } as any,
        session: oldSession,
      });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(teardownAuthoritativePersistentBackingBeforeClose).not.toHaveBeenCalled();
      expect(closeWorkerPoolSession).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.session).toBe(oldSession);
      expect(ds.workingDir).toBe('/remote/riff');
      expect(ds.session.riffParentTaskId).toBe('task-live');
      expect(vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join()).toContain('/close');
    });

    it('refuses a repo switch over a live Mojo generation before teardown or refork (round-4 gate)', async () => {
      const oldSession = makeSession({
        cliId: 'mojo',
        backendType: 'mojo',
        riffParentTaskId: 'mojo-task-live',
        workingDir: '/remote/mojo',
      });
      const ds = makeDaemonSession({
        pendingRepo: false,
        workingDir: '/remote/mojo',
        worker: { killed: false } as any,
        initConfig: { backendType: 'mojo' } as any,
        session: oldSession,
      });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(teardownAuthoritativePersistentBackingBeforeClose).not.toHaveBeenCalled();
      expect(closeWorkerPoolSession).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.session).toBe(oldSession);
      expect(ds.workingDir).toBe('/remote/mojo');
      expect(ds.session.riffParentTaskId).toBe('mojo-task-live');
      expect(vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join()).toContain('/close');
    });

    it('does not create a replacement session when the old close left a residual', async () => {
      // Choosing a directory is not consent to leave a remote session running. The
      // old row DID close, so this is not a failure — but the switch must stop and
      // say so rather than spawning a replacement over an uncancelled remote.
      const ds = makeDaemonSession({ pendingRepo: false, worker: null });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);
      vi.mocked(closeWorkerPoolSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
        alreadyClosed: false,
        known: true,
      } as never);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(sessionStore.createSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      const said = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(said).toContain('mojo-parked-9');
      expect(said).toContain('未创建新会话');
    });

    it('a LOCAL-subtree residual on repo switch points at the host process, not a phantom remote (round-11 P1-2)', async () => {
      // A local residual has no taskId. The old wording rendered "远端会话 undefined
      // 未取消" and sent the operator after a nonexistent remote session.
      const ds = makeDaemonSession({ pendingRepo: false, worker: null });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);
      vi.mocked(closeWorkerPoolSession).mockResolvedValueOnce({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'local_subtree_boundary_unproven' },
        alreadyClosed: false,
        known: true,
      } as never);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(sessionStore.createSession).not.toHaveBeenCalled();
      const said = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(said).toContain('本机');
      expect(said).toContain('未创建新会话');
      expect(said).not.toContain('undefined');
      expect(said).not.toMatch(/远端会话.*未.*取消/);
    });

    it('shared fold-back: every command reply carries the triggering messageId as turnId', async () => {
      // A shared (chat-scope) session triggered from inside a Lark thread
      // records currentReplyTarget={turnId: messageId}. Command replies must
      // pass that same messageId through sessionReply so the turnId gate in
      // resolveSessionReplyTarget anchors them into the topic instead of
      // leaking a plain top-level message.
      const ds = makeDaemonSession({ scope: 'chat' } as Partial<DaemonSession>);
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1', { messageId: 'msg_turn' }), deps, LARK_APP_ID);

      const call = vi.mocked(deps.sessionReply).mock.calls[0];
      expect(call[4]).toBe('msg_turn');
    });

    it('pendingRepo first-spawn: the 已选择 confirmation carries the triggering messageId as turnId', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        scope: 'chat',
        currentReplyTarget: { rootMessageId: 'om_topic_root', turnId: 'msg_prime', updatedAt: new Date().toISOString() },
      } as Partial<DaemonSession>);
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1', { messageId: 'msg_prime' }), deps, LARK_APP_ID);

      const selected = vi.mocked(deps.sessionReply).mock.calls.find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('已选择'),
      );
      expect(selected, 'no 已选择 confirmation was sent').toBeDefined();
      expect(selected![4]).toBe('msg_prime');
    });

    it('should prompt to run /repo first when index given but no cached scan', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('请先执行 /repo');
    });

    it('should reject out-of-range index', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 5'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('序号超出范围');
    });

    it('should select project by index and create new session', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 2'), deps, LARK_APP_ID);

      expect(ds.workingDir).toBe('/home/testuser/project-b');
      // ds.session is replaced by createSession result (pendingRepo is false → else branch)
      expect(closeWorkerPoolSession).toHaveBeenCalledWith('sess-001');
      expect(sessionStore.createSession).toHaveBeenCalledWith(
        CHAT_ID, ROOT_ID, 'project-b (dev)', 'group', undefined,
      );
      expect(ds.session.sessionId).toBe('new-session-123');
      expect(ds.hasHistory).toBe(false);
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(withActiveSessionKeyLock).toHaveBeenCalledWith(
        deps.activeSessions,
        sessionKey(ROOT_ID, LARK_APP_ID),
        expect.any(Function),
      );
    });

    it('keeps the old ZMX session active when repo-switch teardown is refused', async () => {
      const oldSession = makeSession({ backendType: 'zmx', workingDir: '/home/testuser/project-a' });
      const ds = makeDaemonSession({ pendingRepo: false, session: oldSession, repoCardMessageId: 'om_repo_card' });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);
      vi.mocked(teardownAuthoritativePersistentBackingBeforeClose).mockImplementationOnce(() => {
        throw new Error('zmx generation changed');
      });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(teardownAuthoritativePersistentBackingBeforeClose).toHaveBeenCalledWith(ds);
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.closeSession).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.session).toBe(oldSession);
      expect(ds.session.status).toBe('active');
      expect(ds.session.workingDir).toBe('/home/testuser/project-a');
      expect(ds.repoCardMessageId).toBe('om_repo_card');
      expect(vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join()).toContain('zmx generation changed');
    });

    it('mid-session chat switch preserves scope and the original message root', async () => {
      const originalRoot = 'om_original_chat_start';
      const ds = makeDaemonSession({
        pendingRepo: false,
        scope: 'chat',
        currentReplyTarget: {
          rootMessageId: 'om_old_reply_topic',
          turnId: 'turn-old',
          updatedAt: new Date().toISOString(),
        },
        replyThreadAliases: {
          om_old_reply_topic: {
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          },
        },
        streamCardReplyTargetKey: 'thread:om_old_reply_topic',
        session: makeSession({ scope: 'chat', rootMessageId: originalRoot }),
      });
      ds.session.currentReplyTarget = ds.currentReplyTarget;
      ds.session.replyThreadAliases = ds.replyThreadAliases;
      ds.session.streamCardReplyTargetKey = 'thread:om_old_reply_topic';
      const deps = makeDeps(ds);
      deps.activeSessions.clear();
      deps.activeSessions.set(sessionKey(CHAT_ID, LARK_APP_ID), ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
      ]);

      // A chat-scope command is routed with the oc_ chat anchor, not the
      // traceable om_ message root stored on Session.
      await handleCommand('/repo', CHAT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(sessionStore.createSession).toHaveBeenCalledWith(
        CHAT_ID, originalRoot, 'project-a (main)', 'group', 'chat',
      );
      expect(ds.session.scope).toBe('chat');
      expect(ds.session.rootMessageId).toBe(originalRoot);
      expect(ds.currentReplyTarget).toBeUndefined();
      expect(ds.replyThreadAliases).toBeUndefined();
      expect(ds.streamCardReplyTargetKey).toBeUndefined();
      expect(ds.session.currentReplyTarget).toBeUndefined();
      expect(ds.session.replyThreadAliases).toBeUndefined();
      expect(ds.session.streamCardReplyTargetKey).toBeUndefined();
      const persisted = vi.mocked(sessionStore.updateSession).mock.calls.find(
        ([s]) => s.sessionId === 'new-session-123',
      )?.[0];
      expect(persisted).toEqual(expect.objectContaining({
        scope: 'chat',
        rootMessageId: originalRoot,
      }));
    });

    it('mid-session switch should persist workingDir + larkAppId on the new session', async () => {
      // Regression for the daemon-restart crash: when /repo N switches repos
      // mid-session, the NEW session record (returned by createSession) must
      // carry workingDir so a later restore() doesn't fall back to the bot's
      // default cwd and break `claude --resume`.
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(ds.session.workingDir).toBe('/home/testuser/project-a');
      expect(ds.session.larkAppId).toBe(LARK_APP_ID);
      // updateSession must be called AFTER createSession with workingDir set.
      const updateCalls = vi.mocked(sessionStore.updateSession).mock.calls;
      const newSessionUpdate = updateCalls.find(
        ([s]) => s.sessionId === 'new-session-123',
      );
      expect(newSessionUpdate, 'updateSession was never called with the new session').toBeDefined();
      expect(newSessionUpdate![0].workingDir).toBe('/home/testuser/project-a');
    });

    it('mid-session switch empty-starts the replacement CLI and marks its first turn pending', async () => {
      // A repo switch closes the old session and boots a BRAND-NEW CLI with an
      // empty prompt. That fresh CLI has never seen the botmux opening context,
      // so the next real business message must be built as a new topic — same
      // invariant as the pending-repo empty start.
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
      ]);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(ds.hasHistory).toBe(false);
      expect(ds.session.initialUserTurnPending).toBe(true);
    });

    it('should show project list card when called without argument', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(scanMultipleProjects).mockReturnValue([
        { name: 'proj', path: '/home/testuser/proj', branch: 'main' },
      ]);

      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.any(String),
        'interactive',
        LARK_APP_ID,
        'msg_001',
      );
    });

    it('should omit worktrees from the project list when global repoPickerMode is repos', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(repoPickerScanOptions).mockReturnValue({ includeWorktrees: false });
      vi.mocked(scanMultipleProjects).mockReturnValue([
        { name: 'proj', path: '/home/testuser/proj', branch: 'main' },
      ]);

      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(scanMultipleProjects).toHaveBeenCalledWith(
        ['/home/testuser'],
        3,
        expect.objectContaining({
          includeWorktrees: false,
          onBudgetExceeded: expect.any(Function),
        }),
      );
    });

    // ── Scan-budget prompts (behavioural, not just wiring) ──────────────────
    // These fire the onBudgetExceeded callback the handler passes in and assert
    // the USER-VISIBLE consequence. A mutation that keeps the callback wired but
    // empties its body (`() => {}`) leaves scanBudgetHit false, so both prompts
    // vanish — and both of these tests must go red. (The `expect.any(Function)`
    // wiring check above cannot catch that; this is the rev1 false-green lesson.)
    it('budget hit with zero repos → warns to narrow the root and sends NO card', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // scan bailed at the budget before finding anything: empty list + callback.
      vi.mocked(scanMultipleProjects).mockImplementation(((_dirs: any, _depth: any, options: any) => {
        options?.onBudgetExceeded?.({ reason: 'dirs', dirsVisited: 4000, baseDir: '/home/testuser' });
        return [];
      }) as any);

      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      // t() returns the resolved zh string here, so assert on stable fragments
      // that are UNIQUE to each i18n key (avoids brittle full-text matching).
      // scan_budget_no_repos: "…已在到达上限后中止，未发现 git 仓库。"
      // no_git_repos:         "在 {dirs} 下未找到 git 仓库。"
      const replies = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string);
      // Must warn with the budget-specific message (mentions 中止 / 收窄根目录)…
      expect(replies.some(c => typeof c === 'string' && c.includes('到达上限后中止') && c.includes('未发现 git 仓库'))).toBe(true);
      // …and must NOT have fallen through to the plain "未找到 git 仓库" empty message.
      expect(replies.some(c => typeof c === 'string' && c.includes('下未找到 git 仓库'))).toBe(false);
      // …nor sent an interactive repo-selection card (there are no repos to pick).
      const sentCard = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls
        .some(c => c[2] === 'interactive');
      expect(sentCard).toBe(false);
    });

    it('budget hit with a partial list → sends the "incomplete" notice BEFORE the card', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // scan found one repo but tripped the budget: partial list + callback.
      vi.mocked(scanMultipleProjects).mockImplementation(((_dirs: any, _depth: any, options: any) => {
        options?.onBudgetExceeded?.({ reason: 'time', dirsVisited: 12, baseDir: '/home/testuser' });
        return [{ name: 'proj', path: '/home/testuser/proj', branch: 'main' }];
      }) as any);

      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      const calls = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls;
      // scan_budget_partial is the only message containing "列表可能不完整".
      const partialIdx = calls.findIndex(c => typeof c[1] === 'string' && (c[1] as string).includes('列表可能不完整'));
      const cardIdx = calls.findIndex(c => c[2] === 'interactive');
      // Both must happen…
      expect(partialIdx).toBeGreaterThanOrEqual(0);
      expect(cardIdx).toBeGreaterThanOrEqual(0);
      // …and the "may be incomplete" notice must precede the card.
      expect(partialIdx).toBeLessThan(cardIdx);
    });

    it('should resolve a first-level project name and switch repo (mid-session)', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(describeProjectDir).mockReturnValueOnce({ name: 'payments', branch: 'main' });
      const ds = makeDaemonSession({ pendingRepo: false, repoCardMessageId: 'om_card' });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo payments'), deps, LARK_APP_ID);

      expect(scanMultipleProjects).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe('/home/testuser/payments');
      expect(sessionStore.createSession).toHaveBeenCalledWith(
        CHAT_ID, ROOT_ID, 'payments (main)', 'group', undefined,
      );
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      // the pending repo-selection card must be withdrawn after resolving
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'om_card');
      expect(ds.repoCardMessageId).toBeUndefined();
    });

    it('`/repo <name>` as the first message empty-starts and marks the first turn pending', async () => {
      // The literal repro: a brand-new topic whose FIRST message is `/repo
      // homelab`. daemon.ts seeds pendingRepo + pendingPrompt:'' (the message IS
      // the command), so the CLI boots idle — and the user's next message must
      // still arrive as a new-topic opening.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(scanMultipleProjects).mockReturnValue([
        { name: 'homelab', path: '/home/testuser/homelab', branch: 'main' },
      ]);
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: '', worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo homelab'), deps, LARK_APP_ID);

      expect(ds.workingDir).toBe('/home/testuser/homelab');
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(buildNewTopicCliInput).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled(); // pending path, not a switch
      expect(ds.pendingRepo).toBe(false);
      expect(ds.session.initialUserTurnPending).toBe(true);
    });

    it('should reply path_not_found when the arg resolves to nothing', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(scanMultipleProjects).mockReturnValue([]);
      vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);

      try {
        await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo ./nope'), deps, LARK_APP_ID);
      } finally {
        // restore the shared statSync mock for subsequent tests
        vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
      }

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('找不到目录或项目');
      expect(forkWorker).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
    });
  });

  // ─── /repo wt — worktree creation entry ────────────────────────────────────

  describe('/repo wt', () => {
    const SCAN = [{ name: 'project-a', path: '/home/testuser/project-a', branch: 'main' }];
    const CREATION = { path: '/home/testuser/project-a-wt-1', branch: 'wt/1', baseRef: 'origin/main' };

    it('creates a worktree off the picked repo and commits the selection', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(createRepoWorktree).toHaveBeenCalledWith('/home/testuser/project-a', {
        branch: undefined,
        slug: 'test-session',
      });
      expect(ds.workingDir).toBe('/home/testuser/project-a-wt-1');
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(ds.worktreeCreating).toBe(false);
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('worktree 已创建');
    });

    it('keeps an explicit branch instead of auto semantic naming', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue({ ...CREATION, branch: 'feat/manual' });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1 feat/manual'), deps, LARK_APP_ID);

      expect(createRepoWorktree).toHaveBeenCalledWith('/home/testuser/project-a', {
        branch: 'feat/manual',
        slug: undefined,
      });
    });

    it('does not push when an invalid codex-app + riff pair resolves to the local default', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = LARK_APP_ID) => ({
        botName: 'Codex App',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'codex-app',
          backendType: 'riff',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(pushWorktreeBranch).not.toHaveBeenCalled();
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
    });

    it('pushes when a Riff CLI with a stale local backend resolves back to Riff', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = LARK_APP_ID) => ({
        botName: 'Riff',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'riff',
          backendType: 'pty',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(pushWorktreeBranch).toHaveBeenCalledOnce();
      expect(pushWorktreeBranch).toHaveBeenCalledWith(CREATION.path, CREATION.branch);
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
    });

    it('holds the in-flight lock through the created-notice reply (post-git window)', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);
      // Park the FIRST run inside its created-notice reply, then fire a second
      // /repo wt — it must bounce off the lock instead of starting another git.
      let releaseReply: (() => void) | undefined;
      vi.mocked(deps.sessionReply).mockImplementation(async (_root, text) => {
        if (typeof text === 'string' && text.includes('worktree 已创建：') && !releaseReply) {
          return new Promise<string>(res => { releaseReply = () => res('reply-msg-id'); });
        }
        return 'reply-msg-id';
      });

      const first = handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);
      await vi.waitFor(() => expect(releaseReply).toBeTruthy());
      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(createRepoWorktree).toHaveBeenCalledTimes(1);
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('已有一个 worktree 正在创建');

      releaseReply!();
      await first;
      expect(ds.worktreeCreating).toBe(false);
      expect(forkWorker).toHaveBeenCalledTimes(1);
    });

    it('re-checks the session generation after the created notice (during-reply window)', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);
      // Another selection swaps the session while the created notice is in flight.
      vi.mocked(deps.sessionReply).mockImplementation(async (_root, text) => {
        if (typeof text === 'string' && text.includes('worktree 已创建：') && ds.session.sessionId !== 'hijacked') {
          ds.session = { ...ds.session, sessionId: 'hijacked' };
        }
        return 'reply-msg-id';
      });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(forkWorker).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBeUndefined();
      expect(ds.worktreeCreating).toBe(false);
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('未自动切换');
    });

    it('blocks a plain numeric selection while a worktree is in flight', async () => {
      const ds = makeDaemonSession({ pendingRepo: false, worktreeCreating: true });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);

      expect(forkWorker).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBeUndefined();
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('已有一个 worktree 正在创建');
    });

    it('blocks the bare-/repo pending launch while a worktree is in flight', async () => {
      const ds = makeDaemonSession({ pendingRepo: true, worktreeCreating: true });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.pendingRepo).toBe(true); // not consumed
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('已有一个 worktree 正在创建');
    });

    it('aborts the pending fork when the session is /close\'d during prompt prep (last-line defence)', async () => {
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: 'hello world' });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);
      // /close lands inside forkPendingCli's prompt prep — deletes the
      // active-map entry but mutates neither sessionId nor pendingRepo; only
      // the pre-fork identity check can stop the fork.
      vi.mocked(getAvailableBots).mockImplementationOnce(async () => {
        deps.activeSessions.delete(sessionKey(ROOT_ID, LARK_APP_ID));
        return [];
      });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.worktreeCreating).toBe(false);
    });

    it('reports a commit failure as a switch failure — the worktree exists by then', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, SCAN as any);
      vi.mocked(createRepoWorktree).mockResolvedValue(CREATION);
      vi.mocked(forkWorker).mockImplementationOnce(() => { throw new Error('fork boom'); });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo wt 1'), deps, LARK_APP_ID);

      expect(ds.worktreeCreating).toBe(false);
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('自动切换失败');
      expect(replies).toContain('fork boom');
      expect(replies).not.toContain('创建 worktree 失败');
    });
  });

  // ─── bare /repo while pending (replaces the old /skip command) ────────────

  describe('/repo (bare) while pending', () => {
    it('retains the opening reservation and buffers when forkWorker fails before accept', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        initialStartPending: true,
        pendingPrompt: 'first prompt',
        pendingFollowUps: ['buffered follow-up'],
      });
      const deps = makeDeps(ds);
      vi.mocked(forkWorker).mockImplementationOnce(() => {
        expect(ds.pendingRepo).toBe(true);
        expect(ds.initialStartPending).toBe(true);
        expect(ds.pendingPrompt).toBe('first prompt');
        expect(ds.pendingFollowUps).toEqual(['buffered follow-up']);
        throw new Error('fork preaccept failed');
      });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(ds.pendingRepo).toBe(true);
      expect(ds.initialStartPending).toBe(true);
      expect(ds.pendingPrompt).toBe('first prompt');
      expect(ds.pendingFollowUps).toEqual(['buffered follow-up']);
      expect(deleteMessage).not.toHaveBeenCalled();
    });

    it('retries /repo after a synchronous first Riff fork failure stamps the backend', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        initialStartPending: true,
        pendingPrompt: 'first prompt',
        worker: null,
      });
      const deps = makeDeps(ds);
      vi.mocked(forkWorker)
        .mockImplementationOnce(() => {
          ds.session.backendType = 'riff';
          ds.initConfig = { backendType: 'riff' } as any;
          throw new Error('riff child fork failed');
        })
        .mockImplementationOnce(() => {});

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);
      expect(ds.pendingRepo).toBe(true);
      expect(ds.worker).toBeNull();
      expect(ds.session.backendType).toBe('riff');

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledTimes(2);
      expect(ds.pendingRepo).toBe(false);
      expect(vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join()).not.toContain('/close');
    });

    it('should boot the CLI idle (no prompt submitted) when launched via /repo itself', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '',
        pendingTurnId: 'om_repo_command_only',
        repoCardMessageId: 'om_card',
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      // No buffered message → spawn idle with an empty prompt so the user's NEXT
      // message becomes the first prompt (not an empty/boilerplate user_message).
      expect(forkWorker).toHaveBeenCalledWith(ds, '', { turnId: 'om_repo_command_only' });
      expect(buildNewTopicPrompt).not.toHaveBeenCalled();
      // …and that NEXT message must still get the full new-topic opening, so the
      // empty start has to leave a durable, persisted marker behind.
      expect(ds.session.initialUserTurnPending).toBe(true);
      expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      // Cleared pending state + withdrew the (already-sent) card.
      expect(ds.pendingRepo).toBe(false);
      expect(ds.pendingPrompt).toBeUndefined();
      expect(ds.pendingTurnId).toBeUndefined();
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'om_card');
      expect(ds.repoCardMessageId).toBeUndefined();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已直接开启会话');
      // Did NOT fall through to the card-display scan path.
      expect(scanMultipleProjects).not.toHaveBeenCalled();
    });

    it('bare /repo does not pin the default workingDir onto the session record', async () => {
      // Text twin of skip_repo: launch in default cwd without persisting it, so
      // sibling bots still get their own repo card instead of inheriting HOME.
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '',
        repoCardMessageId: 'om_card',
      });
      ds.workingDir = undefined;
      ds.session.workingDir = undefined;
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledTimes(1);
      expect(ds.workingDir).toBeUndefined();
      expect(ds.session.workingDir).toBeUndefined();
    });

    it('holds the pending claim through confirmation so a second /repo cannot mid-session-switch', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: 'hello world',
        pendingTurnId: 'om_first_turn',
        repoCardMessageId: 'om_card',
      });
      const deps = makeDeps(ds);
      deps.lastRepoScan.set(CHAT_ID, [
        { name: 'project-a', path: '/home/testuser/project-a', branch: 'main' },
        { name: 'project-b', path: '/home/testuser/project-b', branch: 'dev' },
      ]);
      let releaseReply: (() => void) | undefined;
      vi.mocked(deps.sessionReply).mockImplementation(async (_root, text) => {
        if (typeof text === 'string' && text.includes('已选择') && !releaseReply) {
          return new Promise<string>(res => { releaseReply = () => res('reply-msg-id'); });
        }
        return 'reply-msg-id';
      });

      const first = handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 1'), deps, LARK_APP_ID);
      await vi.waitFor(() => expect(forkWorker).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(releaseReply).toBeTruthy());
      expect(ds.pendingRepo).toBe(false);
      expect(ds.pendingRepoCommitInFlight).toBe(true);
      const sessionIdAfterFirstFork = ds.session.sessionId;

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo 2'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledTimes(1);
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      expect(ds.session.sessionId).toBe(sessionIdAfterFirstFork);
      expect(ds.workingDir).toBe('/home/testuser/project-a');
      const replies = vi.mocked(deps.sessionReply).mock.calls.map(c => c[1]).join();
      expect(replies).toContain('已有一个 worktree 正在创建');

      releaseReply!();
      await first;

      expect(forkWorker).toHaveBeenCalledTimes(1);
      expect(ds.pendingRepoCommitInFlight).toBe(false);
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'om_card');
      expect(ds.repoCardMessageId).toBeUndefined();
    });

    it('should still submit a buffered first message when bare /repo skips the card', async () => {
      // Normal flow: real first message → card shown → user types bare /repo to
      // skip. The buffered message must be delivered, not dropped.
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '帮我看看这个 bug',
        pendingTurnId: 'om_buffered_first',
        pendingChatContext: {
          chatId: CHAT_ID,
          name: '【Pippit】【BUG】测试群',
          description: 'https://example.test/issue/detail/123',
          mode: 'group',
          fetchStatus: 'ok',
        },
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      // The buffered message is wrapped (mock → `WRAPPED:<prompt>`) and forked.
      expect(buildNewTopicCliInput).toHaveBeenCalled();
      expect(ensureSessionWhiteboard).toHaveBeenCalledWith(ds);
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('帮我看看这个 bug');
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][11]).toMatchObject({
        whiteboardId: 'wb_test',
        chatContext: {
          chatId: CHAT_ID,
          description: 'https://example.test/issue/detail/123',
        },
      });
      expect(forkWorker).toHaveBeenCalledWith(
        ds,
        { content: 'WRAPPED:帮我看看这个 bug' },
        { turnId: 'om_buffered_first' },
      );
      expect(ds.pendingRepo).toBe(false);
      expect(ds.pendingTurnId).toBeUndefined();
      expect(ds.pendingChatContext).toBeUndefined();
      // The buffered message IS the first real user turn — nothing is pending.
      expect(ds.session.initialUserTurnPending).toBeUndefined();
    });

    it('uses the selected CLI snapshot when pendingRepo is submitted with /repo', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '帮我看看这个 bug',
        session: makeSession({
          cliId: undefined,
          cliLaunchSnapshot: {
            version: 1,
            state: 'pending',
            entryId: 'codex',
            cliId: 'codex',
            cliRuntime: null,
            cliPathOverride: null,
            wrapperCli: null,
            model: null,
            reasoningEffort: null,
            launchShell: null,
            startupCommands: [],
          },
        }),
      });

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), makeDeps(ds), LARK_APP_ID);

      expect(vi.mocked(buildNewTopicCliInput).mock.calls[0]?.[2]).toBe('codex');
    });

    it('submits chat context when bare /repo follows an empty group-join prompt', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '',
        pendingTurnId: 'om_group_join',
        pendingChatContext: {
          chatId: CHAT_ID,
          name: '【Pippit】【BUG】测试群',
          description: 'https://example.test/issue/detail/123',
          mode: 'group',
          fetchStatus: 'ok',
        },
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(buildNewTopicCliInput).toHaveBeenCalled();
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('');
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][11]).toMatchObject({
        chatContext: { chatId: CHAT_ID },
      });
      expect(forkWorker).toHaveBeenCalledWith(
        ds,
        { content: 'WRAPPED:' },
        { turnId: 'om_group_join' },
      );
      expect(ds.session.initialUserTurnPending).toBeUndefined();
    });

    it('forwards the pending substitute trigger and complete Codex App sidecar', async () => {
      mockCodexAppBot();
      const substituteTrigger = {
        target: { userId: 'u_configured' },
        observedMention: { name: 'Observed Person', userId: 'u_configured' },
        disclosure: 'prefix' as const,
      };
      const codexAppInput = {
        text: '帮我看看这个 bug',
        additionalContext: {
          botmux_substitute_policy: { kind: 'application' as const, value: 'fixed policy' },
          botmux_substitute_target: { kind: 'untrusted' as const, value: 'observed identity' },
        },
      };
      vi.mocked(buildNewTopicCliInput).mockReturnValueOnce({ content: 'WRAPPED:clean', codexAppInput });
      const ds = makeDaemonSession({
        larkAppId: CODEX_APP_ID,
        session: makeSession({ cliId: 'codex-app' }),
        pendingRepo: true,
        pendingPrompt: '帮我看看这个 bug',
        pendingSubstituteTrigger: substituteTrigger,
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, CODEX_APP_ID);

      expect(vi.mocked(buildNewTopicCliInput).mock.calls[0]![11]).toEqual(expect.objectContaining({
        substituteTrigger,
      }));
      expect(forkWorker).toHaveBeenCalledWith(ds, {
        content: 'WRAPPED:clean',
        codexAppInput,
      }, false);
      expect(ds.pendingSubstituteTrigger).toBeUndefined();
    });

    it('raw-input cold start boots idle and leaves pendingRawInput for prompt_ready', async () => {
      // /goal cold start → repo card → bare /repo skip: the raw command must
      // NOT be wrapped into a prompt; it stays on ds.pendingRawInput and the
      // prompt_ready handler delivers it literally.
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '',
        pendingTurnId: 'om_goal_first',
        pendingRawInput: '/goal 发布 onboarding',
        pendingRawTurnId: 'om_goal_first',
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(buildNewTopicPrompt).not.toHaveBeenCalled();
      expect(ds.pendingRawInput).toBe('/goal 发布 onboarding');
      expect(ds.pendingRawTurnId).toBe('om_goal_first');
      expect(ds.pendingFollowUpInput).toBeUndefined();
      expect(ds.pendingTurnId).toBeUndefined();
      // Raw passthrough owns the first turn (delivered literally on prompt_ready),
      // so this is NOT an "empty start awaiting its first user turn".
      expect(ds.session.initialUserTurnPending).toBeUndefined();
    });

    it('raw-input cold start wraps follow-ups buffered during repo wait into pendingFollowUpInput', async () => {
      // /goal cold start → repo card pending → user keeps typing (buffered in
      // pendingFollowUps) → bare /repo skips the card. The buffered messages
      // must be wrapped and stashed for delivery after the raw input — not
      // silently dropped.
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: '',
        pendingRawInput: '/goal 发布 onboarding',
        pendingFollowUps: ['对了顺手看下 CI', '别忘了更新 changelog'],
      });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      // Wrapped via buildNewTopicCliInput (mock → `WRAPPED:<pendingPrompt>`),
      // follow-ups passed through as the 8th arg.
      expect(buildNewTopicCliInput).toHaveBeenCalled();
      expect(ensureSessionWhiteboard).toHaveBeenCalledWith(ds);
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][7])
        .toEqual(['对了顺手看下 CI', '别忘了更新 changelog']);
      expect((buildNewTopicCliInput as ReturnType<typeof vi.fn>).mock.calls[0][11]).toMatchObject({ whiteboardId: 'wb_test' });
      expect(ds.pendingFollowUpInput).toEqual({
        userPrompt: '对了顺手看下 CI\n\n别忘了更新 changelog',
        cliInput: 'WRAPPED:',
        codexAppInputGateFrozen: true,
      });
      expect(ds.pendingRawInput).toBe('/goal 发布 onboarding');
      expect(ds.pendingFollowUps).toBeUndefined();
    });

    it('should report an invalid workingDir and not spawn (keeps pending for recovery)', async () => {
      // forkWorker doesn't validate cwd, so a dead workingDir must be caught
      // before launch. Keep pendingRepo so the user can `/repo <valid-path>`.
      vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: '', workingDir: '/gone' });
      const deps = makeDeps(ds);

      try {
        await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);
      } finally {
        vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
      }

      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.pendingRepo).toBe(true); // pending kept — recoverable
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('配置的工作目录不存在');
    });
    // The non-pending (mid-session) bare `/repo` → card path is covered by
    // "should show project list card when called without argument" above.
  });

  // ─── /schedule ──────────────────────────────────────────────────────────

  describe('/schedule', () => {
    it('should list tasks when called with no args (empty list)', async () => {
      vi.mocked(scheduleStore.listTasks).mockReturnValue([]);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule'), deps, LARK_APP_ID);

      expect(scheduleStore.listTasks).toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('暂无定时任务');
    });

    it('should list tasks with "list" argument', async () => {
      vi.mocked(scheduleStore.listTasks).mockReturnValue([
        {
          id: 'task-1',
          name: 'Daily news',
          schedule: '50 17 * * *',
          parsed: { kind: 'cron', expr: '50 17 * * *', display: '每日 17:50' },
          prompt: 'Check AI news',
          workingDir: '~/projects',
          chatId: CHAT_ID,
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T17:50:00+08:00'));

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule list'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('定时任务列表');
      expect(replyContent).toContain('task-1');
      expect(replyContent).toContain('Daily news');
    });

    it('should remove a task by id', async () => {
      vi.mocked(scheduler.removeTask).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule remove task-1'), deps, LARK_APP_ID);

      expect(scheduler.removeTask).toHaveBeenCalledWith('task-1');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已删除定时任务 task-1');
    });

    it('should reply not found when removing nonexistent task', async () => {
      vi.mocked(scheduler.removeTask).mockReturnValue(false);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule remove nope'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('未找到任务 nope');
    });

    it('should enable a task', async () => {
      vi.mocked(scheduler.enableTask).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule enable task-1'), deps, LARK_APP_ID);

      expect(scheduler.enableTask).toHaveBeenCalledWith('task-1');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已启用定时任务 task-1');
    });

    it('should disable a task', async () => {
      vi.mocked(scheduler.disableTask).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule disable task-1'), deps, LARK_APP_ID);

      expect(scheduler.disableTask).toHaveBeenCalledWith('task-1');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已禁用定时任务 task-1');
    });

    it('should run a task immediately', async () => {
      vi.mocked(scheduler.runTaskNow).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule run task-1'), deps, LARK_APP_ID);

      expect(scheduler.runTaskNow).toHaveBeenCalledWith('task-1');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已触发定时任务 task-1 立即执行');
    });

    it('should show usage help when schedule cannot be parsed', async () => {
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue(null);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule blah blah'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('无法解析定时任务');
    });

    it('should inherit defaultWorkingDir (not legacy workingDir) when creating a schedule', async () => {
      // Bot only configures defaultWorkingDir; legacy workingDir is unset.
      // The schedule task must pick up defaultWorkingDir, NOT fall back to ~.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultWorkingDir: '~/repo/oncall',
          // Intentionally NO workingDir field
        },
      })) as any);
      vi.mocked(findOncallChat).mockReturnValue(undefined);
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '10 10 * * *', display: '每日 10:10' },
        prompt: '新话题 生成值班日报',
        name: '新话题 生成值班日报',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockReturnValue({
        deliver: 'new-topic',
        executionPosition: 'new-topic',
        silent: false,
        prompt: '生成值班日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-new' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:10:00+08:00'));

      const ds = makeDaemonSession({ workingDir: undefined });
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每个工作日10:10 新话题 生成值班日报'), deps, LARK_APP_ID);

      expect(scheduler.addTask).toHaveBeenCalledTimes(1);
      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // workingDir must be the bot's defaultWorkingDir, NOT ~
      expect(callArgs.workingDir).toBe('~/repo/oncall');
      expect(callArgs.workingDir).not.toBe('~');
      expect(callArgs.executionPosition).toBe('new-topic');
      expect(callArgs.scope).toBe('chat');
    });

    it('should inherit defaultOncall.workingDir when Oncall mode is enabled', async () => {
      // Bot configures defaultOncall.workingDir with enabled=true; no
      // defaultWorkingDir, no legacy workingDir. Schedule must pick it up.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultOncall: { enabled: true, workingDir: '~/codebase/dcar_bpm/roles/oncall' },
        },
      })) as any);
      vi.mocked(findOncallChat).mockReturnValue(undefined);
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '10 10 * * *', display: '每日 10:10' },
        prompt: '新话题 生成值班日报',
        name: '新话题 生成值班日报',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockReturnValue({
        deliver: 'new-topic',
        executionPosition: 'new-topic',
        silent: false,
        prompt: '生成值班日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-oncall' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:10:00+08:00'));

      const ds = makeDaemonSession({ workingDir: undefined });
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每个工作日10:10 新话题 生成值班日报'), deps, LARK_APP_ID);

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.workingDir).toBe('~/codebase/dcar_bpm/roles/oncall');
      expect(callArgs.workingDir).not.toBe('~');
    });

    it('should prefer ds.workingDir over bot defaults when creating a schedule', async () => {
      // Session already has a pinned workingDir (e.g. via /cd); it must win
      // over the bot's defaultWorkingDir.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultWorkingDir: '~/repo/oncall',
        },
      })) as any);
      vi.mocked(findOncallChat).mockReturnValue(undefined);
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 10 * * *', display: '每日 10:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.extractDeliveryMode).mockReturnValue({
        deliver: 'origin',
        prompt: '生成日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-ds' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:00:00+08:00'));

      const ds = makeDaemonSession({ workingDir: '/home/user/custom-dir' });
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日10:00 生成日报'), deps, LARK_APP_ID);

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.workingDir).toBe('/home/user/custom-dir');
    });

    it('should read oncall binding (read-only) without triggering auto-bind side effect', async () => {
      // An oncall binding exists for this chat — it must be used as the
      // workingDir. We verify findOncallChat is consulted (read-only) and
      // the bot's defaultWorkingDir is NOT consulted.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultWorkingDir: '~/repo/oncall',
        },
      })) as any);
      vi.mocked(findOncallChat).mockReturnValue({
        chatId: CHAT_ID,
        workingDir: '~/oncall/bound-dir',
      });
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 10 * * *', display: '每日 10:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.extractDeliveryMode).mockReturnValue({
        deliver: 'origin',
        prompt: '生成日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-oncall-bind' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:00:00+08:00'));

      const ds = makeDaemonSession({ workingDir: undefined });
      const deps = makeDeps(ds);

      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日10:00 生成日报'), deps, LARK_APP_ID);

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Oncall binding wins over bot defaults.
      expect(callArgs.workingDir).toBe('~/oncall/bound-dir');
      // findOncallChat must be called with the bot's appId and the chatId.
      expect(findOncallChat).toHaveBeenCalledWith('app-1', CHAT_ID);
    });

    it('should fall through when defaultWorkingDir points at a missing directory', async () => {
      // defaultWorkingDir is configured but the dir no longer exists on disk.
      // The stale path must NOT be baked into the task (schedules.json is not
      // editable afterwards) — resolution falls through to the legacy
      // workingDir, which does exist.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultWorkingDir: '~/gone-dir',
          workingDir: '~/live-dir',
        },
      })) as any);
      vi.mocked(existsSync).mockImplementation((p: any) => !String(p).includes('gone-dir'));
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 10 * * *', display: '每日 10:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-stale' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:00:00+08:00'));

      const ds = makeDaemonSession({ workingDir: undefined });
      const deps = makeDeps(ds);

      try {
        await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日10:00 生成日报'), deps, LARK_APP_ID);
      } finally {
        // restore the shared existsSync mock for subsequent tests
        vi.mocked(existsSync).mockReturnValue(true);
      }

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.workingDir).toBe('~/live-dir');
    });

    it('should fall through when the pinned session workingDir is stale', async () => {
      // ds.workingDir can be stale too: restoreActiveSessions re-registers
      // persisted sessions (worker:null) and idle suspend keeps ds around —
      // no live process guarantees the dir still exists. A stale pinned dir
      // must fall through to the bot's (valid) defaultWorkingDir.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
        botName: 'Claude',
        config: {
          larkAppId: id,
          larkAppSecret: 'secret-1',
          cliId: 'claude-code' as const,
          defaultWorkingDir: '~/repo/oncall',
        },
      })) as any);
      vi.mocked(existsSync).mockImplementation((p: any) => !String(p).includes('gone-dir'));
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 10 * * *', display: '每日 10:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-stale-ds' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:00:00+08:00'));

      const ds = makeDaemonSession({ workingDir: '~/gone-dir' });
      const deps = makeDeps(ds);

      try {
        await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日10:00 生成日报'), deps, LARK_APP_ID);
      } finally {
        // restore the shared existsSync mock for subsequent tests
        vi.mocked(existsSync).mockReturnValue(true);
      }

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.workingDir).toBe('~/repo/oncall');
    });

    it('静默 keyword: passes silent:true to addTask and echoes the silent note', async () => {
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'interval', minutes: 30, display: '每 30 分钟' },
        prompt: '静默 检查服务，挂了才报警',
        name: '静默 检查服务，挂了才报警',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockReturnValue({
        deliver: 'origin',
        silent: true,
        prompt: '检查服务，挂了才报警',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-silent', prompt: '检查服务，挂了才报警' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-27T10:30:00+08:00'));

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每30分钟 静默 检查服务，挂了才报警'), deps, LARK_APP_ID);

      expect(scheduler.addTask).toHaveBeenCalledTimes(1);
      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.silent).toBe(true);
      expect(callArgs.prompt).toBe('检查服务，挂了才报警');
      // stripped-modifier prompt becomes the task name (mirrors 新话题 behaviour)
      expect(callArgs.name).toBe('检查服务，挂了才报警');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('静默模式');
    });

    it('accepts 静默 + 新话题 and persists the lazy fresh-topic position', async () => {
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '每日 09:00' },
        prompt: '静默 新话题 生成日报',
        name: '静默 新话题 生成日报',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockReturnValue({
        deliver: 'new-topic',
        executionPosition: 'new-topic',
        silent: true,
        prompt: '生成日报',
      });
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-legacy-new-topic', prompt: '生成日报' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-28T09:00:00+08:00'));

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日9:00 静默 新话题 生成日报'), deps, LARK_APP_ID);

      expect(scheduler.addTask).toHaveBeenCalledTimes(1);
      expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({
        prompt: '生成日报',
        scope: 'chat',
        executionPosition: 'new-topic',
        silent: true,
      }));
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('新话题');
      expect(replyContent).toContain('静默模式');
    });

    it('defaults to group top-level when created from a topic/adopt session (no position modifier)', async () => {
      // A schedule born inside a topic (including an adopted one) must not pin
      // its results to that topic. Without an explicit modifier the default is
      // top-level and the root bookmark is dropped.
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '每日 09:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      // Default extractScheduleModifiers mock returns no executionPosition.
      vi.mocked(scheduler.extractScheduleModifiers).mockImplementation((prompt: string) => ({
        deliver: 'origin' as const,
        silent: false,
        prompt,
      }));
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-topic-default' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-28T09:00:00+08:00'));

      // Simulate a topic-scope (adopt) session: scope is 'thread'.
      const ds = makeDaemonSession({ scope: 'thread' });
      const deps = makeDeps(ds);
      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日9:00 生成日报'), deps, LARK_APP_ID);

      expect(scheduler.addTask).toHaveBeenCalledTimes(1);
      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.executionPosition).toBe('top-level');
      expect(callArgs.scope).toBe('chat');
      // The adopt topic root must not be retained as a bookmark.
      expect(callArgs.rootMessageId).toBeUndefined();
    });

    it('stamps the human creator identity (open_id + tenant-stable union_id)', async () => {
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '每日 09:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockImplementation((prompt: string) => ({
        deliver: 'origin' as const,
        silent: false,
        prompt,
      }));
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-human' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-28T09:00:00+08:00'));

      const deps = makeDeps(makeDaemonSession());
      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日9:00 生成日报', {
        senderId: 'ou_creator',
        senderUnionId: 'on_creator',
        senderType: 'user',
      }), deps, LARK_APP_ID);

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.ownerOpenId).toBe('ou_creator');
      expect(callArgs.ownerUnionId).toBe('on_creator');
    });

    it('withholds the union_id when the creating sender is not a human', async () => {
      // A bot-created task must not be able to run as the bot: without a
      // union_id the scheduled turn carries no identity at all, so
      // identity-bound tools fail closed instead of borrowing the bot's access.
      vi.mocked(scheduler.parseNaturalSchedule).mockReturnValue({
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '每日 09:00' },
        prompt: '生成日报',
        name: '生成日报',
      });
      vi.mocked(scheduler.extractScheduleModifiers).mockImplementation((prompt: string) => ({
        deliver: 'origin' as const,
        silent: false,
        prompt,
      }));
      vi.mocked(scheduler.addTask).mockReturnValue({ id: 'task-bot' } as any);
      vi.mocked(scheduler.getNextRun).mockReturnValue(new Date('2026-03-28T09:00:00+08:00'));

      const deps = makeDeps(makeDaemonSession());
      await handleCommand('/schedule', ROOT_ID, makeLarkMessage('/schedule 每日9:00 生成日报', {
        senderId: 'ou_bot_sender',
        senderUnionId: 'on_bot_sender',
        senderType: 'app',
      }), deps, LARK_APP_ID);

      const callArgs = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.ownerOpenId).toBe('ou_bot_sender');
      expect(callArgs.ownerUnionId).toBeUndefined();
    });
  });

  // ─── /login ─────────────────────────────────────────────────────────────

  describe('/login', () => {
    it('should return OAuth URL', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/login', ROOT_ID, makeLarkMessage('/login'), deps, LARK_APP_ID);

      // brand 第三参：测试 bot 未配 brand → normalizeBrand → 'feishu'
      expect(generateAuthUrl).toHaveBeenCalledWith('app-1', 'secret-1', 'feishu');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('飞书用户授权');
      expect(replyContent).toContain('https://open.feishu.cn/auth/v1/test');
    });

    it('should show token status with "status" subcommand', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/login', ROOT_ID, makeLarkMessage('/login status'), deps, LARK_APP_ID);

      expect(getTokenStatus).toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('User token: active');
    });
  });

  // ─── /adopt ─────────────────────────────────────────────────────────────

  describe('/adopt', () => {
    function makeLiveRiffSession(): DaemonSession {
      return makeDaemonSession({
        workingDir: '/remote/riff',
        worker: { killed: false } as any,
        initConfig: { backendType: 'riff' } as any,
        session: makeSession({
          cliId: 'riff',
          backendType: 'riff',
          riffParentTaskId: 'task-live',
          workingDir: '/remote/riff',
        }),
      });
    }

    it('refuses adopt over a live Riff generation before mutating ownership', async () => {
      const ds = makeLiveRiffSession();
      const deps = makeDeps(ds);
      const target = {
        source: 'tmux' as const,
        tmuxTarget: '0:1.0',
        cliPid: 4242,
        sessionId: 'host-cli',
        cliId: 'claude-code' as const,
        cwd: '/local/adopt',
        paneCols: 80,
        paneRows: 24,
      };

      await startAdoptSession(target, ds, deps, LARK_APP_ID);

      expect(validateAdoptTarget).not.toHaveBeenCalled();
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      expect(forkAdoptWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe('/remote/riff');
      expect(ds.session.workingDir).toBe('/remote/riff');
      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.session.riffParentTaskId).toBe('task-live');
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('/close'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('refuses resume import over a live Riff generation before mutating lineage', async () => {
      const ds = makeLiveRiffSession();
      const deps = makeDeps(ds);

      await startResumeImportSession({
        cliSessionId: 'native-resume-id', cwd: '/local/resume', title: 'Imported task', lastActivityAt: 1,
      }, ds, deps, LARK_APP_ID);

      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe('/remote/riff');
      expect(ds.session.workingDir).toBe('/remote/riff');
      expect(ds.session.cliSessionId).toBeUndefined();
      expect(ds.session.riffParentTaskId).toBe('task-live');
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('/close'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('refuses a Codex App thread takeover over a live Riff generation', async () => {
      const ds = makeLiveRiffSession();
      const deps = makeDeps(ds);

      await startCodexAppThreadSession({
        threadId: 'codex-thread-id',
        name: 'Imported Codex thread',
        preview: 'preview',
        cwd: '/local/codex-app',
      }, ds, deps, LARK_APP_ID);

      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect(ds.workingDir).toBe('/remote/riff');
      expect(ds.session.workingDir).toBe('/remote/riff');
      expect(ds.session.cliId).toBe('riff');
      expect(ds.session.cliSessionId).toBeUndefined();
      expect(ds.session.riffParentTaskId).toBe('task-live');
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('/close'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('refuses adopt while the session is still on the pendingRepo gate and posts a close-session card', async () => {
      const ds = makeDaemonSession({
        pendingRepo: true,
        pendingPrompt: 'buffered while picking repo',
        pendingFollowUps: ['second buffered line'],
        repoCardMessageId: 'om_repo_card',
      });
      const deps = makeDeps(ds);
      const target = {
        source: 'tmux' as const,
        tmuxTarget: '0:1.0',
        cliPid: 4242,
        sessionId: 'host-cli',
        cliId: 'claude-code' as const,
        cwd: '/repo',
        paneCols: 80,
        paneRows: 24,
      };

      await startAdoptSession(target, ds, deps, LARK_APP_ID);

      // Refused: no takeover, no state mutation — the pending gate is untouched
      // so the session can still finish via /repo (or the card's close button).
      expect(forkAdoptWorker).not.toHaveBeenCalled();
      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.pendingRepo).toBe(true);
      expect(ds.pendingPrompt).toBe('buffered while picking repo');
      expect(ds.pendingFollowUps).toEqual(['second buffered line']);

      // Posted an interactive card carrying a close-session button bound to this session.
      const replyArgs = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(replyArgs[2]).toBe('interactive');
      const card = JSON.parse(replyArgs[1] as string);
      const buttons = card.elements.flatMap((el: any) => el.actions ?? []);
      const closeBtn = buttons.find((b: any) => b.value?.action === 'close');
      expect(closeBtn).toBeDefined();
      expect(closeBtn.value.session_id).toBe(ds.session.sessionId);
    });

    it('revalidates a selected custom Codex process with the same executable identity', async () => {
      vi.mocked(getBot).mockImplementation((() => ({
        botName: 'Vendor Codex',
        config: {
          larkAppId: LARK_APP_ID,
          larkAppSecret: 'secret-1',
          cliId: 'codex' as const,
          cliRuntime: {
            id: 'vendor-codex',
            displayName: 'Vendor Codex',
            executable: '/opt/vendorCodex',
            update: { provider: 'none' as const },
          },
          cliPathOverride: '/opt/vendorCodex',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      const ds = makeDaemonSession({ session: makeSession({ cliId: 'codex' }) });
      const deps = makeDeps(ds);
      const target = {
        source: 'tmux' as const,
        tmuxTarget: 'fork:0.0',
        cliPid: 4242,
        cliId: 'codex' as const,
        cwd: '/repo',
        paneCols: 80,
        paneRows: 24,
      };

      try {
        await startAdoptSession(target, ds, deps, LARK_APP_ID);

        expect(validateAdoptTarget).toHaveBeenCalledWith(target, '/opt/vendorCodex');
        expect(forkAdoptWorker).toHaveBeenCalledWith(ds);
        const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
        expect(reply).toContain('Vendor Codex');
      } finally {
        vi.mocked(getBot).mockImplementation(defaultGetBot as any);
      }
    });

    it('uses the frozen configured runtime name in resume-import feedback', async () => {
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex', agentFrozen: true,
          cliRuntime: {
            id: 'vendor-codex', displayName: 'Vendor Codex', executable: 'vendor-codex',
            source: 'configured', update: { provider: 'none' },
          },
        }),
      });
      const deps = makeDeps(ds);

      await startResumeImportSession({
        cliSessionId: 'native-resume-id', cwd: '/repo', title: 'Imported task', lastActivityAt: 1,
      }, ds, deps, LARK_APP_ID);

      expect(forkWorker).toHaveBeenCalledWith(ds, '', true);
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
      expect(reply).toContain('Vendor Codex');
    });

    it('should refuse re-adopt and prompt 断开 when ds.adoptedFrom is already set', async () => {
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: 'mysession:0.0',
          originalCliPid: 12345,
          cliId: 'coco',
          cwd: '/home/testuser/fanxuehui.fe',
          paneCols: 200,
          paneRows: 50,
        },
        session: {
          ...makeSession(),
          title: 'Adopt: fanxuehui.fe',
          adoptedFrom: {
            tmuxTarget: 'mysession:0.0',
            originalCliPid: 12345,
            cliId: 'coco',
            cwd: '/home/testuser/fanxuehui.fe',
            paneCols: 200,
            paneRows: 50,
          },
        },
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, LARK_APP_ID);

      // Must NOT scan tmux when we already know the answer ("you're already adopted")
      expect(discoverAdoptableSessions).not.toHaveBeenCalled();

      const replyArgs = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      const replyContent = replyArgs[1] as string;
      // Should mention current adoption AND tell user how to release it.
      // Critically: must NOT show the misleading "未发现可接入" message.
      expect(replyContent).not.toContain('未发现可接入');
      expect(replyContent).toContain('已接入');
      expect(replyContent).toContain('断开');
      // Surface the pane target so the user knows which session they're on
      expect(replyContent).toContain('mysession:0.0');
    });

    it('should also refuse direct-target form (/adopt <pane>) when already adopted', async () => {
      // Even if the user passes an explicit pane, the bridge worker would
      // clobber the current TmuxPipeBackend without user confirmation. Force
      // the user to 断开 first so they make the swap intentionally.
      const ds = makeDaemonSession({
        adoptedFrom: {
          tmuxTarget: 'mysession:0.0',
          originalCliPid: 12345,
          cliId: 'coco',
          cwd: '/home/testuser/fanxuehui.fe',
          paneCols: 200,
          paneRows: 50,
        },
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt 0:2.0'), deps, LARK_APP_ID);

      expect(discoverAdoptableSessions).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已接入');
      expect(replyContent).toContain('断开');
    });

    it('should still show "未发现可接入" when no adoption and tmux scan returns empty', async () => {
      // Sanity: existing behavior preserved for the legitimate "nothing to adopt" case.
      vi.mocked(discoverAdoptableSessions).mockReturnValueOnce([]);
      const ds = makeDaemonSession(); // no adoptedFrom
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, LARK_APP_ID);

      expect(discoverAdoptableSessions).toHaveBeenCalledWith('claude-code');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('未发现可接入');
    });

    it('resumes an exact closed Botmux session id instead of treating it as a tmux pane', async () => {
      const scratch = makeDaemonSession({
        hasHistory: false,
        session: makeSession({ sessionId: 'scratch-session', cliId: undefined }),
      });
      const restored = makeDaemonSession({
        session: makeSession({
          sessionId: 'ad24e30d-25fa-4450-8e84-9e108cb74c92',
          status: 'active',
          cliId: 'claude-code',
          cliSessionId: 'ad24e30d-25fa-4450-8e84-9e108cb74c92',
        }),
      });
      const closed = {
        ...restored.session,
        status: 'closed' as const,
      };
      vi.mocked(sessionStore.getOwnedSession).mockReturnValueOnce(closed);
      vi.mocked(resumeSession).mockResolvedValueOnce({ ok: true, ds: restored });
      const deps = makeDeps(scratch);

      await handleCommand(
        '/adopt',
        ROOT_ID,
        makeLarkMessage('/adopt ad24e30d-25fa-4450-8e84-9e108cb74c92'),
        deps,
        LARK_APP_ID,
      );

      expect(resumeSession).toHaveBeenCalledWith(closed.sessionId, deps.activeSessions);
      expect(discoverAdoptableSessions).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('会话已恢复');
      expect(reply).not.toContain('tmux pane');
    });

    it('resolves a closed Botmux session by its CLI-native id without duplicating ownership', async () => {
      const scratch = makeDaemonSession({
        hasHistory: false,
        session: makeSession({ sessionId: 'scratch-session', cliId: undefined }),
      });
      const closed = makeSession({
        sessionId: 'botmux-session-id',
        status: 'closed',
        cliId: 'codex',
        cliSessionId: 'native-thread-id',
      });
      const restored = makeDaemonSession({ session: { ...closed, status: 'active' } });
      vi.mocked(sessionStore.listSessions).mockReturnValueOnce([closed]);
      vi.mocked(resumeSession).mockResolvedValueOnce({ ok: true, ds: restored });
      const deps = makeDeps(scratch);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt native-thread-id'), deps, LARK_APP_ID);

      expect(resumeSession).toHaveBeenCalledWith('botmux-session-id', deps.activeSessions);
      expect(forkWorker).not.toHaveBeenCalled();
      expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toContain('tmux pane');
    });

    it('does not move a managed session from another topic through /adopt', async () => {
      const scratch = makeDaemonSession({
        hasHistory: false,
        session: makeSession({ sessionId: 'scratch-session', cliId: undefined }),
      });
      const closed = makeSession({
        sessionId: 'other-topic-session',
        status: 'closed',
        rootMessageId: 'om_other_topic',
        cliSessionId: 'native-other-topic',
      });
      vi.mocked(sessionStore.getOwnedSession).mockReturnValueOnce(closed);
      const deps = makeDeps(scratch);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt other-topic-session'), deps, LARK_APP_ID);

      expect(resumeSession).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('另一个话题');
      expect(reply).toContain('botmux resume other-topic-session');
      expect(reply).not.toContain('tmux pane');
    });

    it('does not resume a materialized scheduled run from the containing chat anchor', async () => {
      const scratch = makeDaemonSession({
        scope: 'chat',
        chatId: CHAT_ID,
        hasHistory: false,
        session: makeSession({
          sessionId: 'scratch-session',
          scope: 'chat',
          chatId: CHAT_ID,
          cliId: undefined,
        }),
      });
      const closed = makeSession({
        sessionId: 'materialized-schedule-run',
        status: 'closed',
        scope: 'chat',
        chatId: CHAT_ID,
        rootMessageId: 'om_materialized_root',
        deferredScheduleRun: {
          taskId: 'task-1',
          turnId: 'schedule:task-1:run-1',
          routingAnchor: 'schedule-run:task-1:run-1',
          createdAt: '2026-08-27T00:00:00.000Z',
        },
      });
      vi.mocked(sessionStore.getOwnedSession).mockReturnValueOnce(closed);
      const deps = makeDeps(scratch);

      await handleCommand(
        '/adopt',
        ROOT_ID,
        makeLarkMessage('/adopt materialized-schedule-run'),
        deps,
        LARK_APP_ID,
      );

      expect(resumeSession).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('另一个话题');
    });

    it('says when an exact managed session will resume as a fresh CLI session', async () => {
      const scratch = makeDaemonSession({
        hasHistory: false,
        session: makeSession({ sessionId: 'scratch-session', cliId: undefined }),
      });
      const closed = makeSession({
        sessionId: 'cursor-without-native-id',
        status: 'closed',
        cliId: 'cursor',
        cliSessionId: undefined,
      });
      const restored = makeDaemonSession({ session: { ...closed, status: 'active' } });
      vi.mocked(sessionStore.getOwnedSession).mockReturnValueOnce(closed);
      vi.mocked(resumeSession).mockResolvedValueOnce({ ok: true, ds: restored });
      const deps = makeDeps(scratch);

      await handleCommand(
        '/adopt',
        ROOT_ID,
        makeLarkMessage('/adopt cursor-without-native-id'),
        deps,
        LARK_APP_ID,
      );

      expect(resumeSession).toHaveBeenCalledWith(closed.sessionId, deps.activeSessions);
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('新起干净会话');
      expect(reply).toContain('旧上下文不会带回');
    });

    it('passes the bot current custom Codex executable into live adopt discovery', async () => {
      vi.mocked(getBot).mockImplementation((() => ({
        botName: 'Vendor Codex',
        config: {
          larkAppId: LARK_APP_ID,
          larkAppSecret: 'secret-1',
          cliId: 'codex' as const,
          cliRuntime: {
            id: 'vendor-codex',
            displayName: 'Vendor Codex',
            executable: '/opt/Vendor Codex/vendorCodex',
            update: { provider: 'none' as const },
          },
          cliPathOverride: '/opt/Vendor Codex/vendorCodex',
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      vi.mocked(discoverAdoptableSessions).mockReturnValueOnce([]);
      const ds = makeDaemonSession({ session: makeSession({ cliId: 'codex' }) });
      const deps = makeDeps(ds);

      try {
        await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, LARK_APP_ID);

        expect(discoverAdoptableSessions).toHaveBeenCalledWith(
          'codex',
          '/opt/Vendor Codex/vendorCodex',
        );
      } finally {
        vi.mocked(getBot).mockImplementation(defaultGetBot as any);
      }
    });

    it('does not relabel a frozen official adopt picker after a runtime hot switch', async () => {
      vi.mocked(getBot).mockImplementation((() => ({
        botName: 'Vendor Codex',
        config: {
          larkAppId: LARK_APP_ID,
          larkAppSecret: 'secret-1',
          cliId: 'codex' as const,
          cliRuntime: {
            id: 'vendor-codex', displayName: 'Vendor Codex', executable: 'vendor-codex',
            update: { provider: 'none' as const },
          },
          workingDir: '~/projects',
          workingDirs: ['~/projects'],
        },
      })) as any);
      vi.mocked(discoverAdoptableSessions).mockReturnValueOnce([{
        tmuxTarget: '0:1.0', panePid: 1000, cliPid: 1001, cliId: 'codex',
        cwd: '/repo', paneCols: 80, paneRows: 24,
      }]);
      const ds = makeDaemonSession({
        session: makeSession({
          cliId: 'codex', agentFrozen: true,
          cliRuntime: {
            id: 'codex', displayName: 'Codex', executable: 'codex',
            source: 'official', update: { provider: 'internal' },
          },
        }),
      });

      try {
        await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), makeDeps(ds), LARK_APP_ID);
        const pickerArgs = vi.mocked(buildAdoptSelectCard).mock.calls.at(-1)!;
        expect(pickerArgs[8]).toBeUndefined();
      } finally {
        vi.mocked(getBot).mockImplementation(defaultGetBot as any);
      }
    });

    it('should show the picker card when not adopted and discovery returns sessions', async () => {
      vi.mocked(discoverAdoptableSessions).mockReturnValueOnce([
        {
          tmuxTarget: '0:1.0',
          panePid: 1000,
          cliPid: 1001,
          cliId: 'claude-code',
          cwd: '/home/testuser/projectA',
          paneCols: 200,
          paneRows: 50,
        },
      ]);
      const ds = makeDaemonSession(); // no adoptedFrom
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, LARK_APP_ID);

      const replyArgs = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(replyArgs[2]).toBe('interactive');
      expect(replyArgs[1] as string).toContain('adopt-select');
    });

    it('should not adopt a managed Herdr agent that already has an active owner', async () => {
      vi.mocked(discoverAdoptableSessions).mockReturnValue([
        {
          source: 'herdr',
          herdrSessionName: 'botmux',
          herdrTarget: 'w1:p1',
          herdrPaneId: 'w1:p1',
          herdrAgentName: 'botmux-owned',
          cliId: 'claude-code',
          cwd: '/home/testuser/projectA',
          paneCols: 200,
          paneRows: 50,
        },
      ]);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const owner = makeDaemonSession({
        session: makeSession({
          sessionId: 'owned-session',
          status: 'active',
          persistentBackendTarget: {
            backendType: 'herdr',
            sessionName: 'botmux',
            agentName: 'botmux-owned',
          },
        }),
      });
      deps.activeSessions.set('owned-session', owner);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt botmux:w1:p1'), deps, LARK_APP_ID);

      expect(ds.adoptedFrom).toBeUndefined();
      expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/未发现|未找到/);
    });

    it('should list Codex App threads instead of scanning tmux for codex-app bots', async () => {
      mockCodexAppBot();
      vi.mocked(listCodexAppThreads).mockResolvedValueOnce([
        {
          threadId: 'thread-abc',
          name: 'Existing App Thread',
          preview: 'hello',
          cwd: '/repo/app',
          updatedAtMs: 1780000000000,
        },
      ]);
      const ds = makeDaemonSession({
        larkAppId: CODEX_APP_ID,
        session: makeSession({ cliId: 'codex-app' as any }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, CODEX_APP_ID);

      expect(discoverAdoptableSessions).not.toHaveBeenCalled();
      expect(listCodexAppThreads).toHaveBeenCalledWith(expect.objectContaining({
        codexBin: '/opt/codex',
        cwd: '/home/testuser/projects',
      }));
      const replyArgs = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(replyArgs[2]).toBe('interactive');
      expect(replyArgs[1] as string).toContain('codex-app-thread-select');
    });

    it('should resume a selected Codex App thread directly', async () => {
      mockCodexAppBot();
      vi.mocked(listCodexAppThreads).mockResolvedValueOnce([
        {
          threadId: '019e-thread-full',
          name: 'Fix botmux',
          preview: 'fallback preview',
          cwd: '/repo/botmux',
          updatedAtMs: 1780000000000,
        },
      ]);
      const ds = makeDaemonSession({
        larkAppId: CODEX_APP_ID,
        session: makeSession({ cliId: 'codex-app' as any }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt 019e-thread'), deps, CODEX_APP_ID);

      expect(discoverAdoptableSessions).not.toHaveBeenCalled();
      expect(ds.adoptedFrom).toBeUndefined();
      expect(ds.workingDir).toBe('/repo/botmux');
      expect(ds.session.workingDir).toBe('/repo/botmux');
      expect(ds.session.cliId).toBe('codex-app');
      expect(ds.session.cliSessionId).toBe('019e-thread-full');
      expect(ds.session.adoptedFrom).toBeUndefined();
      expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
      expect(forkWorker).toHaveBeenCalledWith(ds, '', true);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已继续 Codex App 对话');
      expect(replyContent).toContain('Fix botmux');
    });

    it('attaches a Codex App bot to an existing App Server thread without changing its default runtime', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        if (id === CODEX_APP_ID) {
          return {
            botName: 'Codex Remote',
            config: {
              larkAppId: CODEX_APP_ID,
              larkAppSecret: 'secret-1',
              // Existing BotMux Codex App topics keep this default. Only the
              // explicitly selected /adopt thread switches to the official
              // `codex --remote` client below.
              cliId: 'codex-app' as const,
              existingAppServer: {
                endpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
              },
              workingDir: '~/projects',
              workingDirs: ['~/projects'],
            },
          };
        }
        return defaultGetBot(id);
      }) as any);
      vi.mocked(listCodexAppThreads).mockResolvedValueOnce([
        {
          threadId: '019e-remote-thread',
          name: 'Continue GUI thread',
          preview: 'fallback preview',
          cwd: '/repo/remote-codex',
          updatedAtMs: 1780000000000,
        },
      ]);
      const ds = makeDaemonSession({
        larkAppId: CODEX_APP_ID,
        session: makeSession({
          cliId: 'codex-app' as any,
          // A temporary topic shell might have frozen an old launcher; the
          // remote attach must clear it before the new fork.
          wrapperCli: 'old-wrapper codex',
          agentFrozen: true,
        }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt 019e-remote-thread'), deps, CODEX_APP_ID);

      expect(discoverAdoptableSessions).not.toHaveBeenCalled();
      expect(ds.session.cliId).toBe('codex');
      expect(ds.session.cliSessionId).toBe('019e-remote-thread');
      expect(ds.session.existingAppServerEndpoint)
        .toBe('unix:///home/testuser/.codex/app-server-control/app-server-control.sock');
      expect(ds.session.wrapperCli).toBeUndefined();
      expect(ds.session.agentFrozen).toBeUndefined();
      expect(forkWorker).toHaveBeenCalledWith(ds, '', true);
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已共享接入现有 Codex App 对话');
      expect(replyContent).toContain('不会新建或停止开发机 App Server');
    });

    it('does not let an existing App Server shared topic adopt a second thread', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        if (id === CODEX_APP_ID) {
          return {
            botName: 'Codex Remote',
            config: {
              larkAppId: CODEX_APP_ID,
              larkAppSecret: 'secret-1',
              cliId: 'codex-app' as const,
              existingAppServer: {
                endpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
              },
              workingDir: '~/projects',
              workingDirs: ['~/projects'],
            },
          };
        }
        return defaultGetBot(id);
      }) as any);
      const ds = makeDaemonSession({
        larkAppId: CODEX_APP_ID,
        session: makeSession({
          cliId: 'codex' as any,
          cliSessionId: '019e-already-attached',
          existingAppServerEndpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
        }),
      });
      const deps = makeDeps(ds);

      await handleCommand('/adopt', ROOT_ID, makeLarkMessage('/adopt'), deps, CODEX_APP_ID);

      expect(listCodexAppThreads).not.toHaveBeenCalled();
      expect(forkWorker).not.toHaveBeenCalled();
      expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1])
        .toContain('本话题已共享接入一条 Codex App 对话');
    });
  });

  // ─── /oncall ────────────────────────────────────────────────────────────

  describe('/oncall', () => {
    it('should bind when path is under home directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /home/testuser/projects/foo'),
        deps,
        LARK_APP_ID,
      );

      expect(bindOncall).toHaveBeenCalledWith(
        LARK_APP_ID,
        CHAT_ID,
        '/home/testuser/projects/foo',
      );
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已绑定 oncall');
    });

    it('should bind any existing directory regardless of location', async () => {
      // No allowlist — owner is trusted to choose the working directory.
      vi.mocked(existsSync).mockReturnValue(true);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /data00/home/wanghao.muchen/ai-workspace/marketing_insight'),
        deps,
        LARK_APP_ID,
      );

      expect(bindOncall).toHaveBeenCalledWith(
        LARK_APP_ID,
        CHAT_ID,
        '/data00/home/wanghao.muchen/ai-workspace/marketing_insight',
      );
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已绑定 oncall');
    });

    it('should auto-create a non-existent path on /oncall bind and note it', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /brand-new/oncall-dir'),
        deps,
        LARK_APP_ID,
      );

      expect(mkdirSync).toHaveBeenCalledWith('/brand-new/oncall-dir', { recursive: true });
      expect(bindOncall).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, '/brand-new/oncall-dir');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已自动创建');
    });

    it('should reject /oncall bind when auto-create fails', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /brand-new/denied'),
        deps,
        LARK_APP_ID,
      );

      expect(bindOncall).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('无法创建目录');
    });

    it('should reject /oncall bind path that exists but is not a directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValueOnce({ isDirectory: () => false } as any);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /tmp/some-file.txt'),
        deps,
        LARK_APP_ID,
      );

      expect(bindOncall).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('路径不是目录');
    });
  });

  // ─── Unknown command (no-op / falls through switch) ─────────────────────

  describe('unknown command', () => {
    it('should not reply for commands not in switch cases', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/unknown', ROOT_ID, makeLarkMessage('/unknown'), deps, LARK_APP_ID);

      // The switch has no default case, so nothing should be called
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should catch and log errors without throwing', async () => {
      const { logger } = await import('../src/utils/logger.js');
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      // Make sessionReply throw
      vi.mocked(deps.sessionReply).mockRejectedValue(new Error('network error'));

      // Should not throw
      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Command /close error'));
    });
  });

  // ─── /group ───────────────────────────────────────────────────────────────

  describe('/group', () => {
    const mockedCreate = vi.mocked(createGroupWithBots);
    const mockedListBots = vi.mocked(listChatBotMembers);
    const mockedSend = vi.mocked(sendMessage);

    it('creates a solo group (creator only) when no bots are @-mentioned', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/group', ROOT_ID, makeLarkMessage('/group My Project'), deps, LARK_APP_ID);

      expect(mockedCreate).toHaveBeenCalledTimes(1);
      const opts = mockedCreate.mock.calls[0][0];
      expect(opts.larkAppIds).toEqual([LARK_APP_ID]);
      expect(opts.name).toBe('My Project');
      expect(opts.transferOwnerTo).toBe('ou_sender');

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('My Project');
      expect(reply).toContain('oc_new_group');
    });

    it('applies the configured global prefix to /group and reports the final name', async () => {
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: '[AI] ' });
      const deps = makeDeps(makeDaemonSession());

      await handleCommand('/group', ROOT_ID, makeLarkMessage('/group My Project'), deps, LARK_APP_ID);

      expect(mockedCreate.mock.calls[0][0].name).toBe('[AI] My Project');
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('[AI] My Project');
    });

    it('applies the configured global prefix through the /g alias', async () => {
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: 'AI讨论·' });
      const deps = makeDeps(makeDaemonSession());

      await handleCommand('/g', ROOT_ID, makeLarkMessage('/g Project'), deps, LARK_APP_ID);

      expect(mockedCreate.mock.calls[0][0].name).toBe('AI讨论·Project');
    });

    it('does not duplicate a prefix already present in the requested name', async () => {
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: 'AI讨论·' });
      const deps = makeDeps(makeDaemonSession());

      await handleCommand('/group', ROOT_ID, makeLarkMessage('/group AI讨论·Project'), deps, LARK_APP_ID);

      expect(mockedCreate.mock.calls[0][0].name).toBe('AI讨论·Project');
    });

    it('prefixes the existing timestamp fallback when /group has no name', async () => {
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: 'AI讨论·' });
      const deps = makeDeps(makeDaemonSession());

      await handleCommand('/group', ROOT_ID, makeLarkMessage('/group'), deps, LARK_APP_ID);

      expect(mockedCreate.mock.calls[0][0].name).toMatch(/^AI讨论·新会话 \d{2}\/\d{2} \d{2}:\d{2}$/);
    });

    it('keeps the legacy UTF-16 limit without splitting emoji', async () => {
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: 'AI讨论·' });
      const deps = makeDeps(makeDaemonSession());

      await handleCommand('/group', ROOT_ID, makeLarkMessage(`/group ${'😀'.repeat(60)}`), deps, LARK_APP_ID);

      const name = mockedCreate.mock.calls[0][0].name!;
      expect(name.length).toBeLessThanOrEqual(51);
      expect(name).toBe(`AI讨论·${'😀'.repeat(22)}…`);
      expect(name).not.toContain('\uFFFD');
    });

    it('passes /group --role-profile through and strips it from the group name', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/g', ROOT_ID, makeLarkMessage('/g --role-profile collab-main My Project'), deps, LARK_APP_ID);

      expect(mockedCreate).toHaveBeenCalledTimes(1);
      const opts = mockedCreate.mock.calls[0][0];
      expect(opts.name).toBe('My Project');
      expect(opts.roleProfileId).toBe('collab-main');
    });

    it('does NOT auto-post a repo-select card after creating the group', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/group', ROOT_ID, makeLarkMessage('/group X'), deps, LARK_APP_ID);

      // No interactive repo card pushed to the new group.
      expect(mockedSend).not.toHaveBeenCalled();
      // No chat-scope session registered for the new group.
      expect(deps.activeSessions.has(sessionKey('oc_new_group', LARK_APP_ID))).toBe(false);
    });

    it('runs with NO active session, reading the source chat from message.chatId', async () => {
      // The daemon runs /group through SESSIONLESS_DAEMON_COMMANDS — no
      // sessionStore record, so handleCommand sees no ds. Resolving the
      // @-mentioned bots needs the source chatId, which now rides on the
      // message instead of ds.chatId.
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const deps = makeDeps(); // no ds — the sessionless path
      const msg = makeLarkMessage('/group @Codex 项目', {
        chatId: CHAT_ID,
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      // Roster lookup used the chatId from the message, and the group was created.
      expect(mockedListBots).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      expect(mockedCreate.mock.calls[0][0].larkAppIds).toEqual(['app-1', 'app-2']);
    });

    it('fails closed (no group) with bots mentioned but no chatId on message and no ds', async () => {
      const deps = makeDeps(); // no ds
      const msg = makeLarkMessage('/group @Codex 项目', {
        // chatId intentionally omitted
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('无法解析');
    });

    it('invites every @-mentioned bot when the first mentioned bot is us', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/group @Codex 项目讨论', {
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).toHaveBeenCalledTimes(1);
      const opts = mockedCreate.mock.calls[0][0];
      expect(opts.larkAppIds).toEqual(['app-1', 'app-2']);
      // The @Codex token is stripped from the resolved group name.
      expect(opts.name).toBe('项目讨论');
    });

    it('defers silently when we are not the first mentioned bot', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      // Codex is mentioned first → app-2 is the designated creator; app-1 (us) defers.
      const msg = makeLarkMessage('/group @Codex @Claude 项目', {
        mentions: [
          { key: '@_user_1', name: 'Codex', openId: 'ou_codex' },
          { key: '@_user_2', name: 'Claude', openId: 'ou_claude' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
      // Election uses the global bot-name registry + our own open_id — a
      // non-leader decides to defer without any chat-member lookup.
      expect(mockedListBots).not.toHaveBeenCalled();
    });

    it('defers in a per-bot daemon even when getAllBots() only knows itself (no split-brain)', async () => {
      // Faithful to production: the Codex process's in-memory registry has ONLY
      // Codex. The OLD getAllBots()-based election would make Codex self-elect as
      // "first known bot" and double-create. The fix reads the global bot-name
      // registry (bots-info.json), so Codex still defers to the first @-mentioned
      // bot (Claude).
      vi.mocked(getAllBots).mockReturnValueOnce([
        { botName: 'Codex', config: { larkAppId: 'app-2', larkAppSecret: 's', cliId: 'codex', workingDir: '~' } },
      ] as unknown as ReturnType<typeof getAllBots>);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/group @Claude @Codex 项目', {
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      // Handled by the app-2 (Codex) daemon process.
      await handleCommand('/group', ROOT_ID, msg, deps, 'app-2');

      expect(mockedCreate).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('fails closed (no group) when an @-mentioned bot cannot be resolved to an app id', async () => {
      // We are the leader (Claude, first), but the chat-member roster is missing
      // Codex → must NOT create a group silently dropping an intended bot.
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
      ]);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/group @Claude @Codex 项目', {
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('无法解析');
    });

    it('fails closed (no group) when the global bot registry is empty (corrupt bots-info.json)', async () => {
      // Simulate a missing/corrupt bots-info.json → globalKnownBotNames() empty.
      vi.mocked(readFileSync).mockImplementationOnce((p: any) => {
        if (typeof p === 'string' && p.includes('bots-info.json')) return '[]';
        throw new Error('unexpected read');
      });
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/group @Codex 项目', {
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('无法解析');
    });

    it('fails closed (no group) when bots are mentioned but the source chatId is unknown', async () => {
      const ds = makeDaemonSession({ chatId: undefined as unknown as string });
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/group @Codex 项目', {
        mentions: [
          { key: '@_user_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_user_2', name: 'Codex', openId: 'ou_codex' },
        ],
      });

      await handleCommand('/group', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('无法解析');
    });
  });

  // ─── /relay --create ────────────────────────────────────────────────────

  describe('/relay', () => {
    const mockedCreate = vi.mocked(createGroupWithBots);
    const mockedListBots = vi.mocked(listChatBotMembers);
    const mockedSend = vi.mocked(sendMessage);

    beforeEach(async () => {
      // Reset the cross-test stubs we manipulate here.
      const wp = await import('../src/core/worker-pool.js');
      vi.mocked(wp.transferSession).mockReset();
      vi.mocked(wp.transferSession).mockResolvedValue({ ok: true });
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReset();
      vi.mocked(dd.findOnlineDaemon).mockReturnValue(null);
    });

    it('renders the relay picker card when invoked without --create', async () => {
      // Existing session in the current chat (ds) — picker should NOT list it
      // (self-targeting is rejected by the cant_relay_same_chat filter).
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });

      // Other-chat session, same bot, same owner → should appear in picker.
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: 'other-thread task',
          ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Default-private picker: flat 普通群 (default 'chat' mode) now sends the
      // picker as an ephemeral card visible only to the invoker — NOT a visible
      // reply, NOT sessionReply. (Decoupled from privateCard; see the gate.)
      expect(vi.mocked(sendEphemeralCard)).toHaveBeenCalledTimes(1);
      const [ephAppId, ephChatId, ephOpenId, replyContent] = vi.mocked(sendEphemeralCard).mock.calls[0];
      expect(ephAppId).toBe(LARK_APP_ID);
      expect(ephChatId).toBe(CHAT_ID);
      expect(ephOpenId).toBe('ou_sender');
      expect(vi.mocked(replyMessage)).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
      const card = JSON.parse(replyContent as string);
      const containers = card.body.elements.filter((e: any) => e.tag === 'interactive_container');
      expect(containers).toHaveLength(1);
      const cb = containers[0].behaviors[0];
      expect(cb.type).toBe('callback');
      expect(cb.value.action).toBe('relay_select');
      expect(cb.value.session_id).toBe('sess-other');
      expect(cb.value.target_chat_id).toBe(CHAT_ID);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    // Regression (申晗 live 反馈): /relay typed INSIDE a 话题 of a chat-mode
    // 普通群 rendered the picker at the chat TOP LEVEL — the command routed to
    // the chat-scope session (scratch, no turn state), so sessionReply's
    // fold-back had nothing to anchor on and fell through to sendMessage.
    // The card must instead reply_in_thread into the 话题 the user typed in
    // (= the thread target the routing already computed).
    it('picker card replies INTO the 话题 when /relay is typed inside a thread of a chat-mode group', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat' }), scope: 'chat' });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: 'other task',
          ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay', {
        rootId: 'om_topic_root_x',
        threadId: 'omt_thread_x',
      }), deps, LARK_APP_ID);

      const [, anchorMsgId, replyContent, msgType, inThread] = vi.mocked(replyMessage).mock.calls[0];
      expect(anchorMsgId).toBe('om_topic_root_x');
      expect(inThread).toBe(true);
      expect(msgType).toBe('interactive');
      expect(deps.sessionReply).not.toHaveBeenCalled();
      // The baked target matches where the card sits: the same 话题.
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('thread');
      expect(containerValue?.root_id).toBe('om_topic_root_x');
    });

    it('picker falls back to sessionReply when reply-at-invocation fails (thread-scope visible path)', async () => {
      // Thread-scope pickers stay on the VISIBLE in-thread reply (ephemeral has
      // no thread anchor). When that replyMessage refuses (e.g. the /relay
      // message was withdrawn mid-flight), we fall back to sessionReply.
      vi.mocked(replyMessage).mockRejectedValueOnce(new Error('message withdrawn'));
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat' }), scope: 'chat' });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay', {
        rootId: 'om_topic_root_x',
        threadId: 'omt_thread_x',
      }), deps, LARK_APP_ID);

      const [, replyContent, msgType] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(msgType).toBe('interactive');
      expect(JSON.parse(replyContent as string).schema).toBe('2.0');
    });

    it('picker excludes daemon-command scratch sessions (worker:null + no persisted CLI markers)', async () => {
      // Codex review caught: collectRelayPickerEntries only filtered same-
      // bot / non-current-chat / owner / adopt — NOT scratch placeholders.
      // A /help / unfinished /relay in some other chat would leave behind
      // a worker:null + no-cliId session at the operator's owner; that
      // scratch would surface in this picker as a valid pick, and
      // confirming it would migrate an empty shell into the current chat.
      // The fix: pickers filter via isRelayableRealSession too.
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const scratchDs: DaemonSession = {
        ...makeDaemonSession(),
        worker: null,
        hasHistory: false,
        session: makeSession({
          sessionId: 'sess-scratch',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: '/help',
          ownerOpenId: 'ou_sender',
          // No persisted CLI markers — never started a real worker.
          cliId: undefined,
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), scratchDs);

      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Default-private picker → ephemeral even when empty.
      const [, , , cardJson] = vi.mocked(sendEphemeralCard).mock.calls[0];
      const card = JSON.parse(cardJson as string);
      // Scratch must NOT show — picker empty (no interactive_containers).
      expect(card.body.elements.filter((e: any) => e.tag === 'interactive_container')).toHaveLength(0);
    });

    it('picker excludes adopt sessions (those wrapping a user-attached tmux)', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      // Adopt session in another chat — should NOT appear in the picker.
      const adoptDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-adopt',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: 'adopted',
          ownerOpenId: 'ou_sender',
          adoptedFrom: { tmuxTarget: '0:2.0', originalCliPid: 12345, cwd: '/tmp' },
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), adoptDs);

      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const [, , , cardJson] = vi.mocked(sendEphemeralCard).mock.calls[0];
      const card = JSON.parse(cardJson as string);
      // No interactive containers rendered — picker is empty after filtering out the adopt session.
      expect(card.body.elements.filter((e: any) => e.tag === 'interactive_container')).toHaveLength(0);
    });

    it('renders the picker in a thread-mode DM with a thread-scope target seeded on the /relay message', async () => {
      // p2p detection is via ds.chatType (authoritative, no Lark API hit).
      // Thread mode is now the explicit DM opt-out (default is 'chat'): the
      // /relay message seeds a fresh DM 话题, so the baked target is thread-scope
      // anchored at the message id.
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        const bot = defaultGetBot(id);
        (bot.config as any).p2pMode = 'thread';
        return bot;
      }) as any);
      const { getChatNameAndMode } = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({
        session: makeSession({ ownerOpenId: 'ou_sender', chatType: 'p2p' }),
        chatType: 'p2p',
      });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: 'other task',
          ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // p2p must NOT hit the chat-mode API (its failure default 'group' would
      // misclassify the DM).
      expect(vi.mocked(getChatNameAndMode)).not.toHaveBeenCalled();
      // Thread-mode DM target seeds a 话题 on the /relay message — the card
      // replies in_thread there so the picker sits where the session lands.
      const [, anchorMsgId, replyContent, msgType, inThread] = vi.mocked(replyMessage).mock.calls[0];
      expect(anchorMsgId).toBe('msg_001');
      expect(inThread).toBe(true);
      expect(msgType).toBe('interactive');
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('thread');
      expect(containerValue?.root_id).toBe('msg_001');
      expect(containerValue?.target_chat_type).toBe('p2p');
    });

    it('renders the picker in a flat-mode DM (p2pMode chat) with a chat-scope target on the DM chatId', async () => {
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        const bot = defaultGetBot(id);
        (bot.config as any).p2pMode = 'chat';
        return bot;
      }) as any);
      const ds = makeDaemonSession({
        session: makeSession({ ownerOpenId: 'ou_sender', chatType: 'p2p' }),
        chatType: 'p2p',
      });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          title: 'other task',
          ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Flat DM → quote-reply of the /relay message (top level, no thread).
      const [, anchorMsgId, replyContent, msgType, inThread] = vi.mocked(replyMessage).mock.calls[0];
      expect(anchorMsgId).toBe('msg_001');
      expect(inThread).toBe(false);
      expect(msgType).toBe('interactive');
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('chat');
      expect(containerValue?.root_id).toBe(CHAT_ID);
      expect(containerValue?.target_chat_type).toBe('p2p');
    });

    it('renders the picker in topic chats with a thread-scope target (no longer refused)', async () => {
      // Topic chats record chatType='group' locally — resolved via Lark API.
      // Force 'topic'; the picker must now RENDER and bake a thread-scope
      // target anchored at the /relay message id (a fresh 话题 seed).
      const { getChatNameAndMode } = await import('../src/im/lark/client.js');
      vi.mocked(getChatNameAndMode).mockResolvedValueOnce({ name: 'Topic Room', mode: 'topic' });

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // 话题群 top-level → card seeds the 话题 on the /relay message itself.
      const [, anchorMsgId, replyContent, msgType, inThread] = vi.mocked(replyMessage).mock.calls[0];
      expect(anchorMsgId).toBe('msg_001');
      expect(inThread).toBe(true);
      expect(msgType).toBe('interactive');
      expect(String(replyContent)).not.toMatch(/话题群不支持|not supported in topic/);
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('thread');
      // 话题群 top-level → anchor = the /relay message id (makeLarkMessage → 'msg_001').
      expect(containerValue?.root_id).toBe('msg_001');
    });

    // ── privateCard picker gate (PR #654 + 首审/复审修复) ────────────────────
    // The picker exposes session title + source-chat name. When privateCard is
    // on, a FLAT 普通群 (chat-scope) sends it as an ephemeral card (visible to the
    // invoker only). But ephemeral has no thread anchor, so thread-scope targets
    // must NOT use it (see the gate comment in command-handler + the REGRESSION
    // in ephemeral-or-reply.test.ts). 申晗 (2026-07-29): 话题内公开可接受.

    // Helper: bot with privateCard on.
    const withPrivateCard = () => {
      vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => {
        const bot = defaultGetBot(id);
        (bot.config as any).privateCard = true;
        return bot;
      }) as any);
    };

    it('privateCard + flat 普通群 (chat-scope): sends the picker as an ephemeral card, NOT a visible reply', async () => {
      withPrivateCard();
      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat' }), scope: 'chat' });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other', chatId: 'oc_other', rootMessageId: 'om_other_root',
          title: 'secret task', ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Ephemeral send to the invoker in the current chat — never a visible reply.
      expect(vi.mocked(sendEphemeralCard)).toHaveBeenCalledTimes(1);
      const [appId, chatId, openId, cardJson] = vi.mocked(sendEphemeralCard).mock.calls[0];
      expect(appId).toBe(LARK_APP_ID);
      expect(chatId).toBe(CHAT_ID);
      expect(openId).toBe('ou_sender');
      expect(vi.mocked(replyMessage)).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
      // The ephemeral card carries visibility='private' baked into its buttons.
      const card = JSON.parse(cardJson as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.visibility).toBe('private');
    });

    it('REGRESSION: privateCard + thread-scope (话题群) does NOT go ephemeral — stays a visible in-thread reply (public card)', async () => {
      // Ephemeral has no thread anchor: a 话题群 rejects with 18053 and a 话题
      // inside a 普通群 would leak the card to the group top level. So thread-
      // scope pickers must skip ephemeral entirely (guarded, not fallback).
      withPrivateCard();
      const { sendEphemeralCard, getChatNameAndMode } = await import('../src/im/lark/client.js');
      vi.mocked(getChatNameAndMode).mockResolvedValueOnce({ name: 'Topic Room', mode: 'topic' });
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other', chatId: 'oc_other', rootMessageId: 'om_other_root',
          title: 'secret task', ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Ephemeral must NOT be attempted for a thread-scope target.
      expect(vi.mocked(sendEphemeralCard)).not.toHaveBeenCalled();
      // Card goes out as a visible in-thread reply, and is PUBLIC (not private).
      const [, anchorMsgId, replyContent, msgType, inThread] = vi.mocked(replyMessage).mock.calls[0];
      expect(anchorMsgId).toBe('msg_001');
      expect(inThread).toBe(true);
      expect(msgType).toBe('interactive');
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('thread');
      expect(containerValue?.visibility).toBe('public');
    });

    it('privateCard + chat-scope: falls back to a visible reply when the ephemeral send fails (e.g. 18053)', async () => {
      withPrivateCard();
      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      vi.mocked(sendEphemeralCard).mockRejectedValueOnce(new Error('chat can not be thread (code: 18053)'));
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat' }), scope: 'chat' });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other', chatId: 'oc_other', rootMessageId: 'om_other_root',
          title: 'secret task', ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Attempted ephemeral, then fell back to the visible reply with a PUBLIC card.
      expect(vi.mocked(sendEphemeralCard)).toHaveBeenCalledTimes(1);
      const [, , replyContent, msgType] = vi.mocked(replyMessage).mock.calls[0];
      expect(msgType).toBe('interactive');
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.visibility).toBe('public');
    });

    it('privateCard OFF + flat 普通群 (chat-scope): picker STILL defaults to ephemeral (decoupled from privateCard)', async () => {
      // Default-private picker (孙晓雪 2026-08-16): the /relay picker leaks the
      // invoker's session list, has zero public benefit (invoker is always the
      // owner, buttons are owner-only), so it goes ephemeral in a flat 普通群
      // regardless of the privateCard config. privateCard now gates ONLY
      // /card & /close, no longer the picker.
      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', scope: 'chat' }), scope: 'chat' });
      const otherDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other', chatId: 'oc_other', rootMessageId: 'om_other_root',
          title: 'other task', ownerOpenId: 'ou_sender',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherDs);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Ephemeral send to the invoker even with privateCard OFF.
      expect(vi.mocked(sendEphemeralCard)).toHaveBeenCalledTimes(1);
      const [appId, chatId, openId, cardJson] = vi.mocked(sendEphemeralCard).mock.calls[0];
      expect(appId).toBe(LARK_APP_ID);
      expect(chatId).toBe(CHAT_ID);
      expect(openId).toBe('ou_sender');
      expect(vi.mocked(replyMessage)).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
      const card = JSON.parse(cardJson as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.visibility).toBe('private');
    });

    it('picker refuses upfront when this chat already has an active session for the bot', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      // Existing running session in the SAME chat (would collide on transfer).
      // Must be chat-scope — thread-scope sessions (e.g. /t force-topic) live
      // at a different sessionKey anchor and don't collide; the picker only
      // refuses on chat-scope collisions.
      const existing: DaemonSession = {
        ...makeDaemonSession({
          worker: { killed: false } as any,  // truthy → running session
          session: makeSession({ sessionId: 'existing-in-chat', title: 'PR review chat', ownerOpenId: 'ou_sender', scope: 'chat' }),
          scope: 'chat',
        }),
        chatId: CHAT_ID,
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_in_same_chat', LARK_APP_ID), existing);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const reply = vi.mocked(replyMessage).mock.calls[0][2] as string;
      expect(reply).toContain('PR review chat');
      expect(reply).toContain('已经有一个活跃会话');
      // Picker card should NOT have been rendered.
      expect(reply).not.toContain('relay_pick_select');
    });

    // Regression: when /relay rides an EXISTING real session in the current
    // chat (daemon.ts:2034's existing-session DAEMON_COMMANDS path → handle-
    // Command's `ds` IS that session), the conflict scan must STILL flag it
    // as a conflict — even though `c === ds`. Earlier code excluded `ds` by
    // sessionId mismatch, which made this case pass the check and render an
    // empty/misleading picker (王皓 caught this in testing). The fix: drop
    // the sessionId exclusion; rely on `!!c.worker` to filter scratch alone.
    it('picker refuses even when ds itself IS the chat\'s only running session', async () => {
      const ds = makeDaemonSession({
        worker: { killed: false } as any,  // truthy → this IS a real running session
        // Chat-scope: thread-scope sessions don't trip the picker conflict
        // (different sessionKey anchor), only chat-scope ds is a real
        // collision target for an incoming chat-scope relay.
        session: makeSession({ sessionId: 'real-in-chat', title: 'live work', ownerOpenId: 'ou_sender', scope: 'chat' }),
        scope: 'chat',
      });
      // makeDeps registers ds at sessionKey(ROOT_ID, LARK_APP_ID); ds.chatId
      // === CHAT_ID === targetChatId by default, so the conflict scan must
      // see ds itself.
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const reply = vi.mocked(replyMessage).mock.calls[0][2] as string;
      expect(reply).toContain('live work');
      expect(reply).toContain('已经有一个活跃会话');
      // Picker MUST NOT have rendered.
      expect(reply).not.toContain('relay_pick_select');
      expect(reply).not.toContain('选择要接力');
    });

    it('picker excludes sessions whose owner is not the operator', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const otherUserDs: DaemonSession = {
        ...makeDaemonSession(),
        session: makeSession({
          sessionId: 'sess-other-user',
          chatId: 'oc_other',
          rootMessageId: 'om_other_root',
          ownerOpenId: 'ou_someone_else',
        }),
        chatId: 'oc_other',
      };
      const deps = makeDeps(ds);
      deps.activeSessions.set(sessionKey('om_other_root', LARK_APP_ID), otherUserDs);

      const { sendEphemeralCard } = await import('../src/im/lark/client.js');
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const [, , , cardJson] = vi.mocked(sendEphemeralCard).mock.calls[0];
      const card = JSON.parse(cardJson as string);
      // No interactive containers — empty picker (otherUser's session filtered out).
      expect(card.body.elements.filter((e: any) => e.tag === 'interactive_container')).toHaveLength(0);
    });

    it('rejects --create when not invoked inside an active session', async () => {
      // No ds → command was invoked in an empty thread.
      const deps = makeDeps(undefined);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create New Group @Codex', {
        mentions: [{ key: '@_1', name: 'Codex', openId: 'ou_codex' }],
      }), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('已有会话');
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it('requires at least one @-mentioned bot', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create Just a Name'), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('@ 至少一个机器人');
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    // ── p2p (私聊) solo --create ─────────────────────────────────────────────
    // DMs have no member roster, so @-ing a bot is impossible there — the
    // mention gate / leader election / roster resolve are all bypassed and the
    // bot itself is the sole participant. New group = user + this bot; the DM
    // session migrates over with no peer coordination.
    it('p2p --create: solo relay without mentions — group is user + this bot, session migrates', async () => {
      // The global prefix is deliberately scoped to /group; relay names must
      // remain untouched even when the setting is enabled.
      vi.mocked(readGlobalConfig).mockReturnValue({ groupNamePrefix: 'AI讨论·' });
      const ds = makeDaemonSession({
        session: makeSession({ ownerOpenId: 'ou_sender', chatType: 'p2p' }),
        chatType: 'p2p',
      });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create 搬去群里'), deps, LARK_APP_ID);

      // Group created with ONLY this bot; ownership transferred to the sender.
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      const opts = mockedCreate.mock.calls[0][0];
      expect(opts.larkAppIds).toEqual([LARK_APP_ID]);
      expect(opts.name).toBe('搬去群里');
      expect(opts.userOpenIds).toEqual(['ou_sender']);
      expect(opts.transferOwnerTo).toBe('ou_sender');

      // No roster lookup for a DM — listChatBotMembers fails on p2p chats.
      expect(mockedListBots).not.toHaveBeenCalled();

      // The DM session was transferred into the new chat (chat-scope group).
      const wp = await import('../src/core/worker-pool.js');
      expect(wp.transferSession).toHaveBeenCalledWith('sess-001', 'oc_new_group', 'oc_new_group', 'group', 'chat');

      // M1 lands in the new group and labels the source as 单聊 instead of
      // leaking the raw DM chatId.
      expect(mockedSend).toHaveBeenCalled();
      const [, m1ChatId, m1Text] = mockedSend.mock.calls[0];
      expect(m1ChatId).toBe('oc_new_group');
      expect(m1Text).toContain('单聊');
      expect(m1Text).not.toContain(CHAT_ID);

      // Source-side report carries the new group name.
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('搬去群里');
      expect(reply).toContain('Claude');
    });

    it('p2p --create: owner-only check still enforced', async () => {
      const ds = makeDaemonSession({
        session: makeSession({ ownerOpenId: 'ou_other_user', chatType: 'p2p' }),
        chatType: 'p2p',
      });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G'), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('发起人');
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it('rejects --create when sender is not the source session owner', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_other_user' }) });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Codex', {
        mentions: [{ key: '@_1', name: 'Claude', openId: 'ou_claude' }],
      }), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('发起人');
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it('defers silently when this bot is not the first @-mentioned bot', async () => {
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);
      // mentions[0] = Codex (app-2). We are app-1 (Claude) → stay silent.
      const msg = makeLarkMessage('/relay --create G @Codex @Claude', {
        mentions: [
          { key: '@_1', name: 'Codex', openId: 'ou_codex' },
          { key: '@_2', name: 'Claude', openId: 'ou_claude' },
        ],
      });

      await handleCommand('/relay', ROOT_ID, msg, deps, LARK_APP_ID);

      expect(mockedCreate).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    });

    it('happy path: leader builds group, sends M1, transfers self, coordinates peer', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue({ larkAppId: 'app-2', ipcPort: 9999 });

      // Stub global fetch to simulate the peer's migrate-to-chat success.
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ ok: true, sessionId: 'peer-sess-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy);

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);
      const msg = makeLarkMessage('/relay --create New Group @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      });

      await handleCommand('/relay', ROOT_ID, msg, deps, LARK_APP_ID);

      // Group created with both bots, owner transferred to sender.
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      const opts = mockedCreate.mock.calls[0][0];
      expect(opts.larkAppIds).toEqual(['app-1', 'app-2']);
      expect(opts.transferOwnerTo).toBe('ou_sender');

      // M1 announcement was sent to the new chat.
      expect(mockedSend).toHaveBeenCalled();
      expect(mockedSend.mock.calls[0][1]).toBe('oc_new_group');

      // Leader transferred its own session — targetRootMessageId is now a
      // placeholder (the newChatId) since M1 is posted AFTER all transfers
      // settle. The leader's session.rootMessageId is patched to the real
      // M1 id later, see the m1_final_all_ok / m1_final_partial flow.
      const wp = await import('../src/core/worker-pool.js');
      expect(wp.transferSession).toHaveBeenCalledWith('sess-001', 'oc_new_group', 'oc_new_group', 'group', 'chat');

      // Peer migrate-to-chat was POSTed exactly once.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/127\.0\.0\.1:9999\/api\/sessions\/migrate-to-chat$/);
      const body = JSON.parse((init as any).body);
      expect(body.targetChatId).toBe('oc_new_group');
      // Peers also get the placeholder; their session.rootMessageId stays as
      // the chatId (cosmetic — chat-scope routing doesn't use rootMessageId).
      expect(body.targetRootMessageId).toBe('oc_new_group');
      expect(body.requesterLarkAppId).toBe(LARK_APP_ID);
      expect(body.requestingUserOpenId).toBe('ou_sender');

      // Reply contains the new chat name and both bot statuses.
      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('New Group');
      expect(reply).toContain('Claude');
      expect(reply).toContain('Codex');

      vi.unstubAllGlobals();
    });

    it('reports peer as offline when its daemon is not registered', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      // findOnlineDaemon default mock returns null → peer offline.
      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('Codex');
      expect(reply).toContain('守护进程离线');
    });

    // Regression: leader's transferSession overwrites ds.session.rootMessageId
    // to the new (M1) value. Reading sourceAnchor AFTER the leader transfer
    // would feed peers a stale anchor (M1), so they'd 404 in their own
    // registries. Make the mock simulate this overwrite to catch any future
    // refactor that re-introduces the bug.
    it('passes the ORIGINAL pre-transfer rootMessageId as sourceAnchor to peers (regression)', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue({ larkAppId: 'app-2', ipcPort: 9999 });

      // Mock transferSession to actually mutate the session record like the
      // real implementation does — this is what makes the test fail under
      // the buggy code that reads sourceAnchor after the call.
      const wp = await import('../src/core/worker-pool.js');
      vi.mocked(wp.transferSession).mockImplementationOnce(async (sid, newChat, newRoot) => {
        // Look the session up in the registry (the only ds in this test) and
        // overwrite rootMessageId — that's the side effect the real
        // transferSession has at worker-pool.ts:723.
        for (const candidate of deps.activeSessions.values()) {
          if (candidate.session.sessionId === sid) {
            candidate.session.rootMessageId = newRoot;
            candidate.session.chatId = newChat;
            break;
          }
        }
        return { ok: true };
      });

      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy);

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender', rootMessageId: ROOT_ID }) });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      // sourceAnchor in the POST body MUST be the pre-transfer thread root,
      // not the placeholder rootMessageId (newChatId) that the leader
      // transferSession just wrote into ds.session.rootMessageId. Also not
      // the eventual M1 id ('card-msg-id') — peers need the ORIGINAL anchor
      // to find their own pre-transfer session.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
      expect(body.sourceAnchor).toBe(ROOT_ID);
      expect(body.sourceAnchor).not.toBe('card-msg-id');
      expect(body.sourceAnchor).not.toBe('oc_new_group');

      vi.unstubAllGlobals();
    });

    it('aborts peer coordination when the leader transfer fails', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const wp = await import('../src/core/worker-pool.js');
      vi.mocked(wp.transferSession).mockResolvedValue({ ok: false, error: 'worker_busy' });

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      // Peer fetch must NOT have happened — leader self-transfer failure aborts coordination.
      expect(fetchSpy).not.toHaveBeenCalled();
      // And M1 must NOT have been posted — no orphan "已接力" lie in the new chat.
      // The previous flow sent M1 first, then deleted it on failure (the
      // --create path didn't actually delete; the picker path did). The new
      // flow defers M1 entirely, so leader-failure means no M1 at all.
      expect(mockedSend).not.toHaveBeenCalled();

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toContain('worker_busy');

      vi.unstubAllGlobals();
    });

    it('empty-leader path: skips transferSession, closes scratch, still dispatches peers', async () => {
      // Regression for the "/relay --create in an unused chat creates an
      // empty placeholder transfer" bug. When the leader ds is the daemon-
      // command scratch (worker:null + hasHistory:false) we MUST NOT call
      // transferSession (would forkWorker against a non-existent tmux and
      // lie "已就绪" in the M1). Instead: close the scratch, bucket leader
      // as no_session, and continue to peers so they can still migrate
      // their own real sessions.
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue({ larkAppId: 'app-2', ipcPort: 9999 });

      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy);

      const wp = await import('../src/core/worker-pool.js');
      vi.mocked(wp.closeSession).mockClear();
      vi.mocked(wp.transferSession).mockClear();
      mockedSend.mockResolvedValue('final-m1-id' as any);

      // Empty leader (daemon-command scratch shape): no worker, no
      // persisted CLI markers (cliId / lastCliInput both unset).
      // hasHistory false too — though after this guard switched to the
      // persisted-marker predicate, hasHistory alone no longer matters
      // (it's what restoreActiveSessions flips to true on every restart
      // regardless of session kind, which is exactly the trap Codex
      // review caught — see isRelayableRealSession).
      const ds = makeDaemonSession({
        worker: null,
        hasHistory: false,
        session: makeSession({ ownerOpenId: 'ou_sender', cliId: undefined }),
      });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      // transferSession NOT called for empty leader.
      expect(wp.transferSession).not.toHaveBeenCalled();
      // Scratch closed (empty leader hygiene).
      expect(wp.closeSession).toHaveBeenCalledWith(ds.session.sessionId);
      // Peer fetch DID happen (continuation past empty leader).
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // M1 sent with partial template (peer success + leader in failed bucket).
      const m1Body = mockedSend.mock.calls[0][2] as string;
      expect(m1Body).toContain('Codex');           // peer in success
      expect(m1Body).toContain('Claude');          // leader in failed
      expect(m1Body).toMatch(/未能迁移|Failed to migrate/);

      vi.unstubAllGlobals();
    });

    it('all-fresh path: empty leader + offline peer → M1 uses all_fresh template', async () => {
      // Both leader is empty AND all peers couldn't migrate → no bot
      // actually brought a session in. Don't send a partial-M1 with an
      // empty success list (looks weird); use the dedicated all_fresh
      // template that frames the new group as a fresh start.
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      // Peer offline → outcome 'offline' lands in failed bucket.
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue(null);

      mockedSend.mockResolvedValue('final-m1-id' as any);

      const ds = makeDaemonSession({
        worker: null,
        hasHistory: false,
        session: makeSession({ ownerOpenId: 'ou_sender', cliId: undefined }),
      });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      const m1Body = mockedSend.mock.calls[0][2] as string;
      // all_fresh template — no "已就绪" (success list line), no "未能迁移"
      // (failed list line), instead "新群已建好" / "New group created".
      expect(m1Body).toMatch(/新群已建好|New group created/);
      expect(m1Body).not.toMatch(/已就绪：|Ready:/);
    });

    it('posts the final M1 AFTER transfers settle, with success-only template when all migrated', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue({ larkAppId: 'app-2', ipcPort: 9999 });

      // Sequence: every Codex peer succeeds; leader succeeds (default mock).
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy);

      const wp = await import('../src/core/worker-pool.js');
      const sendInvocationOrders: number[] = [];
      const xferInvocationOrders: number[] = [];
      mockedSend.mockImplementation(async (...args: any[]) => {
        sendInvocationOrders.push(mockedSend.mock.invocationCallOrder.at(-1)!);
        return 'final-m1-id';
      });
      vi.mocked(wp.transferSession).mockImplementation(async () => {
        xferInvocationOrders.push(vi.mocked(wp.transferSession).mock.invocationCallOrder.at(-1)!);
        return { ok: true };
      });

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      // Transfer fired before M1 (deferred-M1 contract).
      expect(xferInvocationOrders).toHaveLength(1);
      expect(sendInvocationOrders).toHaveLength(1);
      expect(xferInvocationOrders[0]).toBeLessThan(sendInvocationOrders[0]);

      // M1 body uses the all_ok template (both bots in successBots list,
      // no "未能迁移" / "Failed to migrate" section).
      const m1Body = mockedSend.mock.calls[0][2] as string;
      expect(m1Body).toContain('Claude');
      expect(m1Body).toContain('Codex');
      expect(m1Body).not.toMatch(/未能迁移|Failed to migrate/);

      // Leader's session.rootMessageId was patched from placeholder to final M1 id.
      expect(ds.session.rootMessageId).toBe('final-m1-id');

      vi.unstubAllGlobals();
    });

    it('posts the final M1 with partial template when some peers failed', async () => {
      mockedListBots.mockResolvedValueOnce([
        { larkAppId: 'app-1', openId: 'ou_claude', name: 'claude-code', displayName: 'Claude', source: 'configured' },
        { larkAppId: 'app-2', openId: 'ou_codex', name: 'codex', displayName: 'Codex', source: 'configured' },
      ]);
      // Peer (Codex) is offline → outcome 'offline' lands in failed bucket.
      const dd = await import('../src/utils/daemon-discovery.js');
      vi.mocked(dd.findOnlineDaemon).mockReturnValue(null);

      mockedSend.mockResolvedValue('final-m1-id' as any);

      const ds = makeDaemonSession({ session: makeSession({ ownerOpenId: 'ou_sender' }) });
      const deps = makeDeps(ds);
      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay --create G @Claude @Codex', {
        mentions: [
          { key: '@_1', name: 'Claude', openId: 'ou_claude' },
          { key: '@_2', name: 'Codex',  openId: 'ou_codex' },
        ],
      }), deps, LARK_APP_ID);

      // M1 body uses the partial template — Codex in failed list, Claude in success.
      const m1Body = mockedSend.mock.calls[0][2] as string;
      expect(m1Body).toContain('Claude');
      expect(m1Body).toContain('Codex');
      expect(m1Body).toMatch(/未能迁移|Failed to migrate/);
      expect(m1Body).toMatch(/请在本群发 \/relay|Run \/relay in this chat/);
    });
  });

  // ─── Edge: larkAppId undefined ──────────────────────────────────────────

  describe('edge: larkAppId is undefined', () => {
    it('should treat session as undefined when larkAppId is not provided', async () => {
      // Even if activeSessions has entries, sessionKey requires larkAppId
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), deps, undefined);

      // ds lookup uses `undefined` for larkAppId, so ds is undefined
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('没有活跃的会话');
    });
  });
});

// ─── Helpers unit tests ─────────────────────────────────────────────────────

describe('formatUptime (internal, tested indirectly via /status)', () => {
  it('should format seconds in status output', async () => {
    const ds = makeDaemonSession({
      worker: { killed: false } as any,
      spawnedAt: Date.now() - 5_000, // 5 seconds ago
      lastMessageAt: Date.now() - 2_000, // 2 seconds ago
    });
    const deps = makeDeps(ds);

    await handleCommand('/status', ROOT_ID, makeLarkMessage('/status'), deps, LARK_APP_ID);

    const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    // Should contain "Xs" or "Xm" format
    expect(replyContent).toMatch(/Uptime: \d+s/);
    expect(replyContent).toMatch(/Last message: \d+s ago/);
  });
});

describe('/role subcommand routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes "/role team set <md>" to writeTeamRoleFile (team role, not chat role)', async () => {
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role team set 团队后端角色'), deps, LARK_APP_ID);
    expect(writeTeamRoleFile).toHaveBeenCalledWith(LARK_APP_ID, '团队后端角色');
  });

  it('routes "/role team delete" to deleteTeamRoleFile', async () => {
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role team delete'), deps, LARK_APP_ID);
    expect(deleteTeamRoleFile).toHaveBeenCalledWith(LARK_APP_ID);
  });

  it('routes "/role cap set <label>" to setBotCapability with sender as updatedBy', async () => {
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role cap set 后端排查能手'), deps, LARK_APP_ID);
    expect(setBotCapability).toHaveBeenCalledWith('/fake/data', LARK_APP_ID, '后端排查能手', 'ou_sender');
  });

  it('routes "/role cap clear" to clearBotCapability', async () => {
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role cap clear'), deps, LARK_APP_ID);
    expect(clearBotCapability).toHaveBeenCalledWith('/fake/data', LARK_APP_ID);
  });

  it('plain "/role" shows the EFFECTIVE role via resolveRole (chat override ＞ team)', async () => {
    (resolveRole as ReturnType<typeof vi.fn>).mockReturnValue({ content: 'TEAMROLE_MARKER', source: 'team' });
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role'), deps, LARK_APP_ID);
    expect(resolveRole).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('TEAMROLE_MARKER');
  });

  it('routes "/role profile list" through role-profile-store and marks this bot status', async () => {
    vi.mocked(listRoleProfiles).mockReturnValue([{ profileId: 'collab-main', entryCount: 2, updatedAt: null }]);
    vi.mocked(readRoleProfileEntry).mockReturnValue('profile role');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile list'), deps, LARK_APP_ID);
    expect(listRoleProfiles).toHaveBeenCalledWith('/fake/data');
    expect(readRoleProfileEntry).toHaveBeenCalledWith('/fake/data', 'collab-main', LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('collab-main');
    expect(reply).toContain('已配置');
  });

  it('routes "/role profile save <profile>" from the effective role', async () => {
    vi.mocked(resolveRole).mockReturnValue({ content: 'EFFECTIVE_ROLE', source: 'chat' });
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile save collab-main'), deps, LARK_APP_ID);
    expect(resolveRole).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
    expect(writeRoleProfileEntry).toHaveBeenCalledWith('/fake/data', 'collab-main', LARK_APP_ID, 'EFFECTIVE_ROLE');
  });

  it('routes "/role profile apply <profile>" to write this chat role when empty', async () => {
    vi.mocked(readRoleProfileEntry).mockReturnValue('PROFILE_ROLE');
    vi.mocked(resolveRoleFile).mockReturnValue(null);
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile apply collab-main'), deps, LARK_APP_ID);
    expect(readRoleProfileEntry).toHaveBeenCalledWith('/fake/data', 'collab-main', LARK_APP_ID);
    expect(resolveRoleFile).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
    expect(writeRoleFile).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, 'PROFILE_ROLE');
  });

  it('refuses "/role profile apply <profile>" when chat role exists without --force', async () => {
    vi.mocked(readRoleProfileEntry).mockReturnValue('PROFILE_ROLE');
    vi.mocked(resolveRoleFile).mockReturnValue('EXISTING_CHAT_ROLE');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile apply collab-main'), deps, LARK_APP_ID);
    expect(writeRoleFile).not.toHaveBeenCalled();
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('--force');
  });

  it('allows "/role profile apply <profile> --force" to overwrite chat role', async () => {
    vi.mocked(readRoleProfileEntry).mockReturnValue('PROFILE_ROLE');
    vi.mocked(resolveRoleFile).mockReturnValue('EXISTING_CHAT_ROLE');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile apply collab-main --force'), deps, LARK_APP_ID);
    expect(writeRoleFile).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, 'PROFILE_ROLE');
  });

  it('treats an empty role profile entry as clearing this chat role when forced', async () => {
    vi.mocked(readRoleProfileEntry).mockReturnValue('');
    vi.mocked(resolveRoleFile).mockReturnValue('EXISTING_CHAT_ROLE');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile apply collab-main --force'), deps, LARK_APP_ID);
    expect(deleteRoleFile).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID);
    expect(writeRoleFile).not.toHaveBeenCalled();
  });

  it('refuses an empty entry with a clear-specific message (not overwrite) when no --force', async () => {
    vi.mocked(readRoleProfileEntry).mockReturnValue('');
    vi.mocked(resolveRoleFile).mockReturnValue('EXISTING_CHAT_ROLE');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/role', ROOT_ID, makeLarkMessage('/role profile apply collab-main'), deps, LARK_APP_ID);
    expect(deleteRoleFile).not.toHaveBeenCalled();
    expect(writeRoleFile).not.toHaveBeenCalled();
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('--force');
    expect(reply).toContain('清除'); // clear-intent wording, not the overwrite ('覆盖') message
  });
});

describe('/card — operator / canOperate gate', () => {
  const CHAT_ID = 'oc_chat_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(canOperate).mockReturnValue(true);
    vi.mocked(setCardMode).mockResolvedValue({ ok: true } as any);
    vi.mocked(setChatStreamingCardPin).mockResolvedValue({ ok: true, changed: true } as any);
  });

  it('rejects a non-operator (canOperate=false): operator_only notice, no mode change', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const deps = makeDeps();
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_random', '/card off', deps);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('仅授权用户');
    expect(setCardMode).not.toHaveBeenCalled();
  });

  it('operator: /card off toggles the per-chat streaming card off', async () => {
    const deps = makeDeps();
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card off', deps);
    expect(setCardMode).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, true);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('已关闭');
  });

  it('open mode: a non-owner sender passes canOperate and /card on works', async () => {
    const deps = makeDeps();
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_random', '/card on', deps);
    expect(setCardMode).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, false);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('已恢复');
  });

  it('Plan B: /card on a VC meeting-agent session gets the ordinary not-ready notice (no special-casing)', async () => {
    // Under Plan B a meeting agent is an ordinary chat-scope session, so /card
    // behaves exactly like any other session — postFreshStreamingCard no longer
    // structurally refuses it, and there is no meeting-receiver-specific reason.
    // When a post genuinely can't happen yet, the operator sees the same generic
    // not-ready text as every other session.
    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: { larkAppId: id, larkAppSecret: 's', cliId: 'claude-code' as const, privateCard: false },
    })) as any);
    vi.mocked(postFreshStreamingCard).mockResolvedValue(false);
    const ds = makeDaemonSession({ session: makeSession({ vcMeetingReceiver: true }) });
    const deps = makeDeps(ds);
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card', deps);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('终端尚未就绪');
    expect(reply).not.toContain('会议接收会话');
  });

  it('operator: /card pin off updates the per-chat Pin opt-out without touching streamingCardForced or setCardMode', async () => {
    const ds = makeDaemonSession();
    ds.streamingCardForced = true;
    const deps = makeDeps(ds);

    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin off', deps);

    expect(setChatStreamingCardPin).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, false);
    expect(setCardMode).not.toHaveBeenCalled();
    expect(ds.streamingCardForced).toBe(true);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('置顶');
  });

  it('operator: /card pin on works without a live session and does not touch setCardMode', async () => {
    const deps = makeDeps();

    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin on', deps);

    expect(setChatStreamingCardPin).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, true);
    expect(setCardMode).not.toHaveBeenCalled();
  });

  it('operator: /card pin on under master-off removes the chat override but replies with the master-off hint', async () => {
    const deps = makeDeps();

    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: {
        larkAppId: id,
        larkAppSecret: 's',
        cliId: 'claude-code' as const,
        pinStreamingCard: false,
        noPinStreamingCardChats: [CHAT_ID],
      },
    })) as any);

    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin on', deps);

    expect(setChatStreamingCardPin).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, true);
    expect(setCardMode).not.toHaveBeenCalled();
    expect(((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [])[1] as string).toContain('bot 级');
  });

  it('operator: /card pin status distinguishes master off, chat opt-out, and effective on', async () => {
    const deps = makeDeps();

    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: { larkAppId: id, larkAppSecret: 's', cliId: 'claude-code' as const, pinStreamingCard: false },
    })) as any);
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin status', deps);
    expect(((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [])[1] as string).toContain('bot 级');

    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: { larkAppId: id, larkAppSecret: 's', cliId: 'claude-code' as const, pinStreamingCard: true, noPinStreamingCardChats: [CHAT_ID] },
    })) as any);
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin status', deps);
    expect(((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [])[1] as string).toContain('当前群');

    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: { larkAppId: id, larkAppSecret: 's', cliId: 'claude-code' as const, pinStreamingCard: true },
    })) as any);
    await handleCardCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/card pin status', deps);
    expect(((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [])[1] as string).toContain('已开启');
  });
});

describe('/cot — thinking-process message switch (operator / canOperate)', () => {
  const CHAT_ID = 'oc_chat_1';
  const botWith = (config: Record<string, unknown>) =>
    vi.mocked(getBot).mockImplementation(((id: string = 'app-1') => ({
      botName: 'Claude',
      config: { larkAppId: id, larkAppSecret: 's', cliId: 'claude-code' as const, ...config },
    })) as any);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(canOperate).mockReturnValue(true);
    vi.mocked(setCotMode).mockResolvedValue({ ok: true, changed: true } as any);
    botWith({ thinkingCard: true });
  });

  it('rejects a non-operator: operator_only notice, no mode change', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_random', '/cot off', deps);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('仅授权用户');
    expect(setCotMode).not.toHaveBeenCalled();
  });

  it('/cot off mutes the chat via setCotMode(off=true)', async () => {
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot off', deps);
    expect(setCotMode).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, true);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('已关闭');
  });

  it('/cot on restores the chat and confirms when the master switch is on', async () => {
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot on', deps);
    expect(setCotMode).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, false);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('已恢复');
    expect(reply).not.toContain('thinkingCard on');
  });

  it('/cot on hints at the master switch when thinkingCard is explicitly off', async () => {
    botWith({ thinkingCard: false });
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot on', deps);
    expect(setCotMode).toHaveBeenCalledWith(LARK_APP_ID, CHAT_ID, false);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('thinkingCard on');
  });

  it('/cot on with an untouched config (default ON) confirms without the master-switch hint', async () => {
    botWith({});
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot on', deps);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('已恢复');
    expect(reply).not.toContain('thinkingCard on');
  });

  it('/cot status reports on / chat-muted / master-off states', async () => {
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot', deps);
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('开启中');

    botWith({ thinkingCard: true, noCotChats: [CHAT_ID] });
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot status', deps);
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[1][1]).toContain('本群已关闭');

    botWith({ thinkingCard: false });
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot status', deps);
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[2][1]).toContain('总开关未开');
    expect(setCotMode).not.toHaveBeenCalled();
  });

  it('unknown subcommand shows usage', async () => {
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot bogus', deps);
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('用法');
    expect(setCotMode).not.toHaveBeenCalled();
  });

  it('/cot show without a live session replies no_active_session', async () => {
    const deps = makeDeps();
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot show', deps);
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('没有活跃');
    expect(handleCotThinkingUpdate).not.toHaveBeenCalled();
  });

  it('/cot show mid-turn: forces the session and renders the cached thinking immediately', async () => {
    botWith({ thinkingCard: false }); // switches off — show overrides anyway
    const ds = makeDaemonSession();
    ds.lastThinkingUpdate = { entries: [{ kind: 'thinking', text: 'so far' }], turnId: 'om_turn9' };
    const deps = makeDeps(ds);
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot show', deps);
    expect(ds.cotForced).toBe(true);
    expect(handleCotThinkingUpdate).toHaveBeenCalledWith(ds, expect.objectContaining({
      type: 'thinking_update',
      turnId: 'om_turn9',
      entries: [{ kind: 'thinking', text: 'so far' }],
    }));
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('已召唤');
  });

  it('/cot show while idle: arms the one-shot force for the next turn', async () => {
    const ds = makeDaemonSession();
    const deps = makeDeps(ds);
    await handleCotCommand(ROOT_ID, LARK_APP_ID, CHAT_ID, 'ou_owner', '/cot show', deps);
    expect(ds.cotForced).toBe(true);
    expect(handleCotThinkingUpdate).not.toHaveBeenCalled();
    expect((deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('下个 turn');
  });
});

describe('/term — operable terminal slash command (operator / canOperate)', () => {
  const ownerMsg = (over: Partial<LarkMessage> = {}) => makeLarkMessage('/term', { senderId: 'ou_owner', ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOwnerOpenId).mockReturnValue('ou_owner');
    vi.mocked(canOperate).mockReturnValue(true);
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('ephemeral');
  });

  it('rejects a non-operator (canOperate=false) and never delivers a card', async () => {
    vi.mocked(canOperate).mockReturnValue(false);
    const deps = makeDeps(makeDaemonSession({ workerPort: 41000, workerToken: 't' }));
    await handleCommand('/term', ROOT_ID, makeLarkMessage('/term', { senderId: 'ou_random' }), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('仅授权用户');
    expect(deliverWritableTerminalCardTo).not.toHaveBeenCalled();
  });

  it('open mode / operator: a non-owner sender passes canOperate and gets the card', async () => {
    // canOperate=true (open mode returns true for everyone) → delivery goes to the
    // actual sender, not a fixed owner.
    const ds = makeDaemonSession({ workerPort: 41000, workerToken: 'wtok' });
    const deps = makeDeps(ds);
    await handleCommand('/term', ROOT_ID, makeLarkMessage('/term', { senderId: 'ou_random' }), deps, LARK_APP_ID);
    expect(deliverWritableTerminalCardTo).toHaveBeenCalledWith(ds, 'ou_random');
  });

  it('rejects when senderOpenId is missing even if canOperate passes (needs a recipient)', async () => {
    const deps = makeDeps(makeDaemonSession({ workerPort: 41000, workerToken: 't' }));
    await handleCommand('/term', ROOT_ID, makeLarkMessage('/term', { senderId: undefined as any }), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('仅授权用户');
    expect(deliverWritableTerminalCardTo).not.toHaveBeenCalled();
  });

  it('owner with no active session gets the no-session notice (no delivery)', async () => {
    const deps = makeDeps(); // no session in the map
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('没有活跃会话');
    expect(deliverWritableTerminalCardTo).not.toHaveBeenCalled();
  });

  it('owner with a live session: delivers to the owner; ephemeral needs no extra reply', async () => {
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('ephemeral');
    const ds = makeDaemonSession({ workerPort: 41000, workerToken: 'wtok' });
    const deps = makeDeps(ds);
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    expect(deliverWritableTerminalCardTo).toHaveBeenCalledWith(ds, 'ou_owner');
    // the visible-to-you card IS the response — no breadcrumb message
    expect(deps.sessionReply).not.toHaveBeenCalled();
  });

  it('DM fallback (topic/p2p) drops a visible breadcrumb pointing at the DM', async () => {
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('dm');
    const deps = makeDeps(makeDaemonSession({ workerPort: 41000, workerToken: 'wtok' }));
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('私信');
  });

  it('terminal not ready → not-ready notice', async () => {
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('not_ready');
    const deps = makeDeps(makeDaemonSession());
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('终端还没就绪');
  });

  it('backend without Web Terminal → unsupported notice', async () => {
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('unsupported');
    const deps = makeDeps(makeDaemonSession({ backendType: 'zmx' }));
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('不提供 Web 终端');
  });

  it('delivery failure → failure notice', async () => {
    vi.mocked(deliverWritableTerminalCardTo).mockResolvedValue('failed');
    const deps = makeDeps(makeDaemonSession({ workerPort: 41000, workerToken: 'wtok' }));
    await handleCommand('/term', ROOT_ID, ownerMsg(), deps, LARK_APP_ID);
    const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(reply).toContain('发送失败');
  });
});
