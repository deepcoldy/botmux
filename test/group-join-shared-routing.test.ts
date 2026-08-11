/**
 * 入群主动开工的会话与飞书展示路由回归测试。
 *
 * Run: pnpm vitest run test/group-join-shared-routing.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forkWorker: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
  getProjectScanDirs: vi.fn(() => [] as string[]),
  listChatMemberOpenIds: vi.fn(async () => ['ou_owner']),
  replyMessage: vi.fn(async () => 'om_reply'),
  scanMultipleProjects: vi.fn(() => [] as Array<{ name: string; path: string; type: 'repo' | 'worktree'; branch: string }>),
  sendMessage: vi.fn(async () => 'om_join_seed'),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    getChatMode: mocks.getChatMode,
    listChatMemberOpenIds: mocks.listChatMemberOpenIds,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    ensureSessionWhiteboard: vi.fn(),
    getAvailableBots: mocks.getAvailableBots,
    getProjectScanDirs: mocks.getProjectScanDirs,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
});

let tempRoot = '';
let modules: Awaited<ReturnType<typeof loadModules>>;

function tempDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadModules() {
  const registry = await import('../src/bot-registry.js');
  const sessionStore = await import('../src/services/session-store.js');
  const daemon = await import('../src/daemon.js');
  const types = await import('../src/core/types.js');
  sessionStore.init();
  return { daemon, registry, types };
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'botmux-group-join-shared-'));
  process.env.SESSION_DATA_DIR = tempDir('sessions');
  modules = await loadModules();
}, 30_000);

beforeEach(() => {
  modules.registry.__testOnly_resetBotRegistry();
  modules.daemon.__testOnly_activeSessions.clear();
  vi.clearAllMocks();
  mocks.getChatMode.mockResolvedValue('group');
  mocks.getProjectScanDirs.mockReturnValue([]);
  mocks.listChatMemberOpenIds.mockResolvedValue(['ou_owner']);
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.scanMultipleProjects.mockReturnValue([]);
  mocks.sendMessage.mockResolvedValue('om_join_seed');
});

afterAll(() => {
  delete process.env.SESSION_DATA_DIR;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('handleBotAdded — 普通群 shared 路由', () => {
  it('创建一个话题根并复用 chat-scope session', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared';
    const chatId = 'oc_join_shared';
    const seedId = 'om_join_seed';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '处理群内未完成请求',
      defaultWorkingDir: tempDir('repo-shared'),
      regularGroupReplyMode: 'shared',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      appId,
      chatId,
      '🚀 已加入本群，开始工作…',
      'text',
    );
    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(ds).toBeDefined();
    expect(ds?.scope).toBe('chat');
    expect(ds?.session.rootMessageId).toBe(chatId);
    expect(ds?.session.currentReplyTarget).toMatchObject({
      rootMessageId: seedId,
      turnId: seedId,
    });
    expect(ds?.pendingTurnId).toBeUndefined();
    expect(mocks.forkWorker).toHaveBeenCalledWith(
      ds,
      expect.anything(),
      { turnId: seedId },
    );

    await daemon.__testOnly_sessionReply(chatId, '最终回复', 'text', appId, seedId);
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      appId,
      seedId,
      '最终回复',
      'text',
      true,
      undefined,
      expect.anything(),
    );
  });

  it('尊重群级 shared 覆盖而不是只读取 bot 默认值', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_override';
    const chatId = 'oc_join_override';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-override'),
      regularGroupReplyMode: 'chat',
      chatReplyModes: { [chatId]: 'shared' },
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(ds?.scope).toBe('chat');
    expect(ds?.session.currentReplyTarget?.rootMessageId).toBe('om_join_seed');
    expect(mocks.forkWorker).toHaveBeenCalledWith(
      ds,
      expect.anything(),
      { turnId: 'om_join_seed' },
    );
  });

  it('chat 模式保持群顶层平铺且不创建话题根', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_chat';
    const chatId = 'oc_join_chat';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-chat'),
      regularGroupReplyMode: 'chat',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(ds?.scope).toBe('chat');
    expect(ds?.session.currentReplyTarget).toBeUndefined();
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), false);
  });

  it('等待仓库选择时把卡片和延迟首轮留在同一个话题', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_pending_repo';
    const chatId = 'oc_join_pending_repo';
    const scanDir = tempDir('scan-pending-repo');
    mocks.getProjectScanDirs.mockReturnValue([scanDir]);
    mocks.scanMultipleProjects.mockReturnValue([{
      name: 'botmux',
      path: scanDir,
      type: 'repo',
      branch: 'master',
    }]);
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      regularGroupReplyMode: 'shared',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(ds?.pendingRepo).toBe(true);
    expect(ds?.pendingTurnId).toBe('om_join_seed');
    expect(ds?.repoCardMessageId).toBe('om_reply');
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      appId,
      'om_join_seed',
      expect.any(String),
      'interactive',
      true,
      undefined,
      expect.anything(),
    );
  });

  it('话题群继续使用 seed 锚定的 thread-scope session', async () => {
    mocks.getChatMode.mockResolvedValue('topic');
    const { daemon, registry, types } = modules;
    const appId = 'app_join_topic_group';
    const chatId = 'oc_join_topic_group';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-topic-group'),
      regularGroupReplyMode: 'shared',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey('om_join_seed', appId));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(ds?.scope).toBe('thread');
    expect(ds?.session.rootMessageId).toBe('om_join_seed');
    expect(ds?.session.currentReplyTarget).toBeUndefined();
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), false);
  });
});
