import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import {
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
} from '../src/services/group-collaboration-mode-store.js';
import { parseProjectArgs } from '../src/cli/project-args.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-group-'));
  roots.push(dataDir);
  const cards: string[] = [];
  let sentCards = 0;
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async (_appId, _chatId, cardJson) => {
      cards.push(cardJson);
      sentCards += 1;
      return `om_card_${sentCards}`;
    }),
    updateCard: vi.fn(async (_appId, _messageId, cardJson) => { cards.push(cardJson); }),
    pinMessage: vi.fn(async () => true),
    unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async (_appId, root) => root === 'om_subtask' ? 'omt_topic' : null),
    isMessageWithdrawn: error => error instanceof Error && error.message === 'withdrawn',
    brand: () => 'feishu',
  };
  return {
    dataDir, cards, transport,
    coordinator: new ProjectCoordinator(transport),
    context: { dataDir, chatId: 'oc_project', larkAppId: 'cli_coordinator', coordinatorSessionId: 'session_main' },
  };
}

describe('project group mode', () => {
  it('replaces the onboarding guide with a fresh pinned project card when the project starts', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    const first = await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(first).toMatchObject({ messageId: 'om_card_1', pinned: true, larkAppId: 'cli_coordinator' });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledTimes(1);
    expect(f.cards[0]).toContain('项目群已就绪');
    expect(f.cards[0]).toContain('先讨论');
    expect(f.cards[0]).toContain('直接执行');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId).toBe('om_card_1');

    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot', 'GLM Bot'],
    });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.updateCard).toHaveBeenCalledWith('cli_coordinator', 'om_card_1', expect.stringContaining('GLM Bot'));

    const project = await f.coordinator.run(f.context, {
      action: 'init', title: '引导卡切换验收', goal: '用新卡明确展示项目已经启动',
    });
    expect(project.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.pinMessage).toHaveBeenLastCalledWith('cli_coordinator', 'om_card_2');
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    expect(f.transport.updateCard).not.toHaveBeenCalledWith(
      'cli_coordinator',
      'om_card_1',
      expect.stringContaining('引导卡切换验收'),
    );
    expect(f.cards.at(-1)).toContain('引导卡切换验收');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('retries retiring the old onboarding pin after a best-effort unpin failure', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    f.transport.unpinMessage = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const started = await f.coordinator.run(f.context, {
      action: 'init', title: '项目已启动', goal: '验证旧引导卡清理可重试',
    });
    expect(started.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.card).toMatchObject({
      messageId: 'om_card_2', pinned: true,
    });
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard?.messageId).toBe('om_card_1');

    const refreshed = await f.coordinator.run(f.context, { action: 'refresh' });
    expect(refreshed.card?.messageId).toBe('om_card_2');
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(f.transport.updateCard).toHaveBeenCalledWith(
      'cli_coordinator', 'om_card_2', expect.stringContaining('项目已启动'),
    );
    expect(f.transport.unpinMessage).toHaveBeenCalledTimes(2);
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('unpins and clears an unused onboarding guide when project mode is disabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId, mode: 'project', coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
    });
    await f.coordinator.ensureOnboardingCard(f.context, {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(await f.coordinator.clearOnboardingCard(f.context)).toBe(true);
    expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    expect(readGroupCollaborationMode(f.dataDir, f.context.chatId)?.onboardingCard).toBeUndefined();
  });

  it('creates one pinned plan-list projection backed by a private durable store', async () => {
    const f = fixture();
    const project = await f.coordinator.run(f.context, {
      action: 'init', title: '结算链路治理', goal: '在 09-12 前完成联调与灰度', phase: '方案确认', focus: '拆分首批子任务',
    });
    expect(project.card).toMatchObject({ messageId: 'om_card_1', pinned: true });
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.pinMessage).toHaveBeenCalledWith('cli_coordinator', 'om_card_1');
    const rendered = JSON.parse(f.cards[0]!);
    expect(rendered.schema).toBe('2.0');
    expect(rendered.header.title.content).toBe('结算链路治理');
    expect(f.cards[0]).not.toContain('总体进度');
    expect(f.cards[0]).not.toContain('%');
    expect(f.cards[0]).toContain('推进概况');
    expect(f.cards[0]).toContain('当前推进');
    expect(f.cards[0]).toContain('待办计划');
    expect(f.cards[0]).toContain('完成记录');
    const heroText = rendered.body.elements
      .filter((element: { tag?: string }) => element.tag === 'interactive_container')
      .flatMap((element: { elements?: Array<{ text_size?: string }> }) => element.elements ?? []);
    expect(heroText.filter((element: { text_size?: string }) => element.text_size === 'heading-3')).toHaveLength(2);
    expect(f.cards[0]).not.toContain('示例数据');
    expect(rendered.config.summary.content.length).toBeLessThanOrEqual(60);
    expect(readFileSync(join(f.dataDir, 'project-groups.json'), 'utf8')).not.toContain('larkAppSecret');
  });

  it('registers dispatch topics, resolves real topic links, and applies report progress', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    const dispatched = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '联调验证', purpose: '验证价格和库存链路',
      owners: ['worker-a'], status: 'in_progress', progress: 35,
    });
    expect(dispatched.workstreams[0]).toMatchObject({
      dispatchRoot: 'om_subtask', threadId: 'omt_topic', title: '联调验证', progress: 35,
    });
    const rendered = JSON.parse(f.cards.at(-1)!);
    const table = rendered.body.elements.find((element: { tag?: string }) => element.tag === 'table');
    expect(table.rows[0].status).toContain('[进入话题](https://applink.feishu.cn/client/thread/open?');
    expect(table.rows[0].status).toContain('open_thread_id=omt_topic');
    expect(table.rows[0].wf).toContain("color='indigo'");
    expect(table.rows[0].wf).toContain("color='purple'");
    expect(table.columns.map((column: { name: string }) => column.name)).toEqual(['wf', 'status']);
    expect(table.rows[0].status).not.toContain('%');
    expect(f.cards.at(-1)).not.toContain('"tag":"button"');

    const coordinated = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '', purpose: '',
      owners: ['worker-a'], status: 'in_progress', progress: 40,
    });
    expect(coordinated.workstreams[0]).toMatchObject({
      title: '联调验证', purpose: '验证价格和库存链路', progress: 40,
    });
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '子任务', purpose: '',
      owners: ['worker-a'], status: 'in_progress', progress: 50,
    })).rejects.toThrow('project_workstream_title_required');

    const reported = await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_subtask', content: '全部用例通过',
      status: 'completed', remaining: '无', milestone: '联调通过',
    });
    expect(reported.workstreams[0]).toMatchObject({ status: 'completed', progress: 100, lastReport: '全部用例通过' });
    expect(reported.milestones.at(-1)?.content).toBe('联调通过');
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.workstreams[0]?.status).toBe('completed');

    const coordinatedWithoutLifecycle = await f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_subtask', title: '', purpose: '',
    });
    expect(coordinatedWithoutLifecycle.workstreams[0]).toMatchObject({
      title: '联调验证', purpose: '验证价格和库存链路', owners: ['worker-a'],
      status: 'completed', progress: 100,
    });
  });

  it('rejects missing, generic, and overlong titles for new workstreams', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_missing_title', title: '', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_required');
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_generic_title', title: '子任务', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_required');
    await expect(f.coordinator.run(f.context, {
      action: 'dispatch', dispatchRoot: 'om_long_title', title: '这是一个明显超过二十四个字符并且不适合展示在项目卡片里的标题', purpose: '验证标题门禁', status: 'pending',
    })).rejects.toThrow('project_workstream_title_too_long');
  });

  it('keeps shared blocker text until every blocked workstream clears it', async () => {
    const f = fixture();
    f.transport.resolveThreadId = vi.fn(async (_appId, root) => root === 'om_alpha' ? 'omt_alpha' : 'omt_beta');
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '交付可验收结果' });
    for (const root of ['om_alpha', 'om_beta']) {
      await f.coordinator.run(f.context, {
        action: 'dispatch', dispatchRoot: root, title: root, purpose: '验证阻塞语义', status: 'in_progress', progress: 20,
      });
      await f.coordinator.run(f.context, {
        action: 'report', dispatchRoot: root, content: '等待同一外部依赖', status: 'blocked', progress: 20,
      });
    }
    let project = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(project.blockers).toEqual(['等待同一外部依赖']);

    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_alpha', content: 'alpha 已恢复', status: 'in_progress', progress: 60,
    });
    project = readProjectGroup(f.dataDir, f.context.chatId)!;
    expect(project.blockers).toEqual(['等待同一外部依赖']);
    const cardWhileBlocked = JSON.parse(f.cards.at(-1)!);
    const table = cardWhileBlocked.body.elements.find((element: { tag?: string }) => element.tag === 'table');
    expect(table.rows[0].status).toContain('等待同一外部依赖');

    await f.coordinator.run(f.context, {
      action: 'report', dispatchRoot: 'om_beta', content: 'beta 已恢复', status: 'in_progress', progress: 60,
    });
    expect(readProjectGroup(f.dataDir, f.context.chatId)?.blockers).toEqual([]);
  });

  it('recreates and re-pins a withdrawn projection without losing project state', async () => {
    const f = fixture();
    let sends = 0;
    f.transport.sendCard = vi.fn(async (_appId, _chatId, cardJson) => {
      f.cards.push(cardJson);
      sends += 1;
      return `om_card_${sends}`;
    });
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    f.transport.updateCard = vi.fn(async () => { throw new Error('withdrawn'); });
    const updated = await f.coordinator.run(f.context, { action: 'update', focus: '恢复卡片' });
    expect(updated.card).toMatchObject({ messageId: 'om_card_2', pinned: true });
    expect(updated.focus).toBe('恢复卡片');
  });

  it('refreshes the same card through a group-level template and section configuration', async () => {
    const f = fixture();
    await f.coordinator.run(f.context, { action: 'init', title: '项目', goal: '完成目标' });
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: f.context.chatId,
      mode: 'project',
      coordinatorAppId: f.context.larkAppId,
      workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1,
        templateId: 'compact-list',
        sections: ['workstreams'],
        milestonesExpanded: false,
      },
    });
    await f.coordinator.run(f.context, { action: 'refresh' });
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
    expect(f.cards.at(-1)).toContain('compact-list');
    expect(f.cards.at(-1)).toContain('等待拆解首批任务');
    expect(f.cards.at(-1)).not.toContain('%');
    expect(f.cards.at(-1)).not.toContain('目标：完成目标');
    expect(f.cards.at(-1)).not.toContain('最近里程碑');
  });
});

describe('project CLI parser', () => {
  it('requires title+goal and validates percentage', () => {
    expect(parseProjectArgs('init', ['--title', 'A'])).toEqual({ ok: false, error: 'project init 需要 --title 和 --goal' });
    expect(parseProjectArgs('update', ['--progress', '101'])).toEqual({ ok: false, error: '--progress 必须是 0-100 的整数' });
    expect(parseProjectArgs('init', ['--title', 'A', '--goal', 'G'])).toMatchObject({
      ok: true, help: false, action: { action: 'init', title: 'A', goal: 'G' },
    });
  });

  it('rejects unknown options instead of silently changing project state', () => {
    expect(parseProjectArgs('update', ['--foucs', 'typo'])).toEqual({ ok: false, error: '未知选项: --foucs' });
  });
});
