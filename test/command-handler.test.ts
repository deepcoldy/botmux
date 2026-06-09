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
    daemon: { workingDir: '~' },
    session: { dataDir: '/fake/data' },
  },
}));

// Mock role/profile stores so /role routing tests assert on calls (no real FS).
vi.mock('../src/core/role-resolver.js', () => ({
  writeRoleFile: vi.fn(),
  deleteRoleFile: vi.fn(() => true),
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
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  createSession: vi.fn((_chatId: string, _rootId: string, title: string, chatType: string) => ({
    sessionId: 'new-session-123',
    chatId: _chatId,
    rootMessageId: _rootId,
    title,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    chatType,
  })),
  updateSession: vi.fn(),
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
}));

vi.mock('../src/services/project-scanner.js', () => ({
  scanProjects: vi.fn(() => []),
  scanMultipleProjects: vi.fn(() => []),
  describeProjectDir: vi.fn(() => null),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildRepoSelectCard: vi.fn(() => '{"card":"json"}'),
  buildAdoptSelectCard: vi.fn(() => '{"card":"adopt-select"}'),
  buildCodexAppThreadSelectCard: vi.fn(() => '{"card":"codex-app-thread-select"}'),
  buildSessionClosedCard: vi.fn(
    (sid: string) =>
      `{"header":{"title":{"content":"🛑 会话已关闭"}},"action":"resume","cmd":"botmux resume ${sid.substring(0, 12)}"}`,
  ),
  buildSlashListCard: vi.fn((params: any) => JSON.stringify(params)),
  buildRelayPickerCard: vi.fn(
    (entries: any[], targetChatId: string, rootMessageId: string, _invokerOpenId?: string, _locale?: any, _state?: any, targetScope?: string) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: entries.length === 0 ? [
          { tag: 'markdown', content: 'empty' },
        ] : entries.map((e: any) => ({
          tag: 'interactive_container',
          behaviors: [{
            type: 'callback',
            value: { action: 'relay_select', session_id: e.sessionId, target_chat_id: targetChatId, root_id: rootMessageId, target_scope: targetScope ?? 'chat' },
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
  deleteMessage: vi.fn(),
  sendMessage: vi.fn(async () => 'card-msg-id'),
  listChatBotMembers: vi.fn(async () => []),
  // Tests can override per-scenario via vi.mocked(getChatName).mockResolvedValue(...).
  // Default returns null so picker entries fall back to raw chatId.
  getChatName: vi.fn(async () => null),
  getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
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
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  getCurrentCliVersion: vi.fn(() => '1.0.42'),
  // /close routes the「会话已关闭」card through this: ephemeral (visible-to-you)
  // when the chat supports it, else the visible reply fallback. The stub just
  // invokes the fallback so the existing card-shape assertions (on sessionReply)
  // still hold — topic-group behaviour, where ephemeral is unavailable.
  deliverEphemeralOrReply: vi.fn(async (_ds: any, _op: any, _content: string, _type: string, reply: () => Promise<unknown>) => { await reply(); }),
  transferSession: vi.fn(async () => ({ ok: true })),
  // /relay --create empty-leader path closes the scratch via this; default
  // resolves as idempotent close so unrelated tests don't need to think
  // about it.
  closeSession: vi.fn(async () => ({ ok: true, alreadyClosed: false })),
  // `isRelayableRealSession(ds)` — true when ds.worker is set OR persisted
  // CLI markers exist (session.cliId / session.lastCliInput). The default
  // makeSession fixture sets cliId='claude-code' so most tests pass the
  // predicate; empty-leader tests override `cliId: undefined`. We use the
  // real implementation here (not a vi.fn stub) so the predicate's branch
  // logic is genuinely exercised in every /relay --create scenario.
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
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
  getAvailableBots: vi.fn(async () => []),
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

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { DAEMON_COMMANDS, SESSIONLESS_DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, handleCommand, parseSlashCommandInvocation, parseForceTopicInvocation } from '../src/core/command-handler.js';
import { writeTeamRoleFile, deleteTeamRoleFile, resolveRole } from '../src/core/role-resolver.js';
import { setBotCapability, clearBotCapability } from '../src/services/bot-profile-store.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import { setTerminalProxyPort } from '../src/core/terminal-url.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { killWorker, forkWorker, getCurrentCliVersion, deliverEphemeralOrReply } from '../src/core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicPrompt } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import * as scheduler from '../src/core/scheduler.js';
import { deleteMessage, sendMessage, listChatBotMembers } from '../src/im/lark/client.js';
import { buildSlashListCard } from '../src/im/lark/card-builder.js';
import { createGroupWithBots } from '../src/services/group-creator.js';
import { getAllBots, getBot } from '../src/bot-registry.js';
import { generateAuthUrl, getTokenStatus } from '../src/utils/user-token.js';
import { bindOncall } from '../src/services/oncall-store.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { scanMultipleProjects } from '../src/services/project-scanner.js';
import { discoverAdoptableSessions } from '../src/core/session-discovery.js';
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

function makeDeps(ds?: DaemonSession): CommandHandlerDeps {
  const activeSessions = new Map<string, DaemonSession>();
  if (ds) {
    activeSessions.set(sessionKey(ROOT_ID, ds.larkAppId), ds);
  }
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
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
    const expected = ['/close', '/restart', '/status', '/help', '/cd', '/repo', '/schedule', '/role', '/botconfig', '/pair', '/login', '/adopt', '/detach', '/disconnect', '/oncall', '/group', '/g', '/relay', '/card', '/list-slash-command', '/slash'];
    for (const cmd of expected) {
      expect(DAEMON_COMMANDS.has(cmd), `Expected DAEMON_COMMANDS to contain ${cmd}`).toBe(true);
    }
  });

  it('should no longer contain the removed /skip command (folded into bare /repo)', () => {
    expect(DAEMON_COMMANDS.has('/skip')).toBe(false);
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
    expect(DAEMON_COMMANDS.size).toBe(22);
  });

  it('contains the /list-slash-command lister and its /slash alias', () => {
    expect(DAEMON_COMMANDS.has('/list-slash-command')).toBe(true);
    expect(DAEMON_COMMANDS.has('/slash')).toBe(true);
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
      expect.objectContaining({ id: 'codex', skillsDir: '~/.codex/skills' }),
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
  });

  it('is a subset of DAEMON_COMMANDS (they are still daemon-handled)', () => {
    for (const cmd of SESSIONLESS_DAEMON_COMMANDS) {
      expect(DAEMON_COMMANDS.has(cmd), `${cmd} must also be a daemon command`).toBe(true);
    }
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

describe('PASSTHROUGH_COMMANDS set', () => {
  it('should contain expected slash commands forwarded to CLI', () => {
    for (const cmd of ['/compact', '/model', '/clear', '/plugin', '/usage', '/context', '/cost', '/mcp', '/diff', '/btw']) {
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
    vi.mocked(getBot).mockImplementation(defaultGetBot as any);
    vi.mocked(listCodexAppThreads).mockResolvedValue([]);
  });

  // ─── /close ─────────────────────────────────────────────────────────────

  describe('/close', () => {
    it('should kill worker and remove session when session exists', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/close', ROOT_ID, makeLarkMessage('/close'), deps, LARK_APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessionStore.closeSession).toHaveBeenCalledWith('sess-001');
      expect(deps.activeSessions.has(sessionKey(ROOT_ID, LARK_APP_ID))).toBe(false);
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
      );
      // /close now replies with an interactive card carrying a Resume button
      // and a copyable `botmux resume <id>` command — assert on the card shape
      // rather than the legacy plain text. (Here via the visible-reply fallback.)
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('会话已关闭'),
        'interactive',
        LARK_APP_ID,
      );
      const replyArgs = (deps.sessionReply as any).mock.calls[0];
      const cardJson = replyArgs[1] as string;
      expect(cardJson).toContain('botmux resume');
      expect(cardJson).toContain('"action":"resume"');
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
      );
    });
  });

  // ─── /restart ───────────────────────────────────────────────────────────

  describe('/restart', () => {
    it('should send restart IPC when worker is alive', async () => {
      const workerSend = vi.fn();
      const ds = makeDaemonSession({
        worker: { killed: false, send: workerSend } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(workerSend).toHaveBeenCalledWith({ type: 'restart' });
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('正在重启'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('should kill dead worker and reply recovery message when worker is already killed', async () => {
      const ds = makeDaemonSession({
        worker: { killed: true, send: vi.fn() } as any,
      });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('进程已终止'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('should kill null worker and reply recovery message when no worker', async () => {
      const ds = makeDaemonSession({ worker: null });
      const deps = makeDeps(ds);

      await handleCommand('/restart', ROOT_ID, makeLarkMessage('/restart'), deps, LARK_APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('进程已终止'),
        undefined,
        LARK_APP_ID,
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
      expect(replyContent).toContain('/status');
      expect(replyContent).toContain('/help');
      expect(replyContent).toContain('/schedule');
      expect(replyContent).toContain('/login');
      expect(replyContent).toContain('/compact'); // passthrough list
      expect(replyContent).toContain('/model');
      expect(replyContent).toContain('Claude'); // CLI display name
    });

    it('renders the passthrough list straight from PASSTHROUGH_COMMANDS (no drift)', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/help', ROOT_ID, makeLarkMessage('/help'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      // /help renders [...PASSTHROUGH_COMMANDS].join(' '); guard against anyone
      // re-hardcoding a stale list that drifts from the set.
      expect(replyContent).toContain([...PASSTHROUGH_COMMANDS].join(' '));
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

    it('should reply directory not found when path does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /nonexistent/path'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('目录不存在');
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

  // ─── /repo ──────────────────────────────────────────────────────────────

  describe('/repo', () => {
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
      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessionStore.closeSession).toHaveBeenCalled();
      expect(sessionStore.createSession).toHaveBeenCalledWith(
        CHAT_ID, ROOT_ID, 'project-b (dev)', 'group',
      );
      expect(ds.session.sessionId).toBe('new-session-123');
      expect(ds.hasHistory).toBe(false);
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
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
      );
    });

    it('should resolve a first-level project name and switch repo (mid-session)', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(scanMultipleProjects).mockReturnValue([
        { name: 'payments', path: '/home/testuser/payments', branch: 'main' },
      ]);
      const ds = makeDaemonSession({ pendingRepo: false, repoCardMessageId: 'om_card' });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo payments'), deps, LARK_APP_ID);

      expect(ds.workingDir).toBe('/home/testuser/payments');
      expect(sessionStore.createSession).toHaveBeenCalledWith(
        CHAT_ID, ROOT_ID, 'payments (main)', 'group',
      );
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      // the pending repo-selection card must be withdrawn after resolving
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'om_card');
      expect(ds.repoCardMessageId).toBeUndefined();
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

  // ─── bare /repo while pending (replaces the old /skip command) ────────────

  describe('/repo (bare) while pending', () => {
    it('should boot the CLI idle (no prompt submitted) when launched via /repo itself', async () => {
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: '', repoCardMessageId: 'om_card' });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      // No buffered message → spawn idle with an empty prompt so the user's NEXT
      // message becomes the first prompt (not an empty/boilerplate user_message).
      expect(forkWorker).toHaveBeenCalledWith(ds, '', false);
      expect(buildNewTopicPrompt).not.toHaveBeenCalled();
      expect(killWorker).not.toHaveBeenCalled();
      expect(sessionStore.createSession).not.toHaveBeenCalled();
      // Cleared pending state + withdrew the (already-sent) card.
      expect(ds.pendingRepo).toBe(false);
      expect(ds.pendingPrompt).toBeUndefined();
      expect(deleteMessage).toHaveBeenCalledWith(LARK_APP_ID, 'om_card');
      expect(ds.repoCardMessageId).toBeUndefined();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('已直接开启会话');
      // Did NOT fall through to the card-display scan path.
      expect(scanMultipleProjects).not.toHaveBeenCalled();
    });

    it('should still submit a buffered first message when bare /repo skips the card', async () => {
      // Normal flow: real first message → card shown → user types bare /repo to
      // skip. The buffered message must be delivered, not dropped.
      const ds = makeDaemonSession({ pendingRepo: true, pendingPrompt: '帮我看看这个 bug' });
      const deps = makeDeps(ds);

      await handleCommand('/repo', ROOT_ID, makeLarkMessage('/repo'), deps, LARK_APP_ID);

      // The buffered message is wrapped (mock → `WRAPPED:<prompt>`) and forked.
      expect(buildNewTopicPrompt).toHaveBeenCalled();
      expect((buildNewTopicPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('帮我看看这个 bug');
      expect(forkWorker).toHaveBeenCalledWith(ds, 'WRAPPED:帮我看看这个 bug');
      expect(ds.pendingRepo).toBe(false);
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

    it('should reject /oncall bind on a non-existent path', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand(
        '/oncall',
        ROOT_ID,
        makeLarkMessage('/oncall bind /nonexistent/path'),
        deps,
        LARK_APP_ID,
      );

      expect(bindOncall).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('目录不存在');
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

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      // Reply was an interactive card (msgType='interactive') with v2 schema.
      const [, replyContent, msgType] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(msgType).toBe('interactive');
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

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const [, replyContent] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      const card = JSON.parse(replyContent as string);
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

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const [, replyContent] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      const card = JSON.parse(replyContent as string);
      // No interactive containers rendered — picker is empty after filtering out the adopt session.
      expect(card.body.elements.filter((e: any) => e.tag === 'interactive_container')).toHaveLength(0);
    });

    it('picker refuses upfront in p2p chats (chatType local check)', async () => {
      // p2p (1:1 with bot) has no relay concept; relay-picker entry refuses
      // before rendering. Detection is via ds.chatType — no Lark API hit.
      const ds = makeDaemonSession({
        session: makeSession({ ownerOpenId: 'ou_sender', chatType: 'p2p' }),
        chatType: 'p2p',
      });
      const deps = makeDeps(ds);

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(reply).toMatch(/单聊不支持|not supported in direct/);
      // Picker MUST NOT have rendered.
      expect(reply).not.toContain('选择要接力');
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

      const [, replyContent, msgType] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(msgType).toBe('interactive');
      expect(String(replyContent)).not.toMatch(/话题群不支持|not supported in topic/);
      const card = JSON.parse(replyContent as string);
      const containerValue = card.body.elements.find((e: any) => e.tag === 'interactive_container')?.behaviors?.[0]?.value;
      expect(containerValue?.target_scope).toBe('thread');
      // 话题群 top-level → anchor = the /relay message id (makeLarkMessage → 'msg_001').
      expect(containerValue?.root_id).toBe('msg_001');
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

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
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

      const reply = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
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

      await handleCommand('/relay', ROOT_ID, makeLarkMessage('/relay'), deps, LARK_APP_ID);

      const [, replyContent] = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0];
      const card = JSON.parse(replyContent as string);
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
});
