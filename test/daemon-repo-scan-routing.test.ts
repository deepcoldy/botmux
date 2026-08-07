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
  let outboundMessageSeq = 0;
  const nextOutboundMessageId = (msgType: string | undefined, fallback: string) => (
    msgType === 'interactive' ? `om_interactive_${++outboundMessageSeq}` : fallback
  );
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
    closeSession: vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true })),
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
    nextOutboundMessageId,
    replyMessage: vi.fn(async (...args: any[]) => nextOutboundMessageId(args[3], 'om_reply')),
    resetOutboundMessageSeq: () => { outboundMessageSeq = 0; },
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    scanDeferreds,
    scanMultipleProjectsAsync,
    sendMessage: vi.fn(async (...args: any[]) => nextOutboundMessageId(args[3], 'om_top')),
    updateMessage: vi.fn(async () => undefined),
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
    updateMessage: mocks.updateMessage,
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
  return {
    ...actual,
    closeSession: (...args: any[]) => mocks.closeSession(...args),
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
  };
});

import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { isActiveRepoCard, sessionKey } from '../src/core/types.js';
import { commitRepoSelection } from '../src/im/lark/card-handler.js';
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
  return {
    route,
    ds: ds!,
    scan: mocks.scanDeferreds[0]!,
    progressMessageId: ds!.repoScanCardMessageId,
  };
}

async function waitForScanFinish(ds: { repoScanInFlight?: boolean }): Promise<void> {
  await vi.waitFor(() => expect(ds.repoScanInFlight).toBe(false));
}

describe('first-mention async repo scan routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetOutboundMessageSeq();
    mocks.replyMessage.mockReset();
    mocks.replyMessage.mockImplementation(async (...args: any[]) => (
      mocks.nextOutboundMessageId(args[3], 'om_reply')
    ));
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockImplementation(async (...args: any[]) => (
      mocks.nextOutboundMessageId(args[3], 'om_top')
    ));
    mocks.updateMessage.mockReset();
    mocks.updateMessage.mockResolvedValue(undefined);
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

  it('posts one scan card, then updates that message in place to the picker', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_projects');
    await route;

    expect(progressMessageId).toBeDefined();
    expect(ds.repoScanCardMessageId).toBe(progressMessageId);
    const progressPost = outboundCalls('interactive')[0]!;
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(progressPost[5]).toMatch(/^repo-scan:/);
    expect(JSON.parse(progressPost[2]).config.update_multi).toBe(true);
    expect(outboundText()).toBe('');
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoScanInFlight).toBe(true);

    scan.resolve([project()]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(mocks.updateMessage).toHaveBeenCalledWith(APP, progressMessageId, expect.any(String));
    expect(JSON.parse(mocks.updateMessage.mock.calls[0]![2]).config.update_multi).toBe(true);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoScanInFlight).toBe(false);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('authorizes the same message while its picker PATCH response is pending', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_patch_pending');
    await route;
    let resolveUpdate!: () => void;
    mocks.updateMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));

    scan.resolve([project('patch-pending')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));

    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBe(progressMessageId);
    expect(isActiveRepoCard(ds, progressMessageId)).toBe(true);
    expect(ds.pendingRepo).toBe(true);

    resolveUpdate();
    await waitForScanFinish(ds);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
  });

  it('does not overwrite a newer picker created while the original PATCH response is pending', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_patch_takeover');
    await route;
    let resolveUpdate!: () => void;
    mocks.updateMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));

    scan.resolve([project('patch-takeover')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    ds.repoCardMessageId = 'om_new_picker';
    resolveUpdate();
    await waitForScanFinish(ds);

    expect(ds.repoCardMessageId).toBe('om_new_picker');
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(ds.pendingRepo).toBe(true);
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('does not fall back to /repo when a newer picker wins before the original PATCH fails', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_patch_failed_takeover');
    await route;
    let rejectUpdate!: (error: unknown) => void;
    mocks.updateMessage.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject;
    }));

    scan.resolve([project('patch-failed-takeover')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    ds.repoCardMessageId = 'om_new_picker';
    rejectUpdate(new Error('late provider rejection'));
    await waitForScanFinish(ds);

    expect(ds.repoCardMessageId).toBe('om_new_picker');
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(outboundText()).not.toContain('/repo');
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('keeps the patched picker retryable when its pending commit later fails', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_patch_commit_takeover');
    await route;
    let resolveUpdate!: () => void;
    mocks.updateMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));
    let resolveBots!: (bots: any[]) => void;
    mocks.getAvailableBots.mockImplementationOnce(() => new Promise<any[]>((resolve) => {
      resolveBots = resolve;
    }));
    mocks.forkWorker.mockImplementationOnce(() => { throw new Error('fork boom'); });

    scan.resolve([project('patch-commit-takeover')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    const commitResult = commitRepoSelection(
      {
        ds,
        rootId: 'om_scan_patch_commit_takeover',
        cardMessageId: progressMessageId,
        larkAppId: APP,
        operatorOpenId: OWNER,
        activeSessions,
        sessionReply: async () => 'om_commit_reply',
      },
      '/tmp/patch-commit-takeover',
      'patch-commit-takeover',
    ).then(() => undefined, error => error);
    await vi.waitFor(() => expect(ds.pendingRepoCommitInFlight).toBe(true));

    resolveUpdate();
    await waitForScanFinish(ds);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);

    resolveBots([]);
    const commitError = await commitResult;

    expect(commitError).toEqual(expect.objectContaining({ message: 'fork boom' }));
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(isActiveRepoCard(ds, progressMessageId)).toBe(true);
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('falls back to scan text after a non-transient progress POST failure, then still posts the picker', async () => {
    mocks.replyMessage.mockRejectedValueOnce(new Error('provider rejected progress card'));

    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_progress_fallback');
    await route;

    expect(progressMessageId).toBeUndefined();
    expect(outboundText()).toContain('正在扫描仓库');
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(outboundCalls('interactive')[0]?.[5]).toMatch(/^repo-scan:/);

    scan.resolve([project('fallback-picker')]);
    await waitForScanFinish(ds);

    const interactive = outboundCalls('interactive');
    expect(interactive).toHaveLength(2);
    expect(interactive[1]?.[5]).toMatch(/^repo-picker:/);
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(ds.repoCardMessageId).toBeDefined();
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(ds.pendingRepo).toBe(true);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('retries a transient progress POST failure with the same stable UUID', async () => {
    mocks.replyMessage.mockRejectedValueOnce(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_progress_retry');
    await route;

    const progressAttempts = outboundCalls('interactive');
    expect(progressAttempts).toHaveLength(2);
    expect(progressAttempts[1]?.[5]).toBe(progressAttempts[0]?.[5]);
    expect(progressMessageId).toBeDefined();
    expect(ds.repoScanCardMessageId).toBe(progressMessageId);
    expect(outboundText()).toBe('');

    scan.resolve([]);
    await waitForScanFinish(ds);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('buffers a same-user follow-up during the scan and still posts the picker after resolution', async () => {
    const anchor = 'om_scan_followup_root';
    const { route, ds, scan, progressMessageId } = await startPendingScan(anchor, '首轮请求');
    await route;

    await handleThreadReply(
      makeEventData('om_scan_followup', '扫描期间补充', anchor),
      makeCtx(anchor, 'om_scan_followup'),
    );

    expect(ds.pendingFollowUps).toEqual(['扫描期间补充']);
    expect(outboundText()).toBe('');
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(mocks.forkWorker).not.toHaveBeenCalled();

    scan.resolve([project('flow_android')]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(mocks.updateMessage).toHaveBeenCalledWith(APP, progressMessageId, expect.any(String));
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingFollowUps).toEqual(['扫描期间补充']);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
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
    const progressMessageId = ds.repoScanCardMessageId;
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
    expect(outboundText()).toBe('');
    expect(outboundCalls('interactive')).toHaveLength(1);

    mocks.scanDeferreds[0]!.resolve([project('serialized-flow')]);
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(mocks.updateMessage).toHaveBeenCalledWith(APP, progressMessageId, expect.any(String));
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
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
    const { route, ds, scan, progressMessageId } = await startPendingScan(anchor);

    invalidate(anchor, ds);
    scan.resolve([project('late-project')]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(ds.repoScanInFlight).toBe(false);
  });

  it('keeps the pending input recoverable with /repo when the scan child rejects', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_reject', '不能丢的首轮请求');

    scan.reject(new Error('scanner child crashed'));
    await route;
    await waitForScanFinish(ds);

    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('不能丢的首轮请求');
    expect(ds.repoScanInFlight).toBe(false);
    expect(outboundText()).toContain('/repo');
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('lets bare /repo consume the pending turn while the child is scanning and never reforks', async () => {
    const anchor = 'om_scan_bare_repo';
    const { route, ds, scan, progressMessageId } = await startPendingScan(anchor, '直接开始的首轮请求');

    await handleThreadReply(
      makeEventData('om_scan_bare_repo_command', '/repo', anchor),
      makeCtx(anchor, 'om_scan_bare_repo_command'),
    );

    expect(ds.pendingRepo).toBe(false);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);

    scan.resolve([project('late-after-bare-repo')]);
    await route;
    await waitForScanFinish(ds);

    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.repoScanInFlight).toBe(false);
  });

  it('withdraws scan progress on /close and ignores the late child result', async () => {
    const anchor = 'om_scan_close';
    const { route, ds, scan, progressMessageId } = await startPendingScan(anchor, '关闭前的首轮请求');

    await handleThreadReply(
      makeEventData('om_scan_close_command', '/close', anchor),
      makeCtx(anchor, 'om_scan_close_command'),
    );

    expect(mocks.closeSession).toHaveBeenCalledWith(ds.session.sessionId);
    expect(activeSessions.has(sessionKey(anchor, APP))).toBe(false);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);

    scan.resolve([project('late-after-close')]);
    await route;
    await waitForScanFinish(ds);

    expect(outboundCalls('interactive').some(call => String(call[5]).startsWith('repo-picker:'))).toBe(false);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('keeps scan progress active when /close is refused', async () => {
    mocks.closeSession.mockRejectedValueOnce(new Error('teardown ownership not proven'));
    const anchor = 'om_scan_close_refused';
    const { ds, scan, progressMessageId } = await startPendingScan(anchor, '关闭失败后继续等待');

    await handleThreadReply(
      makeEventData('om_scan_close_refused_command', '/close', anchor),
      makeCtx(anchor, 'om_scan_close_refused_command'),
    );

    expect(activeSessions.get(sessionKey(anchor, APP))).toBe(ds);
    expect(ds.repoScanCardMessageId).toBe(progressMessageId);
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);

    scan.resolve([project('after-refused-close')]);
    await waitForScanFinish(ds);
    expect(mocks.updateMessage).toHaveBeenCalledWith(APP, progressMessageId, expect.any(String));
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('keeps the pending turn recoverable when the in-place picker update fails', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan(
      'om_scan_picker_delivery_failure',
      '卡片失败也不能丢的请求',
    );
    await route;
    mocks.updateMessage.mockRejectedValueOnce(new Error('provider rejected picker update'));

    scan.resolve([project('picker-delivery-failure')]);
    await waitForScanFinish(ds);

    expect(mocks.updateMessage).toHaveBeenCalledWith(APP, progressMessageId, expect.any(String));
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(outboundText()).toContain('/repo');
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('卡片失败也不能丢的请求');
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('retries a transient in-place update once before falling back to /repo', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan(
      'om_scan_picker_update_retry',
      '重试失败也不能丢的请求',
    );
    await route;
    mocks.updateMessage
      .mockRejectedValueOnce(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    scan.resolve([project('picker-update-retry')]);
    await waitForScanFinish(ds);

    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    expect(mocks.updateMessage).toHaveBeenNthCalledWith(1, APP, progressMessageId, expect.any(String));
    expect(mocks.updateMessage).toHaveBeenNthCalledWith(2, APP, progressMessageId, expect.any(String));
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(outboundText()).toContain('/repo');
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('重试失败也不能丢的请求');
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('keeps the same picker active when a transient in-place update retry succeeds', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_picker_retry_success');
    await route;
    mocks.updateMessage
      .mockRejectedValueOnce(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      .mockResolvedValueOnce(undefined);

    scan.resolve([project('picker-retry-success')]);
    await waitForScanFinish(ds);

    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(outboundText()).not.toContain('/repo');
    expect(mocks.deleteMessage).not.toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('rolls back provisional picker authorization when the route changes during retry backoff', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_picker_retry_race');
    await route;
    mocks.updateMessage.mockRejectedValueOnce(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    scan.resolve([project('picker-retry-race')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    expect(ds.repoCardMessageId).toBe(progressMessageId);
    ds.pendingRepo = false;
    await waitForScanFinish(ds);

    expect(mocks.updateMessage).toHaveBeenCalledTimes(1);
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(outboundText()).not.toContain('/repo');
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });

  it('does not retry or overwrite a newer picker that takes over during retry backoff', async () => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_picker_retry_takeover');
    await route;
    mocks.updateMessage.mockRejectedValueOnce(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    scan.resolve([project('picker-retry-takeover')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    ds.repoCardMessageId = 'om_new_picker';
    await waitForScanFinish(ds);

    expect(mocks.updateMessage).toHaveBeenCalledTimes(1);
    expect(ds.repoCardMessageId).toBe('om_new_picker');
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(outboundText()).not.toContain('/repo');
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });

  it.each([
    {
      name: 'a newer picker consumes the route',
      invalidate: (ds: any) => {
        ds.pendingRepo = false;
        ds.repoCardMessageId = 'om_new_picker';
      },
      expectedRepoCardMessageId: 'om_new_picker',
    },
  ])('does not disturb newer route state when $name during card update', async ({
    invalidate,
    expectedRepoCardMessageId,
  }) => {
    const { route, ds, scan, progressMessageId } = await startPendingScan('om_scan_card_delivery_race');
    await route;
    let rejectUpdate!: (error: unknown) => void;
    const cardUpdate = new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    mocks.updateMessage.mockImplementation(() => cardUpdate);

    scan.resolve([project('delivery-race')]);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(1));
    invalidate(ds);
    rejectUpdate(new Error('provider rejected the card update'));
    await waitForScanFinish(ds);

    expect(outboundText()).not.toContain('/repo');
    expect(ds.repoCardMessageId).toBe(expectedRepoCardMessageId);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('folds a follow-up buffered during an empty scan into the only first worker fork', async () => {
    const anchor = 'om_empty_scan_root';
    const { route, ds, scan, progressMessageId } = await startPendingScan(anchor, '首轮请求');

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
    expect(outboundCalls('interactive')).toHaveLength(1);
    expect(ds.repoScanCardMessageId).toBeUndefined();
    expect(mocks.deleteMessage).toHaveBeenCalledWith(APP, progressMessageId);
  });
});
