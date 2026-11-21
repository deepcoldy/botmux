/**
 * 工作流模板页面的纯逻辑（design 2026-11-03 workflow-dashboard-orchestration
 * §5，D5）：列表筛选、人工确认变化的提示、参数表单、「设为参数」的可选位置。
 * 页面上的判断只是展示：保存 / 运行由 daemon 再按同样的规则校验。
 */
import type { SavedWorkflowCatalogEntry, SavedWorkflowVersionView } from '../../workflows/v3/library-catalog.js';
import type { SavedWorkflowGateComparisonAgainst, SavedWorkflowParamDef } from '../../workflows/v3/library-schema.js';
import type { SavedWorkflowParamEdit, SavedWorkflowParamEditField, SavedWorkflowParamEditType } from '../../workflows/v3/library-params.js';
import type { V3Node } from '../../workflows/v3/dag.js';

export function workflowTemplateHref(workflowId: string): string {
  return `#/workflows/library/${encodeURIComponent(workflowId)}`;
}

// ─── 列表（§5.3）─────────────────────────────────────────────────────────

/** 按编排 Bot 和关键字（名称、id）筛选；关键字不分大小写。 */
export function filterTemplates(
  entries: readonly SavedWorkflowCatalogEntry[],
  filter: { bot?: string; keyword?: string },
): SavedWorkflowCatalogEntry[] {
  const keyword = filter.keyword?.trim().toLocaleLowerCase() ?? '';
  return entries.filter((entry) =>
    (!filter.bot || entry.orchestratorAppId === filter.bot)
    && (!keyword || entry.displayName.toLocaleLowerCase().includes(keyword) || entry.workflowId.includes(keyword)));
}

/** 「运行」按钮的状态：群范围模板只展示（I9），未发布的不能运行。 */
export function templateRunState(entry: Pick<SavedWorkflowCatalogEntry, 'scope' | 'status' | 'runnable'>): 'runnable' | 'chat_scope' | 'unpublished' {
  if (entry.scope.kind === 'chat') return 'chat_scope';
  return entry.runnable ? 'runnable' : 'unpublished';
}

// ─── 人工确认的变化（I10）───────────────────────────────────────────────

/**
 * 一个版本的人工确认相对它比较的各个版本（上一版、当前发布版）的变化，合在一起
 * 显示，每条都标明相对哪个版本（I10）。`severe`：少了确认或放宽，与「少了 N 道」
 * 同级警告；其余是普通说明。不列审批人（页面不显示 open_id）。
 */
export interface GateWarningLine {
  key: string;
  base: { kind: 'previous' | 'published'; humanVersion: number };
  /** i18n key + params of the message (after the base prefix). */
  message: { key: string; params: Record<string, string | number> };
  severe: boolean;
}

export function gateWarningLines(comparisons: readonly SavedWorkflowGateComparisonAgainst[] | undefined): GateWarningLine[] {
  const out: GateWarningLine[] = [];
  for (const { base, gates } of comparisons ?? []) {
    const at = { kind: base.kind, humanVersion: base.humanVersion };
    const id = `${base.kind}:${base.revisionId}`;
    if (gates.removed.length) {
      out.push({ key: `${id}:removed`, base: at, severe: true, message: { key: 'workflow.library.gate.fewer', params: { count: gates.removed.length, nodes: gates.removed.join('、') } } });
    }
    for (const item of gates.loosened) {
      const key = item.reason === 'approvers_cleared' ? 'workflow.library.gate.approversCleared'
        : item.reason === 'approvers_added' ? 'workflow.library.gate.approversAdded'
          : 'workflow.library.gate.approveOptionsAdded';
      out.push({ key: `${id}:${item.nodeId}:${item.reason}`, base: at, severe: true, message: { key, params: { node: item.nodeId, count: item.items.length } } });
    }
    if (gates.added.length) out.push({ key: `${id}:added`, base: at, severe: false, message: { key: 'workflow.library.gate.more', params: { count: gates.added.length } } });
    if (gates.changed.length) out.push({ key: `${id}:changed`, base: at, severe: false, message: { key: 'workflow.library.gate.changed', params: { count: gates.changed.length } } });
  }
  return out;
}

/**
 * Who a person is, as the page may say it (D3 rule: never an open_id): 「你」
 * when it is the logged-in person as this bot sees them, else 「其他管理员」.
 * The Dashboard has no cached name lookup; no per-row Feishu call is made.
 */
export function personLabelKey(openId: string, meOpenId: string | undefined): 'workflow.library.you' | 'workflow.library.otherAdmin' {
  return meOpenId !== undefined && openId === meOpenId ? 'workflow.library.you' : 'workflow.library.otherAdmin';
}

/** 版本历史一行的来源标签键。 */
export function versionSourceKey(version: Pick<SavedWorkflowVersionView, 'source'>): string {
  return `workflow.library.source.${version.source}`;
}

// ─── 运行：参数表单（§5.2–5.3）───────────────────────────────────────────

export interface TemplateParamField {
  name: string;
  type: SavedWorkflowParamDef['type'];
  /** 没有默认值且声明为必填。 */
  required: boolean;
  defaultText?: string;
  description?: string;
  /** 文本 / 数字 / 是否以外（object、array）：表单填不了，只能在飞书里用 JSON。 */
  unsupported: boolean;
}

export function templateParamFields(inputs: Record<string, SavedWorkflowParamDef>): TemplateParamField[] {
  return Object.entries(inputs).map(([name, def]) => ({
    name,
    type: def.type,
    required: def.required === true && def.default === undefined,
    ...(def.default !== undefined ? { defaultText: typeof def.default === 'string' ? def.default : JSON.stringify(def.default) } : {}),
    ...(def.description ? { description: def.description } : {}),
    unsupported: def.type === 'object' || def.type === 'array',
  }));
}

/**
 * 表单 → 请求里的参数（都是文字，daemon 按 /workflow run 的规则转换）。空着
 * 的不发（走默认值）；必填没填、数字填得不是数字的先在页面上提示。
 */
export function collectTemplateRunParams(
  fields: readonly TemplateParamField[],
  values: Readonly<Record<string, string>>,
): { params: Record<string, string>; missing: string[]; invalid: string[] } {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    const raw = values[field.name] ?? '';
    if (raw === '') {
      if (field.required) missing.push(field.name);
      continue;
    }
    if (field.type === 'number' && !Number.isFinite(Number(raw.trim() === '' ? NaN : raw))) invalid.push(field.name);
    params[field.name] = raw;
  }
  return { params, missing, invalid };
}

// ─── 保存：「设为参数」能用的位置（§5.2）────────────────────────────────

export interface ParamEditTarget {
  /** 页面里的唯一键。 */
  key: string;
  nodeId: string;
  field: SavedWorkflowParamEditField;
  inputPath?: Array<string | number>;
  label: string;
  text: string;
}

function hostStringLeaves(value: unknown, path: Array<string | number>, out: Array<{ path: Array<string | number>; text: string }>): void {
  if (typeof value === 'string') {
    if (path.length > 0) out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => hostStringLeaves(item, [...path, index], out));
    return;
  }
  if (value && typeof value === 'object') {
    // `{ "$ref": … }` is a binding, not text (chat identity must stay exact).
    if (Object.prototype.hasOwnProperty.call(value, '$ref')) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) hostStringLeaves(child, [...path, key], out);
  }
}

/**
 * 节点目标、追加提示、宿主动作输入里的文字——只有这三处给「设为参数」（与
 * daemon 的规则同口径）；人工确认、拓扑、Bot 字段不在列表里。
 */
export function paramEditTargets(nodes: readonly V3Node[], prefix = ''): ParamEditTarget[] {
  const out: ParamEditTarget[] = [];
  for (const node of nodes) {
    const nodeId = prefix ? `${prefix}.${node.id}` : node.id;
    if (node.type === 'loop' && node.body) {
      out.push(...paramEditTargets(node.body.nodes, nodeId));
      continue;
    }
    if (node.type === 'host') {
      const leaves: Array<{ path: Array<string | number>; text: string }> = [];
      hostStringLeaves(node.input, [], leaves);
      for (const leaf of leaves) {
        out.push({ key: `${nodeId}#input:${leaf.path.join('.')}`, nodeId, field: 'input', inputPath: leaf.path, label: `${nodeId} · ${leaf.path.join('.')}`, text: leaf.text });
      }
      continue;
    }
    if (typeof node.goal === 'string' && node.goal) out.push({ key: `${nodeId}#goal`, nodeId, field: 'goal', label: nodeId, text: node.goal });
    const append = node.override?.systemPromptAppend;
    if (typeof append === 'string' && append) out.push({ key: `${nodeId}#prompt`, nodeId, field: 'systemPromptAppend', label: nodeId, text: append });
  }
  return out;
}

/** `text` 在 `value` 里是从 `start` 开始的第几处（daemon 按这个序号替换）。 */
export function occurrenceAt(value: string, text: string, start: number): number {
  let count = 0;
  for (let at = value.indexOf(text); at >= 0 && at < start; at = value.indexOf(text, at + 1)) count += 1;
  return count;
}

export interface ParamEditDraft {
  name: string;
  type: SavedWorkflowParamEditType;
  defaultText: string;
  description: string;
}

/** 选中的文字 + 填的参数 → 一处「设为参数」；不合格的返回原因键。 */
export function buildParamEdit(
  target: ParamEditTarget,
  selection: { start: number; end: number },
  draft: ParamEditDraft,
): { ok: true; edit: SavedWorkflowParamEdit } | { ok: false; reason: string } {
  const text = target.text.slice(selection.start, selection.end);
  if (!text.trim()) return { ok: false, reason: 'workflow.library.param.selectFirst' };
  if (text.includes('${') || text.includes('}')) return { ok: false, reason: 'workflow.library.param.overlapsMarker' };
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(draft.name) || ['__proto__', 'prototype', 'constructor'].includes(draft.name)) {
    return { ok: false, reason: 'workflow.library.param.badName' };
  }
  let value: string | number | boolean | undefined;
  if (draft.defaultText !== '') {
    if (draft.type === 'number') {
      value = Number(draft.defaultText);
      if (!Number.isFinite(value)) return { ok: false, reason: 'workflow.library.param.badDefault' };
    } else if (draft.type === 'boolean') {
      if (draft.defaultText !== 'true' && draft.defaultText !== 'false') return { ok: false, reason: 'workflow.library.param.badDefault' };
      value = draft.defaultText === 'true';
    } else {
      value = draft.defaultText;
    }
  }
  return {
    ok: true,
    edit: {
      name: draft.name,
      type: draft.type,
      ...(value !== undefined ? { default: value } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      nodeId: target.nodeId,
      field: target.field,
      ...(target.inputPath ? { inputPath: target.inputPath } : {}),
      text,
      occurrence: occurrenceAt(target.text, text, selection.start),
    },
  };
}

/** 新建模板的请求键：同一个保存框重试 / 连点落到同一个模板。 */
export function newTemplateRequestKey(random: () => number = Math.random): string {
  let out = '';
  while (out.length < 24) out += Math.floor(random() * 36).toString(36);
  return out.slice(0, 24);
}
