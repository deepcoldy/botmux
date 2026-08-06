/**
 * Route-level regression coverage for the first-mention asynchronous repo scan.
 *
 * Run: pnpm vitest run test/daemon-repo-scan-routing.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-repo-scan-route-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;

  let sessionSeq = 0;
  const scanDeferreds: Array<{
    promise: Promise<any[]>;
    resolve: (projects: any[]) => void;
    reject: (error: unknown) => void;
  }> = [];
  const scanMultipleProjectsAsync = vi.fn(() => {
    let resolve!: (projects: any[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<any[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    scanDeferreds.push({ promise, resolve, reject });
    return promise;
  });

  return {
    addReaction: vi.fn(async () => 'reaction_received'),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => ({
      sessionId: `sess-repo-scan-${++sessionSeq}`,
      chatId,
      rootMessageId,
      title,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      chatType,
    })),
    deleteMessage: vi.fn(async () => true),
    downloadResources: vi.fn(async () => ({ attachments: [] as any[], needLogin: false })),
    forkWorker: vi.fn(),
    getAvailableBots: vi.fn(async () => [] as any[]),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    getProjectScanDirs: vi.fn(() => ['/tmp']),
    replyMessage: vi.fn(async () => 'om_reply'),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    scanDeferreds,
    scanMultipleProjectsAsync,
    sendMessage: vi.fn(async () => 'om_top'),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    addReaction: mocks.addReaction,
    deleteMessage: mocks.deleteMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
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
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/services/project-scanner-async.js', () => ({
  scanMultipleProjectsAsync: mocks.scanMultipleProjectsAsync,
}));

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import { __resetAnchorQueues, serializeByAnchor } from '../src/utils/anchor-serializer.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';

const APP = 'repo_scan_route_app';
const CHAT = 'oc_repo_scan_route_chat';
const OWNER = 'ou_repo_scan_owner';

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function project(name = 'botmux'): any {
  return {
    name,
    path: `/tmp/${name}`,
    type: 'repo' as const,
    branch: 'main',
  };
}

function outboundCalls(msgType?: string): any[][] {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .filter(call => msgType === undefined || call[3] === msgType);
}

function outboundText(): string {
  return outboundCalls('text').map(call => String(call[2] ?? '')).join('\n');
}

async function startPendingScan(anchor: string, text = '请分析这个需求') {
  const route = handleNewTopic(makeEventData(anchor, text), makeCtx(anchor, anchor));
  await vi.waitFor(() => expect(mocks.scanMultipleProjectsAsync).toHaveBeenCalledTimes(1));
  const ds = activeSessions.get(sessionKey(anchor, APP));
  expect(ds).toBeDefined();
  return { route, ds: ds!, scan: mocks.scanDeferreds[0]! };
}

async function waitForScanFinish(ds: { repoScanInFlight?: boolean }): Promise<void> {
  await vi.waitFor(() => expect(ds.repoScanInFlight).toBe(false));
}

describe('first-mention async repo scan routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanDeferreds.length = 0;
    activeSessions.clear();
    __resetAnchorQueues();
    __testOnly_resetBotRegistry();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      workingDirs: ['/tmp'],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('reports scan progress before the child resolves, then posts the picker without consuming pendingRepo', async () => {
    const { route, ds, scan } = await startPendingScan('om_scan_projects');
    await route;

    expect(outboundText()).toContain('正在扫描仓库');
    expect(outboundCalls('interactive')).toHaveLength(0);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoScanInFlight).toBe(true);

    scan.resolve([project()]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.repoCardMessageId).toBe('om_reply');
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoScanInFlight).toBe(false);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('buffers a same-user follow-up during the scan and still posts the picker after resolution', async () => {
    const anchor = 'om_scan_followup_root';
    const { route, ds, scan } = await startPendingScan(anchor, '首轮请求');
    await route;

    await handleThreadReply(
      makeEventData('om_scan_followup', '扫描期间补充', anchor),
      makeCtx(anchor, 'om_scan_followup'),
    );

    expect(ds.pendingFollowUps).toEqual(['扫描期间补充']);
    expect(outboundText().match(/正在扫描仓库/g)?.length).toBe(2);
    expect(outboundCalls('interactive')).toHaveLength(0);
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    scan.resolve([project('flow_android')]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingFollowUps).toEqual(['扫描期间补充']);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('releases the production-shaped anchor queue while the child is still scanning', async () => {
    const anchor = 'om_scan_serialized_followup';
    const first = serializeByAnchor(
      anchor,
      () => handleNewTopic(makeEventData(anchor, '首轮请求'), makeCtx(anchor, anchor)),
    );
    await vi.waitFor(() => expect(mocks.scanMultipleProjectsAsync).toHaveBeenCalledTimes(1));
    const ds = activeSessions.get(sessionKey(anchor, APP))!;
    await first;
    expect(ds.repoScanInFlight).toBe(true);

    await serializeByAnchor(
      anchor,
      () => handleThreadReply(
        makeEventData('om_scan_serialized_followup_2', '扫描期间的排队补充', anchor),
        makeCtx(anchor, 'om_scan_serialized_followup_2'),
      ),
    );

    expect(ds.pendingFollowUps).toEqual(['扫描期间的排队补充']);
    expect(outboundText().match(/正在扫描仓库/g)?.length).toBe(2);

    mocks.scanDeferreds[0]!.resolve([project('serialized-flow')]);
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the active route is deleted',
      invalidate: (anchor: string, _ds: any) => activeSessions.delete(sessionKey(anchor, APP)),
    },
    {
      name: 'pendingRepo is consumed',
      invalidate: (_anchor: string, ds: any) => { ds.pendingRepo = false; },
    },
  ])('drops a late scan result when $name', async ({ invalidate }) => {
    const anchor = `om_late_${mocks.scanDeferreds.length}_${Math.random().toString(36).slice(2)}`;
    const { route, ds, scan } = await startPendingScan(anchor);

    invalidate(anchor, ds);
    scan.resolve([project('late-project')]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(0);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.repoScanInFlight).toBe(false);
  });

  it('keeps the pending input recoverable with /repo when the scan child rejects', async () => {
    const { route, ds, scan } = await startPendingScan('om_scan_reject', '不能丢的首轮请求');

    scan.reject(new Error('scanner child crashed'));
    await route;
    await waitForScanFinish(ds);

    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('不能丢的首轮请求');
    expect(ds.repoScanInFlight).toBe(false);
    expect(outboundText()).toContain('/repo');
    expect(outboundCalls('interactive')).toHaveLength(0);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('lets bare /repo consume the pending turn while the child is scanning and never reforks', async () => {
    const anchor = 'om_scan_bare_repo';
    const { route, ds, scan } = await startPendingScan(anchor, '直接开始的首轮请求');

    await handleThreadReply(
      makeEventData('om_scan_bare_repo_command', '/repo', anchor),
      makeCtx(anchor, 'om_scan_bare_repo_command'),
    );

    expect(ds.pendingRepo).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);

    scan.resolve([project('late-after-bare-repo')]);
    await route;
    await waitForScanFinish(ds);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(outboundCalls('interactive')).toHaveLength(0);
    expect(ds.repoScanInFlight).toBe(false);
  });

  it.each([
    {
      name: 'the route is consumed',
      invalidate: (ds: any) => { ds.pendingRepo = false; },
    },
    {
      name: 'a repo commit takes ownership',
      invalidate: (ds: any) => { ds.pendingRepoCommitInFlight = true; },
    },
  ])('does not post stale /repo recovery text when $name during card delivery', async ({ invalidate }) => {
    const { route, ds, scan } = await startPendingScan('om_scan_card_delivery_race');
    await route;
    let rejectCard!: (error: unknown) => void;
    const cardDelivery = new Promise<string>((_resolve, reject) => {
      rejectCard = reject;
    });
    mocks.replyMessage.mockImplementation((...args: any[]) => (
      args[3] === 'interactive' ? cardDelivery : Promise.resolve('om_reply')
    ));

    scan.resolve([project('delivery-race')]);
    await vi.waitFor(() => expect(outboundCalls('interactive')).toHaveLength(1));
    invalidate(ds);
    rejectCard(new Error('provider rejected the card'));
    await waitForScanFinish(ds);

    expect(outboundText()).not.toContain('/repo');
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('folds a follow-up buffered during an empty scan into the only first worker fork', async () => {
    const anchor = 'om_empty_scan_root';
    const { route, ds, scan } = await startPendingScan(anchor, '首轮请求');

    await handleThreadReply(
      makeEventData('om_empty_scan_followup', '扫描期间补充', anchor),
      makeCtx(anchor, 'om_empty_scan_followup'),
    );
    scan.resolve([]);
    await route;
    await waitForScanFinish(ds);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const [forkedSession, prompt, options] = mocks.forkWorker.mock.calls[0]!;
    expect(forkedSession).toBe(ds);
    expect(prompt.content).toContain('首轮请求');
    expect(prompt.content).toContain('扫描期间补充');
    expect(options).toEqual({ turnId: 'om_empty_scan_followup' });
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(outboundCalls('interactive')).toHaveLength(0);
  });
});
