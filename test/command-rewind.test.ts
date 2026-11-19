/**
 * Integration tests for /rewind in command-handler: real filesystem and real
 * context-rewind module; daemon collaborators mocked (same harness as
 * command-retry.test.ts).
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
const { sendWorkerInput, forkWorker, rememberLastCliInput, suspendWorker, killWorker, rewindState, backendState, pruneRuns } = vi.hoisted(() => ({
  pruneRuns: [] as Promise<void>[],
  suspendWorker: vi.fn<(ds: any, reason?: string) => boolean>(),
  killWorker: vi.fn<(ds: any) => void>(),
  rewindState: { jsonl: '' as string, truncateError: '' as string, treeRoot: '' as string },
  backendState: { backingType: undefined as string | undefined, probe: 'missing' as string, killThrows: false },
  sendWorkerInput: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  forkWorker: vi.fn<(ds: any, payload: any, hasHistory?: any) => boolean>(),
  rememberLastCliInput: vi.fn<(ds: any, userPrompt: string, cliInput: any, opts?: any) => void>(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  dshRuntimeForSession: vi.fn((): 'official' | 'tui' | undefined => undefined),
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

vi.mock('../src/services/transcript-resolver.js', () => ({
  resolveSessionTranscriptPath: vi.fn(() => (rewindState.jsonl
    ? { path: rewindState.jsonl, kind: 'claude', ...(rewindState.treeRoot ? { writableTreeRoot: rewindState.treeRoot } : {}) }
    : null)),
}));

// Default-delegate to the real module; a test can arm rewindState.truncateError
// to make the truncation step itself throw (backup target occupied, …) so the
// pre-cut replay-state rollback can be asserted through the real handler.
vi.mock('../src/core/context-rewind.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/context-rewind.js')>();
  return {
    ...actual,
    withOpenTranscript: <T,>(...[path, scope, use]: Parameters<typeof actual.withOpenTranscript<T>>) =>
      actual.withOpenTranscript(path, scope, transcript => use({
        scan: transcript.scan,
        cut: (...cut: Parameters<typeof transcript.cut>) => {
          if (rewindState.truncateError) throw new Error(rewindState.truncateError);
          return transcript.cut(...cut);
        },
      })),
  };
});
vi.mock('../src/core/shared-adopt.js', () => ({ isSharedAdoptSession: vi.fn(() => false) }));
// The real backup pruning, each run collected so a test can await it.
vi.mock('../src/core/rewind-backup-retention.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/rewind-backup-retention.js')>();
  return {
    ...actual,
    pruneRewindBackupsBeside: (...args: Parameters<typeof actual.pruneRewindBackupsBeside>) => {
      const pruning = actual.pruneRewindBackupsBeside(...args);
      pruneRuns.push(pruning);
      return pruning;
    },
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { rewindBackupDirForSession, rewindBackupSuffix } from '../src/core/rewind-backup-retention.js';
import { handleCommand, resetPendingRewindPreviewsForTest } from '../src/core/command-handler.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { config } from '../src/config.js';
import { updateSession } from '../src/services/session-store.js';

const LARK_APP_ID = 'app-1';
const ROOT_ID = 'om_root_rw';
const CHAT_ID = 'oc_chat_rw';

const dirs: string[] = [];
const userTurn = (text: string, uuid: string) => ({
  type: 'user', uuid, timestamp: '2026-10-31T01:00:00.000Z',
  message: { role: 'user', content: `<user_message>\n${text}\n</user_message>` },
});
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const line = (v: unknown) => `${JSON.stringify(v)}\n`;

function transcript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-rewind-cmd-'));
  dirs.push(dir);
  const path = join(dir, 'native.jsonl');
  writeFileSync(path, [
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'native' },
    userTurn('A', 'uA'), assistant('a'),
    userTurn('B', 'uB'), assistant('b'),
    userTurn('C', 'uC'), assistant('c'),
  ].map(line).join(''));
  return path;
}

/** Replace `path` with a FIFO and start a writer that opens it after `delaySec`.
 *  A blocking open on the read side then returns once the writer shows up
 *  instead of freezing the test process forever, so a regression fails on the
 *  elapsed-time / reply assertions rather than hanging the run. */
const fifoWriters: ChildProcess[] = [];
function replaceWithFifo(path: string, delaySec: number): void {
  rmSync(path, { force: true });
  const mk = spawnSync('mkfifo', [path]);
  if (mk.status !== 0) throw new Error(`mkfifo failed: ${mk.stderr}`);
  fifoWriters.push(spawn('sh', ['-c', `sleep ${delaySec}; exec 3>"$1"`, 'sh', path], { stdio: 'ignore' }));
}

/** Fake worker: exits (async) only when told to; while "alive" it can still append. */
class FakeWorker extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exit(): void { this.exitCode = 0; this.emit('exit', 0, null); }
}

function makeDs(cliId: Session['cliId'] = 'claude-code', worker: FakeWorker | null = null): DaemonSession {
  return {
    session: {
      sessionId: 'sess-rw', chatId: CHAT_ID, rootMessageId: ROOT_ID, title: 't', status: 'active',
      createdAt: new Date().toISOString(), cliId, cliSessionId: 'native',
      lastUserPrompt: 'C', lastCliInput: { content: 'C' } as any,
    },
    worker: worker as any, workerPort: null, workerToken: null, scope: 'thread', larkAppId: LARK_APP_ID,
    chatId: CHAT_ID, chatType: 'group', spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true,
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

function makeDeps(ds: DaemonSession) {
  const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT_ID, ds.larkAppId), ds]]);
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
    prewarmDocCommentSession: vi.fn(async () => {}),
  } satisfies CommandHandlerDeps & { sessionReply: unknown };
}

const msg = (content: string): LarkMessage => ({
  messageId: 'msg_rw', rootId: ROOT_ID, senderId: 'ou_sender', senderType: 'user', msgType: 'text', content, createTime: String(Date.now()),
});
const run = (deps: ReturnType<typeof makeDeps>, content: string) => handleCommand('/rewind', ROOT_ID, msg(content), deps, LARK_APP_ID);
const lastReply = (deps: ReturnType<typeof makeDeps>) => String(deps.sessionReply.mock.calls.at(-1)?.[1] ?? '');
const remainingUserTexts = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(e => e.type === 'user').map(e => /\n(.*)\n/.exec(e.message.content)?.[1]);

beforeEach(() => {
  vi.clearAllMocks();
  resetPendingRewindPreviewsForTest();
  backendState.backingType = undefined;
  backendState.probe = 'missing';
  backendState.killThrows = false;
  suspendWorker.mockImplementation((ds: any) => { ds.worker = null; return true; });
});
afterEach(async () => {
  // Only the writers this file spawned; one still blocked in open() is killed.
  for (const w of fifoWriters.splice(0)) if (w.exitCode === null && w.signalCode === null) w.kill('SIGKILL');
  await Promise.allSettled(pruneRuns.splice(0));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rewindState.jsonl = '';
  rewindState.truncateError = '';
  rewindState.treeRoot = '';
});

describe('/rewind command', () => {
  it('非 Claude Code 会话明确拒绝，不动任何文件', async () => {
    rewindState.jsonl = transcript();
    const before = readFileSync(rewindState.jsonl, 'utf8');
    for (const cli of ['codex', 'gemini'] as const) {
      const deps = makeDeps(makeDs(cli));
      await run(deps, '/rewind 1 confirm');
      expect(lastReply(deps)).toContain('仅支持 Claude Code');
    }
    expect(readFileSync(rewindState.jsonl, 'utf8')).toBe(before);
    expect(suspendWorker).not.toHaveBeenCalled();
  });

  it('未预览直接 confirm 只给预览，不截断', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回复 `/rewind 1 confirm` 执行');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
    expect(suspendWorker).not.toHaveBeenCalled();
  });

  it('预览 → confirm：截掉该轮及之后，备份完整，清掉 replay 状态与中断轮日志', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs();
    const deps = makeDeps(ds);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-data-'));
    dirs.push(dataDir);
    (config.session as any).dataDir = dataDir;
    const journalPath = join(dataDir, 'turn-marks', `${ds.session.sessionId}.json`);
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, '[]');

    await run(deps, '/rewind 2');
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('已回退');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A']);
    const bak = readdirSync(dirname(rewindState.jsonl)).find(n => n.endsWith('.bak'))!;
    expect(readFileSync(join(dirname(rewindState.jsonl), bak), 'utf8')).toContain('"uC"');
    expect(ds.session.lastUserPrompt).toBeUndefined();
    expect(ds.session.lastCliInput).toBeUndefined();
    expect(existsSync(journalPath)).toBe(false);
  });

  it('预览后来了新一轮：confirm 拒绝（moved），不多删', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    appendFileSync(rewindState.jsonl, line(userTurn('D', 'uD')) + line(assistant('d')));
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('停 CLI 期间又落了一轮：锁内重扫发现序号漂移，拒绝（moved）', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      appendFileSync(rewindState.jsonl, line(userTurn('D', 'uD')));
      return true;
    });
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('第一轮之前不可回退（resume 会失败并换新会话）', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 3');
    expect(lastReply(deps)).toContain('第一轮');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
  });

  it('worker 退出前写入的最后一行不会落在截断点之后', async () => {
    rewindState.jsonl = transcript();
    const worker = new FakeWorker();
    const ds = makeDs('claude-code', worker);
    const deps = makeDeps(ds);
    await run(deps, '/rewind 1');
    // Worker keeps writing for a while after suspend (longer than the 500ms
    // quiet window would tolerate without the exit wait), then exits.
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      setTimeout(() => appendFileSync(rewindState.jsonl, line(assistant('late'))), 900);
      setTimeout(() => worker.exit(), 1000);
      return true;
    });
    await run(deps, '/rewind 1 confirm');
    // Assert only after the late write could have landed.
    await new Promise(r => setTimeout(r, 1200));
    expect(lastReply(deps)).toContain('已回退');
    const text = readFileSync(rewindState.jsonl, 'utf8');
    expect(text).not.toContain('late');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B']);
  }, 20_000);

  it('预览后改发别的序号 confirm：拒绝（moved）且不截断', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
    expect(suspendWorker).not.toHaveBeenCalled();
  });

  it('suspend 返回 false（如 pty 后端）时 killWorker 兜底把 CLI 停掉', async () => {
    rewindState.jsonl = transcript();
    const worker = new FakeWorker();
    const ds = makeDs('claude-code', worker);
    const deps = makeDeps(ds);
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation(() => false);
    killWorker.mockImplementation((d: any) => {
      d.worker = null;
      setTimeout(() => worker.exit(), 5);
    });
    try {
      await run(deps, '/rewind 1 confirm');
      expect(killWorker).toHaveBeenCalledTimes(1);
      expect(lastReply(deps)).toContain('已回退');
      expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B']);
    } finally {
      killWorker.mockReset();
    }
  });

  it('停掉 CLI 后 transcript 消失：明确回报失败，不会零回复', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      rmSync(rewindState.jsonl, { force: true });
      return true;
    });
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
  });

  it('扫描时 transcript 已不存在：明确回复而不是静默', async () => {
    rewindState.jsonl = transcript();
    rmSync(rewindState.jsonl, { force: true });
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind');
    expect(lastReply(deps)).toContain('找不到当前会话的 transcript');
  });

  it('会话记录是软链：列表和预览都回复失败，链接目标的内容不进回复', async () => {
    const target = transcript();
    writeFileSync(target, line(userTurn('LINK_TARGET_TEXT', 'uT')) + line(assistant('t')) + line(userTurn('LINK_TARGET_2', 'uT2')));
    rewindState.jsonl = join(dirname(target), 'link.jsonl');
    symlinkSync(target, rewindState.jsonl);
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind');
    await run(deps, '/rewind 1');
    const replies = deps.sessionReply.mock.calls.map(c => String((c as unknown[])[1]));
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply).toContain('回退失败');
      expect(reply).not.toContain('LINK_TARGET');
    }
  });

  it.skipIf(process.platform === 'win32')('会话记录是命名管道：立即回复失败，不卡在管道上', async () => {
    rewindState.jsonl = transcript();
    // The late writer only keeps a blocking regression from hanging the run:
    // it then reads an empty pipe and lists nothing. Blocking itself is pinned
    // by the child-process test in context-rewind.test.ts.
    replaceWithFifo(rewindState.jsonl, 15);
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind');
    expect(lastReply(deps)).toContain('回退失败');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('停 CLI 后会话记录被换成命名管道：确认时的重扫回复失败，不卡住', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      replaceWithFifo(rewindState.jsonl, 15);
      return true;
    });
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
  }, 60_000);

  it('锁内重扫之后、截断之前路径被删掉重建成同内容的文件：拒绝截断，新文件不动', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    // Same bytes; deleting and recreating can hand the new file the old inode
    // number, so only the descriptor held since the re-scan tells them apart.
    const replacement = readFileSync(rewindState.jsonl, 'utf8');
    (updateSession as any).mockImplementationOnce(() => {
      rmSync(rewindState.jsonl);
      writeFileSync(rewindState.jsonl, replacement);
    });
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(readFileSync(rewindState.jsonl, 'utf8')).toBe(replacement);
    expect(readdirSync(dirname(rewindState.jsonl)).filter(n => n.endsWith('.bak'))).toEqual([]);
  });

  it('会话记录在 CLI 可写的树里：备份写进 daemon 数据目录，树里不留备份', async () => {
    rewindState.jsonl = transcript();
    rewindState.treeRoot = dirname(dirname(rewindState.jsonl));
    const ds = makeDs();
    const deps = makeDeps(ds);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-data-'));
    dirs.push(dataDir);
    (config.session as any).dataDir = dataDir;
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('已回退');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B']);
    const backupDir = join(dataDir, 'rewind-backups', ds.session.sessionId);
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(lastReply(deps)).toContain(join(backupDir, backups[0]!));
    expect(readFileSync(join(backupDir, backups[0]!), 'utf8')).toContain('"uC"');
    expect(readdirSync(dirname(rewindState.jsonl)).filter(n => n.endsWith('.bak'))).toEqual([]);
  });

  it('会话记录的项目目录在解析后被换成指向外部的链接：列表与确认都回复失败，外部内容不进回复、外部文件不被截断', async () => {
    rewindState.jsonl = transcript();
    const projectDir = dirname(rewindState.jsonl);
    rewindState.treeRoot = dirname(projectDir);
    const outside = mkdtempSync(join(tmpdir(), 'botmux-rewind-outside-'));
    dirs.push(outside);
    const outsideFile = join(outside, 'native.jsonl');
    writeFileSync(outsideFile, line(userTurn('OUTSIDE_TEXT', 'uA')) + line(assistant('x')) + line(userTurn('OUTSIDE_B', 'uB'))
      + line(assistant('y')) + line(userTurn('OUTSIDE_C', 'uC')) + line(assistant('z')));
    const swapProjectDir = () => {
      rmSync(`${projectDir}.aside`, { recursive: true, force: true });
      renameSync(projectDir, `${projectDir}.aside`);
      symlinkSync(outside, projectDir);
    };
    const deps = makeDeps(makeDs());
    // Preview on the real tree, then the swap while the CLI is being stopped.
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation((d: any) => { d.worker = null; swapProjectDir(); return true; });
    const outsideBefore = readFileSync(outsideFile, 'utf8');
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(readFileSync(outsideFile, 'utf8')).toBe(outsideBefore);
    expect(readdirSync(outside)).toEqual(['native.jsonl']);
    // A fresh listing through the swapped tree fails the same way.
    await run(deps, '/rewind');
    expect(lastReply(deps)).toContain('回退失败');
    for (const call of deps.sessionReply.mock.calls) expect(String((call as unknown[])[1])).not.toContain('OUTSIDE');
  });

  it('截断前持久化 replay 状态失败：拒绝回退且文件不动', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/rewind 2');
    updateSession.mockImplementationOnce(() => { throw new Error('sqlite busy'); });
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(lastReply(deps)).toContain('sqlite busy');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
    // In-memory replay fields were restored, so the failed attempt is invisible.
    expect(ds.session.lastUserPrompt).toBe('C');
  });

  it('截断成功但中断轮日志删除失败：仍报完成并告警，文件确实截断', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs();
    const deps = makeDeps(ds);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-data-'));
    dirs.push(dataDir);
    (config.session as any).dataDir = dataDir;
    const journalPath = join(dataDir, 'turn-marks', `${ds.session.sessionId}.json`);
    // A directory in place of the journal file makes plain rmSync throw (EISDIR).
    mkdirSync(journalPath, { recursive: true });

    await run(deps, '/rewind 2');
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('已回退');
    expect(lastReply(deps)).toContain('日志清理失败');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A']);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('持久后端 kill 抛错：fail-closed 拒绝且文件不动', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs('claude-code', null);
    const deps = makeDeps(ds);
    backendState.backingType = 'tmux';
    backendState.killThrows = true;
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(lastReply(deps)).toContain('could not verify');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
  });

  it('截断自身失败：回复失败、文件不动、replay 字段回滚', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs();
    const deps = makeDeps(ds);
    await run(deps, '/rewind 2');
    rewindState.truncateError = 'backup target occupied';
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(lastReply(deps)).toContain('backup target occupied');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
    // Replay state was persisted-clear then restored, so /retry keeps its input.
    expect(ds.session.lastUserPrompt).toBe('C');
  });

  it('成功回执发送失败：不回报失败，纯文本兜底仍送达备份路径', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs();
    const deps = makeDeps(ds);
    let replyCalls = 0;
    deps.sessionReply.mockImplementation(async () => {
      replyCalls += 1;
      // Preview is call 1; the done notice (call 2) fails like an expired root.
      if (replyCalls === 2) throw new Error('lark 400 root expired');
      return 'reply-msg-id';
    });
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 1 confirm');
    const allReplies = deps.sessionReply.mock.calls.map(c => String(c[1] ?? ''));
    expect(allReplies.some(r => r.includes('回退失败'))).toBe(false);
    expect(allReplies.at(-1)).toContain('.bak');
    expect(allReplies.at(-1)).toContain('已成功回退');
    // The rewind itself still landed.
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B']);
  });

  it('预览后会话又被 compact：锁内重扫发现目标落在压缩点之前，拒绝（moved）', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 1');
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      appendFileSync(rewindState.jsonl, line({ type: 'system', subtype: 'compact_boundary' }));
      return true;
    });
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
  });

  it('预览后目标轮退化成第一轮（不可 resume）：锁内拒绝（moved）', async () => {
    rewindState.jsonl = transcript();
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind 2');
    suspendWorker.mockImplementation((d: any) => {
      d.worker = null;
      writeFileSync(rewindState.jsonl, [
        { type: 'permission-mode', permissionMode: 'default' },
        userTurn('B', 'uB'), assistant('b'),
        userTurn('C', 'uC'), assistant('c'),
      ].map(line).join(''));
      return true;
    });
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
  });

  it('无 worker 但持久后端 pane 仍存活：探针非 missing 时拒绝截断', async () => {
    rewindState.jsonl = transcript();
    // worker-less session whose tmux pane survived (crash before lazy reattach).
    const ds = makeDs('claude-code', null);
    const deps = makeDeps(ds);
    backendState.backingType = 'tmux';
    backendState.probe = 'exists';
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(lastReply(deps)).toContain('still present');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
  });

  it('无 worker 且持久后端探针不确定（unknown）：同样 fail-closed 拒绝', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs('claude-code', null);
    const deps = makeDeps(ds);
    backendState.backingType = 'tmux';
    backendState.probe = 'unknown';
    await run(deps, '/rewind 1');
    await run(deps, '/rewind 1 confirm');
    expect(lastReply(deps)).toContain('回退失败');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A', 'B', 'C']);
  });

  it('无 worker 但持久后端确认已消失（missing）：正常完成回退', async () => {
    rewindState.jsonl = transcript();
    const ds = makeDs('claude-code', null);
    const deps = makeDeps(ds);
    backendState.backingType = 'tmux';
    backendState.probe = 'missing';
    await run(deps, '/rewind 2');
    await run(deps, '/rewind 2 confirm');
    expect(lastReply(deps)).toContain('已回退');
    expect(remainingUserTexts(rewindState.jsonl)).toEqual(['A']);
  });

  it('列表展示上限与可接受序号一致：15 轮只列、只接受 1–10', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rewind-cmd-'));
    dirs.push(dir);
    const manyPath = join(dir, 'native.jsonl');
    const rows: unknown[] = [{ type: 'permission-mode', permissionMode: 'default' }];
    for (let i = 1; i <= 15; i += 1) {
      rows.push(userTurn(`T${i}`, `uT${i}`), assistant(`r${i}`));
    }
    writeFileSync(manyPath, rows.map(line).join(''));
    rewindState.jsonl = manyPath;
    const deps = makeDeps(makeDs());
    await run(deps, '/rewind');
    expect(lastReply(deps)).toContain('最近 10 个检查点');
    expect(lastReply(deps)).toContain('T6');
    expect(lastReply(deps)).not.toContain('T5');
    await run(deps, '/rewind 15');
    expect(lastReply(deps)).toContain('1–10');
    await run(deps, '/rewind 10');
    expect(lastReply(deps)).toContain('回复 `/rewind 10 confirm` 执行');
  });

  describe('回退备份的保留（#3572）', () => {
    const DAY = 24 * 60 * 60_000;
    /** A backup a cut of `transcriptPath` made `ageMs` ago, last written then. */
    const seedBackup = (dir: string, transcriptPath: string, ageMs: number, kind: 'full' | 'removed' = 'full') => {
      const at = Date.now() - ageMs;
      const path = join(dir, `${basename(transcriptPath)}${rewindBackupSuffix(at, kind)}`);
      writeFileSync(path, 'old backup');
      utimesSync(path, at / 1000, at / 1000);
      return path;
    };

    it('确认回退之后清理会话记录旁边的旧备份：过期的删掉，新的和未过期的留下，别的文件不动', async () => {
      rewindState.jsonl = transcript();
      const dir = dirname(rewindState.jsonl);
      const expired = seedBackup(dir, rewindState.jsonl, 30 * DAY);
      const expiredRemoved = seedBackup(dir, rewindState.jsonl, 8 * DAY, 'removed');
      const young = seedBackup(dir, rewindState.jsonl, 2 * DAY);
      const stranger = join(dir, 'notes.bak');
      writeFileSync(stranger, 'keep');
      utimesSync(stranger, (Date.now() - 30 * DAY) / 1000, (Date.now() - 30 * DAY) / 1000);
      const deps = makeDeps(makeDs());
      await run(deps, '/rewind 1');
      // A preview cuts nothing and prunes nothing.
      expect(pruneRuns).toHaveLength(0);
      await run(deps, '/rewind 1 confirm');
      expect(lastReply(deps)).toContain('已回退');
      expect(pruneRuns).toHaveLength(1);
      await Promise.all(pruneRuns);
      expect(existsSync(expired)).toBe(false);
      expect(existsSync(expiredRemoved)).toBe(false);
      const left = readdirSync(dir);
      const backup = left.find(name => name.endsWith('.bak') && name !== basename(young) && name !== 'notes.bak')!;
      // The new backup holds what the confirm cut.
      expect(lastReply(deps)).toContain(join(dir, backup));
      expect(readFileSync(join(dir, backup), 'utf8')).toContain('"uC"');
      expect(left.sort()).toEqual(['native.jsonl', basename(young), backup, 'notes.bak'].sort());
    });

    it('剪切一落地就登记会话记录旁边的目录（周期清扫找得到）；回执发出之前不清理', async () => {
      rewindState.jsonl = transcript();
      const dir = dirname(rewindState.jsonl);
      const expired = seedBackup(dir, rewindState.jsonl, 30 * DAY);
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-data-'));
      dirs.push(dataDir);
      (config.session as any).dataDir = dataDir;
      const deps = makeDeps(makeDs());
      await run(deps, '/rewind 1');
      // The done receipt hangs (a slow Lark API).
      let releaseReceipt!: () => void;
      deps.sessionReply.mockImplementation(async (...args: unknown[]) => {
        if (String(args[1]).includes('已回退')) await new Promise<void>(resolve => { releaseReceipt = resolve; });
        return 'reply-msg-id';
      });
      const confirming = run(deps, '/rewind 1 confirm');
      await vi.waitFor(() => expect(readdirSync(join(dataDir, 'rewind-backup-places'))).toHaveLength(1));
      const [marker] = readdirSync(join(dataDir, 'rewind-backup-places'));
      expect(readFileSync(join(dataDir, 'rewind-backup-places', marker!), 'utf8')).toBe(dir);
      await vi.waitFor(() => expect(releaseReceipt).toBeTypeOf('function'));
      expect(pruneRuns).toHaveLength(0);
      expect(existsSync(expired)).toBe(true);
      releaseReceipt();
      await confirming;
      await Promise.all(pruneRuns);
      expect(pruneRuns).toHaveLength(1);
      expect(existsSync(expired)).toBe(false);
    });

    it('会话记录在 CLI 可写的树里：清理 daemon 数据目录里这个会话的备份目录', async () => {
      rewindState.jsonl = transcript();
      rewindState.treeRoot = dirname(dirname(rewindState.jsonl));
      const ds = makeDs();
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-rewind-data-'));
      dirs.push(dataDir);
      (config.session as any).dataDir = dataDir;
      const backupDir = rewindBackupDirForSession(dataDir, ds.session.sessionId);
      mkdirSync(backupDir, { recursive: true });
      const expired = seedBackup(backupDir, rewindState.jsonl, 30 * DAY, 'removed');
      const otherSession = rewindBackupDirForSession(dataDir, 'sess-other');
      mkdirSync(otherSession, { recursive: true });
      const otherExpired = seedBackup(otherSession, rewindState.jsonl, 30 * DAY);
      const deps = makeDeps(ds);
      await run(deps, '/rewind 1');
      await run(deps, '/rewind 1 confirm');
      expect(lastReply(deps)).toContain('已回退');
      await Promise.all(pruneRuns);
      expect(existsSync(expired)).toBe(false);
      const left = readdirSync(backupDir);
      expect(left).toHaveLength(1);
      expect(lastReply(deps)).toContain(join(backupDir, left[0]!));
      // Another session's directory is the periodic sweep's business.
      expect(existsSync(otherExpired)).toBe(true);
    });

    it('回退没做成（预览后会话记录又多了一轮）：不清理', async () => {
      rewindState.jsonl = transcript();
      const expired = seedBackup(dirname(rewindState.jsonl), rewindState.jsonl, 30 * DAY);
      const deps = makeDeps(makeDs());
      await run(deps, '/rewind 1');
      appendFileSync(rewindState.jsonl, line(userTurn('D', 'uD')) + line(assistant('d')));
      await run(deps, '/rewind 1 confirm');
      expect(lastReply(deps)).toContain('找不到原来选中的那一轮');
      expect(pruneRuns).toHaveLength(0);
      expect(existsSync(expired)).toBe(true);
    });
  });
});
