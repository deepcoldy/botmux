import { threadAppLink, type Brand } from './lark-hosts.js';
import {
  projectRemainingSummary,
  type ProjectGroupState,
  type ProjectWorkstream,
  type ProjectWorkstreamStatus,
} from '../../services/project-group-store.js';
import {
  resolveProjectProgressCardConfig,
  type ProjectProgressCardConfig,
  type ProjectProgressCardSectionId,
} from '../../services/project-progress-card-config.js';

const STATUS_META: Record<ProjectWorkstreamStatus, { label: string; color: string }> = {
  pending: { label: '未开始', color: 'neutral' },
  in_progress: { label: '进行中', color: 'blue' },
  blocked: { label: '阻塞', color: 'orange' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
};

const STATUS_ORDER: Record<ProjectWorkstreamStatus, number> = {
  blocked: 0,
  in_progress: 1,
  pending: 2,
  failed: 3,
  completed: 4,
};

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function topicLink(project: ProjectGroupState, item: ProjectWorkstream, brand: Brand): string | undefined {
  if (!item.threadId) return undefined;
  return `[进入话题](${threadAppLink(project.chatId, item.threadId, brand)})`;
}

function displayWorkstreams(project: ProjectGroupState): ProjectWorkstream[] {
  return project.workstreams
    .map((item, index) => ({ item, index }))
    .sort((left, right) => STATUS_ORDER[left.item.status] - STATUS_ORDER[right.item.status] || left.index - right.index)
    .map(({ item }) => item);
}

function workstreamTitle(item: ProjectWorkstream): string {
  const title = item.title.trim();
  return title && title !== '子任务' && title !== '子项目' ? truncate(title, 32) : '待命名任务';
}

function workstreamPlanItem(project: ProjectGroupState, item: ProjectWorkstream, brand: Brand): string {
  const status = STATUS_META[item.status];
  const link = topicLink(project, item, brand);
  const title = escapeMarkdown(workstreamTitle(item));
  return `<text_tag color='${status.color}'>${status.label}</text_tag> **${title}**${link ? ` · ${link}` : ''}`;
}

function workstreamTitleItem(project: ProjectGroupState, item: ProjectWorkstream, brand: Brand): string {
  const link = topicLink(project, item, brand);
  const title = escapeMarkdown(workstreamTitle(item));
  return `**${title}**${link ? ` · ${link}` : ''}`;
}

function remainingPlanItems(project: ProjectGroupState): string[] {
  const text = project.remaining?.trim();
  if (!text || text === '无') return [];
  return text.split(/\s*[·•；;\n]\s*/).map(item => item.trim()).filter(Boolean).slice(0, 5);
}

function uniquePlanItems(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function projectProgressSummary(project: ProjectGroupState): string {
  if (project.status === 'completed') return '目标已完成';
  const counts = project.workstreams.reduce((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { pending: 0, in_progress: 0, blocked: 0, completed: 0, failed: 0 });
  const parts = [
    counts.blocked > 0 ? `${counts.blocked} 项阻塞` : '',
    counts.failed > 0 ? `${counts.failed} 项失败` : '',
    counts.in_progress > 0 ? `${counts.in_progress} 项进行中` : '',
    counts.pending > 0 ? `${counts.pending} 项待开始` : '',
    counts.completed > 0 ? `${counts.completed} 项已完成` : '',
  ].filter(Boolean);
  if (parts.length > 0) {
    if (counts.completed === project.workstreams.length && remainingPlanItems(project).length > 0) {
      return '子任务已完成，项目进入收尾';
    }
    return parts.join(' · ');
  }
  return '等待拆解首批任务';
}

function heroElement(label: string, content: string, color: string, background: string): Record<string, unknown> {
  return {
    tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
    has_border: false, disabled: false, background_style: background, padding: '12px 14px 12px 14px',
    direction: 'vertical', horizontal_spacing: '4px', vertical_spacing: '4px',
    horizontal_align: 'left', vertical_align: 'top', margin: '6px 0px 0px 0px',
    elements: [
      { tag: 'markdown', content: `<font color='${color}'>**${label}**</font>`, text_align: 'left', text_size: 'notation' },
      { tag: 'markdown', content: `**${escapeMarkdown(content)}**`, text_align: 'left', text_size: 'heading-3' },
    ],
  };
}

export interface ProjectGroupOnboardingCardInput {
  coordinatorName: string;
  workerNames: string[];
  updatedAt: string;
}

/** Build the durable pre-project guide that occupies the same pinned message
 * later reused by the live project card. Starting remains a normal top-level
 * message so the first conversation can stay exploratory. Role configuration
 * is exposed as a slash command because its native card is sent privately to
 * the owner and reuses the existing `/role` storage and prompt injection. */
export function buildProjectGroupOnboardingCard(input: ProjectGroupOnboardingCardInput): Record<string, unknown> {
  const coordinatorName = truncate(input.coordinatorName || '主控 Bot', 40);
  const workerNames = input.workerNames.map(name => truncate(name, 32)).filter(Boolean).slice(0, 8);
  const workers = workerNames.length > 0 ? workerNames.join('、') : '尚未配置 Worker';
  const updated = new Date(input.updatedAt);
  const updatedLabel = Number.isNaN(updated.getTime())
    ? input.updatedAt
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(updated).replace('/', '-');
  const elements: Array<Record<string, unknown>> = [
    heroElement('下一步', `在群消息顶层 @${coordinatorName}，从讨论或执行开始`, 'indigo', 'indigo-50'),
    {
      tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
      has_border: false, disabled: false, background_style: 'blue-50', padding: '10px 12px 10px 12px',
      direction: 'vertical', horizontal_spacing: '4px', vertical_spacing: '4px',
      horizontal_align: 'left', vertical_align: 'top', margin: '6px 0px 0px 0px',
      elements: [{
        tag: 'markdown', text_align: 'left', text_size: 'normal',
        content: `<font color='blue'>**先讨论**</font>\n还没有明确目标时：\n> @${escapeMarkdown(coordinatorName)} 我想讨论「……」，先帮我澄清问题、约束和下一步。`,
      }],
    },
    {
      tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
      has_border: false, disabled: false, background_style: 'green-50', padding: '10px 12px 10px 12px',
      direction: 'vertical', horizontal_spacing: '4px', vertical_spacing: '4px',
      horizontal_align: 'left', vertical_align: 'top', margin: '6px 0px 0px 0px',
      elements: [{
        tag: 'markdown', text_align: 'left', text_size: 'normal',
        content: `<font color='green'>**直接执行**</font>\n目标已经清楚时：\n> @${escapeMarkdown(coordinatorName)} 启动「……」项目，目标是……，请拆解并推进。`,
      }],
    },
    {
      tag: 'markdown', text_align: 'left', text_size: 'normal', margin: '8px 0px 0px 0px',
      content: `<font color='purple'>**协作配置**</font>\n主控：**${escapeMarkdown(coordinatorName)}**\nWorker：${escapeMarkdown(workers)}\n角色：在群顶层发送 \`@${escapeMarkdown(coordinatorName)} /project roles\``,
    },
    { tag: 'hr', margin: '12px 0px 0px 0px' },
    {
      tag: 'markdown', text_align: 'left', text_size: 'small', margin: '8px 0px 0px 0px',
      content: `<font color='grey'>配置源：Botmux 项目群配置 · 项目尚未初始化 · 更新于 ${updatedLabel}</font>`,
    },
  ];
  return {
    schema: '2.0',
    config: {
      update_multi: true, compact_width: false, enable_forward: true,
      streaming_mode: false, width_mode: 'fill',
      summary: { content: '项目群已就绪 · 等待开始讨论或执行' },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '项目群已就绪', text_align: 'left' },
      subtitle: { tag: 'plain_text', content: '普通群项目协作模式', text_align: 'left' },
      text_tag_list: [{
        tag: 'text_tag', text: { tag: 'plain_text', content: '待启动', text_align: 'left' }, color: 'blue',
      }],
    },
    body: {
      direction: 'vertical', horizontal_spacing: '8px', vertical_spacing: '8px',
      horizontal_align: 'left', vertical_align: 'top', padding: '12px 12px 12px 12px', elements,
    },
  };
}

function planSurface(
  label: string,
  color: string,
  background: string,
  marker: string,
  items: string[],
  emptyText: string,
): Record<string, unknown> {
  const visible = items.slice(0, 4);
  const more = items.length > visible.length ? `\n<font color='grey'>另有 ${items.length - visible.length} 项，见下方子任务表</font>` : '';
  return {
    tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
    has_border: false, disabled: false, background_style: background, padding: '10px 12px 10px 12px',
    direction: 'vertical', horizontal_spacing: '4px', vertical_spacing: '4px',
    horizontal_align: 'left', vertical_align: 'top', margin: '6px 0px 0px 0px',
    elements: [{
      tag: 'markdown',
      content: `<font color='${color}'>**${label} · ${items.length}**</font>\n${visible.length > 0 ? visible.map(item => `${marker} ${item}`).join('\n') : `<font color='grey'>${emptyText}</font>`}${more}`,
      text_align: 'left', text_size: 'normal', margin: '0px 0px 0px 0px',
    }],
  };
}

function planElements(project: ProjectGroupState, brand: Brand): Array<Record<string, unknown>> {
  const ordered = displayWorkstreams(project);
  const doing = ordered.filter(item => item.status === 'blocked' || item.status === 'failed' || item.status === 'in_progress')
    .map(item => workstreamPlanItem(project, item, brand));
  const pending = ordered.filter(item => item.status === 'pending')
    .map(item => workstreamTitleItem(project, item, brand));
  const todo = uniquePlanItems([
    ...pending,
    ...remainingPlanItems(project).map(item => escapeMarkdown(truncate(item, 80))),
  ]);
  const done = ordered.filter(item => item.status === 'completed')
    .slice(-4)
    .map(item => workstreamTitleItem(project, item, brand));
  return [
    {
      tag: 'markdown', content: `<font color='indigo'>**推进概况**</font> · ${escapeMarkdown(projectProgressSummary(project))}`,
      text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
    },
    ...(doing.length > 0
      ? [planSurface('进行中', 'blue', 'blue-50', '<font color=\'blue\'>●</font>', doing, '当前没有进行中事项')]
      : []),
    planSurface('待办计划', 'purple', 'grey-50', '<font color=\'purple\'>○</font>', todo, '当前没有待办事项'),
    planSurface('完成记录', 'green', 'green-50', '<font color=\'green\'>✓</font>', done, '尚无已完成事项'),
  ];
}

function workstreamRows(project: ProjectGroupState, brand: Brand): Array<Record<string, string>> {
  return displayWorkstreams(project).map(item => {
    const status = STATUS_META[item.status];
    const link = topicLink(project, item, brand);
    const owner = escapeMarkdown(truncate(item.owners.join('、') || '待认领', 32));
    const blocker = item.status === 'blocked'
      ? `<font color='orange'>${escapeMarkdown(truncate(item.blocker || '原因待补充', 72))}</font>`
      : '';
    return {
      wf: `**<font color='indigo'>${escapeMarkdown(workstreamTitle(item))}</font>**\n<font color='grey'>${escapeMarkdown(truncate(item.purpose, 72))}</font>\n<font color='purple'>负责人 · ${owner}</font>`,
      status: `<text_tag color='${status.color}'>${status.label}</text_tag>${link ? `\n**${link}**` : ''}${blocker ? `\n${blocker}` : ''}`,
    };
  });
}

function milestonePanel(project: ProjectGroupState, expanded: boolean): Record<string, unknown> {
  const recent = project.milestones.slice(-3).reverse();
  const next = project.nextMilestone ? ` · 下一节点 ${truncate(project.nextMilestone, 40)}` : '';
  const summary = `${recent.length} 项${next}`;
  const content = recent.length > 0
    ? recent.map(item => `- <font color='green'>✓</font> **<font color='indigo'>${item.createdAt.slice(5, 10)}</font>** ${escapeMarkdown(truncate(item.content, 100))}`).join('\n')
    : '- 暂无已完成里程碑';
  return {
    tag: 'collapsible_panel', expanded, margin: '4px 0px 0px 0px',
    padding: '4px 12px 12px 12px', background_color: 'grey-50',
    header: {
      title: { tag: 'plain_text', content: `最近里程碑（${summary}）`, text_align: 'left' },
      expanded_title: { tag: 'plain_text', content: `收起最近里程碑（${summary}）`, text_align: 'left' },
      padding: '12px 12px 12px 12px', width: 'fill',
      icon: { tag: 'standard_icon', token: 'down_outlined', color: 'grey' },
      icon_position: 'right', icon_expanded_angle: -180,
    },
    elements: [{ tag: 'markdown', content, text_align: 'left', text_size: 'normal' }],
  };
}

function sectionEnabled(config: ProjectProgressCardConfig, section: ProjectProgressCardSectionId): boolean {
  return config.sections.includes(section);
}

function focusElements(project: ProjectGroupState, config: ProjectProgressCardConfig): Array<Record<string, unknown>> {
  return [
    ...(sectionEnabled(config, 'goal')
      ? [heroElement('目标', project.goal, 'indigo', 'indigo-50')]
      : []),
    heroElement('当前推进', project.focus || '等待更新', 'blue', 'blue-50'),
  ];
}

function blockerElement(project: ProjectGroupState): Record<string, unknown> {
  return {
    tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
    has_border: false, disabled: false, background_style: 'orange-50', padding: '12px 12px 12px 12px',
    direction: 'vertical', horizontal_spacing: '8px', vertical_spacing: '8px',
    horizontal_align: 'left', vertical_align: 'top', margin: '8px 0px 0px 0px',
    elements: [{
      tag: 'markdown',
      content: `<font color='orange'>**待决策 / 阻塞（${project.blockers.length} 项）**</font>\n${project.blockers.map((item, index) => `${index + 1}. ${escapeMarkdown(truncate(item, 120))}`).join('\n')}`,
      text_align: 'left', text_size: 'normal', margin: '0px 0px 0px 0px',
    }],
  };
}

interface TemplateBodyContext {
  project: ProjectGroupState;
  brand: Brand;
  config: ProjectProgressCardConfig;
}

function statusDashboardBody(context: TemplateBodyContext): Array<Record<string, unknown>> {
  const { project, brand, config } = context;
  const body: Array<Record<string, unknown>> = [
    ...focusElements(project, config),
    ...planElements(project, brand),
  ];
  if (sectionEnabled(config, 'blockers') && project.blockers.length > 0) body.push(blockerElement(project));
  if (sectionEnabled(config, 'workstreams')) {
    body.push({
      tag: 'markdown', content: `<font color='blue'>**子任务状态（${project.workstreams.length}）**</font>`,
      text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
    });
    if (project.workstreams.length > 0) {
      body.push({
        tag: 'table',
        columns: [
          { data_type: 'markdown', name: 'wf', display_name: '子任务', horizontal_align: 'left', width: 'auto' },
          { data_type: 'markdown', name: 'status', display_name: '状态 / 话题', horizontal_align: 'left', width: 'auto' },
        ],
        rows: workstreamRows(project, brand), row_height: 'auto',
        header_style: { text_align: 'left', background_style: 'blue-50', text_color: 'blue', bold: true },
        page_size: Math.min(10, Math.max(1, project.workstreams.length)), margin: '8px 0px 0px 0px',
      });
    } else {
      body.push({
        tag: 'markdown', content: "<font color='grey'>尚未派发子任务。使用 botmux dispatch 后会自动登记到这里。</font>",
        text_align: 'left', text_size: 'normal', margin: '8px 0px 0px 0px',
      });
    }
  }
  if (sectionEnabled(config, 'milestones')) body.push(milestonePanel(project, config.milestonesExpanded));
  return body;
}

function compactListBody(context: TemplateBodyContext): Array<Record<string, unknown>> {
  const { project, brand, config } = context;
  const body: Array<Record<string, unknown>> = [
    ...focusElements(project, config),
    {
      tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
      has_border: false, disabled: false, background_style: 'grey-50', padding: '10px 12px 10px 12px',
      direction: 'vertical', horizontal_spacing: '6px', vertical_spacing: '6px',
      horizontal_align: 'left', vertical_align: 'top', margin: '8px 0px 0px 0px',
      elements: [{
        tag: 'markdown',
        content: `**<font color='indigo'>${escapeMarkdown(projectProgressSummary(project))}</font>** · <font color='blue'>阶段 ${escapeMarkdown(truncate(project.phase, 24))}</font>\n<font color='purple'>下一步：${escapeMarkdown(truncate(projectRemainingSummary(project), 80))}</font>`,
        text_align: 'left', text_size: 'normal', margin: '0px 0px 0px 0px',
      }],
    },
  ];
  if (sectionEnabled(config, 'blockers') && project.blockers.length > 0) body.push(blockerElement(project));
  if (sectionEnabled(config, 'workstreams')) {
    const rows = project.workstreams.length > 0
      ? displayWorkstreams(project).map(item => {
          const status = STATUS_META[item.status];
          const owner = truncate(item.owners.join('、') || '待认领', 32);
          const link = topicLink(project, item, brand);
          return `- <text_tag color='${status.color}'>${status.label}</text_tag> **<font color='indigo'>${escapeMarkdown(workstreamTitle(item))}</font>** · <font color='purple'>${escapeMarkdown(owner)}</font>${link ? ` · ${link}` : ''}`;
        }).join('\n')
      : "<font color='grey'>尚未派发子任务。</font>";
    body.push({
      tag: 'markdown', content: `<font color='blue'>**子任务（${project.workstreams.length}）**</font>\n${rows}`,
      text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
    });
  }
  if (sectionEnabled(config, 'milestones')) body.push(milestonePanel(project, config.milestonesExpanded));
  return body;
}

const TEMPLATE_BODY_BUILDERS: Record<ProjectProgressCardConfig['templateId'], (context: TemplateBodyContext) => Array<Record<string, unknown>>> = {
  'status-dashboard': statusDashboardBody,
  'compact-list': compactListBody,
};

export function buildProjectGroupCard(
  project: ProjectGroupState,
  brand: Brand = 'feishu',
  rawConfig?: ProjectProgressCardConfig,
): Record<string, unknown> {
  const config = resolveProjectProgressCardConfig(rawConfig);
  const updated = new Date(project.updatedAt);
  const updatedLabel = Number.isNaN(updated.getTime())
    ? project.updatedAt
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(updated).replace('/', '-');
  const statusMeta = project.status === 'completed'
    ? { label: '已完成', color: 'green', header: 'green' }
    : project.status === 'paused'
      ? { label: '已暂停', color: 'neutral', header: 'grey' }
      : { label: '进行中', color: 'blue', header: 'blue' };
  const body = TEMPLATE_BODY_BUILDERS[config.templateId]({ project, brand, config });
  body.push(
    { tag: 'hr', margin: '12px 0px 0px 0px' },
    {
      tag: 'markdown',
      content: `<font color='grey'>状态源：Botmux ProjectStore · ${config.templateId} · 原地更新 · 更新于 ${updatedLabel}</font>`,
      text_align: 'left', text_size: 'small', margin: '8px 0px 0px 0px',
    },
  );
  return {
    schema: '2.0',
    config: {
      update_multi: true, compact_width: false, enable_forward: true,
      streaming_mode: false, width_mode: 'fill',
      summary: { content: truncate(`${project.title} · ${projectProgressSummary(project)} · 当前 ${project.focus}`, 60) },
    },
    header: {
      template: statusMeta.header,
      title: { tag: 'plain_text', content: project.title, text_align: 'left' },
      subtitle: { tag: 'plain_text', content: `项目控制面 · 更新于 ${updatedLabel}`, text_align: 'left' },
      text_tag_list: [{
        tag: 'text_tag', text: { tag: 'plain_text', content: statusMeta.label, text_align: 'left' }, color: statusMeta.color,
      }],
    },
    body: {
      direction: 'vertical', horizontal_spacing: '8px', vertical_spacing: '8px',
      horizontal_align: 'left', vertical_align: 'top', padding: '12px 12px 12px 12px', elements: body,
    },
  };
}
