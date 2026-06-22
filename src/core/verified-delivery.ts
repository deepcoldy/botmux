import { createHash, randomBytes } from 'node:crypto';
import type { DispatchBot, PostParagraph } from './dispatch.js';
import { REJECT_REASON, type LedgerEvent, type RejectReason, type TaskStatus, type TaskView } from '../verified-delivery/types.js';

export function slugForTaskId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'task';
}

export function generateTaskId(input: { title: string; brief?: string; nonce?: string }): string {
  const nonce = input.nonce ?? randomBytes(8).toString('hex');
  const hash = createHash('sha256')
    .update(input.title)
    .update('\0')
    .update(input.brief ?? '')
    .update('\0')
    .update(nonce)
    .digest('hex')
    .slice(0, 8);
  return `task-${slugForTaskId(input.title)}-${hash}`;
}

export function buildVerifiedDeliveryInstructions(input: {
  taskId: string;
  acceptanceHint?: string;
}): string {
  const lines = [
    '— 可信交付协议 —',
    `任务号: ${input.taskId}`,
    '完成后必须用结构化回报交付，不能只在群里说“完成”：',
    `botmux report --task ${input.taskId} --summary "做了什么/结果如何" --artifact <主agent可读取的产物路径>`,
    '如果主 agent 读不到产物路径，请改用 inline 证据（测试输出/关键文件内容/diff），确保主 agent 能验证。',
    '如果你无法完成（缺权限/需求有歧义/客观做不到/反复失败），不要硬撑、也不要只在群里说做不了，用求助：',
    `botmux help --task ${input.taskId} --blocker "具体卡在哪、缺什么" --kind access|ambiguous|impossible|repeated_failure|other`,
    '求助会落账并唤醒监管者来处理；监管者定不了的会升级给人。',
  ];
  if (input.acceptanceHint?.trim()) {
    lines.push(`验收提示: ${input.acceptanceHint.trim()}`);
  }
  return lines.join('\n');
}

export function appendVerifiedDeliveryInstructions(input: {
  brief: string;
  taskId: string;
  acceptanceHint?: string;
}): string {
  const trimmed = input.brief.trimEnd();
  const suffix = buildVerifiedDeliveryInstructions({
    taskId: input.taskId,
    acceptanceHint: input.acceptanceHint,
  });
  return trimmed ? `${trimmed}\n\n${suffix}` : suffix;
}

export function buildRejectRetryContent(input: {
  task: TaskView;
  reportId: string;
  reason: RejectReason | string;
  retryBrief?: string;
  expectedEvidence?: string;
}): PostParagraph[] {
  const nodes: PostParagraph = [];
  for (const openId of input.task.workerOpenIds ?? []) {
    nodes.push({ tag: 'at', user_id: openId }, { tag: 'text', text: ' ' });
  }
  nodes.push({
    tag: 'text',
    text: `任务 ${input.task.taskId} 的回报 ${input.reportId} 未通过验收：${input.reason}`,
  });

  const paras: PostParagraph[] = [nodes];
  if (input.retryBrief?.trim()) {
    paras.push([{ tag: 'text', text: `重做要求：${input.retryBrief.trim()}` }]);
  }
  if (input.expectedEvidence?.trim()) {
    paras.push([{ tag: 'text', text: `需要补充的证据：${input.expectedEvidence.trim()}` }]);
  }
  paras.push([{ tag: 'text', text: `修完后请继续用同一任务号重新交付：botmux report --task ${input.task.taskId} ...` }]);
  if (input.reason === REJECT_REASON.EVIDENCE_UNREACHABLE) {
    paras.push([{ tag: 'text', text: '当前证据主 agent 读不到；请改交可读取路径或 inline 自包含证据。' }]);
  }
  return paras;
}

export interface DeliveryListRow {
  taskId: string;
  chatId?: string;
  status: TaskStatus;
  title?: string;
  latestReportId?: string;
  reportCount: number;
  workerTopicRoot?: string;
  workerOpenIds?: string[];
  acceptanceHint?: string;
  createdAt?: number;
  updatedAt?: number;
  ageMs?: number;
}

export function parseDeliveryDuration(input: string): number {
  const raw = input.trim();
  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid duration: ${input}`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid duration: ${input}`);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const scale =
    unit === 'ms' ? 1 :
    unit === 's' ? 1_000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 :
    undefined;
  if (!scale) throw new Error(`invalid duration: ${input}`);
  return Math.floor(value * scale);
}

export function buildDeliveryListRows(input: {
  events: LedgerEvent[];
  tasks: TaskView[];
  status?: TaskStatus;
  olderThanMs?: number;
  now?: number;
}): DeliveryListRow[] {
  const now = input.now ?? Date.now();
  const times = new Map<string, { createdAt: number; updatedAt: number }>();
  for (const e of input.events) {
    const existing = times.get(e.taskId);
    if (!existing) {
      times.set(e.taskId, { createdAt: e.ts, updatedAt: e.ts });
    } else {
      existing.createdAt = Math.min(existing.createdAt, e.ts);
      existing.updatedAt = Math.max(existing.updatedAt, e.ts);
    }
  }

  return input.tasks
    .filter((task) => !input.status || task.status === input.status)
    .map((task) => {
      const t = times.get(task.taskId);
      return {
        taskId: task.taskId,
        chatId: task.chatId,
        status: task.status,
        title: task.title,
        latestReportId: task.latestReportId,
        reportCount: task.reports.length,
        workerTopicRoot: task.workerTopicRoot,
        workerOpenIds: task.workerOpenIds,
        acceptanceHint: task.acceptanceHint,
        createdAt: t?.createdAt,
        updatedAt: t?.updatedAt,
        ageMs: t ? Math.max(0, now - t.updatedAt) : undefined,
      } satisfies DeliveryListRow;
    })
    .filter((row) => input.olderThanMs === undefined || (row.ageMs !== undefined && row.ageMs >= input.olderThanMs))
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.taskId.localeCompare(b.taskId));
}
