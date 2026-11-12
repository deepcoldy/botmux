import { describe, expect, it } from 'vitest';
import {
  buildProjectGroupCard,
  COLLAPSED_COMPLETED_WORKSTREAM_LIMIT,
  formatProjectWorkstreamTitle,
  RECENT_COMPLETED_WORKSTREAM_LIMIT,
  resolveWorkstreamDisplayStatus,
  resolveWorkstreamOwnerNames,
  type ProjectGroupCardRuntime,
} from '../src/im/lark/project-group-card.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import type { ProjectProgressCardConfig, ProjectProgressCardTemplateId } from '../src/services/project-progress-card-config.js';
import {
  projectOverallProgress,
  projectRemainingSummary,
  projectTitleWithoutTaskMarker,
  type ProjectGroupState,
  type ProjectWorkstream,
} from '../src/services/project-group-store.js';

function makeProject(overrides: Partial<ProjectGroupState> = {}): ProjectGroupState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    chatId: 'oc_test',
    larkAppId: 'cli_test',
    coordinatorSessionId: 'sess-1',
    title: '测试项目',
    goal: '目标',
    phase: '进行中',
    focus: '当前焦点',
    status: 'in_progress',
    blockers: [],
    workstreams: [{
      dispatchRoot: 'om_root',
      title: '子任务一',
      purpose: '需要换行的较长子任务说明'.repeat(10),
      owners: [],
      status: 'in_progress',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }],
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('buildProjectGroupCard workstream table', () => {
  it('auto-sizes rows with the shared cap while keeping its own blue header style', () => {
    const card = buildProjectGroupCard(makeProject()) as any;
    const table = card.body.elements.find((e: any) => e.tag === 'table');
    expect(table).toBeTruthy();

    // 行高封顶复用共享片段（回归：该表原本只有 row_height:'auto'，
    // 仍吃组件默认 124px 上限，长 purpose 会被裁）。
    expect(table.row_height).toBe('auto');
    expect(table.row_max_height).toBe('300px');

    // 蓝底表头是该卡自有样式，不能被共享灰底表头片段（含 lines:2）覆盖。
    expect(table.header_style).toMatchObject({
      text_align: 'left',
      background_style: 'blue-50',
      text_color: 'blue',
      bold: true,
    });
    expect(table.header_style).not.toHaveProperty('lines');
  });

  it('omits the table when there are no workstreams', () => {
    const card = buildProjectGroupCard(makeProject({ workstreams: [] })) as any;
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(false);
  });

  it('keeps runtime identity in ProjectStore but hides it from the compact card copy', () => {
    const marker = '[task:0917f0d4099c854321c8aca3f1459c31]';
    const title = `社区编辑器丰富度检测终态刷新修复 ${marker}`;
    const goal = '页面从隐藏或休眠恢复时先拉取服务端最新状态，优先展示真实终态，不修改服务端检测标准；'.repeat(4);
    const project = makeProject({ title, goal });
    const card = buildProjectGroupCard(project) as any;
    const serialized = JSON.stringify(card);
    const goalText = card.body.elements[0].elements[1].content;

    expect(project.title).toBe(title);
    expect(card.header.title.content).toBe('社区编辑器丰富度检测终态刷新修复');
    expect(card.config.summary.content).not.toContain('[task:');
    expect(serialized).not.toContain(marker);
    expect(goalText).toContain('…');
    expect(goalText).not.toContain(goal);
  });

  it.each([
    ['a trailing marker', '终态刷新修复 [task:0917F0D4099C854321C8ACA3F1459C31] ', '终态刷新修复'],
    ['a marker followed by more title', '[task:0917f0d4099c854321c8aca3f1459c31] 终态刷新修复', '[task:0917f0d4099c854321c8aca3f1459c31] 终态刷新修复'],
    ['a non-hex task tag', '终态刷新修复 [task:xyz]', '终态刷新修复 [task:xyz]'],
  ])('group-facing title handles %s', (_, title, shown) => {
    expect(projectTitleWithoutTaskMarker(title)).toBe(shown);
  });
});

function makeLargeScaleProject(): ProjectGroupState {
  const activeStatuses: Array<ProjectWorkstream['status']> = [
    'blocked',
    'in_progress', 'in_progress', 'in_progress', 'in_progress',
    'pending', 'pending', 'pending', 'pending',
    'failed',
  ];
  const activeWorkstreams: ProjectWorkstream[] = activeStatuses.map((status, index) => {
    const seq = String(index + 1).padStart(2, '0');
    const ts = `2026-11-12T04:${seq}:00.000Z`;
    return {
      dispatchRoot: `om_active_${seq}`,
      threadId: `omt_active_thread_${seq}`,
      title: `活跃子任务 ${seq} 看板与推理强度联调`,
      purpose: `核对第 ${seq} 条子任务在多模型路由、卡片渲染与置顶刷新下的端到端稳定性表现并输出验证记录`,
      owners: ['BotAlpha', 'BotGamma'],
      status,
      progress: status === 'in_progress' ? 50 : 0,
      ...(status === 'blocked' ? { blocker: '等待前序分支合并后统一触发线上回归验收' } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
  });
  const completedWorkstreams: ProjectWorkstream[] = Array.from({ length: 26 }, (_, index) => {
    const seq = String(index + 1).padStart(2, '0');
    const ts = `2026-11-12T03:${seq}:00.000Z`;
    return {
      dispatchRoot: `om_done_${seq}`,
      threadId: `omt_done_thread_${seq}`,
      title: `已完成任务 ${seq} 治理与单测补齐`,
      purpose: `完成第 ${seq} 项基础设施改造、补齐回归测试并沉淀交付说明文档供主控验收`,
      owners: ['Codex'],
      status: 'completed',
      progress: 100,
      createdAt: ts,
      updatedAt: ts,
    };
  });
  return makeProject({
    chatId: 'oc_64a56c76afd19e03d490af539efcd99f',
    title: 'AI工具干活群多 Agent 协同基础设施持续迭代',
    goal: '持续打磨多 Bot 协同编排、项目控制面可读性、模型代理路由与会话稳定性，降低长周期项目群的信息噪音。',
    phase: '并行开发与验证',
    focus: '推进项目卡已完成任务折叠、无主任务认领与推理强度观测修复',
    remaining: '合并本地分支·统一部署重启·观察线上置顶卡片刷新效果',
    status: 'active',
    blockers: ['部署窗口需等删 Bot 与推理强度修复分支一并就绪后由主控统一执行'],
    workstreams: [...completedWorkstreams, ...activeWorkstreams],
    milestones: [
      { content: '完成无主任务认领修复与单测验收', createdAt: '2026-11-12T02:30:00.000Z' },
      { content: '完成项目卡已完成任务折叠方案调研评审', createdAt: '2026-11-12T03:50:00.000Z' },
    ],
    nextMilestone: '主控合并各本地修复分支并统一发布',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-12T04:15:00.000Z',
  });
}

function makeCardConfig(
  templateId: ProjectProgressCardTemplateId,
  completedDisplay?: ProjectProgressCardConfig['completedDisplay'],
): ProjectProgressCardConfig {
  return {
    schemaVersion: 1,
    templateId,
    sections: ['goal', 'blockers', 'workstreams', 'milestones'],
    milestonesExpanded: false,
    ...(completedDisplay !== undefined ? { completedDisplay } : {}),
  };
}

describe('buildProjectGroupCard completedDisplay modes', () => {
  it.each(['status-dashboard', 'compact-list'] as const)(
    'defaults omitted completedDisplay to identical output as explicit all in %s',
    (templateId) => {
      const project = makeLargeScaleProject();
      const omittedCard = buildProjectGroupCard(project, 'feishu', makeCardConfig(templateId));
      const explicitAllCard = buildProjectGroupCard(project, 'feishu', makeCardConfig(templateId, 'all'));
      expect(omittedCard).toEqual(explicitAllCard);
    },
  );

  it('reports the true completed workstream total in status-dashboard planElements instead of capping at 4', () => {
    const project = makeLargeScaleProject();
    const card = buildProjectGroupCard(project, 'feishu', makeCardConfig('status-dashboard', 'all')) as any;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('**完成记录 · 26**');
    expect(serialized).toContain('另有 22 项');
    expect(serialized).toContain('已完成任务 26');
    expect(serialized).toContain('已完成任务 23');
  });

  it('supports all / collapsed / recent in compact-list with recent-first ordering and 15-item panel cap', () => {
    const project = makeLargeScaleProject();

    const allCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('compact-list', 'all')) as any;
    const allWorkstreamMd = allCard.body.elements.find(
      (el: any) => el.tag === 'markdown' && String(el.content).includes('**子任务（36）**'),
    );
    expect(allWorkstreamMd).toBeTruthy();
    expect(allWorkstreamMd.content).toContain('已完成任务 01');
    expect(allWorkstreamMd.content).toContain('已完成任务 26');
    expect(
      allCard.body.elements.filter((el: any) => el.tag === 'collapsible_panel'),
    ).toHaveLength(1); // only milestone panel

    const collapsedCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('compact-list', 'collapsed')) as any;
    const activeMd = collapsedCard.body.elements.find(
      (el: any) => el.tag === 'markdown' && String(el.content).includes('**子任务（未完成 10 / 共 36）**'),
    );
    expect(activeMd).toBeTruthy();
    expect(activeMd.content).toContain('活跃子任务 01');
    expect(activeMd.content).toContain('活跃子任务 10');
    expect(activeMd.content).not.toContain('已完成任务');

    const completedPanel = collapsedCard.body.elements.find(
      (el: any) => el.tag === 'collapsible_panel' && el.header?.title?.content === '已完成子任务（26 项）',
    );
    expect(completedPanel).toBeTruthy();
    expect(completedPanel.expanded).toBe(false);
    expect(completedPanel.header.expanded_title.content).toBe('收起已完成子任务（26 项）');
    const panelContent: string = completedPanel.elements[0].content;
    expect(COLLAPSED_COMPLETED_WORKSTREAM_LIMIT).toBe(15);
    expect(panelContent.indexOf('已完成任务 26')).toBeGreaterThanOrEqual(0);
    expect(panelContent.indexOf('已完成任务 25')).toBeGreaterThan(panelContent.indexOf('已完成任务 26'));
    expect(panelContent).toContain('已完成任务 12');
    expect(panelContent).not.toContain('已完成任务 11');
    expect(panelContent).toContain('…另有 11 项更早已完成任务');

    const recentCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('compact-list', 'recent')) as any;
    const recentMd = recentCard.body.elements.find(
      (el: any) => el.tag === 'markdown' && String(el.content).includes('**子任务（36）**'),
    );
    expect(RECENT_COMPLETED_WORKSTREAM_LIMIT).toBe(5);
    expect(recentMd).toBeTruthy();
    expect(recentMd.content).toContain('活跃子任务 01');
    expect(recentMd.content).toContain('已完成任务 26');
    expect(recentMd.content).toContain('已完成任务 22');
    expect(recentMd.content).not.toContain('已完成任务 21');
    expect(recentMd.content).toContain('已省略更早完成的 21 项子任务');
  });

  it('supports all / collapsed / recent in status-dashboard without nesting table inside collapsible_panel', () => {
    const project = makeLargeScaleProject();

    const allCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('status-dashboard', 'all')) as any;
    const allTable = allCard.body.elements.find((el: any) => el.tag === 'table');
    expect(allTable.rows).toHaveLength(36);

    const collapsedCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('status-dashboard', 'collapsed')) as any;
    const activeHeading = collapsedCard.body.elements.find(
      (el: any) => el.tag === 'markdown' && String(el.content).includes('**子任务状态（未完成 10 / 共 36）**'),
    );
    expect(activeHeading).toBeTruthy();
    const activeTable = collapsedCard.body.elements.find((el: any) => el.tag === 'table');
    expect(activeTable).toBeTruthy();
    expect(activeTable.rows).toHaveLength(10);
    expect(JSON.stringify(activeTable.rows)).not.toContain('已完成任务');

    const completedPanel = collapsedCard.body.elements.find(
      (el: any) => el.tag === 'collapsible_panel' && el.header?.title?.content === '已完成子任务（26 项）',
    );
    expect(completedPanel).toBeTruthy();
    expect(completedPanel.expanded).toBe(false);
    expect(completedPanel.elements.every((el: any) => el.tag !== 'table')).toBe(true);
    expect(completedPanel.elements[0].content).toContain('已完成任务 26');
    expect(completedPanel.elements[0].content).toContain('已完成任务 12');
    expect(completedPanel.elements[0].content).not.toContain('已完成任务 11');
    expect(completedPanel.elements[0].content).toContain('…另有 11 项更早已完成任务');

    const recentCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('status-dashboard', 'recent')) as any;
    const recentTable = recentCard.body.elements.find((el: any) => el.tag === 'table');
    expect(recentTable.rows).toHaveLength(15);
    expect(JSON.stringify(recentTable.rows)).toContain('已完成任务 26');
    expect(JSON.stringify(recentTable.rows)).toContain('已完成任务 22');
    expect(JSON.stringify(recentTable.rows)).not.toContain('已完成任务 21');
    expect(JSON.stringify(recentCard.body.elements)).toContain('已省略更早完成的 21 项子任务');
  });

  it('handles 100%-completed and 0%-completed edge cases cleanly in collapsed mode', () => {
    const allDoneProject = makeProject({
      workstreams: Array.from({ length: 4 }, (_, index) => ({
        dispatchRoot: `om_done_${index}`,
        title: `收尾任务 ${index + 1}`,
        purpose: '已完成验证',
        owners: ['Codex'],
        status: 'completed' as const,
        progress: 100,
        createdAt: `2026-11-12T01:0${index}:00.000Z`,
        updatedAt: `2026-11-12T01:0${index}:00.000Z`,
      })),
    });
    const dashboardDone = buildProjectGroupCard(allDoneProject, 'feishu', makeCardConfig('status-dashboard', 'collapsed')) as any;
    expect(dashboardDone.body.elements.some((el: any) => el.tag === 'table')).toBe(false);
    expect(JSON.stringify(dashboardDone.body.elements)).toContain('当前无未完成子任务');
    const dashboardPanel = dashboardDone.body.elements.find(
      (el: any) => el.tag === 'collapsible_panel' && el.header?.title?.content === '已完成子任务（4 项）',
    );
    expect(dashboardPanel).toBeTruthy();
    expect(dashboardPanel.elements[0].content).not.toContain('另有');

    const compactDone = buildProjectGroupCard(allDoneProject, 'feishu', makeCardConfig('compact-list', 'collapsed')) as any;
    expect(JSON.stringify(compactDone.body.elements)).toContain('当前无未完成子任务');

    const noneDoneProject = makeProject();
    for (const templateId of ['status-dashboard', 'compact-list'] as const) {
      const card = buildProjectGroupCard(noneDoneProject, 'feishu', makeCardConfig(templateId, 'collapsed')) as any;
      expect(
        card.body.elements.some((el: any) => el.tag === 'collapsible_panel' && String(el.header?.title?.content).includes('已完成子任务')),
      ).toBe(false);
    }
  });

  it.each([
    ['compact-list', 'collapsed'],
    ['compact-list', 'recent'],
    ['status-dashboard', 'collapsed'],
    ['status-dashboard', 'recent'],
  ] as const)(
    'keeps 36-workstream card payload under 30 KB limit for %s (%s)',
    (templateId, completedDisplay) => {
      const project = makeLargeScaleProject();
      const cardJson = JSON.stringify(buildProjectGroupCard(project, 'feishu', makeCardConfig(templateId, completedDisplay)));
      expect(Buffer.byteLength(cardJson, 'utf8')).toBeLessThan(TURN_REPLY_CARD_MAX_BYTES);
      expect(turnReplyCardRequestBytes(cardJson, project.chatId)).toBeLessThan(TURN_REPLY_CARD_MAX_BYTES);
    },
  );
});

describe('imported workstream status derivation, bot name display, and moved filtering', () => {
  const nowIso = '2026-11-12T08:00:00.000Z';
  const nowMs = Date.parse(nowIso);

  function attachedItem(
    dispatchRoot: string,
    title: string,
    appId: string,
    overrides: Partial<ProjectWorkstream> = {},
    state: NonNullable<ProjectWorkstream['attachment']>['state'] = 'active',
  ): ProjectWorkstream {
    return {
      dispatchRoot,
      threadId: `omt_${dispatchRoot}`,
      title,
      purpose: '迁入子任务验证说明',
      owners: [appId],
      status: 'pending',
      progress: 0,
      attachment: {
        sourceSessionId: `sess_${dispatchRoot}`,
        sourceLarkAppId: appId,
        revision: 1,
        routeRevision: 1,
        source: 'relay',
        state,
        reportCapability: 'verified',
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      ...overrides,
    };
  }

  it('derives running / waiting_reply / idle / closed for imported rows and merges with explicit report statuses', () => {
    const runtime: ProjectGroupCardRuntime = {
      now: nowMs,
      ownerDisplayNames: {
        cli_claude: 'BotAlpha',
        cli_codex: 'BotBeta',
        cli_gamma: 'BotGamma',
      },
      sessionFactsByRoot: {
        om_working: { status: 'working', busySinceAt: nowMs },
        om_delivered: { status: 'idle', lastTurn: { turnId: 'om_t1', outcome: 'delivered', at: nowMs } },
        om_prompt: { status: 'idle', tuiPromptActive: true },
        om_idle: { status: 'idle', lastTurn: null },
        om_inprog_idle: { status: 'idle', lastTurn: null },
        om_inprog_delivered: { status: 'idle', lastTurn: { turnId: 'om_t2', outcome: 'delivered', at: nowMs } },
        om_closed_live: { status: 'closed', closedAt: nowMs },
        om_completed_override: { status: 'idle', lastTurn: null },
        om_blocked_override: { status: 'working', busySinceAt: nowMs },
      },
    };

    expect(resolveWorkstreamDisplayStatus(attachedItem('om_working', '在跑任务', 'cli_claude'), runtime))
      .toEqual({ kind: 'running', label: '在跑', color: 'blue' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_delivered', '已投递等回', 'cli_claude'), runtime))
      .toEqual({ kind: 'waiting_reply', label: '等回复', color: 'wathet' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_prompt', '弹框等回', 'cli_gamma'), runtime))
      .toEqual({ kind: 'waiting_reply', label: '等回复', color: 'orange' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_idle', '空闲任务', 'cli_codex'), runtime))
      .toEqual({ kind: 'idle', label: '空闲', color: 'neutral' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_inprog_idle', '显式进行中', 'cli_claude', { status: 'in_progress' }), runtime))
      .toEqual({ kind: 'in_progress', label: '进行中', color: 'blue' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_inprog_delivered', '显式进行中后投递', 'cli_claude', { status: 'in_progress' }), runtime))
      .toEqual({ kind: 'waiting_reply', label: '等回复', color: 'wathet' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_closed_live', '关闭会话', 'cli_claude'), runtime))
      .toEqual({ kind: 'closed', label: '已关闭', color: 'neutral' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_closed_state', '关闭关联', 'cli_claude', { status: 'in_progress' }, 'closed'), runtime))
      .toEqual({ kind: 'closed', label: '已关闭', color: 'neutral' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_completed_override', '已完结任务', 'cli_claude', { status: 'completed', progress: 100 }), runtime))
      .toEqual({ kind: 'completed', label: '已完成', color: 'green' });
    expect(resolveWorkstreamDisplayStatus(attachedItem('om_blocked_override', '显式受阻', 'cli_claude', { status: 'blocked' }), runtime))
      .toEqual({ kind: 'blocked', label: '阻塞', color: 'orange' });

    expect(resolveWorkstreamOwnerNames(attachedItem('om_working', '在跑任务', 'cli_claude'), runtime)).toEqual(['BotAlpha']);
  });

  it('removes attachment.state=moved rows from card display and counts while preserving ProjectStore data and deduping suffixes', () => {
    const movedRow = attachedItem(
      'om_moved_camera',
      '内置模块示例：调研与实现（已迁出）',
      'cli_claude',
      { status: 'pending' },
      'moved',
    );
    expect(formatProjectWorkstreamTitle(movedRow)).toBe('内置模块示例：调研与实现（已迁出）');
    expect(formatProjectWorkstreamTitle({
      ...movedRow,
      title: '内置模块示例：调研与实现（已迁出）（已迁出）',
    })).toBe('内置模块示例：调研与实现（已迁出）');

    const project = makeProject({
      remaining: undefined,
      workstreams: [
        {
          dispatchRoot: 'om_dispatch_active',
          title: '核心组件瘦身：评估与实测',
          purpose: '派单进行中',
          owners: ['BotAlpha'],
          status: 'in_progress',
          progress: 100,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        attachedItem('om_attach_wait', '子模块插件化：改造与验证', 'cli_claude'),
        attachedItem('om_attach_idle', '多渠道差分升级包实测', 'cli_codex'),
        attachedItem('om_attach_run', '历史增量对账与每日明细补齐', 'cli_gamma'),
        movedRow,
        {
          dispatchRoot: 'om_dispatch_done',
          title: '版本变更台账：标题补可点击链接',
          purpose: '派单已完成',
          owners: ['BotAlpha'],
          status: 'completed',
          progress: 100,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
    });
    const runtime: ProjectGroupCardRuntime = {
      now: nowMs,
      ownerDisplayNames: {
        cli_claude: 'BotAlpha',
        cli_codex: 'BotBeta',
        cli_gamma: 'BotGamma',
      },
      sessionFactsByRoot: {
        om_attach_wait: { status: 'idle', lastTurn: { turnId: 'om_tw', outcome: 'delivered', at: nowMs } },
        om_attach_idle: { status: 'idle', lastTurn: null },
        om_attach_run: { status: 'working', busySinceAt: nowMs },
      },
    };

    // Underlying ProjectStore array retains all 6 items (including moved) for audit/lookup.
    expect(project.workstreams).toHaveLength(6);
    // Counts exclude the moved row (5 visible: 4 incomplete + 1 completed).
    expect(projectRemainingSummary(project)).toBe('4 个子任务');
    expect(projectOverallProgress(project)).toBe(Math.round((100 + 0 + 0 + 0 + 100) / 5));

    const compactCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('compact-list', 'collapsed'), runtime) as any;
    const compactJson = JSON.stringify(compactCard);
    expect(compactJson).toContain('**子任务（未完成 4 / 共 5）**');
    expect(compactJson).not.toContain('内置模块示例');
    expect(compactJson).not.toContain('cli_claude');
    expect(compactJson).not.toContain('cli_codex');
    expect(compactJson).not.toContain('cli_gamma');
    expect(compactJson).toContain('BotAlpha');
    expect(compactJson).toContain('BotBeta');
    expect(compactJson).toContain('BotGamma');
    expect(compactJson).toContain('在跑');
    expect(compactJson).toContain('等回复');
    expect(compactJson).toContain('空闲');
    expect(compactJson).not.toContain('未开始');
    expect(compactJson).toContain('1 项进行中 · 1 项在跑 · 1 项等回复 · 1 项空闲 · 1 项已完成');

    const dashboardCard = buildProjectGroupCard(project, 'feishu', makeCardConfig('status-dashboard', 'collapsed'), runtime) as any;
    const dashboardJson = JSON.stringify(dashboardCard);
    expect(dashboardJson).toContain('**子任务状态（未完成 4 / 共 5）**');
    expect(dashboardJson).not.toContain('内置模块示例');

    // Edge case: project with ONLY moved workstreams omits empty workstream tables cleanly.
    const onlyMoved = makeProject({ workstreams: [movedRow] });
    const onlyMovedCard = buildProjectGroupCard(onlyMoved, 'feishu', makeCardConfig('status-dashboard', 'all'), runtime) as any;
    expect(onlyMovedCard.body.elements.some((el: any) => el.tag === 'table')).toBe(false);
  });
});
