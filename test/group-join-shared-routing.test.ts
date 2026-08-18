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
});

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
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), false);
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
    expect(mocks.forkWorker).toHaveBeenCalledWith(ds, expect.anything(), false);
  });
});
