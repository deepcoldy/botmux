// 用真实 ProjectCoordinator 与项目存储覆盖刷新预算、过期重发、按群防抖与主控转发。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { listProjectGroups, mutateProjectGroup, readProjectGroup } from '../src/services/project-group-store.js';
import { readGroupCollaborationMode, writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import {
  createProjectCardRuntimeSync,
  PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST,
  type ProjectCardRuntimeSyncDeps,
} from '../src/services/project-card-runtime-sync.js';
import type { ProjectGroupCardRuntime } from '../src/im/lark/project-group-card.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expiredError(): Error {
  const error = new Error('past edit window');
  error.name = 'MessageUpdateExpiredError';
  return error;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(opts: { owners?: string[]; coordinatorAppId?: string } = {}) {
  let runtime: ProjectGroupCardRuntime = { ownerDisplayNames: { cli_worker: 'BotAlpha' } };
  let sends = 0;
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'project-card-sync-'));
  roots.push(dataDir);
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => ++sends === 1 ? 'om_card' : `om_card_${sends}`),
    updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => 'omt_topic'),
    isMessageWithdrawn: error => (error as Error)?.name === 'MessageWithdrawnError',
    isMessageUpdateExpired: error => (error as Error)?.name === 'MessageUpdateExpiredError',
    brand: () => 'feishu',
    resolveCardRuntime: vi.fn(async () => runtime),
  };
  const coordinator = new ProjectCoordinator(transport);
  const context = { dataDir, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one' };
  async function initProject(chatId: string) {
    await writeGroupCollaborationMode(dataDir, {
      chatId, mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: ['cli_worker'],
    });
    await coordinator.run({ ...context, chatId }, { action: 'init', title: '项目', goal: '合成目标' });
    await coordinator.run({ ...context, chatId }, {
      action: 'dispatch', dispatchRoot: 'om_ws1', title: '子任务一', purpose: '合成',
      owners: opts.owners ?? ['cli_worker'], status: 'in_progress', progress: 10,
    });
  }
  await initProject(context.chatId);
  if (opts.coordinatorAppId) {
    await writeGroupCollaborationMode(dataDir, {
      chatId: 'oc_group', mode: 'project', coordinatorAppId: opts.coordinatorAppId, workerAppIds: ['cli_worker'],
    });
  }
  vi.mocked(transport.updateCard).mockClear();
  const deps: ProjectCardRuntimeSyncDeps = {
    larkAppId: 'cli_main',
    listProjects: vi.fn(() => listProjectGroups(dataDir)),
    readMode: chatId => readGroupCollaborationMode(dataDir, chatId),
    resolveRuntime: async () => runtime,
    refresh: (project, target) => coordinator.refreshCard({
      ...context, chatId: project.chatId, coordinatorSessionId: project.coordinatorSessionId,
    }, target),
    isMessageUpdateExpired: transport.isMessageUpdateExpired,
    repostExpiredCard: vi.fn((project, target) => coordinator.repostExpiredCard({
      ...context, chatId: project.chatId, coordinatorSessionId: project.coordinatorSessionId,
    }, target)),
    forwardToCoordinator: vi.fn(),
    onDeferred: vi.fn(),
  };
  return {
    dataDir, transport, deps, context, coordinator, initProject,
    sync: createProjectCardRuntimeSync(deps),
    updates: () => vi.mocked(transport.updateCard).mock.calls.length,
    setRuntime: (next: ProjectGroupCardRuntime) => { runtime = next; },
  };
}

describe('project card runtime sync', () => {
  it('只在卡片摘要变化时调飞书：同一状态反复 tick 不重复更新', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(1);
    expect(JSON.parse(String(vi.mocked(f.transport.updateCard).mock.calls[0]![2]))).toBeTruthy();
    expect(String(vi.mocked(f.transport.updateCard).mock.calls[0]![2])).toContain('BotAlpha');

    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotAlpha2' } });
    await f.sync.sync();
    await f.sync.sync();
    expect(f.updates()).toBe(2);
    expect(String(vi.mocked(f.transport.updateCard).mock.calls[1]![2])).toContain('BotAlpha2');
  });

  it('编辑窗口过期：耗尽 PATCH 预算后只重发一次，后续摘要更新新卡', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async (_appId, messageId) => {
      if (messageId === 'om_card') throw expiredError();
    });
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.deps.repostExpiredCard).not.toHaveBeenCalled();
    await f.sync.sync();
    for (let i = PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST; i < 20; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.deps.onDeferred).toHaveBeenCalledTimes(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.unpinMessage).toHaveBeenCalledExactlyOnceWith('cli_main', 'om_card');
    expect(f.transport.pinMessage).toHaveBeenLastCalledWith('cli_main', 'om_card_2');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card).toMatchObject({ messageId: 'om_card_2', pinned: true });

    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
    await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 1);
    expect(f.transport.updateCard).toHaveBeenLastCalledWith('cli_main', 'om_card_2', expect.stringContaining('BotBeta'));
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
  });

  it('新摘要获得完整的独立失败预算，不继承旧摘要的失败计数', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async () => { throw expiredError(); });
    for (let i = 0; i < 20; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);

    // 新摘要：前两次瞬时失败，第三次成功——新预算必须容忍这两次失败。
    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
    vi.mocked(f.transport.updateCard)
      .mockImplementationOnce(async () => { throw new Error('transient 1'); })
      .mockImplementationOnce(async () => { throw new Error('transient 2'); })
      .mockImplementation(async () => {});
    await f.sync.sync();
    await f.sync.sync();
    await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 3);
    // 成功后同摘要不再打接口。
    await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 3);
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
  });

  it('20 个持续过期的 tick 即使摘要变化也只重发一次，冷却结束不额外 PATCH', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    for (let tick = 1; tick <= 20; tick += 1) {
      vi.setSystemTime(start + tick * 30_000);
      f.setRuntime({ ownerDisplayNames: { cli_worker: `Bot${Math.floor((tick - 1) / 3)}` } });
      await f.sync.sync();
    }
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.pinMessage).toHaveBeenCalledTimes(2);
    expect(f.transport.unpinMessage).toHaveBeenCalledTimes(1);

    // The first repost was at 90s. Let the latest digest exhaust its PATCH
    // budget, then verify that the pending repost waits out the full cooldown.
    vi.setSystemTime(start + 630_000);
    await f.sync.sync();
    const updates = f.updates();
    vi.setSystemTime(start + 689_999);
    await f.sync.sync();
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 690_000);
    await f.sync.sync();
    expect(f.updates()).toBe(updates);
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(2);
    expect(f.transport.unpinMessage).toHaveBeenLastCalledWith('cli_main', 'om_card_2');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card?.messageId).toBe('om_card_3');
  });

  it('重发冷却只限本群，另一个群仍能在耗尽预算后恢复', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    await f.initProject('oc_other');
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST; i += 1) await f.sync.sync();
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(2);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(4);
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_main', 'om_card');
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_main', 'om_card_2');
  });

  it('重发失败计入失败次数，同一摘要即使切换回来也只尝试重发一次', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    const sendError = new Error('send failed');
    vi.mocked(f.transport.sendCard).mockRejectedValueOnce(sendError);
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.deps.onDeferred).toHaveBeenCalledTimes(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 1);
    expect(f.deps.onDeferred).toHaveBeenLastCalledWith(f.context.chatId, sendError);
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card).toMatchObject({ messageId: 'om_card', pinned: false });

    vi.setSystemTime(Date.now() + 11 * 60_000);
    for (let i = 0; i < 5; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);

    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
    vi.mocked(f.transport.updateCard).mockResolvedValueOnce(undefined);
    await f.sync.sync();
    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotAlpha' } });
    for (let i = 0; i < 5; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(2 * PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 1);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
  });

  it('非过期错误耗尽预算后停手，不重发', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(new Error('permission denied'));
    for (let i = 0; i < 10; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.deps.repostExpiredCard).not.toHaveBeenCalled();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
  });

  it.each(['PATCH', '重发'] as const)('实际渲染摘要变化时跳过 %s，新摘要用自己的完整预算', async stage => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async (_appId, messageId) => {
      if (messageId === 'om_card') throw expiredError();
    });
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();
    const alpha = { ownerDisplayNames: { cli_worker: 'BotAlpha' } };
    const beta = { ownerDisplayNames: { cli_worker: 'BotBeta' } };
    const resolveCardRuntime = vi.mocked(f.transport.resolveCardRuntime!);
    if (stage === '重发') resolveCardRuntime.mockResolvedValueOnce(alpha);
    resolveCardRuntime.mockResolvedValueOnce(beta);
    // Alpha's budget cannot be spent on Beta, whether the change first
    // appears during the third PATCH or during the ensuing repost.
    await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - (stage === 'PATCH' ? 1 : 0));
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.unpinMessage).not.toHaveBeenCalled();

    f.setRuntime(beta);
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    await f.sync.sync();
    expect(f.transport.sendCard).toHaveBeenLastCalledWith('cli_main', 'oc_group', expect.stringContaining('BotBeta'));
    f.setRuntime(alpha);
    await f.sync.sync();
    expect(f.transport.updateCard).toHaveBeenLastCalledWith('cli_main', 'om_card_2', expect.stringContaining('BotAlpha'));
  });

  it('慢重发失败之后，同群仍需等满冷却窗口', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    vi.mocked(f.transport.sendCard).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      throw new Error('slow send failed');
    });
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST; i += 1) await f.sync.sync();
    const finishedAt = Date.now();
    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST; i += 1) await f.sync.sync();
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    vi.setSystemTime(finishedAt + 10 * 60_000);
    await f.sync.sync();
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(2);
  });

  it.each(['unpin', 'send'] as const)('重发期间切为普通群（%s），不再开始下一次远端写入', async stage => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    const started = gate();
    const release = gate();
    async function inFlight<T>(result: T): Promise<T> {
      started.release();
      await release.promise;
      return result;
    }
    if (stage === 'unpin') vi.mocked(f.transport.unpinMessage).mockImplementationOnce(() => inFlight(true));
    else vi.mocked(f.transport.sendCard).mockImplementationOnce(() => inFlight('om_sent'));
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();
    const reposting = f.sync.sync();
    await started.promise;
    try {
      await writeGroupCollaborationMode(f.dataDir, { chatId: f.context.chatId, mode: 'standard' });
    } finally {
      release.release();
      await reposting;
    }

    expect(f.transport.sendCard).toHaveBeenCalledTimes(stage === 'unpin' ? 1 : 2);
    expect(f.transport.pinMessage).toHaveBeenCalledExactlyOnceWith('cli_main', 'om_card');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card).toMatchObject({
      messageId: stage === 'unpin' ? 'om_card' : 'om_sent',
      pinned: false,
    });
  });

  it('重发过程中交叠的 tick 不重复请求，新摘要随后更新新卡', async () => {
    const f = await fixture();
    const refresh = vi.spyOn(f.deps, 'refresh');
    vi.mocked(f.transport.updateCard).mockImplementation(async (_appId, messageId) => {
      if (messageId === 'om_card') throw expiredError();
    });
    const sending = gate();
    const release = gate();
    vi.mocked(f.transport.sendCard).mockImplementationOnce(async () => {
      sending.release();
      await release.promise;
      return 'om_reposted';
    });
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();
    const reposting = f.sync.sync();
    await sending.promise;
    let overlapping: Promise<void> | undefined;
    try {
      f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
      overlapping = f.sync.sync(f.context.chatId);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(refresh).toHaveBeenCalledTimes(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
      expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    } finally {
      release.release();
      await Promise.all([reposting, overlapping]);
    }
    await f.sync.sync();
    expect(f.transport.updateCard).toHaveBeenLastCalledWith('cli_main', 'om_reposted', expect.stringContaining('BotBeta'));
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
  });

  it('命令在后台预算耗尽时已换卡，排队的重发不替换新卡', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockRejectedValue(expiredError());
    for (let i = 0; i < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST - 1; i += 1) await f.sync.sync();

    const updating = gate();
    const release = gate();
    vi.mocked(f.transport.updateCard).mockImplementationOnce(async () => {
      updating.release();
      await release.promise;
      throw expiredError();
    });
    const syncing = f.sync.sync();
    await updating.promise;
    const command = f.coordinator.run(f.context, { action: 'update', focus: '显式操作' });
    release.release();
    const [project] = await Promise.all([command, syncing]);

    expect(project.card?.messageId).toBe('om_card_2');
    expect(f.deps.repostExpiredCard).toHaveBeenCalledTimes(1);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.unpinMessage).toHaveBeenCalledExactlyOnceWith('cli_main', 'om_card');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card?.messageId).toBe('om_card_2');
  });

  it('瞬时失败会在下一轮重试，成功后停止', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard)
      .mockImplementationOnce(async () => { throw new Error('socket hang up'); })
      .mockImplementation(async () => {});
    await f.sync.sync();
    await f.sync.sync();
    expect(f.updates()).toBe(2);
    for (let i = 0; i < 5; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(2);
  });

  it('只刷新本 Bot 当主控、已有置顶卡、有动态行的项目', async () => {
    const humanOwners = await fixture({ owners: ['人工负责人'] });
    await humanOwners.sync.sync();
    expect(humanOwners.updates()).toBe(0);

    const movedCoordinator = await fixture({ coordinatorAppId: 'cli_other' });
    await movedCoordinator.sync.sync();
    expect(movedCoordinator.updates()).toBe(0);

    // 没有置顶卡的项目（从未发出或已清掉）不由后台同步去新发卡片。
    const noCard = await fixture();
    await mutateProjectGroup(noCard.dataDir, 'oc_group', current => {
      delete current!.card;
      return current;
    });
    await noCard.sync.sync();
    expect(noCard.updates()).toBe(0);
    expect(noCard.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(noCard.transport.pinMessage).toHaveBeenCalledTimes(1);

    const other = await fixture();
    await other.sync.sync('oc_other_group');
    expect(other.updates()).toBe(0);
    await other.sync.sync('oc_group');
    expect(other.updates()).toBe(1);
    expect(readProjectGroup(other.dataDir, 'oc_group')?.card?.messageId).toBe('om_card');
  });

  it('notify：本 Bot 是主控时按群防抖合并；主控在别的 daemon 只转发群 ID；非项目群与非法群 ID 不动', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture();
    f.sync.notify('oc_group');
    f.sync.notify('oc_group');
    f.sync.notify('oc_group');
    expect(f.deps.listProjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.deps.listProjects).toHaveBeenCalledTimes(1);

    f.sync.notify('oc_not_project');
    f.sync.notify('ou_not_a_chat');
    f.sync.notify(undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.deps.listProjects).toHaveBeenCalledTimes(1);
    expect(f.deps.forwardToCoordinator).not.toHaveBeenCalled();

    const peer = await fixture({ coordinatorAppId: 'cli_other' });
    peer.sync.notify('oc_group');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peer.deps.forwardToCoordinator).toHaveBeenCalledTimes(1);
    expect(peer.deps.forwardToCoordinator).toHaveBeenCalledWith('cli_other', 'oc_group');
    expect(peer.deps.listProjects).not.toHaveBeenCalled();
  });
});
