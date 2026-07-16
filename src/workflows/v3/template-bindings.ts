import type {
  V3DagTemplate,
  V3SpecTemplate,
  SavedWorkflowBuiltinContextRef,
  SavedWorkflowParamDef,
} from './library-schema.js';
import type { V3Node } from './dag.js';
import {
  collectV3HostBindingRefs,
  parseV3HostBindingRef,
  V3HostBindingError,
} from './host-bindings.js';

const MARKER_RE = /\$\{(params|context)\.([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

export interface SavedWorkflowTemplateBindings {
  params: string[];
  context: SavedWorkflowBuiltinContextRef[];
}

function collectFromText(text: string | undefined): SavedWorkflowTemplateBindings {
  const params = new Set<string>();
  const context = new Set<SavedWorkflowBuiltinContextRef>();
  if (text) {
    MARKER_RE.lastIndex = 0;
    for (let match = MARKER_RE.exec(text); match; match = MARKER_RE.exec(text)) {
      if (match[1] === 'params') params.add(match[2]!);
      else context.add(match[2] as SavedWorkflowBuiltinContextRef);
    }
  }
  return { params: [...params], context: [...context] };
}

/** Bindings a single goal worker is authorized to receive. */
export function savedWorkflowBindingsForNode(node: V3Node): SavedWorkflowTemplateBindings {
  const goal = collectFromText(node.goal);
  const instructions = collectFromText(node.override?.systemPromptAppend);
  const host = node.type === 'host'
    ? collectV3HostBindingRefs(node.input)
    : [];
  return {
    params: [...new Set([
      ...goal.params,
      ...instructions.params,
      ...host.filter((ref) => ref.kind === 'params').map((ref) => ref.path[0]!),
    ])],
    context: [...new Set([
      ...goal.context,
      ...instructions.context,
      ...host
        .filter((ref) => ref.kind === 'context')
        .map((ref) => ref.path[0] as SavedWorkflowBuiltinContextRef),
    ])],
  };
}

/** All bindings in a DAG, including goal nodes nested inside loop bodies. */
export function collectSavedWorkflowTemplateBindings(
  dagTemplate: V3DagTemplate,
): SavedWorkflowTemplateBindings {
  const params = new Set<string>();
  const context = new Set<SavedWorkflowBuiltinContextRef>();
  const visit = (nodes: readonly V3Node[]): void => {
    for (const node of nodes) {
      const own = savedWorkflowBindingsForNode(node);
      own.params.forEach((name) => params.add(name));
      own.context.forEach((name) => context.add(name));
      if (node.type === 'loop' && node.body) visit(node.body.nodes);
    }
  };
  visit(dagTemplate.nodes);
  return { params: [...params], context: [...context] };
}

/**
 * Spec markers are documentation mirrors only. They may occur in narrative
 * fields, never in sketch ids, booleans, schema fields, or other structure.
 */
export function assertSavedWorkflowSpecTemplateBindings(
  specTemplate: V3SpecTemplate,
  inputs: Record<string, SavedWorkflowParamDef>,
  contextRefs: readonly SavedWorkflowBuiltinContextRef[],
): void {
  const allowed = (path: string): boolean =>
    path === 'specTemplate.title' ||
    path === 'specTemplate.requirement' ||
    path === 'specTemplate.acceptance' ||
    /^specTemplate\.nonGoals\[\d+\]$/.test(path) ||
    /^specTemplate\.nodes\[\d+\]\.(?:goal|acceptance)$/.test(path) ||
    /^specTemplate\.nodes\[\d+\]\.(?:input_needs|expected_outputs|unknowns)\[\d+\]$/.test(path);

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      if (!allowed(path)) {
        throw new Error(`Saved Workflow spec marker is not allowed in structural field ${path}`);
      }
      const covered = new Array<boolean>(value.length).fill(false);
      MARKER_RE.lastIndex = 0;
      for (let match = MARKER_RE.exec(value); match; match = MARKER_RE.exec(value)) {
        const [whole, namespace, name] = match;
        for (let i = match.index; i < match.index + whole.length; i++) covered[i] = true;
        if (namespace === 'params' && !Object.prototype.hasOwnProperty.call(inputs, name)) {
          throw new Error(`Saved Workflow spec references undeclared parameter ${name} at ${path}`);
        }
        if (namespace === 'context' && !contextRefs.includes(name as SavedWorkflowBuiltinContextRef)) {
          throw new Error(`Saved Workflow spec references undeclared context ${name} at ${path}`);
        }
      }
      for (let i = value.indexOf('${'); i >= 0; i = value.indexOf('${', i + 2)) {
        if (!covered[i]) {
          throw new Error(`Saved Workflow has malformed/unsupported spec marker at ${path}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(specTemplate, 'specTemplate');
}

/**
 * Validate all markers and keep topology/bot/gate fields non-parameterized.
 * Human gate prompts are deliberately structural/safety text in P0: the host
 * cannot ask a person to approve an unresolved `${params.x}` target.
 */
export function assertSavedWorkflowTemplateBindings(
  dagTemplate: V3DagTemplate,
  inputs: Record<string, SavedWorkflowParamDef>,
  contextRefs: readonly SavedWorkflowBuiltinContextRef[],
): void {
  const allowedTextPath = (path: string): boolean =>
    path.endsWith('.goal') ||
    path.endsWith('.override.systemPromptAppend') ||
    /\.input(?:\.|\[|$)/.test(path);

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      if (!allowedTextPath(path)) {
        throw new Error(
          `Saved Workflow template marker is not allowed in structural/safety field ${path}; ` +
          'rewrite the literal before saving',
        );
      }
      const covered = new Array<boolean>(value.length).fill(false);
      MARKER_RE.lastIndex = 0;
      for (let match = MARKER_RE.exec(value); match; match = MARKER_RE.exec(value)) {
        const [whole, namespace, name] = match;
        for (let i = match.index; i < match.index + whole.length; i++) covered[i] = true;
        if (namespace === 'params' && !Object.prototype.hasOwnProperty.call(inputs, name)) {
          throw new Error(`Saved Workflow template references undeclared parameter ${name} at ${path}`);
        }
        if (namespace === 'context' && !contextRefs.includes(name as SavedWorkflowBuiltinContextRef)) {
          throw new Error(`Saved Workflow template references undeclared context ${name} at ${path}`);
        }
      }
      for (let i = value.indexOf('${'); i >= 0; i = value.indexOf('${', i + 2)) {
        if (!covered[i]) {
          throw new Error(
            `Saved Workflow has malformed/unsupported template marker at ${path}; ` +
            'rewrite literal `${...}` text before saving',
          );
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record.$ref === 'string') {
        let ref;
        try {
          ref = parseV3HostBindingRef(record.$ref);
        } catch (err) {
          throw new Error(err instanceof V3HostBindingError ? err.message : String(err));
        }
        if (ref.kind === 'params' && !Object.prototype.hasOwnProperty.call(inputs, ref.path[0]!)) {
          throw new Error(`Saved Workflow host input references undeclared parameter ${ref.path[0]} at ${path}`);
        }
        if (ref.kind === 'context' && !contextRefs.includes(ref.path[0] as SavedWorkflowBuiltinContextRef)) {
          throw new Error(`Saved Workflow host input references undeclared context ${ref.path[0]} at ${path}`);
        }
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(dagTemplate, 'dagTemplate');
  for (const node of dagTemplate.nodes) {
    if (node.type !== 'host') continue;
    const root = node.input;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new Error(`Saved Workflow host node ${node.id}.input must be an object`);
    }
    if (
      node.executor === 'botmux-schedule' &&
      Object.prototype.hasOwnProperty.call(root, 'parsed')
    ) {
      throw new Error(
        `Saved Workflow host node ${node.id}.input.parsed must be omitted; ` +
        'the runtime derives and freezes relative schedule time for each run',
      );
    }
    const requiredIdentity: Record<string, SavedWorkflowBuiltinContextRef> =
      node.executor === 'feishu-send' ? { larkAppId: 'larkAppId', chatId: 'chatId' }
      : node.executor === 'feishu-reply' ? { larkAppId: 'larkAppId', rootMessageId: 'rootMessageId' }
      : { larkAppId: 'larkAppId', chatId: 'chatId', chatType: 'chatType' };
    if (
      node.executor === 'botmux-schedule' &&
      Object.prototype.hasOwnProperty.call(root, 'rootMessageId')
    ) {
      requiredIdentity.rootMessageId = 'rootMessageId';
    }
    for (const [field, contextName] of Object.entries(requiredIdentity)) {
      const value = (root as Record<string, unknown>)[field];
      const expected = `context.${contextName}`;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as Record<string, unknown>).$ref !== expected
      ) {
        throw new Error(
          `Saved Workflow host node ${node.id}.input.${field} must be exact { "$ref": "${expected}" }; ` +
          'chat identity cannot come from a mutable parameter or frozen literal',
        );
      }
    }
  }
}
