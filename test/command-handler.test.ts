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
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => '/home/testuser') };
});

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    daemon: { workingDir: '~', projectScanDir: '' },
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
  parseNaturalSchedule: vi.fn(),
  getNextRun: vi.fn(),
  addTask: vi.fn(),
}));

vi.mock('../src/services/project-scanner.js', () => ({
  scanProjects: vi.fn(() => []),
  scanMultipleProjects: vi.fn(() => []),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildRepoSelectCard: vi.fn(() => '{"card":"json"}'),
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

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionCost: vi.fn(),
  formatNumber: vi.fn((n: number) => n.toLocaleString()),
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
}));

vi.mock('../src/utils/user-token.js', () => ({
  generateAuthUrl: vi.fn(() => ({ authUrl: 'https://open.feishu.cn/auth/v1/test' })),
  getTokenStatus: vi.fn(() => 'User token: active'),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { DAEMON_COMMANDS, handleCommand } from '../src/core/command-handler.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage, Session } from '../src/types.js';
import { killWorker, forkWorker, getCurrentCliVersion } from '../src/core/worker-pool.js';
import { getSessionCost } from '../src/core/cost-calculator.js';
import { getSessionWorkingDir } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import * as scheduler from '../src/core/scheduler.js';
import { deleteMessage } from '../src/im/lark/client.js';
import { generateAuthUrl, getTokenStatus } from '../src/utils/user-token.js';
import { existsSync } from 'node:fs';
import { scanMultipleProjects } from '../src/services/project-scanner.js';

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
    const expected = ['/close', '/clear', '/restart', '/status', '/help', '/cd', '/repo', '/skip', '/cost', '/schedule', '/login', '/adopt'];
    for (const cmd of expected) {
      expect(DAEMON_COMMANDS.has(cmd), `Expected DAEMON_COMMANDS to contain ${cmd}`).toBe(true);
    }
  });

  it('should not contain unknown commands', () => {
    expect(DAEMON_COMMANDS.has('/unknown')).toBe(false);
    expect(DAEMON_COMMANDS.has('/exit')).toBe(false);
  });

  it('should have the correct size', () => {
    expect(DAEMON_COMMANDS.size).toBe(12);
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
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('会话已关闭'),
        undefined,
        LARK_APP_ID,
      );
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

  // ─── /clear ─────────────────────────────────────────────────────────────

  describe('/clear', () => {
    it('should kill worker, close old session, create new session', async () => {
      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/clear', ROOT_ID, makeLarkMessage('/clear'), deps, LARK_APP_ID);

      expect(killWorker).toHaveBeenCalledWith(ds);
      expect(sessionStore.closeSession).toHaveBeenCalledWith('sess-001');
      expect(sessionStore.createSession).toHaveBeenCalledWith(CHAT_ID, ROOT_ID, 'Test Session', 'group');
      expect(ds.session.sessionId).toBe('new-session-123');
      expect(ds.hasHistory).toBe(false);
      expect(deps.sessionReply).toHaveBeenCalledWith(
        ROOT_ID,
        expect.stringContaining('上下文已清除'),
        undefined,
        LARK_APP_ID,
      );
    });

    it('should reply no-session message when session does not exist', async () => {
      const deps = makeDeps();

      await handleCommand('/clear', ROOT_ID, makeLarkMessage('/clear'), deps, LARK_APP_ID);

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
      expect(replyContent).toContain('/cost');
      expect(replyContent).toContain('/status');
      expect(replyContent).toContain('/help');
      expect(replyContent).toContain('/schedule');
      expect(replyContent).toContain('/login');
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

    it('should reject paths outside home directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cd', ROOT_ID, makeLarkMessage('/cd /etc/secrets'), deps, LARK_APP_ID);

      expect(killWorker).not.toHaveBeenCalled();
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('路径必须在用户主目录');
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

  // ─── /cost ──────────────────────────────────────────────────────────────

  describe('/cost', () => {
    it('should show cost data when available', async () => {
      vi.mocked(getSessionCost).mockReturnValue({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheCreateTokens: 100,
        model: 'claude-sonnet-4-20250514',
        turns: 3,
      });

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cost', ROOT_ID, makeLarkMessage('/cost'), deps, LARK_APP_ID);

      expect(getSessionCost).toHaveBeenCalledWith('sess-001', '/home/testuser/projects');
      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('sess-001');
      expect(replyContent).toContain('claude-sonnet-4-20250514');
      expect(replyContent).toContain('Turns: 3');
    });

    it('should show not-found message when cost data is missing', async () => {
      vi.mocked(getSessionCost).mockReturnValue(null as any);

      const ds = makeDaemonSession();
      const deps = makeDeps(ds);

      await handleCommand('/cost', ROOT_ID, makeLarkMessage('/cost'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('未找到会话');
    });

    it('should reply no-session when session does not exist', async () => {
      const deps = makeDeps();

      await handleCommand('/cost', ROOT_ID, makeLarkMessage('/cost'), deps, LARK_APP_ID);

      const replyContent = (deps.sessionReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(replyContent).toContain('没有活跃的会话');
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
          type: 'cron',
          schedule: '50 17 * * *',
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
