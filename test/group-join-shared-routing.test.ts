/**
 * 入群主动开工的会话与飞书展示路由回归测试。
 *
 * Run: pnpm vitest run test/group-join-shared-routing.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  forkWorker: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  getChatContext: vi.fn(async (_appId: string, chatId: string) => ({
    chatId,
    name: '【Pippit】【BUG】测试群',
    description: '缺陷：https://example.test/issue/detail/123',
    mode: 'group' as const,
    fetchStatus: 'ok' as const,
  })),
  getProjectScanDirs: vi.fn(() => [] as string[]),
  ensureDefaultOncallBound: vi.fn(async () => undefined),
  downloadResources: vi.fn(async () => ({ attachments: [] as any[], needLogin: false })),
  deleteMessage: vi.fn(async () => true),
  resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
    openId ? { openId, type: 'user' as const, name: 'Owner' } : undefined
  )),
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
    deleteMessage: mocks.deleteMessage,
    getChatContext: mocks.getChatContext,
    listChatMemberOpenIds: mocks.listChatMemberOpenIds,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: mocks.downloadResources,
    ensureSessionWhiteboard: vi.fn(),
    getAvailableBots: mocks.getAvailableBots,
    getProjectScanDirs: mocks.getProjectScanDirs,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: mocks.resolveSender };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/services/oncall-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/oncall-store.js');
  return { ...actual, ensureDefaultOncallBound: mocks.ensureDefaultOncallBound };
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
  modules.daemon.__testOnly_setAutoStartJoinReadyMaxWaitMs();
  vi.clearAllMocks();
  mocks.forkWorker.mockReset();
  mocks.getChatContext.mockImplementation(async (_appId: string, chatId: string) => ({
    chatId,
    name: '【Pippit】【BUG】测试群',
    description: '缺陷：https://example.test/issue/detail/123',
    mode: 'group',
    fetchStatus: 'ok',
  }));
  mocks.getProjectScanDirs.mockReturnValue([]);
  mocks.ensureDefaultOncallBound.mockResolvedValue(undefined);
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.deleteMessage.mockResolvedValue(true);
  mocks.resolveSender.mockImplementation(async (_appId: string, openId: string | undefined) => (
    openId ? { openId, type: 'user', name: 'Owner' } : undefined
  ));
  mocks.listChatMemberOpenIds.mockResolvedValue(['ou_owner']);
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.scanMultipleProjects.mockReturnValue([]);
  mocks.sendMessage.mockResolvedValue('om_join_seed');
});

afterEach(() => {
  modules.daemon.__testOnly_setAutoStartJoinReadyMaxWaitMs();
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
      expect.objectContaining({ turnId: seedId }),
    );
    expect(mocks.getChatContext).toHaveBeenCalledOnce();
    expect(mocks.getChatContext).toHaveBeenCalledWith(appId, chatId);
    const firstTurn = mocks.forkWorker.mock.calls[0]?.[1];
    expect(firstTurn.content).toContain('<chat_context source="lark" trust="untrusted" fetch_status="ok">');
    expect(firstTurn.content).toContain('<name>【Pippit】【BUG】测试群</name>');
    expect(firstTurn.content).toContain('issue/detail/123');
    expect(firstTurn.content).not.toContain('<chat_mode>');
    expect(ds?.pendingChatContext).toBeUndefined();

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

  it('配置 autoStartOnGroupJoinSeed 时 shared 锚点发送自定义文案', async () => {
    const { daemon, registry } = modules;
    const appId = 'app_join_shared_seed';
    const chatId = 'oc_join_shared_seed';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinSeed: '👋 已到岗，开始排查群内线索',
      defaultWorkingDir: tempDir('repo-shared-seed'),
      regularGroupReplyMode: 'shared',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    // daemon 侧取值咬合：自定义 seed 优先于内置 i18n 文案（防止取值逻辑被改坏而测试不报警）。
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      appId,
      chatId,
      '👋 已到岗，开始排查群内线索',
      'text',
    );
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(appId, chatId, '🚀 已加入本群，开始工作…', 'text');
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
      expect.objectContaining({ turnId: 'om_join_seed' }),
    );
  });

  it('群元数据读取失败时仍开工，并明确标记 unavailable', async () => {
    const { daemon, registry } = modules;
    const appId = 'app_join_context_unavailable';
    const chatId = 'oc_join_context_unavailable';
    mocks.getChatContext.mockResolvedValueOnce({
      chatId,
      name: null,
      description: null,
      mode: 'unknown',
      fetchStatus: 'unavailable',
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-context-unavailable'),
      regularGroupReplyMode: 'chat',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    expect(mocks.forkWorker).toHaveBeenCalledOnce();
    const firstTurn = mocks.forkWorker.mock.calls[0]?.[1];
    expect(firstTurn.content).toContain('fetch_status="unavailable"');
    expect(firstTurn.content).toContain('读取失败，不代表群内没有任务');
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
    // 平铺 chat 没有用户消息可锚定，首轮携带 daemon-owned 合成 turn id（join_ 前缀），
    // 而不是 false——否则 worker 发布的 managed_turn_origin 无 turnId，首轮
    // `botmux send` 会被 origin_unproven 拒绝。
    expect(mocks.forkWorker).toHaveBeenCalledWith(
      ds,
      expect.anything(),
      expect.objectContaining({ turnId: expect.stringMatching(/^join_/) }),
    );
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
    expect(ds?.pendingChatContext).toMatchObject({
      chatId,
      name: '【Pippit】【BUG】测试群',
      description: '缺陷：https://example.test/issue/detail/123',
      fetchStatus: 'ok',
    });
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

  it('losing registration leaves no shared seed message or orphaned first turn', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_race';
    const chatId = 'oc_join_shared_race';
    const key = types.sessionKey(chatId, appId);
    const winner = {
      session: {
        sessionId: 'sess-race-winner',
        chatId,
        rootMessageId: chatId,
        title: 'winner',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: appId,
        scope: 'chat',
      },
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: appId,
      chatId,
      chatType: 'group',
      scope: 'chat',
      spawnedAt: Date.now(),
      cliVersion: 'test',
      lastMessageAt: Date.now(),
      hasHistory: true,
    } as any;
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-race'),
      regularGroupReplyMode: 'shared',
    });
    mocks.ensureDefaultOncallBound.mockImplementationOnce(async () => {
      daemon.__testOnly_activeSessions.set(key, winner);
      return undefined;
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    expect(daemon.__testOnly_activeSessions.get(key)).toBe(winner);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('rolls back the registered session when the post-CAS shared seed fails', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_seed_failure';
    const chatId = 'oc_join_shared_seed_failure';
    const key = types.sessionKey(chatId, appId);
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-seed-failure'),
      regularGroupReplyMode: 'shared',
    });
    mocks.sendMessage.mockRejectedValueOnce(new Error('Lark unavailable'));

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    expect(daemon.__testOnly_activeSessions.get(key)).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    expect(daemon.__testOnly_activeSessions.get(key)).toBeDefined();
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });

  it('serializes a chat turn behind the registered join session initialization', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_inbound_race';
    const chatId = 'oc_join_shared_inbound_race';
    const userMessageId = 'om_user_during_join';
    const key = types.sessionKey(chatId, appId);
    let releaseSeed!: (messageId: string) => void;
    const seedPending = new Promise<string>((resolve) => {
      releaseSeed = resolve;
    });
    let seedStarted!: () => void;
    const seedStartedPromise = new Promise<void>((resolve) => {
      seedStarted = resolve;
    });
    mocks.sendMessage.mockImplementationOnce(async () => {
      seedStarted();
      return await seedPending;
    });
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-inbound-race'),
      regularGroupReplyMode: 'shared',
    });

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await seedStartedPromise;
    expect(daemon.__testOnly_activeSessions.get(key)?.worker).toBeNull();

    const replyPromise = daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '加入期间的用户消息' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'chat',
        anchor: chatId,
        replyRootId: userMessageId,
        larkAppId: appId,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.forkWorker).not.toHaveBeenCalled();

    releaseSeed('om_join_seed');
    await Promise.all([joinPromise, replyPromise]);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const ds = daemon.__testOnly_activeSessions.get(key);
    expect(ds?.worker?.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: userMessageId,
    }));
    expect(ds?.session.currentReplyTarget).toMatchObject({
      rootMessageId: userMessageId,
      turnId: userMessageId,
    });
  });

  it('also covers the non-shared post-registration fork window', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_chat_inbound_race';
    const chatId = 'oc_join_chat_inbound_race';
    const userMessageId = 'om_user_during_chat_join';
    const key = types.sessionKey(chatId, appId);
    let releaseAvailableBots!: () => void;
    const availableBotsPending = new Promise<void>((resolve) => {
      releaseAvailableBots = resolve;
    });
    let availableBotsStarted!: () => void;
    const availableBotsStartedPromise = new Promise<void>((resolve) => {
      availableBotsStarted = resolve;
    });
    mocks.getAvailableBots.mockImplementationOnce(async () => {
      availableBotsStarted();
      await availableBotsPending;
      return [];
    });
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-chat-inbound-race'),
      regularGroupReplyMode: 'chat',
    });

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await availableBotsStartedPromise;
    expect(daemon.__testOnly_activeSessions.get(key)?.worker).toBeNull();

    const replyPromise = daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '普通 chat 模式并发消息' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'chat',
        anchor: chatId,
        larkAppId: appId,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.forkWorker).not.toHaveBeenCalled();

    releaseAvailableBots();
    await Promise.all([joinPromise, replyPromise]);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const ds = daemon.__testOnly_activeSessions.get(key);
    expect(ds?.worker?.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: userMessageId,
    }));
  });

  it('yields without re-forking when a non-message entry starts the registered session', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_external_fork_race';
    const chatId = 'oc_join_external_fork_race';
    const key = types.sessionKey(chatId, appId);
    let releaseAvailableBots!: () => void;
    const availableBotsPending = new Promise<void>((resolve) => {
      releaseAvailableBots = resolve;
    });
    let availableBotsStarted!: () => void;
    const availableBotsStartedPromise = new Promise<void>((resolve) => {
      availableBotsStarted = resolve;
    });
    mocks.getAvailableBots.mockImplementationOnce(async () => {
      availableBotsStarted();
      await availableBotsPending;
      return [];
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-external-fork-race'),
      regularGroupReplyMode: 'chat',
    });

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await availableBotsStartedPromise;
    const ds = daemon.__testOnly_activeSessions.get(key)!;
    const externalWorker = { killed: false, send: vi.fn(), pid: 4321 } as any;
    ds.worker = externalWorker;

    releaseAvailableBots();
    await joinPromise;

    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(daemon.__testOnly_activeSessions.get(key)).toBe(ds);
    expect(ds.worker).toBe(externalWorker);
  });

  it('releases a waiting chat turn when shared seed setup rolls back', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_inbound_seed_failure';
    const chatId = 'oc_join_shared_inbound_seed_failure';
    const userMessageId = 'om_user_after_join_seed_failure';
    const key = types.sessionKey(chatId, appId);
    let rejectSeed!: (error: Error) => void;
    const seedPending = new Promise<string>((_resolve, reject) => {
      rejectSeed = reject;
    });
    let seedStarted!: () => void;
    const seedStartedPromise = new Promise<void>((resolve) => {
      seedStarted = resolve;
    });
    mocks.sendMessage.mockImplementationOnce(async () => {
      seedStarted();
      return await seedPending;
    });
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-inbound-seed-failure'),
      regularGroupReplyMode: 'shared',
    });

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await seedStartedPromise;
    const rejectedJoinSessionId = daemon.__testOnly_activeSessions.get(key)?.session.sessionId;

    const replyPromise = daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'seed 失败后仍需处理' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'chat',
        anchor: chatId,
        replyRootId: userMessageId,
        larkAppId: appId,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    rejectSeed(new Error('Lark unavailable during join'));
    await Promise.all([joinPromise, replyPromise]);

    const ds = daemon.__testOnly_activeSessions.get(key);
    expect(ds?.session.sessionId).not.toBe(rejectedJoinSessionId);
    expect(ds?.session.status).toBe('active');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('seed 失败后仍需处理') }),
      expect.objectContaining({ turnId: userMessageId }),
    );
    expect(ds?.session.currentReplyTarget).toMatchObject({
      rootMessageId: userMessageId,
      turnId: userMessageId,
    });
  });

  it('cancels a hung bootstrap so the waiting turn can create the authoritative session', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_inbound_timeout';
    const chatId = 'oc_join_shared_inbound_timeout';
    const userMessageId = 'om_user_after_join_timeout';
    const key = types.sessionKey(chatId, appId);
    let releaseSeed!: (messageId: string) => void;
    const seedPending = new Promise<string>((resolve) => {
      releaseSeed = resolve;
    });
    let seedStarted!: () => void;
    const seedStartedPromise = new Promise<void>((resolve) => {
      seedStarted = resolve;
    });
    mocks.sendMessage.mockImplementationOnce(async () => {
      seedStarted();
      return await seedPending;
    });
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-inbound-timeout'),
      regularGroupReplyMode: 'shared',
    });
    daemon.__testOnly_setAutoStartJoinReadyMaxWaitMs(20);

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await seedStartedPromise;
    const timedOutJoinDs = daemon.__testOnly_activeSessions.get(key)!;
    const timedOutJoinSessionId = timedOutJoinDs.session.sessionId;

    await daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'bootstrap 超时后接管' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'chat',
        anchor: chatId,
        replyRootId: userMessageId,
        larkAppId: appId,
      },
    );

    const ds = daemon.__testOnly_activeSessions.get(key);
    expect(timedOutJoinDs.session.status).toBe('closed');
    expect(ds?.session.sessionId).not.toBe(timedOutJoinSessionId);
    expect(ds?.session.status).toBe('active');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ content: expect.stringContaining('bootstrap 超时后接管') }),
      expect.objectContaining({ turnId: userMessageId }),
    );

    releaseSeed('om_late_join_seed');
    await joinPromise;

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMessage).toHaveBeenCalledWith(appId, 'om_late_join_seed');
    expect(daemon.__testOnly_activeSessions.get(key)).toBe(ds);
  });

  it('does not close a live worker that took over before bootstrap timeout', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_shared_timeout_takeover';
    const chatId = 'oc_join_shared_timeout_takeover';
    const userMessageId = 'om_user_after_external_takeover';
    const key = types.sessionKey(chatId, appId);
    let releaseSeed!: (messageId: string) => void;
    const seedPending = new Promise<string>((resolve) => {
      releaseSeed = resolve;
    });
    let seedStarted!: () => void;
    const seedStartedPromise = new Promise<void>((resolve) => {
      seedStarted = resolve;
    });
    mocks.sendMessage.mockImplementationOnce(async () => {
      seedStarted();
      return await seedPending;
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-shared-timeout-takeover'),
      regularGroupReplyMode: 'shared',
    });
    daemon.__testOnly_setAutoStartJoinReadyMaxWaitMs(20);

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await seedStartedPromise;
    const ds = daemon.__testOnly_activeSessions.get(key)!;
    const externalWorker = { killed: false, send: vi.fn(), pid: 4321 } as any;
    ds.worker = externalWorker;

    await daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '接管后仍要保留 worker' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'chat',
        anchor: chatId,
        replyRootId: userMessageId,
        larkAppId: appId,
      },
    );

    expect(daemon.__testOnly_activeSessions.get(key)).toBe(ds);
    expect(ds.session.status).toBe('active');
    expect(ds.worker).toBe(externalWorker);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(externalWorker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: userMessageId,
    }));

    releaseSeed('om_late_join_seed_after_takeover');
    await joinPromise;

    expect(daemon.__testOnly_activeSessions.get(key)).toBe(ds);
    expect(ds.session.status).toBe('active');
    expect(ds.worker).toBe(externalWorker);
    expect(mocks.deleteMessage).toHaveBeenCalledWith(appId, 'om_late_join_seed_after_takeover');
  });

  it('serializes replies to a topic-group join seed by the exact session key', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_topic_inbound_race';
    const chatId = 'oc_join_topic_inbound_race';
    const seedId = 'om_join_seed';
    const userMessageId = 'om_user_during_topic_join';
    const key = types.sessionKey(seedId, appId);
    mocks.getChatContext.mockImplementationOnce(async (_appId: string, targetChatId: string) => ({
      chatId: targetChatId,
      name: '话题群',
      description: null,
      mode: 'topic',
      fetchStatus: 'ok',
    }));
    let releaseAvailableBots!: () => void;
    const availableBotsPending = new Promise<void>((resolve) => {
      releaseAvailableBots = resolve;
    });
    let availableBotsStarted!: () => void;
    const availableBotsStartedPromise = new Promise<void>((resolve) => {
      availableBotsStarted = resolve;
    });
    mocks.getAvailableBots.mockImplementationOnce(async () => {
      availableBotsStarted();
      await availableBotsPending;
      return [];
    });
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-topic-inbound-race'),
      regularGroupReplyMode: 'shared',
    });

    const joinPromise = daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    await availableBotsStartedPromise;
    expect(daemon.__testOnly_activeSessions.get(key)?.worker).toBeNull();

    const replyPromise = daemon.__testOnly_handleThreadReply(
      {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: userMessageId,
          root_id: seedId,
          thread_id: 'omt_join_topic',
          chat_id: chatId,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'seed 话题内的并发回复' }),
          create_time: String(Date.now()),
        },
      },
      {
        chatId,
        messageId: userMessageId,
        chatType: 'group',
        scope: 'thread',
        anchor: seedId,
        replyRootId: seedId,
        larkAppId: appId,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    releaseAvailableBots();
    await Promise.all([joinPromise, replyPromise]);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const ds = daemon.__testOnly_activeSessions.get(key);
    expect(ds?.worker?.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: userMessageId,
    }));
  });

  it('话题群继续使用 seed 锚定的 thread-scope session', async () => {
    mocks.getChatContext.mockImplementationOnce(async (_appId: string, targetChatId: string) => ({
      chatId: targetChatId,
      name: '话题群',
      description: null,
      mode: 'topic',
      fetchStatus: 'ok',
    }));
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
    // 话题群自动开工：seed 消息 id 即首轮权威 turnId（修复前为 false，首轮回复
    // 发不回飞书）。
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), { turnId: 'om_join_seed' });
  });

  it('话题群配置自定义 seed 时锚点消息用自定义文案', async () => {
    mocks.getChatContext.mockImplementationOnce(async (_appId: string, targetChatId: string) => ({
      chatId: targetChatId,
      name: '话题群',
      description: null,
      mode: 'topic',
      fetchStatus: 'ok',
    }));
    const { daemon, registry } = modules;
    const appId = 'app_join_topic_seed';
    const chatId = 'oc_join_topic_seed';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinSeed: '🔍 已接入，正在读取群内缺陷线索',
      defaultWorkingDir: tempDir('repo-topic-seed'),
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    // thread 锚点发送点同样咬合：话题群路径的自定义 seed 优先于内置文案。
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      appId,
      chatId,
      '🔍 已接入，正在读取群内缺陷线索',
      'text',
    );
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(appId, chatId, '🚀 已加入本群，开始工作…', 'text');
  });

  it('普通群 new-topic 模式开话题并锚定独立 thread-scope session', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_new_topic';
    const chatId = 'oc_join_new_topic';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-new-topic'),
      regularGroupReplyMode: 'new-topic',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    // 普通群（mode='group'）但 reply mode 是 new-topic：应像话题群一样开一个
    // 独立话题（seed + thread-scope），而不是平铺进群顶层 chat-scope。
    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey('om_join_seed', appId));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(ds?.scope).toBe('thread');
    expect(ds?.session.rootMessageId).toBe('om_join_seed');
    // new-topic 是独立会话（非 shared 复用），不 arm shared reply target。
    expect(ds?.session.currentReplyTarget).toBeUndefined();
    // 同话题群：seed 消息 id 即首轮权威 turnId。
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), { turnId: 'om_join_seed' });
  });
});

describe('handleBotAdded — 非 shared 首轮 turn 身份与 provenance', () => {
  // 回归：bot.added 没有用户 message_id，非 shared 自动开工曾以
  // pendingTurnId=undefined fork，worker 发布的 managed_turn_origin 不含
  // turnId，CLI 首轮 `botmux send` 的 managed-origin attestation 被 daemon 以
  // origin_unproven 拒绝（首轮回复发不回飞书）。
  const forkedTurnId = (): string | undefined => {
    const arg = mocks.forkWorker.mock.calls[0]?.[2];
    if (arg && typeof arg === 'object') return (arg as { turnId?: string }).turnId;
    return undefined;
  };

  it('话题群自动开工：seed 即首轮 turnId 且持久化匹配的 turn provenance', async () => {
    mocks.getChatContext.mockImplementationOnce(async (_appId: string, targetChatId: string) => ({
      chatId: targetChatId,
      name: '话题群',
      description: null,
      mode: 'topic',
      fetchStatus: 'ok',
    }));
    const { daemon, registry, types } = modules;
    const appId = 'app_join_topic_turn_id';
    const chatId = 'oc_join_topic_turn_id';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-topic-turn-id'),
      regularGroupReplyMode: 'shared',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey('om_join_seed', appId));
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const forkTurnId = forkedTurnId();
    expect(forkTurnId).toBe('om_join_seed');
    // 持久化了匹配的 turn provenance：per-turn 回复目标 + 冻结的 dispatch 上下文。
    expect(ds?.session.replyTargets?.[forkTurnId!]).toBeDefined();
    expect(ds?.session.turnReplyContexts?.[forkTurnId!]).toMatchObject({
      target: { mode: 'thread', rootMessageId: 'om_join_seed' },
    });
    // 模拟 worker 发布 managed_turn_origin（worker-pool 收到 IPC 后的写入）：
    // 修复前 fork 不带 turnId → managedTurnOrigin.turnId 缺失 → attest 403。
    ds!.managedTurnOrigin = { capability: 'cap-test', turnId: forkTurnId };
    expect(ds?.managedTurnOrigin?.turnId).toBe(forkTurnId);
  });

  it('普通群 new-topic 自动开工：seed 即首轮 turnId 且 provenance 落 thread', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_new_topic_turn_id';
    const chatId = 'oc_join_new_topic_turn_id';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-new-topic-turn-id'),
      regularGroupReplyMode: 'new-topic',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey('om_join_seed', appId));
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const forkTurnId = forkedTurnId();
    expect(forkTurnId).toBe('om_join_seed');
    expect(ds?.session.replyTargets?.[forkTurnId!]).toBeDefined();
    expect(ds?.session.turnReplyContexts?.[forkTurnId!]).toMatchObject({
      target: { mode: 'thread', rootMessageId: 'om_join_seed' },
    });
    ds!.managedTurnOrigin = { capability: 'cap-test', turnId: forkTurnId };
    expect(ds?.managedTurnOrigin?.turnId).toBe(forkTurnId);
  });

  it('平铺 chat 自动开工：合成 join_ turnId 且 provenance 落 plain chat', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_chat_turn_id';
    const chatId = 'oc_join_chat_turn_id';
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-chat-turn-id'),
      regularGroupReplyMode: 'chat',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const forkTurnId = forkedTurnId();
    // 平铺 chat 没有用户消息可锚定：铸造 daemon-owned 合成 turn id（join_ 前缀 +
    // UUID），不冒充 om_ 用户消息 id。
    expect(forkTurnId).toMatch(/^join_[a-f0-9-]{36}$/);
    expect(forkTurnId!.startsWith('om_')).toBe(false);
    expect(ds?.session.replyTargets?.[forkTurnId!]).toBeDefined();
    expect(ds?.session.turnReplyContexts?.[forkTurnId!]).toMatchObject({
      target: { mode: 'plain', chatId },
    });
    // 合成 turn 不写 currentReplyTarget（无 reply root）。
    expect(ds?.session.currentReplyTarget).toBeUndefined();
    ds!.managedTurnOrigin = { capability: 'cap-test', turnId: forkTurnId };
    expect(ds?.managedTurnOrigin?.turnId).toBe(forkTurnId);
  });

  it('无默认目录走 repo 选择卡：thread scope 延迟首轮仍携带 seed turnId', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_picker_thread_turn_id';
    const chatId = 'oc_join_picker_thread_turn_id';
    const scanDir = tempDir('scan-picker-thread-turn-id');
    mocks.getProjectScanDirs.mockReturnValueOnce([scanDir]);
    mocks.scanMultipleProjects.mockReturnValueOnce([{
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
      regularGroupReplyMode: 'new-topic',
      // 关闭对等继承：本文件前序用例在持久化 session store 里留下了同锚点
      // (om_join_seed) 且带 workingDir 的会话，否则会被 findInheritablePeer
      // 继承成 pinned dir，绕过 repo 选择卡路径。
      botToBotSameDir: false,
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    // 延迟启动：不立即 fork，首轮 turn 身份同时落在 pendingTurnId 与持久化的
    // pendingRepoSetup.turnId 上——commitRepoSelection 的 deferred fork 二选一
    // 都必须拿到 seed id（修复前 staged 的是 anchor=seed 但 pendingTurnId 为
    // undefined，且 chat scope 下 anchor 是 oc_ chatId，会被当成 turnId 发出去）。
    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey('om_join_seed', appId));
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds?.pendingRepo).toBe(true);
    expect(ds?.pendingTurnId).toBe('om_join_seed');
    expect(ds?.session.pendingRepoSetup?.turnId).toBe('om_join_seed');
    expect(ds?.session.replyTargets?.['om_join_seed']).toBeDefined();
    expect(ds?.session.turnReplyContexts?.['om_join_seed']).toMatchObject({
      target: { mode: 'thread', rootMessageId: 'om_join_seed' },
    });
  });

  it('无默认目录走 repo 选择卡：chat scope 延迟首轮携带 join_ turnId 而非 oc_ chatId', async () => {
    const { daemon, registry, types } = modules;
    const appId = 'app_join_picker_chat_turn_id';
    const chatId = 'oc_join_picker_chat_turn_id';
    const scanDir = tempDir('scan-picker-chat-turn-id');
    mocks.getProjectScanDirs.mockReturnValueOnce([scanDir]);
    mocks.scanMultipleProjects.mockReturnValueOnce([{
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
      regularGroupReplyMode: 'chat',
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    const ds = daemon.__testOnly_activeSessions.get(types.sessionKey(chatId, appId));
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds?.pendingRepo).toBe(true);
    // 修复前 staged turnId 是 anchor=oc_ chatId（把 chatId 当 turnId 发出）；
    // 修复后两处都是 daemon-owned 合成 id。
    expect(ds?.pendingTurnId).toMatch(/^join_[a-f0-9-]{36}$/);
    expect(ds?.session.pendingRepoSetup?.turnId).toBe(ds?.pendingTurnId);
    const joinTurnId = ds!.pendingTurnId!;
    expect(ds?.session.replyTargets?.[joinTurnId]).toBeDefined();
    expect(ds?.session.turnReplyContexts?.[joinTurnId]).toMatchObject({
      target: { mode: 'plain', chatId },
    });
  });

  it('provenance 持久化失败时回滚会话注册，下次 bot.added 不被去重', async () => {
    // 回归：首轮 turn provenance 的 sessionStore.updateSession 若抛错（文件系统/
    // 数据库瞬态失败），会话已发布到 activeSessions 且 groupJoinAnchorByChat 已
    // 登记。修复前 finally 只 settle barrier/释放 in-flight 锁，留下 active 但
    // worker-null 的会话，后续 bot.added 被无限去重，自动开工无法重试。
    const { daemon, registry, types } = modules;
    const sessionStore = await import('../src/services/session-store.js');
    const appId = 'app_join_provenance_persist_failure';
    const chatId = 'oc_join_provenance_persist_failure';
    const key = types.sessionKey(chatId, appId);
    registry.registerBot({
      larkAppId: appId,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '开始排查',
      defaultWorkingDir: tempDir('repo-provenance-persist-failure'),
      regularGroupReplyMode: 'chat',
    });

    // 只在「带 turn provenance 的那次落盘」上注入一次瞬态失败（ENOSPC 替身）：
    // 注册前的初始字段落盘不带 replyTargets，照常透传。
    const realUpdateSession = sessionStore.updateSession;
    let failedOnce = false;
    let failedSessionId: string | undefined;
    const updateSpy = vi.spyOn(sessionStore, 'updateSession').mockImplementation((s) => {
      if (!failedOnce && s.replyTargets && Object.keys(s.replyTargets).length > 0) {
        failedOnce = true;
        failedSessionId = s.sessionId;
        throw new Error('ENOSPC: no space left on device');
      }
      return realUpdateSession(s);
    });

    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);

    // 回滚：会话从 activeSessions 移除、store 记录被 close、没有 fork——
    // 不留下 worker-null 的 active 会话。
    expect(failedOnce).toBe(true);
    expect(daemon.__testOnly_activeSessions.get(key)).toBeUndefined();
    expect(sessionStore.getSession(failedSessionId!)?.status).toBe('closed');
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    updateSpy.mockRestore();

    // 重试：下一次 bot.added 不被去重，正常注册并 fork。
    await daemon.__testOnly_handleBotAdded(chatId, 'ou_owner', appId);
    expect(daemon.__testOnly_activeSessions.get(key)).toBeDefined();
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
  });
});
