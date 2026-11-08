/**
 * 「设为参数」(design 2026-11-03 workflow-dashboard-orchestration §5.2, E9):
 * a person selects a literal in a node's goal, its extra prompt
 * (`override.systemPromptAppend`) or a host action's input, names it, gives
 * it a type (text / number / yes-no), an optional default and a description;
 * the literal becomes `${params.<name>}` and the template declares the input.
 *
 * Pure. Only those three places are offered — gates, topology and bot fields
 * have no edit kind here — and the result still goes through the existing
 * template rules (`assertSavedWorkflowTemplateBindings` via the revision
 * validator), which refuse e.g. a parameter where a host input needs an exact
 * chat-context reference. There is no "sensitive" option (sensitive inputs
 * are not executable, §5.2).
 */

import {
  isValidSavedWorkflowParamName,
  validateDagTemplate,
  type SavedWorkflowParamDef,
  type SavedWorkflowRevisionDraft,
} from './library-schema.js';
import { isGoalNode, isLoopNode, type V3Node } from './dag.js';

export type SavedWorkflowParamEditType = 'string' | 'number' | 'boolean';
export type SavedWorkflowParamEditField = 'goal' | 'systemPromptAppend' | 'input';

export interface SavedWorkflowParamEdit {
  name: string;
  type: SavedWorkflowParamEditType;
  /** Must match `type`. Absent → the parameter is required. */
  default?: string | number | boolean;
  description?: string;
  /** A goal node (`<loop>.<body>` inside a loop) or a host node. */
  nodeId: string;
  field: SavedWorkflowParamEditField;
  /** `input` only: the path of a string inside the host input. */
  inputPath?: Array<string | number>;
  /** The selected literal. */
  text: string;
  /** Which occurrence of `text` in that string (0-based, default 0). */
  occurrence?: number;
}

export class SavedWorkflowParamEditError extends Error {
  constructor(message: string, readonly index?: number) {
    super(message);
    this.name = 'SavedWorkflowParamEditError';
  }
}

const MAX_EDITS = 64;
const MAX_DESCRIPTION = 500;
const TYPES: readonly SavedWorkflowParamEditType[] = ['string', 'number', 'boolean'];
const FIELDS: readonly SavedWorkflowParamEditField[] = ['goal', 'systemPromptAppend', 'input'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the page's edit list (untrusted JSON). */
export function parseSavedWorkflowParamEdits(raw: unknown): SavedWorkflowParamEdit[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new SavedWorkflowParamEditError('paramEdits 必须是数组');
  if (raw.length > MAX_EDITS) throw new SavedWorkflowParamEditError(`一次最多设 ${MAX_EDITS} 处参数`);
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new SavedWorkflowParamEditError('每一处参数都必须是对象', index);
    const allowed = new Set(['name', 'type', 'default', 'description', 'nodeId', 'field', 'inputPath', 'text', 'occurrence']);
    const extra = Object.keys(item).filter((key) => !allowed.has(key));
    // `sensitive` is not offered (§5.2): refused, not ignored.
    if (extra.length > 0) throw new SavedWorkflowParamEditError(`不支持的字段：${extra.join(', ')}`, index);
    if (typeof item.name !== 'string' || !isValidSavedWorkflowParamName(item.name)) {
      throw new SavedWorkflowParamEditError('参数名只能用字母、数字和下划线，且不能以数字开头', index);
    }
    if (!TYPES.includes(item.type as SavedWorkflowParamEditType)) {
      throw new SavedWorkflowParamEditError('参数类型只能是文本、数字或是/否', index);
    }
    const type = item.type as SavedWorkflowParamEditType;
    if (item.default !== undefined) {
      const ok = type === 'string' ? typeof item.default === 'string'
        : type === 'number' ? typeof item.default === 'number' && Number.isFinite(item.default)
          : typeof item.default === 'boolean';
      if (!ok) throw new SavedWorkflowParamEditError(`参数 ${item.name} 的默认值和类型不符`, index);
    }
    if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > MAX_DESCRIPTION)) {
      throw new SavedWorkflowParamEditError(`说明最多 ${MAX_DESCRIPTION} 个字符`, index);
    }
    if (typeof item.nodeId !== 'string' || !item.nodeId) throw new SavedWorkflowParamEditError('nodeId 不能为空', index);
    if (!FIELDS.includes(item.field as SavedWorkflowParamEditField)) {
      throw new SavedWorkflowParamEditError('参数只能设在节点目标、追加提示或宿主动作的输入里', index);
    }
    const field = item.field as SavedWorkflowParamEditField;
    let inputPath: Array<string | number> | undefined;
    if (field === 'input') {
      if (!Array.isArray(item.inputPath) || item.inputPath.length === 0
        || !item.inputPath.every((seg) => (typeof seg === 'string' && seg && !['__proto__', 'prototype', 'constructor'].includes(seg)) || (Number.isInteger(seg) && (seg as number) >= 0))) {
        throw new SavedWorkflowParamEditError('宿主动作输入要指明是哪个字段', index);
      }
      // A `{ "$ref": … }` binding is not text: never rewritten from here.
      if (item.inputPath.includes('$ref')) throw new SavedWorkflowParamEditError('引用（$ref）不是文字，不能设为参数', index);
      inputPath = item.inputPath as Array<string | number>;
    } else if (item.inputPath !== undefined) {
      throw new SavedWorkflowParamEditError('只有宿主动作输入才有 inputPath', index);
    }
    if (typeof item.text !== 'string' || !item.text.trim()) throw new SavedWorkflowParamEditError('要选中一段文字', index);
    if (item.text.includes('${') || item.text.includes('}')) {
      throw new SavedWorkflowParamEditError('选中的文字不能包含已有的参数标记', index);
    }
    if (item.occurrence !== undefined && (!Number.isInteger(item.occurrence) || (item.occurrence as number) < 0)) {
      throw new SavedWorkflowParamEditError('occurrence 必须是非负整数', index);
    }
    return {
      name: item.name,
      type,
      ...(item.default !== undefined ? { default: item.default as string | number | boolean } : {}),
      ...(typeof item.description === 'string' && item.description.trim() ? { description: item.description.trim() } : {}),
      nodeId: item.nodeId,
      field,
      ...(inputPath ? { inputPath } : {}),
      text: item.text,
      ...(item.occurrence !== undefined ? { occurrence: item.occurrence as number } : {}),
    };
  });
}

function findNode(nodes: V3Node[], nodeId: string): V3Node | undefined {
  const top = nodes.find((node) => node.id === nodeId);
  if (top && !isLoopNode(top)) return top;
  for (const node of nodes) {
    if (!isLoopNode(node) || !nodeId.startsWith(`${node.id}.`)) continue;
    const bodyId = nodeId.slice(node.id.length + 1);
    const hit = node.body.nodes.find((candidate) => candidate.id === bodyId);
    if (hit) return hit;
  }
  return undefined;
}

function nthIndexOf(haystack: string, needle: string, occurrence: number): number {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = haystack.indexOf(needle, at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/** Replace occurrence `n` of `text` in `value` by the marker; refuses a
 *  selection that would cut into an existing `${…}` marker. */
function replaceInText(value: string, edit: SavedWorkflowParamEdit, index: number): string {
  const at = nthIndexOf(value, edit.text, edit.occurrence ?? 0);
  if (at < 0) throw new SavedWorkflowParamEditError(`节点 ${edit.nodeId} 里找不到选中的文字`, index);
  const end = at + edit.text.length;
  for (let open = value.indexOf('${'); open >= 0; open = value.indexOf('${', open + 2)) {
    const close = value.indexOf('}', open);
    if (close >= 0 && at <= close && end > open) {
      throw new SavedWorkflowParamEditError('选中的文字和已有的参数标记重叠', index);
    }
  }
  return `${value.slice(0, at)}\${params.${edit.name}}${value.slice(end)}`;
}

/**
 * Apply the edits to a revision draft: a new draft (the input is not
 * mutated) whose DAG carries the markers and whose inputs declare them. An
 * input the revision already declares (a run of a template) cannot be
 * redeclared. With any edit the spec — documentation only, never executed —
 * is marked stale, as a distilled revision is.
 */
export function applySavedWorkflowParamEdits(
  revision: SavedWorkflowRevisionDraft,
  edits: readonly SavedWorkflowParamEdit[],
): SavedWorkflowRevisionDraft {
  if (edits.length === 0) return revision;
  const nodes = JSON.parse(JSON.stringify(revision.dagTemplate.nodes)) as V3Node[];
  const inputs: Record<string, SavedWorkflowParamDef> = { ...revision.inputs };
  const declared = new Map<string, SavedWorkflowParamEdit>();
  edits.forEach((edit, index) => {
    if (Object.prototype.hasOwnProperty.call(revision.inputs, edit.name)) {
      throw new SavedWorkflowParamEditError(`参数 ${edit.name} 已经存在`, index);
    }
    const earlier = declared.get(edit.name);
    if (earlier && (earlier.type !== edit.type || earlier.default !== edit.default || earlier.description !== edit.description)) {
      throw new SavedWorkflowParamEditError(`参数 ${edit.name} 在几处的类型、默认值或说明不一致`, index);
    }
    declared.set(edit.name, edit);
    const node = findNode(nodes, edit.nodeId);
    if (!node) throw new SavedWorkflowParamEditError(`没有这个节点：${edit.nodeId}`, index);
    if (edit.field === 'goal' || edit.field === 'systemPromptAppend') {
      if (!isGoalNode(node)) throw new SavedWorkflowParamEditError(`节点 ${edit.nodeId} 不是任务节点`, index);
      if (edit.field === 'goal') {
        if (typeof node.goal !== 'string') throw new SavedWorkflowParamEditError(`节点 ${edit.nodeId} 没有目标`, index);
        node.goal = replaceInText(node.goal, edit, index);
      } else {
        const append = node.override?.systemPromptAppend;
        if (typeof append !== 'string') throw new SavedWorkflowParamEditError(`节点 ${edit.nodeId} 没有追加提示`, index);
        node.override = { ...node.override, systemPromptAppend: replaceInText(append, edit, index) };
      }
      return;
    }
    if (node.type !== 'host') throw new SavedWorkflowParamEditError(`节点 ${edit.nodeId} 不是宿主动作`, index);
    let parent: unknown = node.input;
    const path = edit.inputPath!;
    for (const seg of path.slice(0, -1)) {
      parent = isRecord(parent) || Array.isArray(parent) ? (parent as Record<string | number, unknown>)[seg] : undefined;
    }
    const last = path[path.length - 1]!;
    const container = isRecord(parent) || Array.isArray(parent) ? parent as Record<string | number, unknown> : undefined;
    const leaf = container ? container[last] : undefined;
    if (!container || typeof leaf !== 'string' || !Object.prototype.hasOwnProperty.call(container, last)) {
      throw new SavedWorkflowParamEditError(`宿主动作 ${edit.nodeId} 的这个输入不是文字`, index);
    }
    // The whole value → a typed reference; part of it → a text marker.
    container[last] = leaf === edit.text ? { $ref: `params.${edit.name}` } : replaceInText(leaf, edit, index);
  });
  for (const [name, edit] of declared) {
    inputs[name] = {
      type: edit.type,
      ...(edit.default === undefined ? { required: true } : { default: edit.default }),
      ...(edit.description ? { description: edit.description } : {}),
    };
  }
  return {
    ...revision,
    inputs,
    specStatus: 'stale',
    dagTemplate: validateDagTemplate({ ...revision.dagTemplate, nodes }),
  };
}
