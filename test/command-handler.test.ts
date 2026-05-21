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
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
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
  },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app-1',
      larkAppSecret: 'secret-1',
      cliId: 'claude-code' as const,
      workingDir: '~/projects',
      workingDirs: ['~/projects'],
    },
  })),
  getAllBots: vi.fn(() => [
    {
      config: {
        larkAppId: 'app-1',
        larkAppSecret: 'secret-1',
        cliId: 'claude-code' as const,
        workingDir: '~/projects',
      },
    },
  ]),
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
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildRepoSelectCard: vi.fn(() => '{"card":"json"}'),
  buildAdoptSelectCard: vi.fn(() => '{"card":"adopt-select"}'),
  buildSessionClosedCard: vi.fn(
    (sid: string) =>
      `{"header":{"title":{"content":"🛑 会话已关闭"}},"action":"resume","cmd":"botmux resume ${sid.substring(0, 12)}"}`,
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
  getCurrentCliVersion: vi.fn(() => '1.0.42'),
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
}));

vi.mock('../src/core/session-discovery.js', () => ({
  discoverAdoptableSessions: vi.fn(() => []),
  validateAdoptTarget: vi.fn(() => true),
}));

vi.mock('../src/utils/user-token.js', () => ({
  generateAuthUrl: vi.fn(() => ({ authUrl: 'https://open.feishu.cn/auth/v1/test' })),
  getTokenStatus: vi.fn(() => 'User token: active'),
}));

vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: vi.fn(() => ({ ok: true, created: true })),
  unbindOncall: vi.fn(() => ({ ok: true })),
  getOncallStatus: vi.fn(() => undefined),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, handleCommand, parseSlashCommandInvocation, parseForceTopicInvocation } from '../src/core/command-handler.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { killWorker, forkWorker, getCurrentCliVersion } from '../src/core/worker-pool.js';
import { getSessionWorkingDir } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import * as scheduler from '../src/core/scheduler.js';
import { deleteMessage } from '../src/im/lark/client.js';
import { generateAuthUrl, getTokenStatus } from '../src/utils/user-token.js';
import { bindOncall } from '../src/services/oncall-store.js';
import { existsSync, statSync } from 'node:fs';
import { scanMultipleProjects } from '../src/services/project-scanner.js';
import { discoverAdoptableSessions } from '../src/core/session-discovery.js';

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
    activeSessions.set(sessionKey(ROOT_ID, LARK_APP_ID), ds);
  }
  return {
    activeSessions,
    sessionReply: vi.fn(async () => 'reply-msg-id'),
    getActiveCount: vi.fn(() => activeSessions.size),
    lastRepoScan: new Map(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DAEMON_COMMANDS set', () => {
  it('should contain all expected commands', () => {
    const expected = ['/close', '/restart', '/status', '/help', '/cd', '/repo', '/skip', '/schedule', '/login', '/adopt', '/oncall'];
    for (const cmd of expected) {
      expect(DAEMON_COMMANDS.has(cmd), `Expected DAEMON_COMMANDS to contain ${cmd}`).toBe(true);
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
    expect(DAEMON_COMMANDS.size).toBe(11);
  });
});

describe('PASSTHROUGH_COMMANDS set', () => {
  it('should contain expected slash commands forwarded to CLI', () => {
    for (const cmd of ['/compact', '/model', '/clear', '/plugin', '/usage']) {
      expect(PASSTHROUGH_COMMANDS.has(cmd), `Expected PASSTHROUGH_COMMANDS to contain ${cmd}`).toBe(true);
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
      // /close now replies with an interactive card carrying a Resume button
      // and a copyable `botmux resume <id>` command — assert on the card shape
      // rather than the legacy plain text.
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
      expect(replyContent).toContain('http://localhost:8080');
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
  });

  // ─── /skip ──────────────────────────────────────────────────────────────

  describe('/skip', () => {
    it('should reply no pending repo when not waiting for selection', async () => {
      const ds = makeDaemonSession({ pendingRepo: false });
      const deps = makeDeps(ds);

      await handleCommand('/skip', ROOT_ID, makeLarkMessage('/skip'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('当前没有待选择的仓库');
    });

    it('should reply no pending repo when session does not exist', async () => {
      const deps = makeDeps();

      await handleCommand('/skip', ROOT_ID, makeLarkMessage('/skip'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('当前没有待选择的仓库');
    });
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

      expect(generateAuthUrl).toHaveBeenCalledWith('app-1', 'secret-1');
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
