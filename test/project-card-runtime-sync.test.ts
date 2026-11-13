// 主控置顶卡的运行态刷新：只在卡片摘要变化时调飞书，同一摘要的失败有上限，
// 事件按群防抖合并，主控在别的 daemon 时只转发群 ID。用真实 ProjectCoordinator 与项目存储。
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

async function fixture(opts: { owners?: string[]; coordinatorAppId?: string } = {}) {
  let runtime: ProjectGroupCardRuntime = { ownerDisplayNames: { cli_worker: 'BotAlpha' } };
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'project-card-sync-'));
  roots.push(dataDir);
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => 'om_card'),
    updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => 'omt_topic'),
    isMessageWithdrawn: error => (error as Error)?.name === 'MessageWithdrawnError',
    isMessageUpdateExpired: error => (error as Error)?.name === 'MessageUpdateExpiredError',
    brand: () => 'feishu',
    // 生产里主控发卡与同步共用同一个运行态解析。
    resolveCardRuntime: async () => runtime,
  };
  const coordinator = new ProjectCoordinator(transport);
  const context = { dataDir, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one' };
  await writeGroupCollaborationMode(dataDir, {
    chatId: 'oc_group', mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: ['cli_worker'],
  });
  await coordinator.run(context, { action: 'init', title: '项目', goal: '合成目标' });
  await coordinator.run(context, {
    action: 'dispatch', dispatchRoot: 'om_ws1', title: '子任务一', purpose: '合成',
    owners: opts.owners ?? ['cli_worker'], status: 'in_progress', progress: 10,
  });
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
    refresh: project => coordinator.run({
      dataDir, chatId: project.chatId, larkAppId: 'cli_main', coordinatorSessionId: project.coordinatorSessionId,
    }, { action: 'refresh' }),
    forwardToCoordinator: vi.fn(),
    onDeferred: vi.fn(),
  };
  return {
    dataDir, transport, deps,
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

  it('卡片过了编辑窗口（永久失败）：同一摘要最多试有限次，摘要变化后才再试', async () => {
    const f = await fixture();
    vi.mocked(f.transport.updateCard).mockImplementation(async () => { throw expiredError(); });
    for (let i = 0; i < 20; i += 1) await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    expect(f.deps.onDeferred).toHaveBeenCalledTimes(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST);
    // 永久失败不会被当成撤回去另发新卡。
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);

    f.setRuntime({ ownerDisplayNames: { cli_worker: 'BotBeta' } });
    await f.sync.sync();
    expect(f.updates()).toBe(PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 1);
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
