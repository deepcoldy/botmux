/**
 * Task tree of an orchestrating session: the child topics it dispatched (from
 * orchestrate-dispatch.json), each with a status and its last progress line.
 *
 * Pure: the registry, session rows and local bot ids come in, the tree and its
 * renderings go out. The card is display-only (markdown + open_url links) so it
 * can be patched in place whenever a child changes state.
 */
import { threadAppLink, type Brand } from '../im/lark/lark-hosts.js';
import type { DispatchRegistry } from './dispatch-registry.js';

export type TaskTreeNodeState = 'running' | 'waiting' | 'done' | 'failed' | 'dispatched' | 'closed';
export type TaskTreeNodeKind = 'task' | 'review';

/** `botmux report --status` values recorded on the dispatch entry. */
export type DispatchReportStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface DispatchLastReport {
  status?: DispatchReportStatus;
  /** First non-empty line of the report, already trimmed for display. */
  line?: string;
  at: string;
}

export interface TaskTreeSessionRow {
  sessionId: string;
  larkAppId?: string;
  rootMessageId?: string;
  status?: string;
}

export interface TaskTreeNode {
  dispatchRoot: string;
  title: string;
  kind: TaskTreeNodeKind;
  state: TaskTreeNodeState;
  /** The child runs on a bot this machine does not host: live state unknown. */
  otherMachine: boolean;
  lastLine?: string;
  updatedAt?: string;
  targetChatId?: string;
  threadId?: string;
}

export interface TaskTree {
  orchSessionId: string;
  title: string;
  requirement?: { id?: string; url?: string };
  nodes: TaskTreeNode[];
}

const REPORT_STATUSES = new Set<DispatchReportStatus>(['pending', 'in_progress', 'blocked', 'completed', 'failed']);
const LINE_MAX = 80;

export function isDispatchReportStatus(value: unknown): value is DispatchReportStatus {
  return typeof value === 'string' && REPORT_STATUSES.has(value as DispatchReportStatus);
}

/** First non-empty line, cut to a phone-width length. */
export function reportDisplayLine(content: string): string | undefined {
  const line = content.split('\n').map(part => part.trim()).find(part => part.length > 0);
  if (!line) return undefined;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

/** Record a child's report on its dispatch entry (inside a registry update).
 *  Returns the orchestrating session to refresh, or undefined when the entry is
 *  unknown. A report without `--status` keeps the previous status. */
export function recordDispatchLastReport(
  registry: DispatchRegistry,
  dispatchRoot: string,
  report: { status?: unknown; content: string; at: string },
): string | undefined {
  const raw = registry[dispatchRoot];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  // A status-less report continues the current task's status, never an earlier one's.
  const previous = currentReport(entry);
  const status = isDispatchReportStatus(report.status) ? report.status : previous?.status;
  const line = reportDisplayLine(report.content) ?? previous?.line;
  entry.lastReport = { ...(status ? { status } : {}), ...(line ? { line } : {}), at: report.at };
  return typeof entry.orchSessionId === 'string' ? entry.orchSessionId : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The report still describes the child's current task: a later dispatch
 *  attempt into the same topic (`--into`) starts after it. */
function reportIsCurrent(entry: Record<string, unknown>, report: DispatchLastReport | undefined): report is DispatchLastReport {
  if (!report) return false;
  const attemptMs = Date.parse(str(entry.attemptAt) ?? '');
  if (!Number.isFinite(attemptMs)) return true;
  const reportMs = Date.parse(report.at);
  return Number.isFinite(reportMs) && reportMs >= attemptMs;
}

function currentReport(entry: Record<string, unknown>): DispatchLastReport | undefined {
  const report = entry.lastReport as DispatchLastReport | undefined;
  return reportIsCurrent(entry, report) ? report : undefined;
}

function nodeState(entry: Record<string, unknown>, child: TaskTreeSessionRow | undefined): TaskTreeNodeState {
  // A report is newer evidence than the dispatch receipt: a child whose
  // acceptance timed out may still pick the task up and report.
  const reported = currentReport(entry)?.status;
  if (reported === 'completed') return 'done';
  if (reported === 'failed') return 'failed';
  // Closed without reporting an outcome: someone may have stopped it halfway.
  if (child?.status === 'closed') return 'closed';
  if (reported === 'blocked') return 'waiting';
  if (reported === 'in_progress') return 'running';
  if (entry.status === 'failed' || entry.status === 'timed_out') return 'failed';
  if (child?.status === 'active') return 'running';
  return entry.status === 'accepted' ? 'running' : 'dispatched';
}

function acceptanceLine(entry: Record<string, unknown>): string | undefined {
  switch (entry.status) {
    case 'accepted': return '已接单';
    case 'timed_out': return '接单超时：派发后未确认子会话已收到';
    case 'failed': return `派发失败${str(entry.errorCode) ? `（${entry.errorCode}）` : ''}`;
    default: return undefined;
  }
}

export function buildDispatchTaskTree(input: {
  registry: DispatchRegistry;
  orchSessionId: string;
  title: string;
  requirement?: { id?: string; url?: string };
  sessions: Iterable<TaskTreeSessionRow>;
  /** Bot app ids this machine hosts; a child on any other bot is remote. */
  localAppIds: ReadonlySet<string>;
  threadIds?: Readonly<Record<string, string>>;
}): TaskTree {
  const byRoot = new Map<string, TaskTreeSessionRow[]>();
  for (const session of input.sessions) {
    if (!session.rootMessageId) continue;
    const list = byRoot.get(session.rootMessageId) ?? [];
    list.push(session);
    byRoot.set(session.rootMessageId, list);
  }
  const nodes: Array<TaskTreeNode & { createdAt: string }> = [];
  for (const [dispatchRoot, raw] of Object.entries(input.registry)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.orchSessionId !== input.orchSessionId) continue;
    const targetAppIds = Array.isArray(entry.targetAppIds)
      ? entry.targetAppIds.filter((id): id is string => typeof id === 'string')
      : [];
    const otherMachine = targetAppIds.length > 0 && targetAppIds.every(id => !input.localAppIds.has(id));
    const candidates = byRoot.get(dispatchRoot) ?? [];
    const child = otherMachine ? undefined
      : candidates.find(s => s.status === 'active' && (!targetAppIds.length || targetAppIds.includes(s.larkAppId ?? '')))
        ?? candidates.find(s => !targetAppIds.length || targetAppIds.includes(s.larkAppId ?? ''));
    const report = currentReport(entry);
    const threadId = input.threadIds?.[dispatchRoot] ?? str(entry.threadId);
    nodes.push({
      dispatchRoot,
      title: str(entry.title) ?? '子任务',
      kind: entry.kind === 'review' ? 'review' : 'task',
      state: nodeState(entry, child),
      otherMachine,
      ...(report?.line ?? acceptanceLine(entry) ? { lastLine: report?.line ?? acceptanceLine(entry) } : {}),
      ...(str(report?.at) ?? str(entry.updatedAt) ? { updatedAt: str(report?.at) ?? str(entry.updatedAt) } : {}),
      ...(str(entry.targetChatId) ? { targetChatId: str(entry.targetChatId) } : {}),
      ...(threadId ? { threadId } : {}),
      createdAt: str(entry.createdAt) ?? '',
    });
  }
  nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    orchSessionId: input.orchSessionId,
    title: input.title,
    ...(input.requirement && (input.requirement.id || input.requirement.url) ? { requirement: input.requirement } : {}),
    nodes: nodes.map(({ createdAt: _createdAt, ...node }) => node),
  };
}

const STATE_LABEL: Record<TaskTreeNodeState, string> = {
  running: '🔵 在跑',
  waiting: '🟠 等人',
  done: '🟢 已完成',
  failed: '🔴 失败',
  dispatched: '⚪ 已派发',
  closed: '⚫ 已关闭',
};

/** Lark card markdown treats these as syntax; titles and lines are user text. */
function escapeMd(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]~]/g, ch => `\\${ch}`);
}

/** An https URL safe to place inside a markdown link target, or undefined. */
export function safeRequirementUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  return url.href.replace(/[()<>\s\[\]]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function headerTemplate(tree: TaskTree): string {
  if (tree.nodes.some(n => n.state === 'failed')) return 'red';
  if (tree.nodes.some(n => n.state === 'waiting')) return 'orange';
  if (tree.nodes.length > 0 && tree.nodes.every(n => n.state === 'done')) return 'green';
  return 'blue';
}

function summary(tree: TaskTree): string {
  const count = (state: TaskTreeNodeState) => tree.nodes.filter(n => n.state === state).length;
  const parts = [
    `共 ${tree.nodes.length} 项`,
    count('running') ? `在跑 ${count('running')}` : '',
    count('waiting') ? `等人 ${count('waiting')}` : '',
    count('done') ? `已完成 ${count('done')}` : '',
    count('failed') ? `失败 ${count('failed')}` : '',
    count('dispatched') ? `已派发 ${count('dispatched')}` : '',
    count('closed') ? `已关闭 ${count('closed')}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function timeLabel(iso: string | undefined, timeZone: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

function nodeMarkdown(node: TaskTreeNode, brand: Brand, timeZone: string): string {
  const tag = node.kind === 'review' ? '［审查］' : '';
  const remote = node.otherMachine ? '（另一台机器，状态取自派发记录）' : '';
  const lines = [`**${tag}${escapeMd(node.title)}**　${STATE_LABEL[node.state]}${remote}`];
  if (node.lastLine) lines.push(`<font color='grey'>${escapeMd(node.lastLine)}</font>`);
  const when = timeLabel(node.updatedAt, timeZone);
  const link = node.targetChatId && node.threadId ? `[打开话题](${threadAppLink(node.targetChatId, node.threadId, brand)})` : '';
  const footer = [when ? `更新于 ${when}` : '', link].filter(Boolean).join('　');
  if (footer) lines.push(footer);
  return lines.join('\n');
}

export function renderDispatchTaskTreeCard(tree: TaskTree, opts: {
  brand?: Brand;
  timeZone?: string;
  now?: Date;
} = {}): Record<string, unknown> {
  const brand = opts.brand ?? 'feishu';
  const timeZone = opts.timeZone ?? 'Asia/Shanghai';
  const elements: Array<Record<string, unknown>> = [];
  const head: string[] = [summary(tree)];
  const req = tree.requirement;
  const reqUrl = safeRequirementUrl(req?.url);
  if (reqUrl) head.push(`需求：[${escapeMd(req?.id ?? '查看需求')}](${reqUrl})`);
  else if (req?.id) head.push(`需求：${escapeMd(req.id)}`);
  elements.push({ tag: 'markdown', content: head.join('\n') });
  if (tree.nodes.length === 0) {
    elements.push({ tag: 'markdown', content: '还没有派出的子任务。' });
  }
  tree.nodes.forEach((node, i) => {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: nodeMarkdown(node, brand, timeZone), element_id: `node_${i}` });
  });
  const refreshed = timeLabel((opts.now ?? new Date()).toISOString(), timeZone);
  elements.push({ tag: 'markdown', content: `<font color='grey'>任务树 · 刷新于 ${refreshed}</font>`, text_size: 'notation' });
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: tree.title || '编排任务' },
      subtitle: { tag: 'plain_text', content: '任务树' },
      template: headerTemplate(tree),
    },
    body: { elements },
  };
}

export function renderDispatchTaskTreeText(tree: TaskTree): string {
  const plain: Record<TaskTreeNodeState, string> = {
    running: '在跑', waiting: '等人', done: '已完成', failed: '失败', dispatched: '已派发', closed: '已关闭',
  };
  const lines = [`${tree.title || '编排任务'}（${summary(tree)}）`];
  if (tree.requirement) lines.push(`需求：${tree.requirement.id ?? ''} ${tree.requirement.url ?? ''}`.trim());
  tree.nodes.forEach((node, i) => {
    const last = i === tree.nodes.length - 1;
    const kind = node.kind === 'review' ? '[审查] ' : '';
    const remote = node.otherMachine ? '，另一台机器' : '';
    lines.push(`${last ? '└─' : '├─'} ${kind}${node.title}  [${plain[node.state]}${remote}]  ${node.dispatchRoot}`);
    if (node.lastLine) lines.push(`${last ? '   ' : '│  '}  ${node.lastLine}`);
  });
  return lines.join('\n');
}
