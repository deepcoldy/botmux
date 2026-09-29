import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parse as parseYaml } from 'yaml';
import type { BotConfig } from '../bot-registry.js';
import { resolveEffectivePluginIds } from '../core/plugins/effective.js';
import { PluginMcpGateway } from '../core/plugins/mcp/gateway.js';
import { readGlobalConfig } from '../global-config.js';
import type { TrustedCaller } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  commandExecutorBinaryDigest,
  CommandExecutorError,
  isPluginToolCommandExecutor,
  materializeCommandExecutorOutput,
  pluginVersionAtLeast,
  resolveCommandExecutor,
  resolveCommandRenderer,
  runCommandRenderer,
  runProcessCommandExecutor,
  type CommandExecutor,
  type CommandExecutorOutputResult,
  type ExecutorArgumentSource,
  type ResolvedExecutorInput,
} from './command-executors.js';
import { getInstalledPlugin } from './plugin-registry-store.js';

export const FROZEN_COMMAND_DIR = join('.botmux', 'commands');

export interface NaturalLanguageFrozenCommandInvocation {
  cmd: string;
  commandContent: string;
}

/**
 * Parse only an exact, single-line user instruction to run an installed
 * frozen command. Keeping this grammar deliberately narrow lets the host
 * bypass the model without mistaking numbered examples, pasted checklists, or
 * prose that merely mentions `/command` for an execution request.
 */
export function parseNaturalLanguageFrozenCommandInvocation(
  content: string,
): NaturalLanguageFrozenCommandInvocation | undefined {
  const trimmed = content.trim();
  if (!trimmed || /\r|\n/u.test(trimmed)) return undefined;
  const match = /^(?:运行|执行|run)\s+(\/[\p{L}\p{N}_-]+)(?![\p{L}\p{N}_\/-])(?:\s+([\s\S]+?))?[。！!]?$/iu.exec(trimmed);
  if (!match) return undefined;
  const cmd = match[1]!.toLowerCase();
  const rawArgs = (match[2] ?? '').trim();
  return {
    cmd,
    commandContent: rawArgs ? `${cmd} ${rawArgs}` : cmd,
  };
}

/**
 * Parse the exact prompt shape accepted by a scheduled Frozen Command.
 *
 * New tasks persist the canonical `/command args` form. The optional leading
 * punctuation + run verb exists only to consume tasks created from the older
 * documented `/schedule <rule>，执行 /command` wording. Keep this parser
 * deliberately narrower than prose: scheduled prompts that discuss a command
 * must continue through the normal model path instead of being executed.
 */
export function parseScheduledFrozenCommandInvocation(
  content: string,
): NaturalLanguageFrozenCommandInvocation | undefined {
  const trimmed = content.trim();
  if (!trimmed || /\r|\n/u.test(trimmed)) return undefined;
  const direct = /^(\/[\p{L}\p{N}_-]+)(?![\p{L}\p{N}_\/-])(?:\s+([\s\S]+?))?$/u.exec(trimmed);
  if (direct) {
    const cmd = direct[1]!.toLowerCase();
    const rawArgs = (direct[2] ?? '').trim();
    return { cmd, commandContent: rawArgs ? `${cmd} ${rawArgs}` : cmd };
  }
  const compatibility = trimmed.replace(/^[,，、:：]\s*/u, '');
  if (/(?:[\s,，]+(?:然后|并且|再)|[\s,，]+and\s+then\b)/iu.test(compatibility)) return undefined;
  return parseNaturalLanguageFrozenCommandInvocation(compatibility);
}

const COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const INPUT_PLACEHOLDER_RE = /^\{\{\s*((?:caller\.(?:open_id|union_id|name)|chat\.(?:id|type)|message\.id|today|now)|[A-Za-z][A-Za-z0-9_]*)\s*\}\}$/;
const EMBEDDED_PARAMETER_PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const EMBEDDED_CALLER_PLACEHOLDER_RE = /\{\{\s*caller\.(?:open_id|union_id|name)\s*\}\}/;
const OUTPUT_VARIABLE_RE = /\{\{\s*([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*\}\}/gu;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DATE_RE = /^today(?:([+-])(\d{1,4}))?$/;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const PROCESS_EXECUTION_FAILURE_CODES = new Set([
  'executor_timeout',
  'executor_spawn_failed',
  'executor_non_zero_exit',
  'executor_output_limit',
  'executor_output_encoding',
  'executor_output_json',
  'executor_output_invalid',
  'executor_output_too_deep',
  'executor_output_field_missing',
  'executor_output_projection_conflict',
  'executor_output_container_invalid',
]);
const PLUGIN_TOOL_ERROR_POLICY = {
  invalid_request: {
    code: 'plugin_tool_invalid_request',
    message: '插件工具请求不合法。',
    transient: false,
  },
  permission_denied: {
    code: 'plugin_tool_permission_denied',
    message: '当前用户无权执行该插件工具。',
    transient: false,
  },
  not_found: {
    code: 'plugin_tool_not_found',
    message: '插件工具未找到请求的资源。',
    transient: false,
  },
  rate_limited: {
    code: 'plugin_tool_rate_limited',
    message: '插件工具请求过于频繁，请稍后重试。',
    transient: true,
  },
  timeout: {
    code: 'plugin_tool_timeout',
    message: '插件工具执行超时，请稍后重试。',
    transient: true,
  },
  temporarily_unavailable: {
    code: 'plugin_tool_temporarily_unavailable',
    message: '插件工具暂时不可用，请稍后重试。',
    transient: true,
  },
  execution_failed: {
    code: 'plugin_tool_execution_failed',
    message: '插件工具执行失败。',
    transient: false,
  },
} as const;
const SAFE_PLUGIN_TOOL_ERROR_CODES = new Set<string>(
  Object.values(PLUGIN_TOOL_ERROR_POLICY).map(policy => policy.code),
);
const RAW_HTML_TAG_RE = /<\s*\/?\s*(?:a|abbr|address|area|article|aside|at|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)\b(?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/iu;

export function isProcessExecutionFailureCode(code: string): boolean {
  return PROCESS_EXECUTION_FAILURE_CODES.has(code);
}

export class FrozenCommandError extends Error {
  override readonly name = 'FrozenCommandError';

  constructor(
    readonly code: string,
    message: string,
    readonly usage?: string,
    readonly executionFailure = false,
    readonly transient = false,
    readonly executionId?: string,
  ) {
    super(message);
  }
}

interface IntegerParameter {
  name: string;
  label?: string;
  type: 'integer';
  min: number;
  max: number;
  default?: number;
}

interface EnumParameter {
  name: string;
  label?: string;
  type: 'enum';
  values: Array<string | number>;
  default?: string | number;
}

interface DateParameter {
  name: string;
  label?: string;
  type: 'date';
  min?: string;
  max?: string;
  default?: string;
}

interface StringParameter {
  name: string;
  label?: string;
  type: 'string';
  pattern?: string;
  maxLength: number;
  default?: string;
}

export type FrozenCommandParameter = IntegerParameter | EnumParameter | DateParameter | StringParameter;

export type FrozenCommandOutputFormat = 'text' | 'markdown';
type FrozenCommandOutputHandoff = {
  prompt: string;
  data?: string;
  maxRows: number;
};
type FrozenCommandOutputShow = {
  kind: 'result' | 'text';
  text?: string;
};

export type FrozenCommandOutputRule = {
  when?: string;
  handoff: FrozenCommandOutputHandoff;
  show?: never;
} | {
  when?: string;
  handoff?: never;
  show: FrozenCommandOutputShow;
};

export interface FrozenCommandDefinition {
  schemaVersion: 2;
  status: 'active';
  name: string;
  description: string;
  timezone: string;
  steps: Array<{
    id: string;
    executor: string;
    input: Record<string, string | number | boolean>;
    renderer: string;
    required: boolean;
  }>;
  params: FrozenCommandParameter[];
  output: {
    format: FrozenCommandOutputFormat;
    rules: FrozenCommandOutputRule[];
  };
}

export type FrozenCommandOutputScalar = string | number | boolean | null;

export type FrozenCommandOutputBlock =
  | { type: 'markdown'; markdown: string }
  | {
      type: 'table';
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, FrozenCommandOutputScalar>>;
      totalRows: number;
      truncated: boolean;
    };

/** Channel-neutral output kept by the frozen-command executor. Feishu renders
 * it as a card today; a future Web surface can consume the same blocks without
 * treating Feishu JSON or arbitrary HTML as the source of truth. */
export interface FrozenCommandPresentation {
  schemaVersion: 1;
  /** Effective command format after a matching `show` rule override. The IM
   * transport uses this hint to choose a plain text message only for `text`;
   * blocks stay channel-neutral markdown/table in every format. */
  format: FrozenCommandOutputFormat;
  fallbackText: string;
  blocks: FrozenCommandOutputBlock[];
}

export interface FrozenCommandSnapshot {
  filePath: string;
  realpath: string;
  raw: string;
  definition: FrozenCommandDefinition;
}

export interface FrozenCommandExecutionResult {
  referenceDate: string;
  text: string;
  presentation: FrozenCommandPresentation;
  truncated: boolean;
  executorId: string;
  executorRevision?: string;
  executionId?: string;
  projectedResult?: Record<string, unknown>;
  businessResult?: {
    rows: Array<Record<string, string | number | boolean | bigint | null | undefined>>;
    totalRows: number;
    columns?: Array<{ key: string; label: string }>;
  };
}

function singleFrozenCommandStep(definition: FrozenCommandDefinition): FrozenCommandDefinition['steps'][number] {
  return definition.steps[0]!;
}

export type FrozenCommandResolvedOutput =
  | { kind: 'deliver'; text: string; presentation: FrozenCommandPresentation }
  | { kind: 'handoff'; prompt: string };

export interface FrozenCommandNormalizedArgument {
  name: string;
  label: string;
  value: string;
}

export interface FrozenCommandExecutionContext {
  caller?: {
    open_id?: string;
    union_id?: string;
    name?: string;
  };
  chat?: {
    id?: string;
    type?: string;
  };
  message?: {
    id?: string;
  };
}

export interface FrozenCommandExecutionAuditContext {
  source: 'direct' | 'confirmed' | 'schedule';
  specHash?: string;
  stateRevisionId?: string;
  taskId?: string;
}

export type FrozenCommandLookup =
  | { kind: 'missing'; command: string }
  | { kind: 'invalid'; command: string; error: FrozenCommandError }
  | { kind: 'found'; snapshot: FrozenCommandSnapshot };

export function frozenCommandExecutorRevision(definition: FrozenCommandDefinition): string {
  try {
    const step = singleFrozenCommandStep(definition);
    const executor = resolveCommandExecutor(step.executor);
    assertFrozenCommandExecutorContract(definition, executor);
    const renderer = resolveCommandRenderer(step.renderer);
    const rendererRevision = typeof renderer === 'string' ? renderer : renderer.revision;
    return createHash('sha256')
      .update(JSON.stringify([{ id: step.id, executor: executor.revision, renderer: rendererRevision }]))
      .digest('hex');
  } catch (error) {
    if (error instanceof CommandExecutorError) throw new FrozenCommandError(error.code, error.message);
    throw error;
  }
}

function executorContractError(message: string): never {
  throw new FrozenCommandError('definition_executor_contract', `命令定义与执行器参数契约不兼容：${message}`);
}

function assertLiteralExecutorValue(
  name: string,
  value: string | number | boolean,
  schema: import('./command-executors.js').CommandExecutorArgument,
): void {
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || (value as number) < schema.min! || (value as number) > schema.max!) {
      executorContractError(`input.${name} 必须是 ${schema.min}-${schema.max} 的整数`);
    }
    return;
  }
  if (schema.type === 'enum') {
    if (!schema.values!.some(candidate => candidate === value)) {
      executorContractError(`input.${name} 不在执行器允许枚举中`);
    }
    return;
  }
  if (typeof value !== 'string') executorContractError(`input.${name} 必须是字符串`);
  if (value.length > schema.maxLength! || value.includes('\0')) {
    executorContractError(`input.${name} 超过执行器长度上限 ${schema.maxLength}`);
  }
  if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
    executorContractError(`input.${name} 不符合执行器格式约束`);
  }
}

function assertParameterExecutorContract(
  inputName: string,
  parameter: FrozenCommandParameter,
  schema: import('./command-executors.js').CommandExecutorArgument,
): void {
  if (parameter.type === 'integer') {
    if (schema.type !== 'integer') executorContractError(`input.${inputName} 的参数类型应为 integer`);
    if (parameter.min < schema.min! || parameter.max > schema.max!) {
      executorContractError(`input.${inputName} 的范围 ${parameter.min}-${parameter.max} 超出执行器 ${schema.min}-${schema.max}`);
    }
    return;
  }
  if (parameter.type === 'enum') {
    if (schema.type !== 'enum') executorContractError(`input.${inputName} 的参数类型应为 enum`);
    const unsupported = parameter.values.filter(value => !schema.values!.some(candidate => candidate === value));
    if (unsupported.length > 0) executorContractError(`input.${inputName} 含执行器不接受的枚举值`);
    return;
  }
  if (schema.type !== 'string') executorContractError(`input.${inputName} 的参数类型应为 string`);
  const maxLength = parameter.type === 'date' ? 10 : parameter.maxLength;
  if (maxLength > schema.maxLength!) {
    executorContractError(`input.${inputName} 的长度上限 ${maxLength} 超出执行器 ${schema.maxLength}`);
  }
  if (schema.pattern) {
    if (parameter.type === 'date') {
      const pattern = new RegExp(schema.pattern, 'u');
      if (!pattern.test('2000-01-01') || !pattern.test('2099-12-31')) {
        executorContractError(`input.${inputName} 的 date 范围不满足执行器格式约束`);
      }
    } else if (parameter.pattern !== schema.pattern) {
      executorContractError(`input.${inputName} 的 pattern 必须与执行器一致`);
    }
  }
}

/** Validate every possible command input before an approval/restore can be staged. */
export function assertFrozenCommandExecutorContract(
  definition: FrozenCommandDefinition,
  executor: CommandExecutor = resolveCommandExecutor(singleFrozenCommandStep(definition).executor),
): void {
  const step = singleFrozenCommandStep(definition);
  const renderer = resolveCommandRenderer(step.renderer);
  if (executor.output.content && step.renderer !== 'builtin.content') {
    executorContractError(`带 content 的执行器 ${executor.id} 只能使用 builtin.content`);
  }
  if (!executor.output.content && step.renderer === 'builtin.content') {
    executorContractError(`数据执行器 ${executor.id} 不能使用 builtin.content`);
  }
  if (executor.output.content && typeof renderer !== 'string') {
    executorContractError(`带 content 的执行器 ${executor.id} 不能使用脚本渲染器`);
  }
  if (definition.output.rules.some(rule => rule.handoff) && !executor.policy.allowHandoff) {
    executorContractError(`执行器 ${executor.id} 不允许把结果或失败交给模型`);
  }
  const configured = new Set(Object.keys(step.input));
  const unknown = [...configured].filter(name => !Object.hasOwn(executor.arguments, name));
  if (unknown.length > 0) executorContractError(`执行器不接受 input：${unknown.join(', ')}`);
  for (const [name, schema] of Object.entries(executor.arguments)) {
    if (!configured.has(name)) {
      if (schema.required && schema.default === undefined) executorContractError(`缺少 required input：${name}`);
      continue;
    }
    const value = step.input[name]!;
    if (isPluginToolCommandExecutor(executor)
      && typeof value === 'string'
      && EMBEDDED_CALLER_PLACEHOLDER_RE.test(value)) {
      executorContractError(`input.${name} 不得声明 caller 身份；插件身份只能由可信 _meta 注入`);
    }
    const placeholder = typeof value === 'string' ? INPUT_PLACEHOLDER_RE.exec(value) : null;
    if (!placeholder) {
      if (!schema.accepts.includes('literal')) executorContractError(`input.${name} 不接受 literal 来源`);
      assertLiteralExecutorValue(name, value, schema);
      continue;
    }
    const sourceName = placeholder[1]!;
    if (sourceName.includes('.') || sourceName === 'today' || sourceName === 'now') {
      const source = `context:${sourceName}` as ExecutorArgumentSource;
      if (!schema.accepts.includes(source)) executorContractError(`input.${name} 不接受 ${source} 来源`);
      if (schema.type !== 'string') executorContractError(`input.${name} 的上下文值必须由 string 参数接收`);
      continue;
    }
    if (!schema.accepts.includes('param')) executorContractError(`input.${name} 不接受 param 来源`);
    const parameter = definition.params.find(item => item.name === sourceName);
    if (!parameter) executorContractError(`input.${name} 引用了未声明参数 ${sourceName}`);
    assertParameterExecutorContract(name, parameter, schema);
  }
}

export function assertFrozenCommandSchedulable(definition: FrozenCommandDefinition): void {
  try {
    const executor = resolveCommandExecutor(singleFrozenCommandStep(definition).executor);
    assertFrozenCommandExecutorContract(definition, executor);
    if (!executor.policy.schedulable) {
      throw new FrozenCommandError('executor_schedule_denied', `执行器 ${executor.id} 不允许用于定时任务`);
    }
  } catch (error) {
    if (error instanceof FrozenCommandError) throw error;
    if (error instanceof CommandExecutorError) throw new FrozenCommandError(error.code, error.message);
    throw error;
  }
}

/** Third-party executable content is deliberately not part of the blocking
 * executor revision. This digest is an approval-time baseline for drift alerts
 * under isolation scheme B; scripts remain covered by the blocking artifact
 * digests inside executorRevision. */
export function frozenCommandExecutorBinaryDigest(definition: FrozenCommandDefinition): string | undefined {
  try {
    const executor = resolveCommandExecutor(singleFrozenCommandStep(definition).executor);
    return isPluginToolCommandExecutor(executor) ? undefined : commandExecutorBinaryDigest(executor);
  } catch (error) {
    if (error instanceof CommandExecutorError) {
      throw new FrozenCommandError(error.code, error.message);
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !accepted.has(key));
  if (unknown.length > 0) {
    throw new FrozenCommandError('definition_unknown_field', `${context} 包含未知字段：${unknown.join(', ')}`);
  }
}

function nonBlank(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FrozenCommandError('definition_invalid_field', `${field} 必须是非空字符串`);
  }
  if (value.length > max) {
    throw new FrozenCommandError('definition_field_too_long', `${field} 超过长度上限 ${max}`);
  }
  return value;
}

export function normalizeFrozenCommandName(raw: string): string | undefined {
  const normalized = raw.replace(/^\//, '').normalize('NFKC').toLocaleLowerCase('und');
  return COMMAND_NAME_RE.test(normalized) ? normalized : undefined;
}

export function frozenCommandFilePath(workingDir: string, rawCommand: string): string {
  const command = normalizeFrozenCommandName(rawCommand);
  if (!command) throw new FrozenCommandError('invalid_command_name', `非法指令名：${rawCommand}`);
  return join(resolve(workingDir), FROZEN_COMMAND_DIR, `${command}.yaml`);
}

/**
 * Read only the declaration status from a command file without treating a
 * tombstone as an executable definition. This is intentionally metadata-only:
 * lifecycle authority still comes exclusively from the bot-scoped ledger.
 */
export function readFrozenCommandFileStatus(input: {
  workingDir: string;
  command: string;
}): string | undefined {
  const command = normalizeFrozenCommandName(input.command);
  if (!command) return undefined;
  const filePath = frozenCommandFilePath(input.workingDir, command);
  if (!existsSync(filePath)) return undefined;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024) return undefined;
  try {
    const realpath = assertCommandPathContained(input.workingDir, filePath);
    const value = parseYaml(readFileSync(realpath, 'utf8'), {
      strict: true,
      uniqueKeys: true,
      maxAliasCount: 0,
    });
    return isPlainObject(value) && typeof value.status === 'string'
      ? value.status
      : undefined;
  } catch {
    return undefined;
  }
}

function assertCommandPathContained(workingDir: string, filePath: string): string {
  const root = realpathSync(resolve(workingDir));
  const actual = realpathSync(filePath);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new FrozenCommandError('definition_file_invalid', '指令定义越出当前工作目录');
  }
  return actual;
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseParameter(value: unknown, index: number): FrozenCommandParameter {
  if (!isPlainObject(value)) {
    throw new FrozenCommandError('definition_invalid_parameter', `params[${index}] 必须是对象`);
  }
  onlyKeys(value, ['name', 'label', 'type', 'default', 'min', 'max', 'values', 'pattern', 'maxLength'], `params[${index}]`);
  const name = nonBlank(value.name, `params[${index}].name`, 64).trim();
  if (!PARAM_NAME_RE.test(name)) {
    throw new FrozenCommandError('definition_invalid_parameter', `非法参数名：${name}`);
  }
  const label = typeof value.label === 'string' && value.label.trim()
    ? value.label.trim().slice(0, 100)
    : undefined;
  if (value.type === 'integer') {
    if (!Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max) || (value.min as number) > (value.max as number)) {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: integer 必须声明有效 min/max`);
    }
    if (value.default !== undefined && (!Number.isSafeInteger(value.default)
      || (value.default as number) < (value.min as number)
      || (value.default as number) > (value.max as number))) {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: default 超出 min/max`);
    }
    return {
      name,
      ...(label ? { label } : {}),
      type: 'integer',
      min: value.min as number,
      max: value.max as number,
      ...(value.default === undefined ? {} : { default: value.default as number }),
    };
  }
  if (value.type === 'enum') {
    if (!Array.isArray(value.values) || value.values.length === 0 || value.values.length > 100) {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: enum values 必须有 1-100 项`);
    }
    const values = value.values.map((candidate) => {
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256 && !candidate.includes('\0')) return candidate;
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: enum 候选值不合法`);
    });
    const defaultValue = value.default;
    if (defaultValue !== undefined && !values.some(candidate => candidate === defaultValue)) {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: default 不在 values 中`);
    }
    return {
      name,
      ...(label ? { label } : {}),
      type: 'enum',
      values,
      ...(defaultValue === undefined ? {} : { default: defaultValue as string | number }),
    };
  }
  if (value.type === 'date') {
    for (const field of ['min', 'max', 'default'] as const) {
      const candidate = value[field];
      if (candidate !== undefined && (typeof candidate !== 'string' || (!ISO_DATE_RE.test(candidate) && !RELATIVE_DATE_RE.test(candidate)))) {
        throw new FrozenCommandError('definition_invalid_parameter', `${name}.${field} 必须是 YYYY-MM-DD 或 today±N`);
      }
    }
    return {
      name,
      ...(label ? { label } : {}),
      type: 'date',
      ...(value.min === undefined ? {} : { min: value.min as string }),
      ...(value.max === undefined ? {} : { max: value.max as string }),
      ...(value.default === undefined ? {} : { default: value.default as string }),
    };
  }
  if (value.type === 'string') {
    const maxLength = value.maxLength === undefined ? 1_000 : value.maxLength;
    if (!Number.isSafeInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > 10_000) {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: maxLength 必须在 1-10000 之间`);
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== 'string' || value.pattern.length > 2_000) {
        throw new FrozenCommandError('definition_invalid_parameter', `${name}: pattern 不合法`);
      }
      try { new RegExp(value.pattern, 'u'); } catch {
        throw new FrozenCommandError('definition_invalid_parameter', `${name}: pattern 不是有效正则`);
      }
    }
    if (value.default !== undefined && typeof value.default !== 'string') {
      throw new FrozenCommandError('definition_invalid_parameter', `${name}: default 必须是字符串`);
    }
    return {
      name,
      ...(label ? { label } : {}),
      type: 'string',
      maxLength: maxLength as number,
      ...(value.pattern === undefined ? {} : { pattern: value.pattern as string }),
      ...(value.default === undefined ? {} : { default: value.default as string }),
    };
  }
  throw new FrozenCommandError('definition_invalid_parameter', `${name}: 不支持参数类型 ${String(value.type)}`);
}

function parseDefinition(raw: string, command: string): FrozenCommandDefinition {
  let value: unknown;
  try {
    value = parseYaml(raw, { strict: true, uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new FrozenCommandError('definition_yaml_invalid', `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value)) throw new FrozenCommandError('definition_invalid', '指令定义必须是对象');
  onlyKeys(value, [
    'schemaVersion', 'status', 'name', 'description', 'timezone', 'steps', 'params',
    'output', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  ], 'definition');
  if (value.schemaVersion !== 2) {
    throw new FrozenCommandError(
      'definition_version_unsupported',
      `仅支持 schemaVersion=2；当前为 ${String(value.schemaVersion ?? '未声明')}，请先迁移旧命令`,
    );
  }
  if (value.status !== undefined && value.status !== 'active') {
    throw new FrozenCommandError('definition_inactive', `命令定义状态不是 active：${String(value.status)}`);
  }
  const name = normalizeFrozenCommandName(nonBlank(value.name, 'name', 64));
  if (!name || name !== command) {
    throw new FrozenCommandError('definition_name_mismatch', '定义 name 与文件名不一致');
  }
  const description = nonBlank(value.description, 'description', 1_000).trim();
  const timezone = typeof value.timezone === 'string' && value.timezone.trim()
    ? value.timezone.trim()
    : DEFAULT_TIMEZONE;
  if (!isTimezone(timezone)) throw new FrozenCommandError('definition_invalid_timezone', `非法时区：${timezone}`);
  if (!Array.isArray(value.steps) || value.steps.length !== 1) {
    throw new FrozenCommandError('definition_invalid_steps', '第一批仅支持 steps 恰好包含 1 步');
  }
  const steps = value.steps.map((candidate, index) => {
    if (!isPlainObject(candidate)) throw new FrozenCommandError('definition_invalid_steps', `steps[${index}] 必须是对象`);
    onlyKeys(candidate, ['id', 'executor', 'input', 'renderer', 'required'], `steps[${index}]`);
    const id = nonBlank(candidate.id, `steps[${index}].id`, 64).trim();
    if (!PARAM_NAME_RE.test(id)) throw new FrozenCommandError('definition_invalid_steps', `steps[${index}].id 格式不合法`);
    const executor = nonBlank(candidate.executor, `steps[${index}].executor`, 128).trim();
    const renderer = nonBlank(candidate.renderer, `steps[${index}].renderer`, 128).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executor)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(renderer)) {
      throw new FrozenCommandError('definition_invalid_steps', `steps[${index}] 的 executor 或 renderer id 不合法`);
    }
    if (!isPlainObject(candidate.input)) throw new FrozenCommandError('definition_invalid_input', `steps[${index}].input 必须是对象`);
    if (Object.keys(candidate.input).length > 32) {
      throw new FrozenCommandError('definition_invalid_input', `steps[${index}].input 最多 32 个字段`);
    }
    const stepInput = Object.fromEntries(Object.entries(candidate.input).map(([key, inputValue]) => {
      if (!PARAM_NAME_RE.test(key)) throw new FrozenCommandError('definition_invalid_input', `非法 input 字段：${key}`);
      if (!['string', 'number', 'boolean'].includes(typeof inputValue)
        || (typeof inputValue === 'string' && inputValue.includes('\0'))) {
        throw new FrozenCommandError('definition_invalid_input', `input.${key} 只能是字符串、数值或布尔值`);
      }
      return [key, inputValue as string | number | boolean];
    }));
    if (candidate.required !== undefined && typeof candidate.required !== 'boolean') {
      throw new FrozenCommandError('definition_invalid_steps', `steps[${index}].required 必须是布尔值`);
    }
    return { id, executor, input: stepInput, renderer, required: candidate.required === true };
  });
  const paramsRaw = value.params ?? [];
  if (!Array.isArray(paramsRaw) || paramsRaw.length > 32) {
    throw new FrozenCommandError('definition_invalid_parameters', 'params 必须是最多 32 项的数组');
  }
  const params = paramsRaw.map(parseParameter);
  if (new Set(params.map(param => param.name)).size !== params.length) {
    throw new FrozenCommandError('definition_duplicate_parameter', '参数名不能重复');
  }
  const declared = new Set(params.map(param => param.name));
  const referencedParams: string[] = [];
  for (const [key, candidate] of Object.entries(steps[0]!.input)) {
    if (typeof candidate !== 'string' || !candidate.includes('{{')) continue;
    const match = INPUT_PLACEHOLDER_RE.exec(candidate);
    if (match) {
      const placeholder = match[1]!;
      if (!placeholder.includes('.') && placeholder !== 'today' && placeholder !== 'now') {
        referencedParams.push(placeholder);
      }
      continue;
    }
    const embedded = [...candidate.matchAll(EMBEDDED_PARAMETER_PLACEHOLDER_RE)].map(item => item[1]!);
    const residue = candidate.replace(EMBEDDED_PARAMETER_PLACEHOLDER_RE, '');
    if (embedded.length === 0 || residue.includes('{{') || residue.includes('}}')) {
      throw new FrozenCommandError('definition_invalid_placeholder', `input.${key} 包含无法识别的模板变量`);
    }
    referencedParams.push(...embedded);
  }
  const unknown = [...new Set(referencedParams.filter(name => !declared.has(name)))];
  if (unknown.length > 0) throw new FrozenCommandError('definition_unknown_placeholder', `input 使用了未声明参数：${unknown.join(', ')}`);
  const unused = params.filter(param => !referencedParams.includes(param.name));
  if (unused.length > 0) throw new FrozenCommandError('definition_unused_parameter', `参数未在 input 中使用：${unused.map(item => item.name).join(', ')}`);
  const stepIds = new Set(steps.map(step => step.id));
  const validateRuleNamespaces = (template: string, field: string): void => {
    for (const match of template.matchAll(OUTPUT_VARIABLE_RE)) {
      const path = match[1]!;
      const parts = path.split('.');
      const valid = (parts[0] === 'q' && parts.length >= 3 && stepIds.has(parts[1]!))
        || (parts[0] === 'run' && path === 'run.status')
        || (parts[0] === 'run' && parts.length >= 3 && stepIds.has(parts[1]!))
        || (parts[0] === 'cmd' && parts.length >= 2);
      if (!valid) {
        throw new FrozenCommandError('definition_invalid_output', `${field} 使用了非法变量命名空间：${path}`);
      }
    }
  };
  let output: FrozenCommandDefinition['output'] = { format: 'markdown', rules: [] };
  if (value.output !== undefined) {
    if (!isPlainObject(value.output)) throw new FrozenCommandError('definition_invalid_output', 'output 必须是对象');
    onlyKeys(value.output, ['format', 'rules'], 'output');
    const format = value.output.format ?? 'markdown';
    if (format !== 'text' && format !== 'markdown') {
      throw new FrozenCommandError(
        'definition_invalid_output',
        'output.format 只能是 text 或 markdown',
      );
    }
    const parseHandoff = (candidate: unknown, field: string): FrozenCommandOutputHandoff => {
      if (!isPlainObject(candidate)) {
        throw new FrozenCommandError('definition_invalid_output', `${field} 必须是对象`);
      }
      onlyKeys(candidate, ['prompt', 'data', 'maxRows'], field);
      const prompt = nonBlank(candidate.prompt, `${field}.prompt`, 10_000);
      const data = candidate.data === undefined
        ? undefined
        : nonBlank(candidate.data, `${field}.data`, 10_000);
      const maxRows = candidate.maxRows ?? 50;
      if (!Number.isInteger(maxRows) || (maxRows as number) < 1 || (maxRows as number) > 1_000) {
        throw new FrozenCommandError('definition_invalid_output', `${field}.maxRows 必须在 1-1000 之间`);
      }
      validateRuleNamespaces(prompt, `${field}.prompt`);
      if (data !== undefined) validateRuleNamespaces(data, `${field}.data`);
      return { prompt, ...(data === undefined ? {} : { data }), maxRows: maxRows as number };
    };
    const parseShow = (candidate: unknown, field: string): FrozenCommandOutputShow => {
      if (candidate === 'result') return { kind: 'result' };
      if (!isPlainObject(candidate)) {
        throw new FrozenCommandError('definition_invalid_output', `${field} 必须是 result 或对象`);
      }
      onlyKeys(candidate, ['text'], field);
      const text = candidate.text === undefined ? undefined : nonBlank(candidate.text, `${field}.text`, 10_000);
      if (text === undefined) throw new FrozenCommandError('definition_invalid_output', `${field} 必须声明 text`);
      validateRuleNamespaces(text, `${field}.text`);
      return {
        kind: 'text',
        text,
      };
    };
    const rules: FrozenCommandOutputRule[] = [];
    if (value.output.rules !== undefined) {
      if (!Array.isArray(value.output.rules) || value.output.rules.length > 20) {
        throw new FrozenCommandError('definition_invalid_output', 'output.rules 必须是最多 20 项的数组');
      }
      for (const [index, candidate] of value.output.rules.entries()) {
        if (!isPlainObject(candidate)) throw new FrozenCommandError('definition_invalid_output', `output.rules[${index}] 必须是对象`);
        onlyKeys(candidate, ['when', 'handoff', 'show'], `output.rules[${index}]`);
        const hasHandoff = candidate.handoff !== undefined;
        const hasShow = candidate.show !== undefined;
        if (hasHandoff === hasShow) {
          throw new FrozenCommandError('definition_invalid_output', `output.rules[${index}] 必须且只能声明 handoff 或 show`);
        }
        const when = candidate.when === undefined
          ? undefined
          : nonBlank(candidate.when, `output.rules[${index}].when`, 1_000).trim();
        if (when !== undefined) validateRuleNamespaces(when, `output.rules[${index}].when`);
        rules.push(hasHandoff
          ? {
              ...(when === undefined ? {} : { when }),
              handoff: parseHandoff(candidate.handoff, `output.rules[${index}].handoff`),
            }
          : {
              ...(when === undefined ? {} : { when }),
              show: parseShow(candidate.show, `output.rules[${index}].show`),
            });
      }
    }
    output = { format, rules };
  }
  return {
    schemaVersion: 2,
    status: 'active',
    name,
    description,
    timezone,
    steps,
    params,
    output,
  };
}

export function loadFrozenCommandSnapshot(input: { workingDir: string; command: string }): FrozenCommandSnapshot | undefined {
  const command = normalizeFrozenCommandName(input.command);
  if (!command) return undefined;
  const filePath = frozenCommandFilePath(input.workingDir, command);
  if (!existsSync(filePath)) return undefined;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new FrozenCommandError('definition_file_invalid', '指令定义禁止使用符号链接');
  }
  if (!stat.isFile() || stat.size > 512 * 1024) {
    throw new FrozenCommandError('definition_file_invalid', '指令定义必须是小于 512 KiB 的普通文件');
  }
  const realpath = assertCommandPathContained(input.workingDir, filePath);
  const raw = readFileSync(realpath, 'utf8');
  return { filePath, realpath, raw, definition: parseDefinition(raw, command) };
}

/** Parse a not-yet-installed definition for the host-owned lifecycle flow.
 *
 * The candidate is deliberately validated without writing it to the live
 * command directory. This lets create/update present one authoritative card
 * and keeps the currently approved command usable until the human confirms.
 */
export function parseFrozenCommandCandidate(input: {
  workingDir: string;
  command: string;
  raw: string;
}): FrozenCommandSnapshot {
  const command = normalizeFrozenCommandName(input.command);
  if (!command) throw new FrozenCommandError('invalid_command_name', `非法指令名：${input.command}`);
  if (Buffer.byteLength(input.raw, 'utf8') > 512 * 1024) {
    throw new FrozenCommandError('definition_file_invalid', '指令定义必须小于 512 KiB');
  }
  const filePath = frozenCommandFilePath(input.workingDir, command);
  return {
    filePath,
    realpath: resolve(filePath),
    raw: input.raw,
    definition: parseDefinition(input.raw, command),
  };
}

export function lookupFrozenCommand(input: { workingDir: string; command: string }): FrozenCommandLookup {
  const command = normalizeFrozenCommandName(input.command) ?? input.command.replace(/^\//, '');
  if (!normalizeFrozenCommandName(command)) return { kind: 'missing', command };
  try {
    const snapshot = loadFrozenCommandSnapshot({ workingDir: input.workingDir, command });
    return snapshot ? { kind: 'found', snapshot } : { kind: 'missing', command };
  } catch (error) {
    return {
      kind: 'invalid',
      command,
      error: error instanceof FrozenCommandError
        ? error
        : new FrozenCommandError('definition_invalid', error instanceof Error ? error.message : String(error)),
    };
  }
}

export function listFrozenCommandSnapshots(workingDir: string): Array<{ command: string; snapshot?: FrozenCommandSnapshot; error?: FrozenCommandError }> {
  const dir = join(resolve(workingDir), FROZEN_COMMAND_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
    .map(entry => basename(entry.name, '.yaml'))
    .map(command => normalizeFrozenCommandName(command))
    .filter((command): command is string => !!command)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .map((command) => {
      try {
        return { command, snapshot: loadFrozenCommandSnapshot({ workingDir, command }) };
      } catch (error) {
        return {
          command,
          error: error instanceof FrozenCommandError
            ? error
            : new FrozenCommandError('definition_invalid', error instanceof Error ? error.message : String(error)),
        };
      }
    });
}

export function frozenCommandUsage(definition: FrozenCommandDefinition): string {
  const args = definition.params.map(param => param.default === undefined
    ? `<${param.label ?? param.name}>`
    : `[${param.label ?? param.name}]`);
  return `/${definition.name}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
}

function referenceDateFor(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const mapped = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${mapped.year}-${mapped.month}-${mapped.day}`;
}

function epochDay(value: string): number {
  if (!ISO_DATE_RE.test(value)) throw new FrozenCommandError('parameter_invalid_date', `日期格式错误：${value}`);
  const [year, month, day] = value.split('-').map(Number);
  const millis = Date.UTC(year!, month! - 1, day!);
  const parsed = new Date(millis);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new FrozenCommandError('parameter_invalid_date', `不存在的日期：${value}`);
  }
  return Math.floor(millis / 86_400_000);
}

function resolveDate(value: string, referenceDate: string): string {
  if (ISO_DATE_RE.test(value)) {
    epochDay(value);
    return value;
  }
  const match = RELATIVE_DATE_RE.exec(value);
  if (!match) throw new FrozenCommandError('parameter_invalid_date', `日期格式错误：${value}`);
  const offset = match[2] ? Number(match[2]) * (match[1] === '-' ? -1 : 1) : 0;
  return new Date((epochDay(referenceDate) + offset) * 86_400_000).toISOString().slice(0, 10);
}

function tokenizeArguments(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (escaped || quote) throw new FrozenCommandError('parameter_invalid_syntax', '参数引号或转义不完整');
  if (current) result.push(current);
  return result;
}

function resolveParameter(
  parameter: FrozenCommandParameter,
  supplied: string | undefined,
  referenceDate: string,
): { display: string; value: string | number } {
  const value = supplied ?? parameter.default;
  if (value === undefined) throw new FrozenCommandError('parameter_required', `缺少参数：${parameter.label ?? parameter.name}`);
  if (parameter.type === 'integer') {
    const text = String(value);
    if (!/^-?(?:0|[1-9]\d*)$/.test(text) || text.length > 20) {
      throw new FrozenCommandError('parameter_invalid_integer', `${parameter.label ?? parameter.name} 必须是整数`);
    }
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < parameter.min || parsed > parameter.max) {
      throw new FrozenCommandError('parameter_integer_out_of_range', `${parameter.label ?? parameter.name} 必须在 ${parameter.min}～${parameter.max} 之间`);
    }
    return { display: String(parsed), value: parsed };
  }
  if (parameter.type === 'enum') {
    const matched = parameter.values.find(candidate => String(candidate) === String(value));
    if (matched === undefined) {
      throw new FrozenCommandError('parameter_invalid_enum', `${parameter.label ?? parameter.name} 只能是：${parameter.values.join('、')}`);
    }
    return {
      display: String(matched),
      value: matched,
    };
  }
  if (parameter.type === 'string') {
    const text = String(value);
    if (text.length > parameter.maxLength || text.includes('\0')) {
      throw new FrozenCommandError('parameter_invalid_string', `${parameter.label ?? parameter.name} 超过长度上限`);
    }
    if (parameter.pattern && !new RegExp(parameter.pattern, 'u').test(text)) {
      throw new FrozenCommandError('parameter_invalid_string', `${parameter.label ?? parameter.name} 不符合格式约束`);
    }
    return { display: text, value: text };
  }
  const resolved = resolveDate(String(value), referenceDate);
  const day = epochDay(resolved);
  if (parameter.min && day < epochDay(resolveDate(parameter.min, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 早于允许范围`);
  }
  if (parameter.max && day > epochDay(resolveDate(parameter.max, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 晚于允许范围`);
  }
  return { display: resolved, value: resolved };
}

function resolveFrozenCommandArguments(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): {
  referenceDate: string;
  values: Map<string, string | number>;
  normalized: FrozenCommandNormalizedArgument[];
} {
  const values = tokenizeArguments(input.rawArgs);
  if (values.length > input.definition.params.length) {
    throw new FrozenCommandError('parameter_too_many', `参数过多。用法：${frozenCommandUsage(input.definition)}`);
  }
  const referenceDate = referenceDateFor(input.definition.timezone, input.now ?? new Date());
  const resolvedValues = new Map<string, string | number>();
  const normalized = input.definition.params.map((parameter, index) => {
    const resolved = resolveParameter(parameter, values[index], referenceDate);
    resolvedValues.set(parameter.name, resolved.value);
    return {
      name: parameter.name,
      label: parameter.label ?? parameter.name,
      value: resolved.display,
    };
  });
  return { referenceDate, values: resolvedValues, normalized };
}

/** Parse and normalize with the host-owned generic argument parser. Executor
 * payload encoding belongs to the plugin and is deliberately absent here. */
export function normalizeFrozenCommandArguments(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): { referenceDate: string; args: FrozenCommandNormalizedArgument[] } {
  const resolved = resolveFrozenCommandArguments(input);
  return { referenceDate: resolved.referenceDate, args: resolved.normalized };
}

function outputFromToolResult(result: Record<string, unknown>, contentIsMarkdown: boolean): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isPlainObject)
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n')
    .trim();
  if (contentIsMarkdown && text) return text;
  if (text) {
    try { return JSON.parse(text); } catch { /* prefer structuredContent below */ }
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  return undefined;
}

const safeBusinessText = (value: string): string => value
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/<at\b[^>]*\/?>/gi, '[mention]')
    .replace(/<\/at>/gi, '')
    .replace(/[\t\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');

const safeMarkdownText = (value: string): string => value
  .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
  .replace(/<at\b[^>]*\/?>/gi, '[mention]')
  .replace(/<\/at>/gi, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');

const escapeMarkdownData = (value: string): string => safeBusinessText(value)
  .replace(/([\\`*{}\[\]()#+\-.!_|>~])/g, '\\$1');

function renderedTemplateValue(value: unknown, markdownData: boolean): string {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') rendered = String(value);
  else if (value === null || value === undefined) rendered = '—';
  else rendered = JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
  return markdownData ? escapeMarkdownData(rendered) : safeBusinessText(rendered);
}

const MAX_PRESENTATION_TABLE_ROWS = 50;
const MAX_PRESENTATION_TABLE_COLUMNS = 20;
const MAX_PRESENTATION_CELL_CHARS = 1_000;

function outputScalar(
  value: unknown,
  maxChars: number,
): { value: FrozenCommandOutputScalar; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  if (typeof value === 'number' && Number.isFinite(value)) return { value, truncated: false };
  if (typeof value === 'boolean') return { value, truncated: false };
  const text = safeBusinessText(typeof value === 'string' ? value : String(value));
  return text.length > maxChars
    ? { value: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
    : { value: text, truncated: false };
}

function presentationColumns(
  business: NonNullable<FrozenCommandExecutionResult['businessResult']>,
): Array<{ key: string; label: string }> {
  const labels = new Map((business.columns ?? []).map(column => [column.key, column.label]));
  const keys = [...new Set([
    ...(business.columns ?? []).map(column => column.key),
    ...business.rows.flatMap(row => Object.keys(row)),
  ])].filter(key => business.rows.some(row => Object.hasOwn(row, key)));
  return keys.slice(0, MAX_PRESENTATION_TABLE_COLUMNS).map(key => ({
    key,
    label: safeBusinessText(labels.get(key) ?? key),
  }));
}

/** Convert an execution result into the portable display contract. `text`
 * remains the exact backwards-compatible fallback while rich transports use
 * the structured blocks. */
export function buildFrozenCommandPresentation(input: {
  definition: FrozenCommandDefinition;
  text: string;
  businessResult?: FrozenCommandExecutionResult['businessResult'];
}): FrozenCommandPresentation {
  const { definition, text } = input;
  const format = definition.output.format;
  return {
    schemaVersion: 1,
    format,
    fallbackText: text,
    blocks: [{ type: 'markdown', markdown: text }],
  };
}

function frozenOutputContext(result: FrozenCommandExecutionResult): Record<string, unknown> {
  const business = result.businessResult;
  if (!business) {
    throw new FrozenCommandError('conditional_output_data_invalid', '查询结果缺失或格式异常，无法判断条件');
  }
  const first = business.rows[0] ?? {};
  return {
    ...first,
    rows: business.rows,
    data: business.rows,
    row_count: business.totalRows,
  };
}

function contextValue(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
      throw new FrozenCommandError('conditional_output_value_missing', `条件引用了不存在的字段：${path}`);
    }
    current = current[part];
  }
  return current;
}

function parseConditionLiteral(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.startsWith('"')) {
      try { return JSON.parse(text) as string; } catch { /* report below */ }
    } else {
      return text.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
  }
  throw new FrozenCommandError('conditional_output_invalid_literal', `条件比较值不合法：${text}`);
}

export function evaluateFrozenCommandOutputCondition(
  expression: string,
  result: FrozenCommandExecutionResult,
): boolean {
  return evaluateFrozenCommandRule(expression, {
    q: frozenOutputContext(result),
    run: { status: 'ok' },
  });
}

function evaluateFrozenCommandRule(expression: string, context: Record<string, unknown>): boolean {
  const clauses = expression.split(/\s+&&\s+/u);
  if (clauses.length === 0 || clauses.length > 10) {
    throw new FrozenCommandError('conditional_output_invalid_expression', '条件表达式格式不合法');
  }
  return clauses.every((clause) => {
    const match = /^\s*\{\{\s*((?:q|run|cmd)\.[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*\}\}\s*(>=|<=|===|!==|==|!=|>|<)\s*(.*?)\s*$/u.exec(clause);
    if (!match) {
      throw new FrozenCommandError('conditional_output_invalid_expression', '条件表达式格式不合法');
    }
    const left = contextValue(context, match[1]!);
    const right = parseConditionLiteral(match[3]!);
    const operator = match[2]!;
    if (operator === '==' || operator === '===') return left === right;
    if (operator === '!=' || operator === '!==') return left !== right;
    if (typeof left !== 'number' || !Number.isFinite(left) || typeof right !== 'number') {
      throw new FrozenCommandError('conditional_output_type_mismatch', '大小比较只支持有限数值');
    }
    if (operator === '>') return left > right;
    if (operator === '>=') return left >= right;
    if (operator === '<') return left < right;
    return left <= right;
  });
}

function renderFrozenOutputTemplate(
  template: string,
  context: Record<string, unknown>,
  markdownData = false,
): string {
  return template.replace(/\{\{\s*((?:q|run|cmd)\.[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*\}\}/gu, (_full, path: string) => {
    const value = contextValue(context, path);
    return renderedTemplateValue(value, markdownData);
  });
}

function processBusinessResult(
  projected: Record<string, unknown>,
  container?: string,
): FrozenCommandExecutionResult['businessResult'] {
  const candidate = container === undefined
    ? Object.values(projected).find(Array.isArray)
    : contextValue(projected, container);
  if (Array.isArray(candidate) && candidate.every(isPlainObject)) {
    const keys = [...new Set(candidate.flatMap(row => Object.keys(row)))];
    return {
      rows: candidate as Array<Record<string, string | number | boolean | bigint | null | undefined>>,
      totalRows: candidate.length,
      columns: keys.map(key => ({ key, label: safeBusinessText(key) })),
    };
  }
  const keys = Object.keys(projected);
  return {
    rows: [projected as Record<string, string | number | boolean | bigint | null | undefined>],
    totalRows: 1,
    columns: keys.map(key => ({ key, label: safeBusinessText(key) })),
  };
}

function processContextMap(input: {
  trustedCaller: TrustedCaller;
  context?: FrozenCommandExecutionContext;
  referenceDate: string;
  now: Date;
}): Record<string, string | undefined> {
  if ((input.context?.caller?.open_id
      && input.context.caller.open_id !== input.trustedCaller.requestUserOpenId)
    || (input.context?.caller?.union_id
      && input.context.caller.union_id !== input.trustedCaller.requestUserUnionId)) {
    throw new FrozenCommandError('context_identity_mismatch', '执行上下文身份与可信调用者不一致，已拒绝执行');
  }
  return {
    'caller.open_id': input.trustedCaller.requestUserOpenId,
    'caller.union_id': input.trustedCaller.requestUserUnionId,
    'caller.name': input.context?.caller?.name,
    'chat.id': input.context?.chat?.id,
    'chat.type': input.context?.chat?.type,
    'message.id': input.context?.message?.id,
    today: input.referenceDate,
    now: input.now.toISOString(),
  };
}

function resolveExecutorInput(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  trustedCaller: TrustedCaller;
  context?: FrozenCommandExecutionContext;
  now: Date;
}): {
  values: Record<string, ResolvedExecutorInput>;
  parameterValues: Record<string, string | number>;
  referenceDate: string;
} {
  const resolved = resolveFrozenCommandArguments({
    definition: input.definition,
    rawArgs: input.rawArgs,
    now: input.now,
  });
  const context = processContextMap({
    trustedCaller: input.trustedCaller,
    context: input.context,
    referenceDate: resolved.referenceDate,
    now: input.now,
  });
  const values: Record<string, ResolvedExecutorInput> = {};
  for (const [name, configured] of Object.entries(singleFrozenCommandStep(input.definition).input)) {
    if (typeof configured === 'string') {
      const placeholder = INPUT_PLACEHOLDER_RE.exec(configured);
      if (placeholder) {
        const key = placeholder[1]!;
        if (key.includes('.') || key === 'today' || key === 'now') {
          const value = context[key];
          if (value === undefined || value === '') {
            throw new FrozenCommandError('context_value_missing', `执行上下文缺少 ${key}，已拒绝执行`);
          }
          values[name] = { value, source: `context:${key}` as ExecutorArgumentSource };
        } else {
          const value = resolved.values.get(key);
          if (value === undefined) throw new FrozenCommandError('parameter_required', `缺少参数：${key}`);
          values[name] = { value, source: 'param' };
        }
        continue;
      }
    }
    values[name] = { value: configured as string | number, source: 'literal' };
  }
  return {
    values,
    parameterValues: Object.fromEntries(resolved.values),
    referenceDate: resolved.referenceDate,
  };
}

function truncateFrozenOutput(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n（结果已截断）`
    : text;
}

function truncateFrozenHandoff(body: string, notice: string, maxChars: number): string {
  const full = `${body}${notice}`;
  if (full.length <= maxChars) return full;
  const limitNotice = '\n\n（注入内容同时达到字符上限）';
  const reserved = `${notice}${limitNotice}`;
  const keep = Math.max(0, maxChars - reserved.length);
  return `${body.slice(0, keep)}${reserved}`;
}

export function resolveFrozenCommandOutput(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  source: 'direct' | 'confirmed' | 'schedule';
  taskId?: string;
  result?: FrozenCommandExecutionResult;
  error?: unknown;
  now?: Date;
}): FrozenCommandResolvedOutput {
  const { definition, result, error } = input;
  if ((result === undefined) === (error === undefined)) {
    throw new FrozenCommandError('output_decision_invalid', '输出决策必须且只能包含执行结果或执行错误');
  }
  if (error !== undefined && (!(error instanceof FrozenCommandError) || !error.executionFailure)) {
    throw error;
  }
  const normalized = normalizeFrozenCommandArguments({ definition, rawArgs: input.rawArgs, now: input.now });
  const step = singleFrozenCommandStep(definition);
  const stepQuery = result?.businessResult ? frozenOutputContext(result) : result?.projectedResult ?? {};
  const q = { [step.id]: stepQuery };
  const safeError = error instanceof FrozenCommandError ? {
    code: error.code,
    message: userFacingFrozenCommandError(error),
    transient: error.transient,
  } : undefined;
  const context: Record<string, unknown> = {
    q,
    run: {
      status: result ? 'ok' : 'error',
      [step.id]: {
        status: result ? 'ok' : 'error',
        error: safeError ?? { code: '', message: '', transient: false },
        executionId: result?.executionId ?? (error instanceof FrozenCommandError ? error.executionId : undefined) ?? '',
      },
    },
    cmd: {
      name: definition.name,
      description: definition.description,
      args: Object.fromEntries(normalized.args.map(argument => [argument.name, argument.value])),
      executor: step.executor,
      source: input.source,
      taskId: input.taskId ?? '',
    },
  };
  const matched = definition.output.rules.find((rule) => {
    // A show rule can only render a successful result. On failure it must not
    // swallow the original error or evaluate a q.* condition against an empty
    // result. Handoff rules remain eligible for execution-stage failures.
    if (error !== undefined && (rule.show || rule.when?.includes('{{q.'))) return false;
    return rule.when === undefined || evaluateFrozenCommandRule(rule.when, context);
  });
  if (matched?.handoff) {
    const executor = resolveCommandExecutor(step.executor);
    if (!executor.policy.allowHandoff) {
      throw new FrozenCommandError('executor_handoff_denied', `执行器 ${executor.id} 不允许把结果或失败交给模型`);
    }
    const qRows = result?.businessResult?.rows ?? [];
    const limitedRows = qRows.slice(0, matched.handoff.maxRows);
    const handoffContext = {
      ...context,
      q: { ...q, [step.id]: { ...stepQuery, rows: limitedRows, data: limitedRows } },
    };
    const statusLine = result
      ? `成功，execution_id=${result.executionId ?? 'unknown'}`
      : `失败，${safeError!.code}，${JSON.stringify(safeError!.message)}`;
    const serializedArguments = JSON.stringify(Object.fromEntries(
      normalized.args.map(argument => [argument.name, argument.value]),
    ));
    const fixedContext = [
      '[固化命令上下文]',
      `命令：/${definition.name}`,
      `说明：${JSON.stringify(definition.description)}`,
      `参数：${serializedArguments}`,
      `执行器：${step.executor}`,
      `触发方式：${input.source}`,
      `执行结果：${statusLine}`,
      `执行 ID：${result?.executionId ?? (error instanceof FrozenCommandError ? error.executionId : undefined) ?? 'unknown'}`,
    ].join('\n');
    const authorPrompt = renderFrozenOutputTemplate(matched.handoff.prompt, handoffContext);
    const data = matched.handoff.data === undefined
      ? (result?.businessResult ? JSON.stringify(limitedRows) : undefined)
      : renderFrozenOutputTemplate(matched.handoff.data, handoffContext);
    const inputNotice = executor.policy.handoffIncludesInput
      ? `\n\n[执行器输入，仅供工具调用，不要向用户展示]\n${JSON.stringify(step.input)}`
      : '';
    const truncation = result?.businessResult
      ? (result.businessResult.totalRows > limitedRows.length
          ? `\n\n共 ${result.businessResult.totalRows} 行，已截断为前 ${limitedRows.length} 行。`
          : `\n\n共 ${result.businessResult.totalRows} 行。`)
      : '';
    const body = `${fixedContext}\n\n${authorPrompt}${data === undefined ? '' : `\n\n数据：\n${data}`}${inputNotice}`;
    return { kind: 'handoff', prompt: truncateFrozenHandoff(body, truncation, DEFAULT_MAX_OUTPUT_CHARS) };
  }
  if (matched?.show) {
    if (matched.show.kind === 'result') {
      if (error !== undefined) throw error;
      return { kind: 'deliver', text: result!.text, presentation: result!.presentation };
    }
    const format = definition.output.format;
    const text = renderFrozenOutputTemplate(
      matched.show.text!,
      context,
      format !== 'text',
    );
    const safeText = format === 'text' ? markdownToPlainText(text) : sanitizeFrozenCommandMarkdown(text);
    const rendered = truncateFrozenOutput(safeText, DEFAULT_MAX_OUTPUT_CHARS);
    return {
      kind: 'deliver',
      text: rendered,
      presentation: {
        schemaVersion: 1,
        format,
        fallbackText: rendered,
        blocks: [{ type: 'markdown', markdown: rendered }],
      },
    };
  }
  if (error !== undefined) throw error;
  return { kind: 'deliver', text: result!.text, presentation: result!.presentation };
}

function toolName(tools: Array<{ name?: unknown }>, pluginId: string, requested: string): string {
  const names = tools.map(tool => typeof tool.name === 'string' ? tool.name : '').filter(Boolean);
  if (names.includes(requested)) return requested;
  const candidates = names.filter(name => name === `${pluginId}__${requested}`);
  if (candidates.length === 1) return candidates[0]!;
  throw new FrozenCommandError('plugin_tool_missing', `插件 ${pluginId} 未提供工具 ${requested}`);
}

export function isTransientPluginToolFailure(text: string): boolean {
  // Resource ceilings are deliberate protection, not transient transport
  // noise. Retrying them through a model would amplify load.
  if (/memory limit|resource limit|quota|too many rows|limit exceeded/i.test(text)) return false;
  return /timed?\s*out|timeout|temporar|unavailable|connection|transport|socket|econn|connection closed|overload|rate.?limit|too many requests|\b50[234]\b/i.test(text);
}

function frozenCommandAuditRecord(input: {
  input: {
    definition: FrozenCommandDefinition;
    rawArgs: string;
    targetLarkAppId: string;
    trustedCaller: TrustedCaller | undefined;
    turnId: string;
    now?: Date;
    audit?: FrozenCommandExecutionAuditContext;
  };
  executionId: string;
  executorRevision: string;
  status: 'completed' | 'failed';
  startedAt: number;
  stdoutBytes?: number;
  truncated?: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  errorCode?: string;
  outputAudit?: Record<string, unknown>;
}): Record<string, unknown> {
  let normalizedParams: Array<{ name: string; type: string; value: '[REDACTED]' }> = [];
  try {
    const normalized = normalizeFrozenCommandArguments({
      definition: input.input.definition,
      rawArgs: input.input.rawArgs,
      now: input.input.now,
    }).args;
    normalizedParams = normalized.map(item => ({
      name: item.name,
      type: input.input.definition.params.find(param => param.name === item.name)?.type ?? 'unknown',
      value: '[REDACTED]',
    }));
  } catch {
    // Invalid arguments still need an audit row; never let audit formatting
    // replace the actual parser error.
  }
  return {
    event: 'frozen_command_execution',
    execution_id: input.executionId,
    status: input.status,
    target_bot_id: input.input.targetLarkAppId,
    command: input.input.definition.name,
    executor_id: singleFrozenCommandStep(input.input.definition).executor,
    executor_revision: input.executorRevision,
    spec_hash: input.input.audit?.specHash,
    state_revision_id: input.input.audit?.stateRevisionId,
    source: input.input.audit?.source ?? 'direct',
    task_id: input.input.audit?.taskId ?? input.input.trustedCaller?.taskId,
    caller_open_id: input.input.trustedCaller?.requestUserOpenId,
    caller_union_id: input.input.trustedCaller?.requestUserUnionId,
    turn_id: input.input.turnId,
    normalized_params: normalizedParams,
    isolation_mode: 'none',
    duration_ms: Math.max(0, Date.now() - input.startedAt),
    stdout_bytes: input.stdoutBytes,
    truncated: input.truncated ?? false,
    exit_code: input.exitCode,
    signal: input.signal,
    error_code: input.errorCode,
    output_audit: input.outputAudit,
  };
}

function markdownCell(value: unknown): string {
  return escapeMarkdownData(renderedTemplateValue(value, false)).replace(/\|/g, '\\|');
}

function outputRowValue(row: Record<string, unknown>, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function builtinTableMarkdown(output: CommandExecutorOutputResult): string {
  if (output.rows.length === 0 || output.columns.length === 0) return '暂无数据';
  if (output.rows.length === 1) {
    return output.columns
      .map(column => `**${escapeMarkdownData(column.label)}**：${markdownCell(outputRowValue(output.rows[0]!, column.key))}`)
      .join('\n');
  }
  const header = `| ${output.columns.map(column => escapeMarkdownData(column.label)).join(' | ')} |`;
  const separator = `| ${output.columns.map(() => '---').join(' | ')} |`;
  const rows = output.rows.map(row => `| ${output.columns.map(column => markdownCell(outputRowValue(row, column.key))).join(' | ')} |`);
  const note = output.totalRows > output.rows.length
    ? `\n\n共 ${output.totalRows} 行，仅展示前 ${output.rows.length} 行。`
    : '';
  return [header, separator, ...rows].join('\n') + note;
}

function sanitizeMarkdownSegment(value: string): string {
  if (RAW_HTML_TAG_RE.test(value)) throw new FrozenCommandError('renderer_output_unsafe', '渲染结果包含原始 HTML，已拒绝展示', undefined, true);
  return safeMarkdownText(value)
    .replace(/@/g, '＠')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/giu, '$1');
}

/** Apply host display policy without corrupting JSON inside fenced code. */
export function sanitizeFrozenCommandMarkdown(value: string): string {
  let cursor = 0;
  let rendered = '';
  const fence = /```([^\r\n]*)\r?\n([\s\S]*?)```/gu;
  for (const match of value.matchAll(fence)) {
    const index = match.index ?? 0;
    rendered += sanitizeMarkdownSegment(value.slice(cursor, index));
    const language = match[1]!.trim().toLowerCase();
    const body = safeMarkdownText(match[2]!).replace(/@/g, '＠');
    rendered += `\`\`\`${language}\n${body}\`\`\``;
    cursor = index + match[0].length;
  }
  rendered += sanitizeMarkdownSegment(value.slice(cursor));
  return rendered;
}

function markdownToPlainText(markdown: string): string {
  return safeMarkdownText(markdown)
    .replace(/```[^\r\n]*\r?\n([\s\S]*?)```/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s*[-+*]\s+/gmu, '')
    .replace(/(?<!\\)[*_~`]/gu, '')
    .replace(/\\([\\`*{}\[\]()#+\-.!_|>~])/gu, '$1')
    .trim();
}

function outputBusinessResult(output: CommandExecutorOutputResult): FrozenCommandExecutionResult['businessResult'] {
  return {
    rows: output.rows as Array<Record<string, string | number | boolean | bigint | null | undefined>>,
    totalRows: output.totalRows,
    columns: output.columns,
  };
}

async function renderExecutorOutput(input: {
  definition: FrozenCommandDefinition;
  output: CommandExecutorOutputResult;
  normalizedArgs: FrozenCommandNormalizedArgument[];
  workingDir?: string;
  executionId: string;
}): Promise<string> {
  const step = singleFrozenCommandStep(input.definition);
  if (step.renderer === 'builtin.content') return sanitizeFrozenCommandMarkdown(input.output.content ?? '');
  if (step.renderer === 'builtin.table') return sanitizeFrozenCommandMarkdown(builtinTableMarkdown(input.output));
  const renderer = resolveCommandRenderer(step.renderer);
  if (typeof renderer === 'string') throw new FrozenCommandError('renderer_contract_invalid', `渲染器 ${renderer} 与执行器输出不兼容`);
  try {
    const rendered = await runCommandRenderer({
      renderer,
      workingDir: input.workingDir,
      payload: {
        rows: input.output.rows,
        columns: input.output.columns,
        totalRows: input.output.totalRows,
        fields: input.output.projected,
        cmd: {
          name: input.definition.name,
          args: Object.fromEntries(input.normalizedArgs.map(argument => [argument.name, argument.value])),
        },
      },
    });
    return sanitizeFrozenCommandMarkdown(rendered.markdown);
  } catch (error) {
    logger.warn('[frozen-command:audit]', {
      event: 'renderer_failed',
      execution_id: input.executionId,
      command: input.definition.name,
      renderer_id: step.renderer,
      error_code: error instanceof CommandExecutorError || error instanceof FrozenCommandError ? error.code : 'renderer_failed',
    });
    return sanitizeFrozenCommandMarkdown(builtinTableMarkdown(input.output));
  }
}

export async function executeFrozenCommand(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  targetLarkAppId: string;
  botConfig: Pick<BotConfig, 'plugins' | 'larkAppId' | 'larkAppSecret'>;
  trustedCaller: TrustedCaller | undefined;
  turnId: string;
  dataDir: string;
  now?: Date;
  timeoutMs?: number;
  workingDir?: string;
  context?: FrozenCommandExecutionContext;
  expectedExecutorRevision?: string;
  audit?: FrozenCommandExecutionAuditContext;
}): Promise<FrozenCommandExecutionResult> {
  if (!input.trustedCaller
    || (input.trustedCaller.senderType !== 'user' && input.trustedCaller.source !== 'schedule_creator')) {
    throw new FrozenCommandError('untrusted_caller', '无法确认调用者身份，已拒绝执行');
  }
  if (input.botConfig.larkAppId !== input.targetLarkAppId) {
    throw new FrozenCommandError('executor_identity_mismatch', '目标 Bot 与执行身份不一致，已拒绝执行');
  }
  const now = input.now ?? new Date();
  const executionId = randomUUID();
  const startedAt = Date.now();
  const currentExecutorRevision = frozenCommandExecutorRevision(input.definition);
  if (input.expectedExecutorRevision && input.expectedExecutorRevision !== currentExecutorRevision) {
    throw new FrozenCommandError('executor_revision_changed', '执行器配置或脚本已变化，命令必须重新确认');
  }
  const step = singleFrozenCommandStep(input.definition);
  const executor = resolveCommandExecutor(step.executor);
  const scheduled = input.trustedCaller.source === 'schedule_creator';
  if (scheduled && !executor.policy.schedulable) {
    throw new FrozenCommandError('executor_schedule_denied', `执行器 ${executor.id} 不允许用于定时任务`);
  }
  const resolved = resolveExecutorInput({
    definition: input.definition,
    rawArgs: input.rawArgs,
    trustedCaller: input.trustedCaller,
    context: input.context,
    now,
  });
  let executorOutput: CommandExecutorOutputResult;
  let stdoutBytes: number | undefined;
  let exitCode: number | undefined;
  let signal: NodeJS.Signals | null | undefined;
  try {
    if (!isPluginToolCommandExecutor(executor)) {
      const executed = await runProcessCommandExecutor({
        executor,
        values: resolved.values,
        botConfig: input.botConfig,
        workingDir: input.workingDir,
        executionId,
      });
      executorOutput = executed.output;
      stdoutBytes = executed.stdoutBytes;
      exitCode = executed.exitCode;
      signal = executed.signal;
    } else {
      const pluginIds = resolveEffectivePluginIds(input.botConfig, readGlobalConfig());
      if (!pluginIds.includes(executor.plugin)) throw new FrozenCommandError('plugin_tool_not_enabled', `当前角色未启用插件 ${executor.plugin}`);
      const installed = getInstalledPlugin(executor.plugin);
      if (!installed) throw new FrozenCommandError('plugin_tool_not_installed', `插件 ${executor.plugin} 未安装`);
      if (!pluginVersionAtLeast(installed.version, executor.minimumVersion)) {
        throw new FrozenCommandError('plugin_tool_version_unsupported', `插件 ${executor.plugin} 版本不满足最低要求 ${executor.minimumVersion}`);
      }
      if (!installed.contributions?.mcp) throw new FrozenCommandError('plugin_tool_gateway_missing', `插件 ${executor.plugin} 未声明 MCP 工具入口`);
      const timeoutMs = Math.min(input.timeoutMs ?? executor.policy.timeoutMs, executor.policy.timeoutMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      const gateway = new PluginMcpGateway([executor.plugin], {
        ...process.env,
        SESSION_DATA_DIR: input.dataDir,
        BOTMUX_SESSION_ID: undefined,
        BOTMUX_EXECUTION_ID: executionId,
      }, {
        trustedTurnIdentity: () => ({ caller: input.trustedCaller, turnId: input.turnId }),
      });
      const client = new Client({ name: 'botmux-frozen-command', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);
        const listed = await client.listTools(undefined, { signal: controller.signal, maxTotalTimeout: timeoutMs });
        const execute = toolName(listed.tools, executor.plugin, executor.tool);
        const descriptor = listed.tools.find(tool => tool.name === execute);
        const schemaProperties = isPlainObject(descriptor?.inputSchema)
          && isPlainObject(descriptor.inputSchema.properties)
          ? descriptor.inputSchema.properties
          : {};
        const usesFrozenTemplateEnvelope = ['payload', 'parameters', 'values']
          .every(field => Object.hasOwn(schemaProperties, field));
        const toolResult = await client.callTool({
          name: execute,
          arguments: usesFrozenTemplateEnvelope
            ? {
                payload: step.input,
                parameters: input.definition.params,
                values: resolved.parameterValues,
              }
            : Object.fromEntries(Object.entries(resolved.values).map(([key, value]) => [key, value.value])),
        }, undefined, { signal: controller.signal, maxTotalTimeout: timeoutMs }) as Record<string, unknown>;
        if (toolResult.isError === true) {
          throw new FrozenCommandError('plugin_tool_execution_failed', '插件工具执行失败。', undefined, true, false, executionId);
        }
        const raw = outputFromToolResult(toolResult, executor.output.content === 'markdown');
        executorOutput = materializeCommandExecutorOutput(executor.output, raw);
      } catch (error) {
        if (error instanceof FrozenCommandError || error instanceof CommandExecutorError) throw error;
        if (controller.signal.aborted) throw new FrozenCommandError('execution_timeout', '固化命令执行超时', undefined, true, true, executionId);
        throw new FrozenCommandError(
          'plugin_tool_unavailable',
          '插件工具暂时不可用，请稍后重试。',
          undefined,
          true,
          isTransientPluginToolFailure(error instanceof Error ? error.message : String(error)),
          executionId,
        );
      } finally {
        clearTimeout(timeout);
        await Promise.allSettled([client.close(), gateway.close()]);
      }
    }
    if (executorOutput.errorCode) {
      const policy = PLUGIN_TOOL_ERROR_POLICY[executorOutput.errorCode as keyof typeof PLUGIN_TOOL_ERROR_POLICY]
        ?? PLUGIN_TOOL_ERROR_POLICY.execution_failed;
      throw new FrozenCommandError(policy.code, policy.message, undefined, true, policy.transient, executionId);
    }
    const normalizedArgs = normalizeFrozenCommandArguments({ definition: input.definition, rawArgs: input.rawArgs, now }).args;
    const markdown = await renderExecutorOutput({
      definition: input.definition,
      output: executorOutput,
      normalizedArgs,
      workingDir: input.workingDir,
      executionId,
    });
    const rawText = input.definition.output.format === 'text' ? markdownToPlainText(markdown) : markdown;
    const text = truncateFrozenOutput(rawText, DEFAULT_MAX_OUTPUT_CHARS);
    const businessResult = outputBusinessResult(executorOutput);
    logger.info('[frozen-command:audit]', frozenCommandAuditRecord({
      input,
      executionId,
      executorRevision: currentExecutorRevision,
      status: 'completed',
      startedAt,
      stdoutBytes,
      truncated: rawText.length > DEFAULT_MAX_OUTPUT_CHARS,
      exitCode,
      signal,
      outputAudit: executorOutput.audit,
    }));
    return {
      referenceDate: resolved.referenceDate,
      text,
      presentation: buildFrozenCommandPresentation({ definition: input.definition, text, businessResult }),
      truncated: rawText.length > DEFAULT_MAX_OUTPUT_CHARS,
      executorId: executor.id,
      executorRevision: currentExecutorRevision,
      executionId,
      projectedResult: executorOutput.projected,
      businessResult,
    };
  } catch (error) {
    logger.warn('[frozen-command:audit]', frozenCommandAuditRecord({
      input,
      executionId,
      executorRevision: currentExecutorRevision,
      status: 'failed',
      startedAt,
      errorCode: error instanceof FrozenCommandError || error instanceof CommandExecutorError ? error.code : 'execution_failed',
    }));
    if (error instanceof FrozenCommandError) throw error;
    if (error instanceof CommandExecutorError) {
      const executionFailure = isProcessExecutionFailureCode(error.code)
        || error.code.startsWith('executor_output_')
        || error.code === 'executor_content_limit';
      throw new FrozenCommandError(
        error.code,
        error.message,
        undefined,
        executionFailure,
        executionFailure && (error.code === 'executor_timeout' || error.code === 'executor_spawn_failed'),
        executionId,
      );
    }
    throw error;
  }
}

export function userFacingFrozenCommandError(error: unknown): string {
  if (!(error instanceof FrozenCommandError)) return '固化命令执行失败，请稍后重试。';
  if (error.code === 'plugin_tool_unavailable') return '插件工具暂时不可用，请稍后重试。';
  if (SAFE_PLUGIN_TOOL_ERROR_CODES.has(error.code)) return error.message;
  if (/^(?:parameter_|definition_|executor_|context_value_missing$|untrusted_caller$|execution_timeout$)/.test(error.code)) {
    return error.message;
  }
  return '固化命令未执行完成，请稍后重试或联系维护方。';
}
