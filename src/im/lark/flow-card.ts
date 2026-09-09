/**
 * `botmux flow` 的四种飞书卡片（设计文档 §11 M2）：进度卡、决策卡、信号卡、中断卡。
 *
 * 纯函数：不碰 daemon / IO，单测友好。与 v3 卡同一套形态（v1 card JSON、`plain_text`
 * 渲染不可信文本、按钮 value 自带 action namespace + 可复现 nonce），但 action 前缀是 `flow_`。
 *
 * 权威永远在 runner（§7.2）：卡片只是 daemon 对 runner 快照 / wait 的投影；点击经 daemon 前置门
 * 转成控制请求交给 runner 裁决，冻结卡只是把裁决结果回显出来。
 */
import type { OpenWait, PendingDecision, RunSnapshot } from '../../flow/types.js';

export const FLOW_CANCEL_ACTION = 'flow_cancel';
export const FLOW_DECIDE_ACTION = 'flow_decide';
export const FLOW_DECIDE_RUN_ACTION = 'flow_decide_run';
export const FLOW_SIGNAL_ACTION = 'flow_signal';
export const FLOW_RESEND_ACTION = 'flow_resend';
export const FLOW_RESUME_ACTION = 'flow_resume';

export const FLOW_ACTIONS: ReadonlySet<string> = new Set([
  FLOW_CANCEL_ACTION,
  FLOW_DECIDE_ACTION,
  FLOW_DECIDE_RUN_ACTION,
  FLOW_SIGNAL_ACTION,
  FLOW_RESEND_ACTION,
  FLOW_RESUME_ACTION,
]);

export function isFlowCardAction(action: unknown): boolean {
  return typeof action === 'string' && FLOW_ACTIONS.has(action);
}

/** 信号卡表单里承载「整段 JSON」的字段名（schema 不是扁平对象时的兜底）。 */
export const FLOW_SIGNAL_JSON_FIELD = 'flow_signal_json';
/** 扁平对象 schema 的每个属性一个输入框：`flow_f_<属性名>`。 */
export const FLOW_SIGNAL_FIELD_PREFIX = 'flow_f_';

export type FlowActionValue =
  | { action: typeof FLOW_CANCEL_ACTION; runId: string; nonce: string }
  | { action: typeof FLOW_DECIDE_ACTION; runId: string; identity: string; attempt: number; content: string; choice: 'accept-failed' | 'retry'; nonce: string; key: string }
  | { action: typeof FLOW_DECIDE_RUN_ACTION; runId: string; choice: 'accept-journal' | 'assume-clean' | 'cancel'; nonce: string; key: string }
  | { action: typeof FLOW_SIGNAL_ACTION; runId: string; identity: string; version: number; nonce: string; /** 单选按钮直接带选项 */ choice?: string; /** 单选按钮对应的属性名（对象 schema）或空（裸 enum） */ field?: string; key?: string }
  | { action: typeof FLOW_RESEND_ACTION; runId: string; identity: string; version: number; nonce: string }
  | { action: typeof FLOW_RESUME_ACTION; runId: string; gen: number; choice: 'resume' | 'cancel'; nonce: string; key: string };

/** 可复现、非机密的 nonce（同 v3 卡）：同一 run 同一对象重发卡也一致，纯粹挡篡改与串号。 */
export function flowCardNonce(runId: string, kind: string, key: string): string {
  return `flow:${runId}:${kind}:${key}`;
}

const PROMPT_MAX = 1500;
const ERROR_MAX = 400;
const RETURNED_MAX = 1200;
const ATTEMPT_ROWS_MAX = 14;

// ---------------------------------------------------------------------------
// 进度卡
// ---------------------------------------------------------------------------

export interface FlowProgressCardInput {
  snapshot: RunSnapshot;
  scriptName: string;
  /** 已中断（runner 不在）：冻结成灰卡，恢复入口在中断卡上。 */
  interrupted?: { reason: string } | null;
}

export function buildFlowProgressCard(input: FlowProgressCardInput): string {
  const s = input.snapshot;
  const interrupted = input.interrupted ?? null;
  const status = interrupted ? 'interrupted' : s.status;
  const template = statusColor(status);
  const title = `flow · ${short(input.scriptName, 40)} · ${statusLabel(status)}`;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(s.runId)} · gen ${s.gen}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**健康度 / 活动时间**\n${escapeMd(s.health)} · ${Math.round(s.activeMs / 1000)}s` } },
        { is_short: true, text: { tag: 'lark_md', content: `**agent**\n${s.counts.ok} ok · ${s.counts.failed} failed · ${s.counts.inflight} 在途` } },
      ],
    },
  ];
  if (s.attempts.length > 0) {
    const rows = s.attempts.slice(-ATTEMPT_ROWS_MAX).map((a) => {
      const mark = a.state === 'result' ? '✅' : a.state === 'failed' ? '❌' : '⏳';
      const tail = a.state === 'failed' ? ` ${a.category ?? ''}` : a.state === 'inflight' ? ` ${a.phase ?? 'queued'}` : '';
      const who = a.botName ? `${a.botName}${a.cli ? ` · ${a.cli}` : ''}` : a.cli;
      return `${mark} ${a.identity} #${a.attempt}${who ? ` (${who})` : ''}${tail}`;
    });
    if (s.attempts.length > ATTEMPT_ROWS_MAX) rows.unshift(`… 另有 ${s.attempts.length - ATTEMPT_ROWS_MAX} 个更早的 attempt`);
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: rows.join('\n') } });
  }
  if (s.pending.length > 0 || s.runPause) {
    elements.push({ tag: 'hr' });
    const lines = s.pending.map((p) => `⏸ ${p.identity} #${p.attempt} 等待决策（${p.reason}）`);
    if (s.runPause) lines.push(`⏸ run 级暂停：${s.runPause.reason}`);
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `${lines.join('\n')}\n→ 见话题里的决策卡` } });
  }
  if (s.waits.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: s.waits.map((w) => `✋ ${w.identity} v${w.version} 等待信号（卡片 ${deliveryLabel(w.delivery)}）`).join('\n') },
    });
  }
  if (s.notes.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: s.notes.map((n) => `· ${n}`).join('\n') } });
  }
  if (s.error) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `错误 ${s.error.code}: ${truncate(s.error.message, ERROR_MAX)}` } });
  }
  if (s.finished) {
    elements.push({ tag: 'hr' });
    const returned = s.finished.returned === null || s.finished.returned === undefined ? '（无返回值）' : truncate(JSON.stringify(s.finished.returned, null, 2), RETURNED_MAX);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**结束**：${escapeMd(statusLabel(s.finished.status))} · 重放 ${escapeMd(s.finished.replay)}` } });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: returned } });
  }
  if (interrupted) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `run 已中断（${interrupted.reason}）；恢复与取消见话题里的中断卡。` } });
  } else if (!s.finished) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '取消 run' },
          type: 'danger',
          value: { action: FLOW_CANCEL_ACTION, runId: s.runId, nonce: flowCardNonce(s.runId, 'cancel', '') } satisfies FlowActionValue,
        },
      ],
    });
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `botmux flow inspect ${s.runId}` }] });
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

// ---------------------------------------------------------------------------
// 决策卡（attempt 级与 run 级）
// ---------------------------------------------------------------------------

export interface FlowDecisionCardInput {
  runId: string;
  decision: PendingDecision;
  /** 有值 → 冻结（已决策 / run 已取消 / 已失效）。 */
  resolution?: { choice: 'accept-failed' | 'retry' | 'timeout' | 'canceled' | 'stale'; by?: string } | null;
}

export function flowDecisionKey(identity: string, attempt: number): string {
  return `${identity}#${attempt}`;
}

export function buildFlowDecisionCard(input: FlowDecisionCardInput): string {
  const d = input.decision;
  const key = flowDecisionKey(d.identity, d.attempt);
  const nonce = flowCardNonce(input.runId, 'decide', key);
  const resolution = input.resolution ?? null;
  const title = resolution ? `已处理：${d.identity} #${d.attempt}` : `需要决策：${d.identity} #${d.attempt}`;
  const template = resolution ? (resolution.choice === 'retry' ? 'green' : resolution.choice === 'accept-failed' ? 'orange' : 'grey') : 'orange';
  const reasonText = d.reason === 'uncertain'
    ? '副作用不确定：prompt 的发送意图已持久化，CLI 可能已执行过操作；重试可能重复副作用'
    : '需要人工决定：这次失败不会自动重跑';
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(input.runId)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**失败**\n${escapeMd(d.outcome.category)} · retry ${escapeMd(d.outcome.retry)} · effects ${escapeMd(d.outcome.effects)}` } },
      ],
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'plain_text', content: reasonText } },
    { tag: 'div', text: { tag: 'plain_text', content: truncate(d.outcome.error, ERROR_MAX) } },
  ];
  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: resolutionText(resolution) } });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        decisionButton(input.runId, d, 'accept-failed', '接受失败并继续', 'default', nonce),
        decisionButton(input.runId, d, 'retry', '重试一次', 'primary', nonce),
      ],
    });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `终端：botmux flow decide ${input.runId} '${d.identity}' --attempt ${d.attempt} --accept-failed|--retry` }] });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

function decisionButton(runId: string, d: PendingDecision, choice: 'accept-failed' | 'retry', label: string, type: string, nonce: string): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { action: FLOW_DECIDE_ACTION, runId, identity: d.identity, attempt: d.attempt, content: d.content, choice, nonce, key: choice } satisfies FlowActionValue,
  };
}

export interface FlowRunPauseCardInput {
  runId: string;
  gen: number;
  pause: { reason: PendingDecision['reason']; detail: string };
  resolution?: { choice: 'accept-journal' | 'assume-clean' | 'cancel' | 'stale'; by?: string } | null;
}

export function buildFlowRunPauseCard(input: FlowRunPauseCardInput): string {
  const nonce = flowCardNonce(input.runId, 'pause', String(input.gen));
  const resolution = input.resolution ?? null;
  const accept: 'accept-journal' | 'assume-clean' = input.pause.reason === 'journal_integrity' ? 'accept-journal' : 'assume-clean';
  const acceptLabel = input.pause.reason === 'journal_integrity' ? '接受 journal 并继续' : input.pause.reason === 'escape' ? '视为已清理并继续' : '视为已清理并继续';
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', fields: [{ is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(input.runId)} · gen ${input.gen}` } }, { is_short: true, text: { tag: 'lark_md', content: `**原因**\n${escapeMd(input.pause.reason)}` } }] },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'plain_text', content: truncate(input.pause.detail, PROMPT_MAX) } },
  ];
  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: resolution.choice === 'stale' ? '已失效' : `${resolution.choice === 'cancel' ? '❌ 已取消 run' : `✅ ${resolution.choice}`}${resolution.by ? ` · by ${short(resolution.by, 24)}` : ''}` } });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: acceptLabel }, type: 'primary', value: { action: FLOW_DECIDE_RUN_ACTION, runId: input.runId, choice: accept, nonce, key: accept } satisfies FlowActionValue },
        { tag: 'button', text: { tag: 'plain_text', content: '取消 run' }, type: 'danger', value: { action: FLOW_DECIDE_RUN_ACTION, runId: input.runId, choice: 'cancel', nonce, key: 'cancel' } satisfies FlowActionValue },
      ],
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: resolution ? 'grey' : 'red', title: { tag: 'plain_text', content: resolution ? `已处理：run 级暂停（${input.pause.reason}）` : `run 暂停：${input.pause.reason}` } },
    elements,
  });
}

// ---------------------------------------------------------------------------
// 信号卡：按 schema 渲染表单
// ---------------------------------------------------------------------------

export interface FlowSignalCardInput {
  runId: string;
  wait: OpenWait;
  /** 恢复后旧卡刷新：加一行说明。 */
  note?: string;
  /** 有值 → 冻结。 */
  resolution?: { how: 'consumed' | 'superseded' | 'timeout' | 'canceled' | 'stale'; by?: string | null; value?: unknown; newVersion?: number } | null;
}

interface SchemaShape {
  kind: 'enum' | 'fields' | 'json';
  /** 裸 enum：field 为 null；对象里唯一必填 enum 属性：field 为属性名 */
  enumField?: string | null;
  enumValues?: unknown[];
  fields?: Array<{ name: string; type: string; required: boolean; enumValues?: unknown[]; description?: string }>;
}

/** 从 JSON Schema 子集推断表单形态：单 enum → 按钮；扁平对象 → 每属性一个输入框；其它 → 整段 JSON。 */
export function signalFormShape(schema: unknown): SchemaShape {
  const s = schema as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return { kind: 'json' };
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.length <= 8) return { kind: 'enum', enumField: null, enumValues: s.enum };
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const names = Object.keys(props);
    if (names.length === 1 && Array.isArray(props[names[0]!]?.enum) && (props[names[0]!]!.enum as unknown[]).length <= 8) {
      return { kind: 'enum', enumField: names[0]!, enumValues: props[names[0]!]!.enum as unknown[] };
    }
    if (names.length > 0 && names.length <= 8) {
      const fields: NonNullable<SchemaShape['fields']> = [];
      for (const name of names) {
        const p = props[name] ?? {};
        const type = typeof p.type === 'string' ? p.type : Array.isArray(p.enum) ? 'string' : 'json';
        if (!['string', 'number', 'integer', 'boolean', 'json'].includes(type) && !Array.isArray(p.enum)) return { kind: 'json' };
        fields.push({ name, type, required: required.has(name), ...(Array.isArray(p.enum) ? { enumValues: p.enum as unknown[] } : {}), ...(typeof p.description === 'string' ? { description: p.description } : {}) });
      }
      return { kind: 'fields', fields };
    }
  }
  return { kind: 'json' };
}

export function buildFlowSignalCard(input: FlowSignalCardInput): string {
  const w = input.wait;
  const nonce = flowCardNonce(input.runId, 'signal', `${w.identity}:${w.version}`);
  const resolution = input.resolution ?? null;
  const shape = signalFormShape(w.schema);
  const title = resolution ? `${signalResolutionTitle(resolution.how)}：${w.identity} v${w.version}` : `等待你的信号：${w.identity} v${w.version}`;
  const template = resolution ? (resolution.how === 'consumed' ? 'green' : 'grey') : 'blue';
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', fields: [{ is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(input.runId)}` } }, { is_short: true, text: { tag: 'lark_md', content: `**位置**\n${escapeMd(w.identity)} · v${w.version}` } }] },
    { tag: 'hr' },
    // 脚本作者写的 prompt 是不可信文本：plain_text，不给 <at> 之类的飞书标签机会
    { tag: 'div', text: { tag: 'plain_text', content: truncate(w.prompt, PROMPT_MAX) } },
  ];
  if (input.note) elements.push({ tag: 'div', text: { tag: 'plain_text', content: input.note } });
  if (resolution) {
    elements.push({ tag: 'hr' });
    let text: string;
    switch (resolution.how) {
      case 'consumed':
        text = `✅ 已提交${resolution.by ? ` · by ${short(resolution.by, 24)}` : ''}\n${truncate(JSON.stringify(resolution.value ?? null), RETURNED_MAX)}`;
        break;
      case 'superseded':
        text = resolution.newVersion ? `已作废：重发为 v${resolution.newVersion}` : '已作废：等待内容已变化，新卡片随后到达';
        break;
      case 'timeout':
        text = '⌛ 等待超时，脚本已收到 wait_timeout';
        break;
      case 'canceled':
        text = '❌ run 已取消';
        break;
      default:
        text = '已失效';
    }
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: text } });
  } else if (shape.kind === 'enum') {
    elements.push({
      tag: 'action',
      actions: (shape.enumValues ?? []).map((opt) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: short(String(opt), 60) },
        type: 'primary',
        value: { action: FLOW_SIGNAL_ACTION, runId: input.runId, identity: w.identity, version: w.version, nonce, choice: JSON.stringify(opt), field: shape.enumField ?? undefined, key: JSON.stringify(opt) } satisfies FlowActionValue,
      })),
    });
  } else {
    const inputs: Array<Record<string, unknown>> = [];
    if (shape.kind === 'fields') {
      for (const f of shape.fields ?? []) {
        const hint = f.enumValues ? `${f.enumValues.map(String).join(' | ')}` : f.type === 'json' ? 'JSON' : f.type;
        inputs.push({ tag: 'div', text: { tag: 'plain_text', content: `${f.name}${f.required ? '' : '（可选）'} · ${hint}${f.description ? ` · ${short(f.description, 80)}` : ''}` } });
        inputs.push({ tag: 'input', name: `${FLOW_SIGNAL_FIELD_PREFIX}${f.name}`, placeholder: { tag: 'plain_text', content: f.enumValues ? `其中之一：${f.enumValues.map(String).join(' / ')}` : f.type === 'boolean' ? 'true / false' : f.type } });
      }
    } else {
      inputs.push({ tag: 'div', text: { tag: 'plain_text', content: `按 schema 填写一段 JSON：\n${truncate(JSON.stringify(w.schema), 400)}` } });
      inputs.push({ tag: 'input', name: FLOW_SIGNAL_JSON_FIELD, placeholder: { tag: 'plain_text', content: '{ ... }' } });
    }
    elements.push({
      tag: 'form',
      name: 'flow_signal_form',
      elements: [
        ...inputs,
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '提交信号' },
          type: 'primary',
          name: 'flow_signal_submit',
          action_type: 'form_submit',
          value: { action: FLOW_SIGNAL_ACTION, runId: input.runId, identity: w.identity, version: w.version, nonce } satisfies FlowActionValue,
        },
      ],
    });
  }
  if (!resolution) {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '重发这张卡' }, type: 'default', value: { action: FLOW_RESEND_ACTION, runId: input.runId, identity: w.identity, version: w.version, nonce } satisfies FlowActionValue },
      ],
    });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `终端：botmux flow signal ${input.runId} '${w.identity}' --payload '<json>'` }] });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

/**
 * 把卡片表单值按 schema 形态还原成信号 payload。只做类型还原，不做校验——校验是 runner 的事（§7.2）。
 * 返回 `{ ok: false }` 只在「根本解析不出来」（非法 JSON、必填为空）时出现。
 */
export function signalPayloadFromForm(schema: unknown, formValue: Record<string, unknown> | undefined, choice?: { field?: string; choice: string }): { ok: true; value: unknown } | { ok: false; error: string } {
  const shape = signalFormShape(schema);
  if (choice) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.choice);
    } catch {
      return { ok: false, error: '选项值不是合法 JSON' };
    }
    return { ok: true, value: choice.field ? { [choice.field]: parsed } : parsed };
  }
  const fv = formValue ?? {};
  if (shape.kind === 'fields') {
    const out: Record<string, unknown> = {};
    for (const f of shape.fields ?? []) {
      const raw = fv[`${FLOW_SIGNAL_FIELD_PREFIX}${f.name}`];
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text.length === 0) {
        if (f.required) return { ok: false, error: `${f.name} 是必填项` };
        continue;
      }
      const coerced = coerceField(text, f.type, f.enumValues);
      if (!coerced.ok) return { ok: false, error: `${f.name}: ${coerced.error}` };
      out[f.name] = coerced.value;
    }
    return { ok: true, value: out };
  }
  const raw = fv[FLOW_SIGNAL_JSON_FIELD];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { ok: false, error: '请填写 JSON' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '不是合法 JSON' };
  }
}

function coerceField(text: string, type: string, enumValues?: unknown[]): { ok: true; value: unknown } | { ok: false; error: string } {
  if (enumValues) {
    const hit = enumValues.find((v) => String(v) === text);
    if (hit !== undefined) return { ok: true, value: hit };
    return { ok: false, error: `必须是 ${enumValues.map(String).join(' / ')} 之一` };
  }
  switch (type) {
    case 'string':
      return { ok: true, value: text };
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: '不是数字' };
    }
    case 'integer': {
      const n = Number(text);
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: '不是整数' };
    }
    case 'boolean': {
      const l = text.toLowerCase();
      if (['true', 'yes', 'y', '1', '是'].includes(l)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0', '否'].includes(l)) return { ok: true, value: false };
      return { ok: false, error: '填 true 或 false' };
    }
    default:
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: '不是合法 JSON' };
      }
  }
}

// ---------------------------------------------------------------------------
// 中断卡
// ---------------------------------------------------------------------------

export interface FlowInterruptedCardInput {
  runId: string;
  gen: number;
  scriptName: string;
  reason: string;
  /** 中断时在途 / 等待中的 identity。 */
  inflight: string[];
  resolution?: { choice: 'resume' | 'cancel' | 'stale'; by?: string } | null;
}

export function buildFlowInterruptedCard(input: FlowInterruptedCardInput): string {
  const nonce = flowCardNonce(input.runId, 'interrupted', String(input.gen));
  const resolution = input.resolution ?? null;
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', fields: [{ is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(input.runId)} · gen ${input.gen}` } }, { is_short: true, text: { tag: 'lark_md', content: `**脚本**\n${escapeMd(short(input.scriptName, 40))}` } }] },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'plain_text', content: `原因：${input.reason}${input.inflight.length > 0 ? `\n中断时在途：${input.inflight.join(', ')}` : ''}\n恢复后：已完成的结果复用；有发送意图的在途 attempt 标为不确定、等你决策；等待中的信号卡继续有效。` } },
  ];
  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: resolution.choice === 'stale' ? '已失效（run 已被别处恢复或结束）' : `${resolution.choice === 'resume' ? '▶️ 已恢复' : '❌ 已取消'}${resolution.by ? ` · by ${short(resolution.by, 24)}` : ''}` } });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '恢复 run' }, type: 'primary', value: { action: FLOW_RESUME_ACTION, runId: input.runId, gen: input.gen, choice: 'resume', nonce, key: 'resume' } satisfies FlowActionValue },
        { tag: 'button', text: { tag: 'plain_text', content: '取消 run' }, type: 'danger', value: { action: FLOW_RESUME_ACTION, runId: input.runId, gen: input.gen, choice: 'cancel', nonce, key: 'cancel' } satisfies FlowActionValue },
      ],
    });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `终端：botmux flow resume ${input.runId}` }] });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: resolution ? 'grey' : 'orange', title: { tag: 'plain_text', content: resolution ? `已处理：run ${short(input.runId, 20)} 中断` : `run 已中断：${short(input.runId, 20)}` } },
    elements,
  });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'blue';
    case 'paused':
      return 'orange';
    case 'completed':
      return 'green';
    case 'partial':
      return 'yellow';
    case 'interrupted':
      return 'grey';
    default:
      return 'red';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'paused':
      return '等待中';
    case 'completed':
      return '完成';
    case 'partial':
      return '部分完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'interrupted':
      return '已中断';
    default:
      return status;
  }
}

function deliveryLabel(delivery: OpenWait['delivery']): string {
  switch (delivery) {
    case 'delivered':
      return '已投递';
    case 'resent':
      return '已重发';
    case 'failed':
      return '投递失败，可用终端提交';
    default:
      return '投递中';
  }
}

function resolutionText(r: NonNullable<FlowDecisionCardInput['resolution']>): string {
  const by = r.by ? ` · by ${short(r.by, 24)}` : '';
  switch (r.choice) {
    case 'retry':
      return `🔁 已决策：重试一次${by}`;
    case 'accept-failed':
      return `✅ 已决策：接受失败并继续${by}`;
    case 'timeout':
      return '⌛ 决策等待超时，run 已取消';
    case 'canceled':
      return '❌ run 已取消；这次失败仍待决策，恢复后再问';
    default:
      return '已失效';
  }
}

function signalResolutionTitle(how: NonNullable<FlowSignalCardInput['resolution']>['how']): string {
  switch (how) {
    case 'consumed':
      return '已提交';
    case 'superseded':
      return '已作废';
    case 'timeout':
      return '已超时';
    case 'canceled':
      return '已取消';
    default:
      return '已失效';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（截断）`;
}

function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义 lark_md 里会被解析的字符。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
