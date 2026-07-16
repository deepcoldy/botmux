/** Pure, fail-loud v2 definition -> v3 Saved Workflow converter. */

import type { BotConfig } from '../../bot-registry.js';
import type {
  HumanGate,
  ParamDef,
  SubagentNode,
  WorkflowDefinition,
  WorkflowNode,
} from '../definition.js';
import { validateWorkflowParamSchema } from '../shared/params.js';
import { resolveBotConfig, botToSnapshot } from '../v3/bot-resolve.js';
import { isV3SupportedCli, SPEC_SCHEMA_VERSION } from '../v3/contract.js';
import {
  V3_HOST_EXECUTORS,
  validateDag,
  type V3HumanGate,
  type V3Node,
  type V3ResultSchema,
} from '../v3/dag.js';
import {
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowSideEffects,
  SAVED_WORKFLOW_PARAM_NAME_RE,
  validateDagTemplate,
  validateSpecTemplate,
  type SavedWorkflowOwner,
  type SavedWorkflowParamDef,
  type SavedWorkflowRevisionDraft,
  type SavedWorkflowScope,
} from '../v3/library-schema.js';

export type LegacyMigrationSeverity = 'error' | 'warning';

export interface LegacyMigrationIssue {
  severity: LegacyMigrationSeverity;
  code: string;
  path: string;
  message: string;
  hint: string;
}

export interface LegacyConversionTargetContext {
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  /** Needed only when proving a chat-scoped schedule target is unchanged. */
  chatType?: 'group' | 'p2p';
}

export type LegacyWorkflowConversionResult =
  | {
    ok: true;
    revision: SavedWorkflowRevisionDraft;
    issues: LegacyMigrationIssue[];
  }
  | {
    ok: false;
    issues: LegacyMigrationIssue[];
  };

interface ConversionContext {
  definition: WorkflowDefinition;
  bots: BotConfig[];
  target?: LegacyConversionTargetContext;
  issues: LegacyMigrationIssue[];
}

const V3_RESULT_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

function issue(
  ctx: ConversionContext,
  severity: LegacyMigrationSeverity,
  code: string,
  path: string,
  message: string,
  hint: string,
): void {
  ctx.issues.push({ severity, code, path, message, hint });
}

function error(
  ctx: ConversionContext,
  code: string,
  path: string,
  message: string,
  hint: string,
): void {
  issue(ctx, 'error', code, path, message, hint);
}

function warning(
  ctx: ConversionContext,
  code: string,
  path: string,
  message: string,
  hint: string,
): void {
  issue(ctx, 'warning', code, path, message, hint);
}

function hasErrors(ctx: ConversionContext): boolean {
  return ctx.issues.some((item) => item.severity === 'error');
}

function lintReusableLiterals(value: unknown, path: string, ctx: ConversionContext): void {
  if (typeof value === 'string') {
    if (/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s"']{6,}/i.test(value)) {
      warning(
        ctx,
        'EMBEDDED_SECRET_LITERAL',
        path,
        'Text looks like an embedded secret and would become a reusable library asset.',
        'Replace it with an external secret reference; do not acknowledge unless this is a confirmed false positive.',
      );
    }
    if (/(?:^|[\s"'])(?:\/(?:Users|home|root|tmp|etc|var)\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/.test(value)) {
      warning(
        ctx,
        'MACHINE_LOCAL_PATH_LITERAL',
        path,
        'Text contains an absolute machine-local path.',
        'Move the path to bot configuration or explicitly acknowledge that the migrated asset is machine-bound.',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => lintReusableLiterals(item, `${path}[${index}]`, ctx));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      lintReusableLiterals(child, `${path}.${key}`, ctx);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function scanGoalBindings(
  text: string,
  path: string,
  params: Readonly<Record<string, ParamDef>>,
  ctx: ConversionContext,
): void {
  const covered = new Array<boolean>(text.length).fill(false);
  const markerRe = /\$\{([^{}]+)\}/g;
  for (let match = markerRe.exec(text); match; match = markerRe.exec(text)) {
    const whole = match[0];
    const ref = match[1]!;
    for (let index = match.index; index < match.index + whole.length; index++) covered[index] = true;
    const paramMatch = /^params\.([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(ref);
    if (paramMatch) {
      if (!Object.prototype.hasOwnProperty.call(params, paramMatch[1]!)) {
        error(
          ctx,
          'UNDECLARED_PARAM_BINDING',
          path,
          `Prompt references undeclared parameter ${paramMatch[1]}.`,
          'Declare the parameter or rewrite the prompt as a literal.',
        );
      }
      continue;
    }
    if (ref.startsWith('params.')) {
      error(
        ctx,
        'NESTED_PARAM_BINDING_UNSUPPORTED',
        path,
        `Nested v2 parameter binding \${${ref}} cannot be represented by the v3 template marker contract.`,
        'Promote the nested value to its own top-level parameter before migrating.',
      );
      continue;
    }
    if (ref.includes('.output.') || ref.includes('.previous.')) {
      error(
        ctx,
        'OUTPUT_BINDING_UNSUPPORTED',
        path,
        `v2 output binding \${${ref}} performs JSON value interpolation that v3 goal inputs do not reproduce.`,
        'Redesign the consumer to read an upstream manifest via v3 inputs, then save the redesigned run.',
      );
      continue;
    }
    error(
      ctx,
      'MALFORMED_TEMPLATE_BINDING',
      path,
      `Unsupported v2 interpolation marker \${${ref}}.`,
      'Rewrite literal ${...} text or use one declared top-level ${params.NAME} marker.',
    );
  }
  for (let index = text.indexOf('${'); index >= 0; index = text.indexOf('${', index + 2)) {
    if (!covered[index]) {
      error(
        ctx,
        'MALFORMED_TEMPLATE_BINDING',
        path,
        'Prompt contains a malformed or nested ${...} marker.',
        'Rewrite the marker before migrating.',
      );
    }
  }
}

function hasDynamicBinding(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(hasDynamicBinding);
  if (!isRecord(value)) return false;
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string') return true;
  return Object.values(value).some(hasDynamicBinding);
}

function convertGate(
  gate: HumanGate | undefined,
  path: string,
  ctx: ConversionContext,
  host: boolean,
): V3HumanGate | null {
  if (!gate) return null;
  if (typeof gate.prompt !== 'string') {
    error(
      ctx,
      'WHOLE_FIELD_REF_UNSUPPORTED',
      `${path}.prompt`,
      'A whole-field $ref gate prompt cannot be migrated safely.',
      'Rewrite the approval prompt as static text.',
    );
    return null;
  }
  if (gate.prompt.includes('${')) {
    error(
      ctx,
      'DYNAMIC_GATE_PROMPT_UNSUPPORTED',
      `${path}.prompt`,
      'v3 Saved Workflow gates are structural safety text and cannot contain template markers.',
      'Use a static prompt; host gates automatically show the frozen payload being approved.',
    );
  }
  if (gate.deadlineMs !== undefined) {
    error(
      ctx,
      'GATE_DEADLINE_UNSUPPORTED',
      `${path}.deadlineMs`,
      'v3 Saved Workflow gates have no definition-level deadline equivalent.',
      'Remove the deadline and rely on explicit operator resolution.',
    );
  }
  if (gate.onTimeout !== undefined) {
    if (gate.deadlineMs === undefined) {
      warning(
        ctx,
        'INERT_GATE_TIMEOUT_DROPPED',
        `${path}.onTimeout`,
        'onTimeout has no deadline and is inert; it will be dropped.',
        'Remove the inert field from the legacy definition.',
      );
    } else {
      error(
        ctx,
        'GATE_TIMEOUT_POLICY_UNSUPPORTED',
        `${path}.onTimeout`,
        'v3 has no equivalent automatic timeout resolution policy.',
        'Redesign the approval lifecycle without automatic success/failure.',
      );
    }
  }
  return {
    prompt: gate.prompt,
    options: ['approve', 'reject'],
    approveOptions: ['approve'],
    approvers: [...(gate.approvers ?? [])],
    ...(host ? {} : {}),
  };
}

function mapTimeout(
  timeoutMs: number | undefined,
  path: string,
  ctx: ConversionContext,
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (timeoutMs % 1000 !== 0) {
    error(
      ctx,
      'SUBSECOND_TIMEOUT_UNSUPPORTED',
      path,
      `timeoutMs=${timeoutMs} cannot be represented exactly as integer timeoutSec.`,
      'Round the legacy timeout to whole seconds explicitly, then migrate again.',
    );
    return undefined;
  }
  return timeoutMs / 1000;
}

function validateRetryAndTransportFields(
  node: WorkflowNode,
  path: string,
  ctx: ConversionContext,
): void {
  if ('retryPolicy' in node && node.retryPolicy) {
    if (node.retryPolicy.maxAttempts > 1) {
      error(
        ctx,
        'AUTO_RETRY_UNSUPPORTED',
        `${path}.retryPolicy`,
        'v2 automatic retry/backoff cannot be reproduced by v3 Saved Workflows.',
        'Remove automatic retry and use v3 blocked -> operator retry semantics.',
      );
    } else {
      warning(
        ctx,
        'INERT_RETRY_POLICY_DROPPED',
        `${path}.retryPolicy`,
        'retryPolicy.maxAttempts=1 cannot retry and will be dropped.',
        'Remove the inert retry policy from the legacy definition.',
      );
    }
  }
  if ('maxOutputBytes' in node && node.maxOutputBytes !== undefined) {
    warning(
      ctx,
      'MAX_OUTPUT_BYTES_DROPPED',
      `${path}.maxOutputBytes`,
      'v3 has no definition-level maxOutputBytes field; the goal manifest contract applies its own limits.',
      'Review output size expectations and acknowledge this warning before commit.',
    );
  }
  if ('unsafeAllowUngated' in node && node.unsafeAllowUngated === true) {
    error(
      ctx,
      'UNSAFE_UNGATED_UNSUPPORTED',
      `${path}.unsafeAllowUngated`,
      'v3 host side effects always require approval of frozen input.',
      'Add a humanGate and remove unsafeAllowUngated.',
    );
  }
}

function convertResultSchema(
  raw: Record<string, unknown> | undefined,
  path: string,
  ctx: ConversionContext,
): V3ResultSchema | undefined {
  if (!raw) return undefined;
  const allowedTop = new Set(['$schema', 'type', 'properties', 'required']);
  const extras = Object.keys(raw).filter((key) => !allowedTop.has(key));
  if (extras.length > 0) {
    error(
      ctx,
      'OUTPUT_SCHEMA_UNSUPPORTED',
      path,
      `outputSchema uses unsupported keyword(s): ${extras.join(', ')}.`,
      'Reduce it to the flat v3 subset: type/properties/required with primitive property types.',
    );
    return undefined;
  }
  if (raw.$schema !== undefined) {
    if (typeof raw.$schema !== 'string') {
      error(ctx, 'OUTPUT_SCHEMA_UNSUPPORTED', `${path}.$schema`, '$schema must be a string annotation.', 'Remove it.');
    } else {
      warning(
        ctx,
        'OUTPUT_SCHEMA_ANNOTATION_DROPPED',
        `${path}.$schema`,
        '$schema is an annotation and will be dropped from the v3 executable subset.',
        'Acknowledge the warning or remove the annotation.',
      );
    }
  }
  if (raw.type !== 'object' || !isRecord(raw.properties) || Object.keys(raw.properties).length === 0) {
    error(
      ctx,
      'OUTPUT_SCHEMA_UNSUPPORTED',
      path,
      'v3 resultSchema requires a non-empty flat object schema.',
      'Rewrite outputSchema to {type:"object", properties:{...}, required:[...]}.',
    );
    return undefined;
  }
  const properties: V3ResultSchema['properties'] = {};
  for (const [name, rawProperty] of Object.entries(raw.properties)) {
    if (!isRecord(rawProperty)) {
      error(ctx, 'OUTPUT_SCHEMA_UNSUPPORTED', `${path}.properties.${name}`, 'Property schema must be an object.', 'Use {type:<primitive>}.');
      continue;
    }
    const extras = Object.keys(rawProperty).filter((key) => key !== 'type' && key !== 'enum');
    if (extras.length > 0 || !V3_RESULT_TYPES.has(String(rawProperty.type))) {
      error(
        ctx,
        'OUTPUT_SCHEMA_UNSUPPORTED',
        `${path}.properties.${name}`,
        `Property is outside the v3 flat subset${extras.length ? ` (keywords: ${extras.join(', ')})` : ''}.`,
        'Use type string/number/boolean/array/object and optional string enum only.',
      );
      continue;
    }
    if (rawProperty.enum !== undefined) {
      if (
        rawProperty.type !== 'string' ||
        !Array.isArray(rawProperty.enum) ||
        rawProperty.enum.length === 0 ||
        rawProperty.enum.some((item) => typeof item !== 'string' || !item)
      ) {
        error(
          ctx,
          'OUTPUT_SCHEMA_UNSUPPORTED',
          `${path}.properties.${name}.enum`,
          'v3 only supports a non-empty string enum on a string property.',
          'Remove or rewrite the enum.',
        );
      } else {
        properties[name] = { type: 'string', enum: [...rawProperty.enum] };
      }
    } else {
      properties[name] = { type: rawProperty.type as V3ResultSchema['properties'][string]['type'] };
    }
  }
  let required: string[] | undefined;
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((item) => typeof item !== 'string')) {
      error(ctx, 'OUTPUT_SCHEMA_UNSUPPORTED', `${path}.required`, 'required must be a string array.', 'Rewrite the required list.');
    } else {
      required = [...raw.required] as string[];
    }
  }
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

function validateBot(node: SubagentNode, path: string, ctx: ConversionContext): void {
  let bot: BotConfig;
  try {
    bot = resolveBotConfig(node.bot, ctx.bots);
  } catch (err) {
    error(
      ctx,
      'BOT_NOT_FOUND',
      `${path}.bot`,
      err instanceof Error ? err.message : String(err),
      'Update the legacy node to an exact configured larkAppId.',
    );
    return;
  }
  if (node.bot !== bot.larkAppId) {
    error(
      ctx,
      'BOT_SELECTOR_NOT_STABLE',
      `${path}.bot`,
      `Selector ${JSON.stringify(node.bot)} resolves by mutable display name, not exact larkAppId ${bot.larkAppId}.`,
      `Replace it with ${JSON.stringify(bot.larkAppId)} before migrating.`,
    );
  }
  try {
    const snapshot = botToSnapshot(bot);
    if (!isV3SupportedCli(snapshot.cliId)) {
      error(
        ctx,
        'CLI_NOT_SUPPORTED',
        `${path}.bot`,
        `Bot ${bot.larkAppId} uses CLI ${snapshot.cliId}, outside the v3 goal-mode allowlist.`,
        'Choose a Claude Code, Codex, Seed, Traex, or Relay bot.',
      );
    }
  } catch (err) {
    error(
      ctx,
      'BOT_PERMISSION_UNSUPPORTED',
      `${path}.bot`,
      err instanceof Error ? err.message : String(err),
      'Use a v3-supported workflow bot with CLI bypass permission enabled.',
    );
  }
}

function convertSubagent(
  id: string,
  node: SubagentNode,
  ctx: ConversionContext,
): V3Node {
  const path = `nodes.${id}`;
  validateBot(node, path, ctx);
  validateRetryAndTransportFields(node, path, ctx);
  if (typeof node.prompt !== 'string') {
    error(
      ctx,
      'WHOLE_FIELD_REF_UNSUPPORTED',
      `${path}.prompt`,
      'A whole-field $ref prompt cannot be represented by the v3 goal contract.',
      'Rewrite the prompt as static text plus declared top-level ${params.NAME} markers.',
    );
  } else {
    scanGoalBindings(node.prompt, `${path}.prompt`, ctx.definition.params ?? {}, ctx);
  }
  if (node.workingDir !== undefined) {
    error(
      ctx,
      'NODE_WORKING_DIR_UNSUPPORTED',
      `${path}.workingDir`,
      'v3 Saved Workflow nodes cannot override workingDir.',
      'Move the working directory to the selected bot configuration.',
    );
  }
  if (node.toolPolicy !== undefined) {
    error(
      ctx,
      'TOOL_POLICY_UNSUPPORTED',
      `${path}.toolPolicy`,
      'v3 Saved Workflow capability overrides do not support tool allow/deny policies.',
      'Move the restriction to the bot sandbox/capability configuration.',
    );
  }
  if (node.modelOverrides?.reasoningEffort !== undefined) {
    error(
      ctx,
      'REASONING_EFFORT_UNSUPPORTED',
      `${path}.modelOverrides.reasoningEffort`,
      'v3 per-node override has no reasoningEffort field.',
      'Remove it or encode the intent in the node goal/system prompt.',
    );
  }
  const humanGate = convertGate(node.humanGate, `${path}.humanGate`, ctx, false);
  if (node.timeoutMs !== undefined) {
    warning(
      ctx,
      'NODE_TIMEOUT_BECOMES_EFFECTIVE',
      `${path}.timeoutMs`,
      'The current v2 dispatch path does not forward node timeoutMs, while v3 will enforce the converted timeoutSec.',
      'Review the duration and acknowledge this behavior correction before commit.',
    );
  }
  const timeoutSec = mapTimeout(
    node.timeoutMs ?? ctx.definition.defaults?.timeoutMs,
    node.timeoutMs !== undefined ? `${path}.timeoutMs` : 'defaults.timeoutMs',
    ctx,
  );
  const resultSchema = convertResultSchema(node.outputSchema, `${path}.outputSchema`, ctx);
  return {
    id,
    type: 'goal',
    goal: typeof node.prompt === 'string' ? node.prompt : 'UNSUPPORTED_WHOLE_FIELD_PROMPT',
    bot: node.bot,
    depends: (node.depends ?? []).map((from) => ({ from })),
    inputs: [],
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    ...(humanGate ? { humanGate } : {}),
    ...(node.modelOverrides?.model ? { override: { model: node.modelOverrides.model } } : {}),
    ...(resultSchema ? { resultSchema } : {}),
  };
}

function literalEquals(input: Record<string, unknown>, field: string, expected: string): boolean {
  return typeof input[field] === 'string' && input[field] === expected;
}

function convertHost(
  id: string,
  node: Extract<WorkflowNode, { type: 'hostExecutor' }>,
  ctx: ConversionContext,
): V3Node {
  const path = `nodes.${id}`;
  validateRetryAndTransportFields(node, path, ctx);
  const supported = (V3_HOST_EXECUTORS as readonly string[]).includes(node.executor);
  if (!supported) {
    error(
      ctx,
      'HOST_EXECUTOR_UNSUPPORTED',
      `${path}.executor`,
      `Host executor ${node.executor} is not in the v3 allowlist.`,
      `Use one of ${V3_HOST_EXECUTORS.join(', ')} or redesign this node as a goal.`,
    );
  }
  const humanGate = convertGate(node.humanGate, `${path}.humanGate`, ctx, true);
  if (!node.humanGate) {
    error(
      ctx,
      'HOST_GATE_REQUIRED',
      `${path}.humanGate`,
      'v3 requires every side effect to approve its frozen input.',
      'Add a static humanGate and remove unsafeAllowUngated.',
    );
  }
  if (!isRecord(node.input)) {
    error(ctx, 'HOST_INPUT_UNSUPPORTED', `${path}.input`, 'Host input must be an object.', 'Rewrite the host payload as an object.');
  }
  if (hasDynamicBinding(node.input)) {
    error(
      ctx,
      'HOST_DYNAMIC_BINDING_UNSUPPORTED',
      `${path}.input`,
      'P0 migration refuses $ref/${...} inside legacy host payloads.',
      'Redesign the host input with v3 typed params/context bindings, then save a v3 run.',
    );
  }
  if (node.outputSchema !== undefined) {
    error(
      ctx,
      'HOST_OUTPUT_SCHEMA_UNSUPPORTED',
      `${path}.outputSchema`,
      'v3 host output uses the trusted executor receipt contract, not an authored result schema.',
      'Remove the host outputSchema and update downstream nodes to consume the receipt manifest.',
    );
  }
  if (node.timeoutMs !== undefined || ctx.definition.defaults?.timeoutMs !== undefined) {
    warning(
      ctx,
      'INERT_HOST_TIMEOUT_DROPPED',
      node.timeoutMs !== undefined ? `${path}.timeoutMs` : 'defaults.timeoutMs',
      'The current v2 host path does not enforce this timeout, and v3 host recovery uses provider response/reconcile bounds instead.',
      'Remove the inert field or acknowledge that v3 provider recovery owns the timeout.',
    );
  }

  const input = isRecord(node.input) ? cloneJson(node.input) : {};
  const target = ctx.target;
  if (node.executor === 'feishu-reply') {
    error(
      ctx,
      'FIXED_REPLY_TARGET_UNSUPPORTED',
      `${path}.input.rootMessageId`,
      'A fixed legacy reply root cannot become reusable without changing which message receives the reply.',
      'Redesign it as a v3 workflow that explicitly uses the current context.rootMessageId.',
    );
  }
  if (!target || target.scope.kind !== 'chat') {
    error(
      ctx,
      'HOST_CHAT_SCOPE_REQUIRED',
      path,
      'A literal legacy host destination can only be preserved in a chat-scoped v3 definition.',
      'Dry-run/commit with explicit owner, --scope chat, --chat-id, and --chat-type.',
    );
  } else if (node.executor === 'feishu-send') {
    if (
      !literalEquals(input, 'larkAppId', target.owner.larkAppId) ||
      !literalEquals(input, 'chatId', target.scope.chatId)
    ) {
      error(
        ctx,
        'HOST_TARGET_MISMATCH',
        `${path}.input`,
        'Legacy feishu-send app/chat literals do not match the explicit chat-scoped migration target.',
        'Choose the matching owner/app/chat or redesign the destination explicitly.',
      );
    } else {
      input.larkAppId = { $ref: 'context.larkAppId' };
      input.chatId = { $ref: 'context.chatId' };
    }
  } else if (node.executor === 'botmux-schedule') {
    const legacyChatType = input.chatType === undefined ? 'group' : input.chatType;
    if (
      !target.chatType ||
      !literalEquals(input, 'larkAppId', target.owner.larkAppId) ||
      !literalEquals(input, 'chatId', target.scope.chatId) ||
      legacyChatType !== target.chatType
    ) {
      error(
        ctx,
        'HOST_TARGET_MISMATCH',
        `${path}.input`,
        'Legacy schedule app/chat/chatType literals do not match the explicit chat-scoped target.',
        'Choose the exact matching owner/app/chat/chatType.',
      );
    }
    if (input.parsed !== undefined) {
      error(
        ctx,
        'SCHEDULE_PARSED_INPUT_UNSUPPORTED',
        `${path}.input.parsed`,
        'Saved Workflows must parse and freeze relative schedules for each run; stored parsed time is unsafe.',
        'Remove parsed and keep only the authored schedule expression.',
      );
    }
    if (input.rootMessageId !== undefined) {
      error(
        ctx,
        'SCHEDULE_FIXED_ROOT_UNSUPPORTED',
        `${path}.input.rootMessageId`,
        'A fixed legacy message root is not reusable without changing behavior.',
        'Remove the fixed root or redesign this as a current-root context workflow.',
      );
    }
    if (input.deliver === 'local') {
      error(
        ctx,
        'SCHEDULE_LOCAL_DELIVERY_UNSUPPORTED',
        `${path}.input.deliver`,
        'v3 schedule host does not support deliver=local.',
        'Use origin/new-topic delivery.',
      );
    }
    if (target.chatType) {
      delete input.parsed;
      input.larkAppId = { $ref: 'context.larkAppId' };
      input.chatId = { $ref: 'context.chatId' };
      input.chatType = { $ref: 'context.chatType' };
    }
  }

  return {
    id,
    type: 'host',
    executor: supported ? node.executor as (typeof V3_HOST_EXECUTORS)[number] : 'feishu-send',
    input,
    depends: (node.depends ?? []).map((from) => ({ from })),
    inputs: [],
    humanGate: humanGate ?? {
      prompt: 'UNSUPPORTED_MISSING_HOST_GATE',
      options: ['approve', 'reject'],
      approveOptions: ['approve'],
      approvers: [],
    },
  };
}

function convertParams(ctx: ConversionContext): Record<string, SavedWorkflowParamDef> {
  const inputs: Record<string, SavedWorkflowParamDef> = Object.create(null) as Record<string, SavedWorkflowParamDef>;
  for (const [name, param] of Object.entries(ctx.definition.params ?? {})) {
    if (!SAVED_WORKFLOW_PARAM_NAME_RE.test(name)) {
      error(
        ctx,
        'PARAM_NAME_UNSUPPORTED',
        `params.${name}`,
        `Legacy parameter name ${JSON.stringify(name)} is outside the v3 [A-Za-z_][A-Za-z0-9_]* contract.`,
        'Rename it to a safe underscore-based identifier and update every prompt marker.',
      );
    }
    if (param.format !== undefined) {
      error(
        ctx,
        'PARAM_FORMAT_UNSUPPORTED',
        `params.${name}.format`,
        `Legacy parameter format ${JSON.stringify(param.format)} has no v3 equivalent.`,
        'Remove the format after reviewing whether the value is sensitive; sensitive v3 execution remains disabled in P0.',
      );
    }
    inputs[name] = {
      type: param.type,
      ...(param.required !== undefined ? { required: param.required } : {}),
      ...(param.default !== undefined ? { default: cloneJson(param.default) } : {}),
      ...(param.description !== undefined ? { description: param.description } : {}),
    };
  }
  try {
    validateWorkflowParamSchema({ params: inputs });
  } catch (err) {
    error(
      ctx,
      'PARAM_SCHEMA_INVALID',
      'params',
      err instanceof Error ? err.message : String(err),
      'Rename invalid parameters and make every default match its declared type.',
    );
  }
  return inputs;
}

function validateDefinitionDefaults(ctx: ConversionContext): void {
  const defaults = ctx.definition.defaults;
  if (!defaults) return;
  if (defaults.retryPolicy) {
    if (defaults.retryPolicy.maxAttempts > 1) {
      error(
        ctx,
        'AUTO_RETRY_UNSUPPORTED',
        'defaults.retryPolicy',
        'v2 default automatic retry/backoff cannot be reproduced by v3.',
        'Remove it and use operator retry.',
      );
    } else {
      warning(
        ctx,
        'INERT_RETRY_POLICY_DROPPED',
        'defaults.retryPolicy',
        'retryPolicy.maxAttempts=1 cannot retry and will be dropped.',
        'Remove the inert policy or acknowledge the warning.',
      );
    }
  }
  if (defaults.maxOutputBytes !== undefined) {
    warning(
      ctx,
      'MAX_OUTPUT_BYTES_DROPPED',
      'defaults.maxOutputBytes',
      'v3 goal manifests use their own output limits.',
      'Review output size expectations and acknowledge the warning.',
    );
  }
  if (defaults.maxConcurrency !== undefined) {
    error(
      ctx,
      'MAX_CONCURRENCY_UNSUPPORTED',
      'defaults.maxConcurrency',
      'v3 Saved Workflow DAGs have no definition-level concurrency cap.',
      'Remove the field after reviewing the fan-out/resource impact.',
    );
  }
  if (defaults.timeoutMs !== undefined) {
    warning(
      ctx,
      'DEFAULT_TIMEOUT_BECOMES_EFFECTIVE',
      'defaults.timeoutMs',
      'The current v2 dispatch path does not forward definition timeoutMs, while migrated v3 goal nodes will enforce it.',
      'Review the timeout and acknowledge this behavior correction before commit.',
    );
  }
}

function validateSingleSink(definition: WorkflowDefinition, ctx: ConversionContext): void {
  const bodyNodes = new Set<string>();
  for (const node of Object.values(definition.nodes)) {
    if (node.type === 'loop') node.body.forEach((id) => bodyNodes.add(id));
  }
  const depended = new Set<string>();
  for (const [id, node] of Object.entries(definition.nodes)) {
    if (bodyNodes.has(id)) continue;
    for (const dep of node.depends ?? []) depended.add(dep);
  }
  const sinks = Object.keys(definition.nodes).filter((id) => !bodyNodes.has(id) && !depended.has(id));
  if (sinks.length !== 1) {
    error(
      ctx,
      'MULTI_SINK_UNSUPPORTED',
      'nodes',
      `Legacy graph has ${sinks.length} workflow sinks (${sinks.join(', ') || 'none'}); v3 migration requires one explicit product sink.`,
      'Add an aggregation node that depends on every terminal branch.',
    );
  }
}

function syntheticSpec(definition: WorkflowDefinition) {
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    title: definition.workflowId,
    requirement:
      `Migration of legacy workflow ${definition.workflowId} v${definition.version}. ` +
      'The DAG template is execution truth; this synthetic spec is documentation only.',
    acceptance: 'Preserve the supported legacy node goals, ordering, bot selectors, parameters, and static gates.',
    nonGoals: ['Automatically reinterpret unsupported v2 bindings, decision loops, or capability policies.'],
    nodes: Object.entries(definition.nodes).map(([id, node]) => ({
      sketchId: id,
      goal: node.type === 'subagent'
        ? (typeof node.prompt === 'string' ? node.prompt : `Legacy subagent ${id}`)
        : node.type === 'hostExecutor'
          ? `Invoke trusted host executor ${node.executor}`
          : `Legacy ${node.type} ${id} requires redesign`,
      input_needs: (node.depends ?? []).map((dep) => `Completion of legacy dependency ${dep}`),
      expected_outputs: [node.type === 'hostExecutor' ? 'Trusted executor receipt manifest' : 'Goal manifest product'],
      acceptance: node.description?.trim() || `Complete legacy node ${id} under its declared dependencies.`,
      risk_gate: ('humanGate' in node && !!node.humanGate) || node.type === 'hostExecutor',
      unknowns: [],
    })),
  };
}

export function convertLegacyWorkflowDefinition(input: {
  definition: WorkflowDefinition;
  bots: BotConfig[];
  target?: LegacyConversionTargetContext;
}): LegacyWorkflowConversionResult {
  const ctx: ConversionContext = {
    definition: input.definition,
    bots: input.bots,
    target: input.target,
    issues: [],
  };
  lintReusableLiterals(input.definition, 'definition', ctx);
  validateDefinitionDefaults(ctx);
  validateSingleSink(input.definition, ctx);
  const inputs = convertParams(ctx);
  const nodes: V3Node[] = [];
  for (const [id, node] of Object.entries(input.definition.nodes)) {
    if (node.type === 'subagent') {
      nodes.push(convertSubagent(id, node, ctx));
    } else if (node.type === 'hostExecutor') {
      nodes.push(convertHost(id, node, ctx));
    } else {
      error(
        ctx,
        'DECISION_LOOP_UNSUPPORTED',
        `nodes.${id}`,
        `Legacy ${node.type} control flow uses a human decision terminator that v3 structured loops cannot reproduce.`,
        'Redesign it as a v3 structured loop with a machine resultSchema exit and optional grants.',
      );
    }
  }

  let normalizedDagTemplate: { nodes: V3Node[] } | undefined;
  if (!hasErrors(ctx)) {
    try {
      validateDag({ runId: 'legacy-migration-check', nodes });
      normalizedDagTemplate = validateDagTemplate({ nodes });
    } catch (err) {
      error(
        ctx,
        'V3_DAG_VALIDATION_FAILED',
        'nodes',
        err instanceof Error ? err.message : String(err),
        'Apply the reported v3 DAG constraints before migrating.',
      );
    }
  }
  const specTemplate = syntheticSpec(input.definition);
  let normalizedSpecTemplate: ReturnType<typeof validateSpecTemplate> | undefined;
  if (!hasErrors(ctx)) {
    try {
      normalizedSpecTemplate = validateSpecTemplate(specTemplate);
    } catch (err) {
      error(
        ctx,
        'V3_SPEC_VALIDATION_FAILED',
        'specTemplate',
        err instanceof Error ? err.message : String(err),
        'Fix the legacy descriptions/ids that cannot form a v3 spec.',
      );
    }
  }
  if (hasErrors(ctx)) return { ok: false, issues: ctx.issues };

  const dagTemplate = normalizedDagTemplate!;
  return {
    ok: true,
    revision: {
      inputs,
      contextRefs: nodes.some((node) => node.type === 'host')
        ? ['chatId', 'larkAppId', 'chatType']
        : [],
      specTemplate: normalizedSpecTemplate!,
      specStatus: 'stale',
      dagTemplate,
      safety: {
        gateDigest: computeSavedWorkflowGateDigest(dagTemplate),
        sideEffects: computeSavedWorkflowSideEffects(dagTemplate),
      },
    },
    issues: ctx.issues,
  };
}
