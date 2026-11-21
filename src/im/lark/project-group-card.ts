import { deriveSessionTaskStatus, type SessionTaskFacts } from '../../core/session-task-status.js';
import { t, type Locale } from '../../i18n/index.js';
import { threadAppLink, type Brand } from './lark-hosts.js';
import { TABLE_AUTO_ROW_HEIGHT } from './table-style.js';
import {
  projectRemainingSummary,
  projectTitleWithoutTaskMarker,
  visibleProjectWorkstreams,
  type ProjectGroupState,
  type ProjectWorkstream,
} from '../../services/project-group-store.js';
import {
  resolveProjectProgressCardCompletedDisplay,
  resolveProjectProgressCardConfig,
  type ProjectProgressCardConfig,
  type ProjectProgressCardSectionId,
} from '../../services/project-progress-card-config.js';

export const COLLAPSED_COMPLETED_WORKSTREAM_LIMIT = 15;
export const RECENT_COMPLETED_WORKSTREAM_LIMIT = 5;

export interface ProjectGroupCardRuntime {
  /** Keyed by dispatchRoot: live or persisted SessionTaskFacts for attached source sessions. */
  sessionFactsByRoot?: Readonly<Record<string, SessionTaskFacts | undefined>>;
  /** Keyed by raw owner token (e.g. cli_xxx larkAppId): human-readable bot display name. */
  ownerDisplayNames?: Readonly<Record<string, string>>;
  /** Optional clock override for deterministic status derivation in tests. */
  now?: number;
}

export type ProjectWorkstreamDisplayKind =
  | 'blocked'
  | 'failed'
  | 'in_progress'
  | 'running'
  | 'waiting_reply'
  | 'idle'
  | 'pending'
  | 'closed'
  | 'completed';

export interface ProjectWorkstreamDisplayStatus {
  kind: ProjectWorkstreamDisplayKind;
  label: string;
  color: string;
}

const DISPLAY_STATUS_ORDER: Record<ProjectWorkstreamDisplayKind, number> = {
  blocked: 0,
  running: 1,
  in_progress: 1,
  waiting_reply: 2,
  idle: 3,
  pending: 4,
  closed: 5,
  failed: 6,
  completed: 7,
};

const ATTACHMENT_STATE_SUFFIXES = [
  '（已迁出）',
  '（连接已关闭）',
  '（连接待核对）',
  '（登记待完成）',
  '（手工跟踪）',
] as const;

export function resolveWorkstreamDisplayStatus(
  item: ProjectWorkstream,
  runtime?: ProjectGroupCardRuntime,
): ProjectWorkstreamDisplayStatus {
  // Explicit terminal or blocker states from `botmux report` / coordinator `update` always win.
  if (item.status === 'completed') return { kind: 'completed', label: '已完成', color: 'green' };
  if (item.status === 'failed') return { kind: 'failed', label: '失败', color: 'red' };
  if (item.status === 'blocked') return { kind: 'blocked', label: '阻塞', color: 'orange' };

  if (!item.attachment) {
    return item.status === 'in_progress'
      ? { kind: 'in_progress', label: '进行中', color: 'blue' }
      : { kind: 'pending', label: '未开始', color: 'neutral' };
  }

  if (item.attachment.state === 'closed') {
    return { kind: 'closed', label: '已关闭', color: 'neutral' };
  }
  if (item.attachment.state === 'pending') {
    return { kind: 'pending', label: '未开始', color: 'neutral' };
  }

  const facts = runtime?.sessionFactsByRoot?.[item.dispatchRoot];
  if (facts) {
    const derived = deriveSessionTaskStatus(facts, runtime?.now);
    if (derived.kind === 'closed') return { kind: 'closed', label: '已关闭', color: 'neutral' };
    if (derived.kind === 'working') return { kind: 'running', label: '在跑', color: 'blue' };
    if (derived.kind === 'needs_you') return { kind: 'waiting_reply', label: '等回复', color: 'orange' };
    if (derived.kind === 'delivered') return { kind: 'waiting_reply', label: '等回复', color: 'wathet' };
    return item.status === 'in_progress'
      ? { kind: 'in_progress', label: '进行中', color: 'blue' }
      : { kind: 'idle', label: '空闲', color: 'neutral' };
  }

  if (item.status === 'in_progress') {
    return { kind: 'in_progress', label: '进行中', color: 'blue' };
  }
  if (
    runtime?.sessionFactsByRoot
    && Object.prototype.hasOwnProperty.call(runtime.sessionFactsByRoot, item.dispatchRoot)
    && item.attachment.state === 'active'
  ) {
    return { kind: 'idle', label: '空闲', color: 'neutral' };
  }
  return { kind: 'pending', label: '未开始', color: 'neutral' };
}

export function resolveWorkstreamOwnerNames(
  item: ProjectWorkstream,
  runtime?: ProjectGroupCardRuntime,
): string[] {
  const rawOwners = item.owners.length > 0
    ? item.owners
    : (item.attachment?.sourceLarkAppId ? [item.attachment.sourceLarkAppId] : []);
  const out: string[] = [];
  for (const raw of rawOwners) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const mapped = runtime?.ownerDisplayNames?.[trimmed]?.trim() || trimmed;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function formatWorkstreamOwnerText(item: ProjectWorkstream, runtime?: ProjectGroupCardRuntime): string {
  return truncate(resolveWorkstreamOwnerNames(item, runtime).join('、') || '待认领', 32);
}

function dedupeTrailingAttachmentSuffixes(rawTitle: string): string {
  let result = rawTitle.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ATTACHMENT_STATE_SUFFIXES) {
      if (result.endsWith(`${suffix}${suffix}`)) {
        result = result.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return result;
}

export function formatProjectWorkstreamTitle(item: ProjectWorkstream): string {
  const cleaned = dedupeTrailingAttachmentSuffixes(item.title);
  const label = cleaned && cleaned !== '子任务' && cleaned !== '子项目' ? truncate(cleaned, 32) : '待命名任务';
  const attachment = item.attachment;
  const state = attachment?.state;
  const suffix = state === 'moved' ? '（已迁出）'
    : state === 'closed' ? '（连接已关闭）'
      : state === 'unknown' ? '（连接待核对）'
        : state === 'pending' ? '（登记待完成）'
          : attachment?.reportCapability === 'manual' ? '（手工跟踪）' : '';
  return suffix && !label.endsWith(suffix) ? `${label}${suffix}` : label;
}

export function buildProjectGroupCardDigest(
  project: ProjectGroupState,
  runtime?: ProjectGroupCardRuntime,
): string {
  const visible = visibleProjectWorkstreams(project);
  return JSON.stringify({
    revision: project.revision,
    status: project.status,
    rows: visible.map(item => {
      const display = resolveWorkstreamDisplayStatus(item, runtime);
      return [
        item.dispatchRoot,
        display.kind,
        display.label,
        display.color,
        formatWorkstreamOwnerText(item, runtime),
        formatProjectWorkstreamTitle(item),
      ];
    }),
  });
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function displayProjectTitle(value: string): string {
  const title = projectTitleWithoutTaskMarker(value);
  return truncate(title || '项目进度', 42);
}

function displayProjectGoal(value: string): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), 120);
}

function topicLink(project: ProjectGroupState, item: ProjectWorkstream, brand: Brand): string | undefined {
  if (!item.threadId) return undefined;
  return `[进入话题](${threadAppLink(project.chatId, item.threadId, brand)})`;
}

function displayWorkstreams(project: ProjectGroupState, runtime?: ProjectGroupCardRuntime): ProjectWorkstream[] {
  return visibleProjectWorkstreams(project)
    .map((item, index) => ({ item, index, order: DISPLAY_STATUS_ORDER[resolveWorkstreamDisplayStatus(item, runtime).kind] }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ item }) => item);
}

function completedWorkstreamsByRecent(project: ProjectGroupState): ProjectWorkstream[] {
  return visibleProjectWorkstreams(project)
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'completed')
    .sort((left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt) || right.index - left.index)
    .map(({ item }) => item);
}

function workstreamTitle(item: ProjectWorkstream): string {
  return formatProjectWorkstreamTitle(item);
}

function workstreamPlanItem(
  project: ProjectGroupState,
  item: ProjectWorkstream,
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): string {
  const status = resolveWorkstreamDisplayStatus(item, runtime);
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

function projectProgressSummary(project: ProjectGroupState, runtime?: ProjectGroupCardRuntime): string {
  if (project.status === 'completed') return '目标已完成';
  const visible = visibleProjectWorkstreams(project);
  if (visible.length === 0) {
    if (project.blockers.length > 0) return `${project.blockers.length} 项阻塞`;
    if (project.status === 'paused') return '项目已暂停';
    return '项目按当前阶段推进';
  }
  const counts: Record<ProjectWorkstreamDisplayKind, number> = {
    blocked: 0,
    failed: 0,
    in_progress: 0,
    running: 0,
    waiting_reply: 0,
    idle: 0,
    pending: 0,
    closed: 0,
    completed: 0,
  };
  for (const item of visible) {
    counts[resolveWorkstreamDisplayStatus(item, runtime).kind] += 1;
  }
  const parts = [
    counts.blocked > 0 ? `${counts.blocked} 项阻塞` : '',
    counts.failed > 0 ? `${counts.failed} 项失败` : '',
    counts.in_progress > 0 ? `${counts.in_progress} 项进行中` : '',
    counts.running > 0 ? `${counts.running} 项在跑` : '',
    counts.waiting_reply > 0 ? `${counts.waiting_reply} 项等回复` : '',
    counts.idle > 0 ? `${counts.idle} 项空闲` : '',
    counts.pending > 0 ? `${counts.pending} 项待开始` : '',
    counts.closed > 0 ? `${counts.closed} 项已关闭` : '',
    counts.completed > 0 ? `${counts.completed} 项已完成` : '',
  ].filter(Boolean);
  if (parts.length > 0) {
    if (counts.completed === visible.length && remainingPlanItems(project).length > 0) {
      return '子任务已完成，项目进入收尾';
    }
    return parts.join(' · ');
  }
  return '项目按当前阶段推进';
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

/** Replace an obsolete setup guide after the live progress card is published. */
export function buildProjectGroupStartedNoticeCard(locale?: Locale): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: t('project.started.summary', undefined, locale) } },
    header: { template: 'blue', title: { tag: 'plain_text', content: t('project.started.title', undefined, locale) } },
    body: { elements: [{ tag: 'markdown', content: t('project.started.body', undefined, locale) }] },
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
): Record<string, unknown> {
  const visible = items.slice(0, 4);
  const more = items.length > visible.length ? `\n<font color='grey'>另有 ${items.length - visible.length} 项</font>` : '';
  return {
    tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
    has_border: false, disabled: false, background_style: background, padding: '10px 12px 10px 12px',
    direction: 'vertical', horizontal_spacing: '4px', vertical_spacing: '4px',
    horizontal_align: 'left', vertical_align: 'top', margin: '6px 0px 0px 0px',
    elements: [{
      tag: 'markdown',
      content: `<font color='${color}'>**${label} · ${items.length}**</font>\n${visible.map(item => `${marker} ${item}`).join('\n')}${more}`,
      text_align: 'left', text_size: 'normal', margin: '0px 0px 0px 0px',
    }],
  };
}

function planElements(
  project: ProjectGroupState,
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): Array<Record<string, unknown>> {
  const ordered = displayWorkstreams(project, runtime);
  const doing = ordered.filter(item => {
    const kind = resolveWorkstreamDisplayStatus(item, runtime).kind;
    return kind === 'blocked'
      || kind === 'failed'
      || kind === 'in_progress'
      || kind === 'running'
      || kind === 'waiting_reply'
      || kind === 'idle'
      || kind === 'closed';
  }).map(item => workstreamPlanItem(project, item, brand, runtime));
  const pending = ordered.filter(item => resolveWorkstreamDisplayStatus(item, runtime).kind === 'pending')
    .map(item => workstreamTitleItem(project, item, brand));
  const todo = uniquePlanItems([
    ...pending,
    ...remainingPlanItems(project).map(item => escapeMarkdown(truncate(item, 80))),
  ]);
  const done = completedWorkstreamsByRecent(project)
    .map(item => workstreamTitleItem(project, item, brand));
  return [
    {
      tag: 'markdown', content: `<font color='indigo'>**推进概况**</font> · ${escapeMarkdown(projectProgressSummary(project, runtime))}`,
      text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
    },
    ...(doing.length > 0
      ? [planSurface('进行中', 'blue', 'blue-50', '<font color=\'blue\'>●</font>', doing)]
      : []),
    ...(todo.length > 0
      ? [planSurface('待办计划', 'purple', 'grey-50', '<font color=\'purple\'>○</font>', todo)]
      : []),
    ...(done.length > 0
      ? [planSurface('完成记录', 'green', 'green-50', '<font color=\'green\'>✓</font>', done)]
      : []),
  ];
}

function compactWorkstreamLine(
  project: ProjectGroupState,
  item: ProjectWorkstream,
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): string {
  const status = resolveWorkstreamDisplayStatus(item, runtime);
  const owner = formatWorkstreamOwnerText(item, runtime);
  const link = topicLink(project, item, brand);
  return `- <text_tag color='${status.color}'>${status.label}</text_tag> **<font color='indigo'>${escapeMarkdown(workstreamTitle(item))}</font>** · <font color='purple'>${escapeMarkdown(owner)}</font>${link ? ` · ${link}` : ''}`;
}

function completedWorkstreamPanel(
  project: ProjectGroupState,
  completedRecent: ProjectWorkstream[],
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): Record<string, unknown> {
  const visible = completedRecent.slice(0, COLLAPSED_COMPLETED_WORKSTREAM_LIMIT);
  const hiddenCount = completedRecent.length - visible.length;
  const lines = visible.map(item => compactWorkstreamLine(project, item, brand, runtime));
  if (hiddenCount > 0) {
    lines.push(`<font color='grey'>…另有 ${hiddenCount} 项更早已完成任务</font>`);
  }
  return {
    tag: 'collapsible_panel', expanded: false, margin: '6px 0px 0px 0px',
    padding: '4px 12px 12px 12px', background_color: 'grey-50',
    header: {
      title: { tag: 'plain_text', content: `已完成子任务（${completedRecent.length} 项）`, text_align: 'left' },
      expanded_title: { tag: 'plain_text', content: `收起已完成子任务（${completedRecent.length} 项）`, text_align: 'left' },
      padding: '12px 12px 12px 12px', width: 'fill',
      icon: { tag: 'standard_icon', token: 'down_outlined', color: 'grey' },
      icon_position: 'right', icon_expanded_angle: -180,
    },
    elements: [{ tag: 'markdown', content: lines.join('\n'), text_align: 'left', text_size: 'normal' }],
  };
}

function workstreamRows(
  items: ProjectWorkstream[],
  project: ProjectGroupState,
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): Array<Record<string, string>> {
  return items.map(item => {
    const status = resolveWorkstreamDisplayStatus(item, runtime);
    const link = topicLink(project, item, brand);
    const owner = escapeMarkdown(formatWorkstreamOwnerText(item, runtime));
    const blocker = item.status === 'blocked'
      ? `<font color='orange'>${escapeMarkdown(truncate(item.blocker || '原因待补充', 72))}</font>`
      : '';
    return {
      wf: `**<font color='indigo'>${escapeMarkdown(workstreamTitle(item))}</font>**\n<font color='grey'>${escapeMarkdown(truncate(item.purpose, 72))}</font>\n<font color='purple'>负责人 · ${owner}</font>`,
      status: `<text_tag color='${status.color}'>${status.label}</text_tag>${link ? `\n**${link}**` : ''}${blocker ? `\n${blocker}` : ''}`,
    };
  });
}

function workstreamTable(
  items: ProjectWorkstream[],
  project: ProjectGroupState,
  brand: Brand,
  runtime?: ProjectGroupCardRuntime,
): Record<string, unknown> {
  return {
    tag: 'table',
    columns: [
      { data_type: 'markdown', name: 'wf', display_name: '子任务', horizontal_align: 'left', width: 'auto' },
      { data_type: 'markdown', name: 'status', display_name: '状态 / 话题', horizontal_align: 'left', width: 'auto' },
    ],
    rows: workstreamRows(items, project, brand, runtime), ...TABLE_AUTO_ROW_HEIGHT,
    header_style: { text_align: 'left', background_style: 'blue-50', text_color: 'blue', bold: true },
    page_size: Math.min(10, items.length), margin: '8px 0px 0px 0px',
  };
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
      ? [heroElement('目标', displayProjectGoal(project.goal), 'indigo', 'indigo-50')]
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
  runtime?: ProjectGroupCardRuntime;
}

function statusDashboardBody(context: TemplateBodyContext): Array<Record<string, unknown>> {
  const { project, brand, config, runtime } = context;
  const visible = visibleProjectWorkstreams(project);
  const body: Array<Record<string, unknown>> = [
    ...focusElements(project, config),
    ...planElements(project, brand, runtime),
  ];
  if (sectionEnabled(config, 'blockers') && project.blockers.length > 0) body.push(blockerElement(project));
  if (sectionEnabled(config, 'workstreams') && visible.length > 0) {
    const completedDisplay = resolveProjectProgressCardCompletedDisplay(config);
    const ordered = displayWorkstreams(project, runtime);
    if (completedDisplay === 'all') {
      body.push({
        tag: 'markdown', content: `<font color='blue'>**子任务状态（${visible.length}）**</font>`,
        text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
      });
      body.push(workstreamTable(ordered, project, brand, runtime));
    } else if (completedDisplay === 'collapsed') {
      const active = ordered.filter(item => item.status !== 'completed');
      const completedRecent = completedWorkstreamsByRecent(project);
      if (completedRecent.length === 0) {
        body.push({
          tag: 'markdown', content: `<font color='blue'>**子任务状态（${visible.length}）**</font>`,
          text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
        });
        body.push(workstreamTable(active, project, brand, runtime));
      } else if (active.length > 0) {
        body.push({
          tag: 'markdown',
          content: `<font color='blue'>**子任务状态（未完成 ${active.length} / 共 ${visible.length}）**</font>`,
          text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
        });
        body.push(workstreamTable(active, project, brand, runtime));
        body.push(completedWorkstreamPanel(project, completedRecent, brand, runtime));
      } else {
        body.push({
          tag: 'markdown',
          content: `<font color='blue'>**子任务状态（未完成 0 / 共 ${visible.length}）**</font>\n<font color='grey'>当前无未完成子任务</font>`,
          text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
        });
        body.push(completedWorkstreamPanel(project, completedRecent, brand, runtime));
      }
    } else {
      const active = ordered.filter(item => item.status !== 'completed');
      const completedRecent = completedWorkstreamsByRecent(project);
      const shownCompleted = completedRecent.slice(0, RECENT_COMPLETED_WORKSTREAM_LIMIT);
      const hiddenCount = completedRecent.length - shownCompleted.length;
      body.push({
        tag: 'markdown', content: `<font color='blue'>**子任务状态（${visible.length}）**</font>`,
        text_align: 'left', text_size: 'normal', margin: '12px 0px 0px 0px',
      });
      body.push(workstreamTable([...active, ...shownCompleted], project, brand, runtime));
      if (hiddenCount > 0) {
        body.push({
          tag: 'markdown',
          content: `<font color='grey'>已省略更早完成的 ${hiddenCount} 项子任务</font>`,
          text_align: 'left', text_size: 'small', margin: '4px 0px 0px 0px',
        });
      }
    }
  }
  if (sectionEnabled(config, 'milestones') && (project.milestones.length > 0 || project.nextMilestone)) {
    body.push(milestonePanel(project, config.milestonesExpanded));
  }
  return body;
}

function compactListBody(context: TemplateBodyContext): Array<Record<string, unknown>> {
  const { project, brand, config, runtime } = context;
  const visible = visibleProjectWorkstreams(project);
  const body: Array<Record<string, unknown>> = [
    ...focusElements(project, config),
    {
      tag: 'interactive_container', behaviors: [], width: 'fill', height: 'auto', corner_radius: '8px',
      has_border: false, disabled: false, background_style: 'grey-50', padding: '10px 12px 10px 12px',
      direction: 'vertical', horizontal_spacing: '6px', vertical_spacing: '6px',
      horizontal_align: 'left', vertical_align: 'top', margin: '8px 0px 0px 0px',
      elements: [{
        tag: 'markdown',
        content: `**<font color='indigo'>${escapeMarkdown(projectProgressSummary(project, runtime))}</font>** · <font color='blue'>阶段 ${escapeMarkdown(truncate(project.phase, 24))}</font>\n<font color='purple'>下一步：${escapeMarkdown(truncate(projectRemainingSummary(project), 80))}</font>`,
        text_align: 'left', text_size: 'normal', margin: '0px 0px 0px 0px',
      }],
    },
  ];
  if (sectionEnabled(config, 'blockers') && project.blockers.length > 0) body.push(blockerElement(project));
  if (sectionEnabled(config, 'workstreams') && visible.length > 0) {
    const completedDisplay = resolveProjectProgressCardCompletedDisplay(config);
    const ordered = displayWorkstreams(project, runtime);
    if (completedDisplay === 'all') {
      const rows = ordered.map(item => compactWorkstreamLine(project, item, brand, runtime)).join('\n');
      body.push({
        tag: 'markdown', content: `<font color='blue'>**子任务（${visible.length}）**</font>\n${rows}`,
        text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
      });
    } else if (completedDisplay === 'collapsed') {
      const active = ordered.filter(item => item.status !== 'completed');
      const completedRecent = completedWorkstreamsByRecent(project);
      if (completedRecent.length === 0) {
        const rows = active.map(item => compactWorkstreamLine(project, item, brand, runtime)).join('\n');
        body.push({
          tag: 'markdown', content: `<font color='blue'>**子任务（${visible.length}）**</font>\n${rows}`,
          text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
        });
      } else if (active.length > 0) {
        const rows = active.map(item => compactWorkstreamLine(project, item, brand, runtime)).join('\n');
        body.push({
          tag: 'markdown',
          content: `<font color='blue'>**子任务（未完成 ${active.length} / 共 ${visible.length}）**</font>\n${rows}`,
          text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
        });
        body.push(completedWorkstreamPanel(project, completedRecent, brand, runtime));
      } else {
        body.push({
          tag: 'markdown',
          content: `<font color='blue'>**子任务（未完成 0 / 共 ${visible.length}）**</font>\n<font color='grey'>当前无未完成子任务</font>`,
          text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
        });
        body.push(completedWorkstreamPanel(project, completedRecent, brand, runtime));
      }
    } else {
      const active = ordered.filter(item => item.status !== 'completed');
      const completedRecent = completedWorkstreamsByRecent(project);
      const shownCompleted = completedRecent.slice(0, RECENT_COMPLETED_WORKSTREAM_LIMIT);
      const hiddenCount = completedRecent.length - shownCompleted.length;
      const rows = [...active, ...shownCompleted].map(item => compactWorkstreamLine(project, item, brand, runtime)).join('\n');
      const overflow = hiddenCount > 0 ? `\n<font color='grey'>已省略更早完成的 ${hiddenCount} 项子任务</font>` : '';
      body.push({
        tag: 'markdown',
        content: `<font color='blue'>**子任务（${visible.length}）**</font>\n${rows}${overflow}`,
        text_align: 'left', text_size: 'normal', margin: '10px 0px 0px 0px',
      });
    }
  }
  if (sectionEnabled(config, 'milestones') && (project.milestones.length > 0 || project.nextMilestone)) {
    body.push(milestonePanel(project, config.milestonesExpanded));
  }
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
  runtime?: ProjectGroupCardRuntime,
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
  const title = displayProjectTitle(project.title);
  const body = TEMPLATE_BODY_BUILDERS[config.templateId]({ project, brand, config, runtime });
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
      summary: { content: truncate(`${title} · ${projectProgressSummary(project, runtime)} · 当前 ${project.focus}`, 60) },
    },
    header: {
      template: statusMeta.header,
      title: { tag: 'plain_text', content: title, text_align: 'left' },
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
