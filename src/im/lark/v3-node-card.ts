/**
 * Cards of a bot-executed workflow node (design 2026-11-03 §5.3, §5.4, §7.2):
 *
 * - the NODE CARD is the node topic's root, posted by the main bot without
 *   mentioning anyone and patched in place as the node's state changes;
 * - the HANDOFF CARD is the first reply in that topic. It carries everything
 *   the executing bot needs (goal, acceptance, inputs, required outputs,
 *   deadline, exact `botmux report` commands) and mentions the target bot in
 *   the same signed footer `botmux send --mention` uses, which is what makes
 *   the target's daemon receive it;
 * - the REPORT CARD is posted by the executing bot's daemon after the run
 *   accepted a structured submission. Its summary is bot-written text and is
 *   rendered as plain text, never markdown.
 *
 * Pure renderers: no IO, no clock (callers pass `now`).
 */

import { appendReplyCardFooterToV2Card } from './md-card.js';
import {
  attachWorkflowSidebarEntry,
  workflowSignatureRow,
  type WorkflowSidebarEntryLink,
} from './workflow-sidebar-entry.js';

/** Stands in for the handoff's own message id, which Lark assigns only after
 *  the card is sent. The sender patches the posted card with the real id and
 *  the receiving daemon substitutes it in the turn it hands to its CLI. */
export const WORKFLOW_HANDOFF_ID_PLACEHOLDER = 'om_<本条消息>';

export type V3NodeCardStatus =
  | { kind: 'handing_off' }
  | { kind: 'acceptance_unknown'; since: number }
  /** `stalledAt` is shown only when no later turn started (`activeAt`). */
  | { kind: 'running'; acceptedAt: number; deadlineAt?: number; stalledAt?: number; activeAt?: number }
  | { kind: 'done'; elapsedMs?: number }
  | { kind: 'blocked'; errorCode?: string; message?: string }
  | { kind: 'cancelled' }
  | { kind: 'superseded' }
  | { kind: 'reassigned' };

export interface V3NodeCardView {
  runTitle: string;
  runId: string;
  nodeId: string;
  /** 1-based position among the run's goal nodes, when known. */
  nodeIndex?: number;
  nodeCount?: number;
  botName: string;
  /** The main bot executes this node itself (§6.5). */
  selfExecuted: boolean;
  attemptNumber: number;
  loopIteration?: number;
  status: V3NodeCardStatus;
  upstream: Array<{ nodeId: string; done: boolean }>;
  now: number;
  /** §11: the「工作流 ›」sidebar entry at the signature row's right end. */
  entry?: WorkflowSidebarEntryLink;
}

function plain(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

/** Escape text placed inside lark markdown (also neutralizes `<at …>`). */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`[\]<>]/g, (c) => `\\${c}`);
}

/** "Stopped without submitting" until a later turn starts in the session. */
export function v3NodeStalled(status: Extract<V3NodeCardStatus, { kind: 'running' }>): boolean {
  if (status.stalledAt === undefined || status.stalledAt < status.acceptedAt) return false;
  return status.activeAt === undefined || status.activeAt <= status.stalledAt;
}

export function formatV3StartTime(ms: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function formatV3Elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

const BLOCKED_REASON_TEXT: Record<string, string> = {
  BOT_NOT_IN_CHAT: '执行 Bot 不在本群',
  BOT_OFFLINE: '执行 Bot 的 daemon 不在线',
  COLLABORATION_DENIED: '无法建立群内协作授权',
  IDENTITY_UNAVAILABLE: '无法取得执行身份',
  HANDOFF_NOT_ACCEPTED: '执行 Bot 没有在期限内接单',
  HANDOFF_UNCERTAIN: '无法确认交接是否送达，请看一眼群消息再重试',
  BOT_REPORTED_BLOCKED: '执行 Bot 报告做不了',
  NODE_TIMEOUT: '超时未提交有效结果',
};

function statusLine(view: V3NodeCardView): { text: string; template: string } {
  const attempt = `（第 ${view.attemptNumber} 次）`;
  const status = view.status;
  switch (status.kind) {
    case 'handing_off':
      return { text: `交接中，等待接单 ${attempt}`, template: 'blue' };
    case 'acceptance_unknown':
      return { text: `交接中 · 暂时查不到是否接单，正在重试 ${attempt}`, template: 'blue' };
    case 'running': {
      // A start time, not a running "已用 X 分钟": the card is patched on
      // state changes only, so an elapsed figure would go stale silently.
      const started = `${formatV3StartTime(status.acceptedAt)} 开始`;
      return v3NodeStalled(status)
        ? { text: `进行中 · Bot 已停下，未提交 · ${started} ${attempt}`, template: 'orange' }
        : { text: `进行中 · ${started} ${attempt}`, template: 'blue' };
    }
    case 'done':
      return {
        text: `已完成${status.elapsedMs !== undefined ? ` · 用时 ${formatV3Elapsed(status.elapsedMs)}` : ''} ${attempt}`,
        template: 'green',
      };
    case 'blocked': {
      const reason = (status.errorCode && BLOCKED_REASON_TEXT[status.errorCode]) ?? '受阻';
      return { text: `已停下：${reason} ${attempt}`, template: status.errorCode === 'NODE_TIMEOUT' ? 'red' : 'orange' };
    }
    case 'cancelled':
      return { text: `已取消 ${attempt}`, template: 'grey' };
    case 'superseded':
      return { text: `已被新的尝试替代 ${attempt}`, template: 'grey' };
    case 'reassigned':
      return { text: `已改派 ${attempt}`, template: 'grey' };
  }
}

/** The node topic's root card (no mention; patched in place). */
export function buildV3NodeCard(view: V3NodeCardView): string {
  const position = view.nodeIndex && view.nodeCount ? ` ${view.nodeIndex}/${view.nodeCount}` : '';
  const loop = view.loopIteration ? `（第 ${view.loopIteration} 轮）` : '';
  const { text, template } = statusLine(view);
  const elements: Array<Record<string, unknown>> = [
    plain(`执行：${view.botName}${view.selfExecuted ? '（主 Bot 自己）' : ''}`),
    plain(`状态：${text}`),
  ];
  if (view.status.kind === 'blocked' && view.status.message) {
    elements.push(plain(`原因：${view.status.message.slice(0, 500)}`));
  }
  if (view.upstream.length > 0) {
    elements.push(plain(`上游：${view.upstream.map((up) => `${up.nodeId} ${up.done ? '✅' : '⏳'}`).join('  ')}`));
  }
  elements.push({ tag: 'hr' });
  elements.push(workflowSignatureRow(md(`<font color='grey'>botmux · 工作流 ${escapeMarkdown(view.runId)}</font>`), view.entry));
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      template,
      title: { tag: 'plain_text', content: `🔧 工作流「${view.runTitle}」· 节点${position}：${view.nodeId}${loop}` },
    },
    body: { direction: 'vertical', elements },
  });
}

export interface V3HandoffCardInput {
  runTitle: string;
  nodeId: string;
  attemptNumber: number;
  loopIteration?: number;
  goal: string;
  acceptance?: string;
  /** Extra instructions frozen on the node (`override.systemPromptAppend`). */
  extraInstructions?: string;
  inputs: Array<{ from: string; output?: string; name: string }>;
  omitted: Array<{ from: string; reason: string }>;
  outputs: Array<{ key: string; path: string; kind: string }>;
  resultFields: Array<{ name: string; type: string; required: boolean; enum?: string[] }>;
  revisitTo?: string[];
  timeoutSec: number;
  /** The real handoff id, or {@link WORKFLOW_HANDOFF_ID_PLACEHOLDER}. */
  handoffRef: string;
  /** The binding nonce the receiving daemon recognizes this handoff by. */
  nonce: string;
  /** Set when the full goal / acceptance / instructions did not fit the card
   *  and travel as this attachment instead. */
  overflowAttachment?: string;
  retryOf?: { errorCode?: string; message?: string };
  reassignedFrom?: string;
  /** Mention target, or the main bot itself (§6.5: no mention). */
  target: { kind: 'bot'; openId: string } | { kind: 'self' };
  /** §11: the「工作流 ›」sidebar entry at the signature row's right end. */
  entry?: WorkflowSidebarEntryLink;
}

/** The exact `botmux report` command lines for a handoff (also used in the
 *  self-executed turn's prompt). */
export function v3HandoffReportCommands(input: Pick<V3HandoffCardInput, 'handoffRef' | 'outputs' | 'resultFields'>): {
  completed: string;
  blocked: string;
} {
  const outputArgs = input.outputs.map((output) => `--output ${output.key}=<${output.path} 的路径>`);
  const resultArg = input.resultFields.length > 0 ? ['--result-file result.json'] : [];
  return {
    completed: [
      `botmux report --dispatch-root ${input.handoffRef} --status completed`,
      ...outputArgs,
      ...resultArg,
      '--content-file summary.md',
    ].join(' \\\n    '),
    blocked: `botmux report --dispatch-root ${input.handoffRef} --status blocked "原因"`,
  };
}

/** Feishu rejects interactive cards around 30 KB. The handoff card is kept
 *  under this many UTF-8 bytes of serialized JSON (footer included). */
export const V3_HANDOFF_CARD_MAX_BYTES = 24 * 1024;
/** Preview length of authored text when the full text travels as a file. */
const OVERFLOW_PREVIEW_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Plain-text body of a handoff (the card body and the self-executed prompt). */
export function v3HandoffBodyText(input: V3HandoffCardInput): string {
  const lines: string[] = [];
  if (input.retryOf) {
    const reason = (input.retryOf.errorCode && BLOCKED_REASON_TEXT[input.retryOf.errorCode]) ?? input.retryOf.errorCode ?? '上次未完成';
    lines.push(`上次的情况：${reason}${input.retryOf.message ? `（${input.retryOf.message.slice(0, 300)}）` : ''}`, '');
  }
  if (input.reassignedFrom) lines.push('本节点已改派给你。', '');
  const preview = (text: string) => (input.overflowAttachment ? clip(text, OVERFLOW_PREVIEW_CHARS) : text);
  if (input.overflowAttachment) {
    lines.push(`要求较长，完整内容见附件 ${input.overflowAttachment}（已放进你的会话），以附件为准。`, '');
  }
  lines.push('要做什么：', preview(input.goal.trim()), '');
  if (input.acceptance?.trim()) lines.push(`完成标准：${preview(input.acceptance.trim())}`, '');
  if (input.extraInstructions?.trim()) lines.push('补充要求：', preview(input.extraInstructions.trim()), '');
  if (input.inputs.length > 0 || input.omitted.length > 0) {
    lines.push('输入（已作为本条消息的附件放进你的会话）：');
    for (const item of input.inputs) {
      lines.push(`· ${item.from}${item.output ? ` / ${item.output}` : ''}：${item.name}`);
    }
    for (const item of input.omitted) lines.push(`· ${item.from}：已知缺席（${item.reason}），不要臆造它的内容`);
    lines.push('');
  }
  lines.push('要交的产出：');
  if (input.outputs.length === 0 && input.resultFields.length === 0) {
    lines.push('· 无固定产出要求；可用 --output <名字>=<路径> 交文件，摘要写进 summary.md');
  }
  for (const output of input.outputs) lines.push(`· ${output.key}：${output.path}（${output.kind}）`);
  if (input.resultFields.length > 0) {
    const fields = input.resultFields.map((field) =>
      `${field.name}（${field.type}${field.enum ? `，取值 ${field.enum.join('/')}` : ''}，${field.required ? '必填' : '选填'}）`);
    lines.push(`· result.json，字段：${fields.join('、')}`);
  }
  if (input.revisitTo && input.revisitTo.length > 0) {
    lines.push(`· 需要返工上游时，result.json 写 {"status":"revisit","revisitTo":"<${input.revisitTo.join('|')}>"}`);
  }
  lines.push('');
  lines.push(`期限：接单后 ${formatV3Elapsed(input.timeoutSec * 1000)}。`, '');
  const commands = v3HandoffReportCommands(input);
  lines.push('怎么交：', '做完运行', `  ${commands.completed}`, `做不了：${commands.blocked}`);
  lines.push('提交被拒时命令会列出缺什么，补齐后在本轮重新提交即可。');
  lines.push('需要问人：直接在这里问，发起人会在这里回复。');
  lines.push('', `交接编号：${input.nonce}`);
  return lines.join('\n');
}

/** The full authored text, for the overflow attachment. */
export function v3HandoffTaskMarkdown(input: V3HandoffCardInput): string {
  return [
    `# 【工作流任务】${input.runTitle} · ${input.nodeId}`,
    '',
    '## 要做什么',
    input.goal.trim(),
    ...(input.acceptance?.trim() ? ['', '## 完成标准', input.acceptance.trim()] : []),
    ...(input.extraInstructions?.trim() ? ['', '## 补充要求', input.extraInstructions.trim()] : []),
    '',
  ].join('\n');
}

/**
 * The handoff card within {@link V3_HANDOFF_CARD_MAX_BYTES}: when the authored
 * text does not fit, the card carries a preview and `overflowTask` holds the
 * full text for the caller to stage as `overflowName`.
 */
export function planV3HandoffCard(input: V3HandoffCardInput, overflowName: string): {
  card: string;
  overflowTask?: string;
} {
  const full = buildV3HandoffCard(input);
  if (Buffer.byteLength(full) <= V3_HANDOFF_CARD_MAX_BYTES) return { card: full };
  const overflowTask = v3HandoffTaskMarkdown(input);
  let reduced: V3HandoffCardInput = { ...input, overflowAttachment: overflowName };
  let card = buildV3HandoffCard(reduced);
  // Long declared lists (inputs / outputs / omitted) are trimmed last.
  for (const keep of [40, 20, 10, 5, 0]) {
    if (Buffer.byteLength(card) <= V3_HANDOFF_CARD_MAX_BYTES) break;
    reduced = {
      ...reduced,
      inputs: input.inputs.slice(0, keep),
      omitted: input.omitted.slice(0, keep),
      outputs: input.outputs.slice(0, keep),
      resultFields: input.resultFields.slice(0, keep),
    };
    card = buildV3HandoffCard(reduced);
  }
  if (Buffer.byteLength(card) > V3_HANDOFF_CARD_MAX_BYTES) {
    throw new Error('v3 handoff card does not fit the card size budget');
  }
  return { card, overflowTask };
}

/** The handoff card (first reply in the node topic). */
export function buildV3HandoffCard(input: V3HandoffCardInput): string {
  const loop = input.loopIteration ? ` · 第 ${input.loopIteration} 轮` : '';
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: `【工作流任务】${input.runTitle} · ${input.nodeId}（第 ${input.attemptNumber} 次${loop}）` },
    },
    body: { direction: 'vertical', elements: [plain(v3HandoffBodyText(input))] },
  };
  if (input.target.kind === 'self') {
    (card.body as { elements: unknown[] }).elements.push(
      { tag: 'hr' },
      workflowSignatureRow(md("<font color='grey'>botmux · 执行：主 Bot 自己</font>"), input.entry),
    );
    return JSON.stringify(card);
  }
  const withFooter = appendReplyCardFooterToV2Card(card, { recipientOpenIds: [input.target.openId], locale: 'zh' });
  if (!withFooter) throw new Error('v3 handoff card: cannot attach the mention footer');
  return attachWorkflowSidebarEntry(JSON.stringify(withFooter), input.entry);
}

export interface V3NodeReportCardInput {
  nodeId: string;
  botName: string;
  summary: string;
  files: Array<{ key: string; name: string; bytes: number }>;
  elapsedMs?: number;
  /** §11: the「工作流 ›」sidebar entry at the signature row's right end. */
  entry?: WorkflowSidebarEntryLink;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The report card the executing bot's daemon posts after a successful
 *  submission. Everything bot-written is plain text. */
export function buildV3NodeReportCard(input: V3NodeReportCardInput): string {
  const elements: Array<Record<string, unknown>> = [];
  const summary = input.summary.trim();
  if (summary) elements.push(plain(summary.slice(0, 3000)));
  if (input.files.length > 0) {
    elements.push(plain(['产出：', ...input.files.map((file) => `· ${file.key}：${file.name}（${formatBytes(file.bytes)}）`)].join('\n')));
  }
  elements.push({ tag: 'hr' });
  elements.push(workflowSignatureRow(
    md(`<font color='grey'>botmux · ${escapeMarkdown(input.botName)} 已提交${input.elapsedMs !== undefined ? ` · 用时 ${formatV3Elapsed(input.elapsedMs)}` : ''}</font>`),
    input.entry,
  ));
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: { template: 'green', title: { tag: 'plain_text', content: `✅ 节点 ${input.nodeId} 已提交，校验通过` } },
    body: { direction: 'vertical', elements },
  });
}
