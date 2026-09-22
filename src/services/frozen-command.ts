import { randomUUID } from 'node:crypto';
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
  BUILTIN_DATA_MCP_EXECUTOR_ID,
  BUILTIN_DATA_MCP_EXECUTOR_REVISION,
  commandExecutorBinaryDigest,
  CommandExecutorError,
  resolveCommandExecutor,
  runProcessCommandExecutor,
  type ExecutorArgumentSource,
  type ResolvedExecutorInput,
} from './command-executors.js';

export const DATA_MCP_PLUGIN_ID = 'data-mcp';
export const FROZEN_COMMAND_DIR = join('.botmux', 'commands');

const COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const INPUT_PLACEHOLDER_RE = /^\{\{\s*((?:caller\.(?:open_id|union_id|name)|chat\.(?:id|type)|message\.id|today|now)|[A-Za-z][A-Za-z0-9_]*)\s*\}\}$/;
const OUTPUT_PLACEHOLDER_RE = /\{\{\s*result\.([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DATE_RE = /^today(?:([+-])(\d{1,4}))?$/;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class FrozenCommandError extends Error {
  override readonly name = 'FrozenCommandError';

  constructor(
    readonly code: string,
    message: string,
    readonly usage?: string,
    readonly fallbackAllowed = false,
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

export interface FrozenCommandDefinition {
  schemaVersion: 2;
  status: 'active';
  name: string;
  description: string;
  timezone: string;
  executor: string;
  input: Record<string, string | number | boolean>;
  params: FrozenCommandParameter[];
  output: {
    text?: string;
    prefix?: string;
    suffix?: string;
    maxChars: number;
    when?: string;
    handoff?: {
      prompt: string;
      data: string;
      maxRows: number;
    };
    else?: {
      text: string;
    };
  };
  onError: 'fallback_llm' | 'fail';
}

export interface FrozenCommandSnapshot {
  filePath: string;
  realpath: string;
  raw: string;
  definition: FrozenCommandDefinition;
}

export interface FrozenCommandExecutionResult {
  renderedSql?: string;
  referenceDate: string;
  text: string;
  truncated: boolean;
  executorId: string;
  executorRevision?: string;
  executionId?: string;
  projectedResult?: Record<string, unknown>;
  queryId?: string;
  businessResult?: {
    rows: Array<Record<string, string | number | boolean | bigint | null | undefined>>;
    totalRows: number;
  };
}

export type FrozenCommandScheduledOutput =
  | { kind: 'deliver'; text: string }
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
  if (definition.executor === BUILTIN_DATA_MCP_EXECUTOR_ID) return BUILTIN_DATA_MCP_EXECUTOR_REVISION;
  try {
    return resolveCommandExecutor(definition.executor).revision;
  } catch (error) {
    if (error instanceof CommandExecutorError) throw new FrozenCommandError(error.code, error.message);
    throw error;
  }
}

/** Third-party executable content is deliberately not part of the blocking
 * executor revision. This digest is an approval-time baseline for drift alerts
 * under isolation scheme B; scripts remain covered by the blocking artifact
 * digests inside executorRevision. */
export function frozenCommandExecutorBinaryDigest(definition: FrozenCommandDefinition): string | undefined {
  if (definition.executor === BUILTIN_DATA_MCP_EXECUTOR_ID) return undefined;
  try {
    return commandExecutorBinaryDigest(resolveCommandExecutor(definition.executor));
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
    'schemaVersion', 'status', 'name', 'description', 'timezone', 'executor', 'input', 'params',
    'output', 'onError', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
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
  const executor = nonBlank(value.executor, 'executor', 128).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executor)) {
    throw new FrozenCommandError('definition_invalid_executor', 'executor id 格式不合法');
  }
  if (!isPlainObject(value.input)) throw new FrozenCommandError('definition_invalid_input', 'input 必须是对象');
  if (Object.keys(value.input).length === 0 || Object.keys(value.input).length > 32) {
    throw new FrozenCommandError('definition_invalid_input', 'input 必须有 1-32 个字段');
  }
  const commandInput = Object.fromEntries(Object.entries(value.input).map(([key, candidate]) => {
    if (!PARAM_NAME_RE.test(key)) throw new FrozenCommandError('definition_invalid_input', `非法 input 字段：${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof candidate) || (typeof candidate === 'string' && candidate.includes('\0'))) {
      throw new FrozenCommandError('definition_invalid_input', `input.${key} 只能是字符串、数值或布尔值`);
    }
    return [key, candidate as string | number | boolean];
  }));
  const paramsRaw = value.params ?? [];
  if (!Array.isArray(paramsRaw) || paramsRaw.length > 32) {
    throw new FrozenCommandError('definition_invalid_parameters', 'params 必须是最多 32 项的数组');
  }
  const params = paramsRaw.map(parseParameter);
  if (new Set(params.map(param => param.name)).size !== params.length) {
    throw new FrozenCommandError('definition_duplicate_parameter', '参数名不能重复');
  }
  const declared = new Set(params.map(param => param.name));
  let referencedParams: string[] = [];
  if (executor === BUILTIN_DATA_MCP_EXECUTOR_ID) {
    onlyKeys(commandInput, ['sql', 'datasource'], 'input');
    const sql = nonBlank(commandInput.sql, 'input.sql', 200_000);
    if (/\{\{\s*(?:caller|chat|message)\./i.test(sql)) {
      throw new FrozenCommandError('definition_identity_in_sql', 'SQL 模板禁止使用身份变量；调用者身份只能走 Gateway metadata');
    }
    referencedParams = [...sql.matchAll(PLACEHOLDER_RE)].map(match => match[1]!);
    const unknown = [...new Set(referencedParams.filter(name => !declared.has(name)))];
    if (unknown.length > 0) throw new FrozenCommandError('definition_unknown_placeholder', `SQL 使用了未声明参数：${unknown.join(', ')}`);
    if (/\{\{|\}\}/.test(sql.replace(PLACEHOLDER_RE, ''))) {
      throw new FrozenCommandError('definition_invalid_placeholder', 'SQL 模板包含无法识别的占位符');
    }
    if (commandInput.datasource !== undefined
      && (typeof commandInput.datasource !== 'string' || !/^[A-Za-z0-9._-]+$/.test(commandInput.datasource))) {
      throw new FrozenCommandError('definition_invalid_datasource', 'input.datasource 格式不合法');
    }
  } else {
    for (const [key, candidate] of Object.entries(commandInput)) {
      if (typeof candidate !== 'string' || !candidate.includes('{{')) continue;
      const match = INPUT_PLACEHOLDER_RE.exec(candidate);
      if (!match) throw new FrozenCommandError('definition_invalid_placeholder', `input.${key} 变量必须独占整个值，且 key 必须在封闭集合中`);
      const placeholder = match[1]!;
      if (!placeholder.includes('.') && placeholder !== 'today' && placeholder !== 'now') {
        referencedParams.push(placeholder);
      }
    }
    const unknown = [...new Set(referencedParams.filter(name => !declared.has(name)))];
    if (unknown.length > 0) throw new FrozenCommandError('definition_unknown_placeholder', `input 使用了未声明参数：${unknown.join(', ')}`);
  }
  const unused = params.filter(param => !referencedParams.includes(param.name));
  if (unused.length > 0) throw new FrozenCommandError('definition_unused_parameter', `参数未在 input 中使用：${unused.map(item => item.name).join(', ')}`);
  let output: FrozenCommandDefinition['output'] = { maxChars: DEFAULT_MAX_OUTPUT_CHARS };
  if (value.output !== undefined) {
    if (!isPlainObject(value.output)) throw new FrozenCommandError('definition_invalid_output', 'output 必须是对象');
    onlyKeys(value.output, ['text', 'prefix', 'suffix', 'maxChars', 'when', 'handoff', 'else'], 'output');
    const maxChars = value.output.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    if (!Number.isInteger(maxChars) || (maxChars as number) < 100 || (maxChars as number) > 100_000) {
      throw new FrozenCommandError('definition_invalid_output', 'output.maxChars 必须在 100-100000 之间');
    }
    const hasConditionalField = value.output.when !== undefined
      || value.output.handoff !== undefined
      || value.output.else !== undefined;
    let conditional: Pick<FrozenCommandDefinition['output'], 'when' | 'handoff' | 'else'> = {};
    if (hasConditionalField) {
      const when = nonBlank(value.output.when, 'output.when', 1_000).trim();
      if (!isPlainObject(value.output.handoff)) {
        throw new FrozenCommandError('definition_invalid_output', 'output.handoff 必须是对象');
      }
      onlyKeys(value.output.handoff, ['prompt', 'data', 'maxRows'], 'output.handoff');
      const prompt = nonBlank(value.output.handoff.prompt, 'output.handoff.prompt', 10_000);
      const data = value.output.handoff.data === undefined
        ? '{{q.rows}}'
        : nonBlank(value.output.handoff.data, 'output.handoff.data', 10_000);
      const maxRows = value.output.handoff.maxRows ?? 50;
      if (!Number.isInteger(maxRows) || (maxRows as number) < 1 || (maxRows as number) > 1_000) {
        throw new FrozenCommandError('definition_invalid_output', 'output.handoff.maxRows 必须在 1-1000 之间');
      }
      if (!isPlainObject(value.output.else)) {
        throw new FrozenCommandError('definition_invalid_output', 'output.else 必须是对象');
      }
      onlyKeys(value.output.else, ['text'], 'output.else');
      const elseText = nonBlank(value.output.else.text, 'output.else.text', 10_000);
      conditional = {
        when,
        handoff: { prompt, data, maxRows: maxRows as number },
        else: { text: elseText },
      };
    }
    output = {
      maxChars: maxChars as number,
      ...(typeof value.output.text === 'string' ? { text: value.output.text } : {}),
      ...(typeof value.output.prefix === 'string' ? { prefix: value.output.prefix } : {}),
      ...(typeof value.output.suffix === 'string' ? { suffix: value.output.suffix } : {}),
      ...conditional,
    };
  }
  if (executor !== BUILTIN_DATA_MCP_EXECUTOR_ID && !output.text) {
    throw new FrozenCommandError('definition_invalid_output', 'process/script 命令必须声明 output.text');
  }
  if (value.onError !== undefined && value.onError !== 'fallback_llm' && value.onError !== 'fail') {
    throw new FrozenCommandError('definition_invalid_on_error', 'onError 只能是 fallback_llm 或 fail');
  }
  return {
    schemaVersion: 2,
    status: 'active',
    name,
    description,
    timezone,
    executor,
    input: commandInput,
    params,
    output,
    onError: value.onError === 'fail' ? 'fail' : 'fallback_llm',
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

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
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
): { sql: string; display: string; value: string | number } {
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
    return { sql: String(parsed), display: String(parsed), value: parsed };
  }
  if (parameter.type === 'enum') {
    const matched = parameter.values.find(candidate => String(candidate) === String(value));
    if (matched === undefined) {
      throw new FrozenCommandError('parameter_invalid_enum', `${parameter.label ?? parameter.name} 只能是：${parameter.values.join('、')}`);
    }
    return {
      sql: typeof matched === 'number' ? String(matched) : sqlString(matched),
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
    return { sql: sqlString(text), display: text, value: text };
  }
  const resolved = resolveDate(String(value), referenceDate);
  const day = epochDay(resolved);
  if (parameter.min && day < epochDay(resolveDate(parameter.min, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 早于允许范围`);
  }
  if (parameter.max && day > epochDay(resolveDate(parameter.max, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 晚于允许范围`);
  }
  return { sql: sqlString(resolved), display: resolved, value: resolved };
}

function resolveFrozenCommandArguments(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): {
  referenceDate: string;
  encoded: Map<string, string>;
  values: Map<string, string | number>;
  normalized: FrozenCommandNormalizedArgument[];
} {
  const values = tokenizeArguments(input.rawArgs);
  if (values.length > input.definition.params.length) {
    throw new FrozenCommandError('parameter_too_many', `参数过多。用法：${frozenCommandUsage(input.definition)}`);
  }
  const referenceDate = referenceDateFor(input.definition.timezone, input.now ?? new Date());
  const encoded = new Map<string, string>();
  const resolvedValues = new Map<string, string | number>();
  const normalized = input.definition.params.map((parameter, index) => {
    const resolved = resolveParameter(parameter, values[index], referenceDate);
    encoded.set(parameter.name, resolved.sql);
    resolvedValues.set(parameter.name, resolved.value);
    return {
      name: parameter.name,
      label: parameter.label ?? parameter.name,
      value: resolved.display,
    };
  });
  return { referenceDate, encoded, values: resolvedValues, normalized };
}

/** Parse and normalize with the exact same host-owned parser used by SQL
 * rendering. This is safe to show in confirmation cards and never contains
 * SQL template bytes. */
export function normalizeFrozenCommandArguments(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): { referenceDate: string; args: FrozenCommandNormalizedArgument[] } {
  const resolved = resolveFrozenCommandArguments(input);
  return { referenceDate: resolved.referenceDate, args: resolved.normalized };
}

export function renderFrozenCommandSql(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): { sql: string; referenceDate: string } {
  if (input.definition.executor !== BUILTIN_DATA_MCP_EXECUTOR_ID) {
    throw new FrozenCommandError('definition_executor_mismatch', '仅 Data MCP 内建执行器可以渲染 SQL');
  }
  const resolved = resolveFrozenCommandArguments(input);
  const template = input.definition.input.sql;
  if (typeof template !== 'string') throw new FrozenCommandError('definition_invalid_input', 'input.sql 缺失');
  const sql = template.replace(PLACEHOLDER_RE, (_full, name: string) => resolved.encoded.get(name)!);
  return { sql, referenceDate: resolved.referenceDate };
}

function redactSqlFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSqlFields);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const hidesSql = /^(?:sql|query|statement|original_sql|normalized_sql|rendered_sql|validated_sql)$/i.test(key)
      || /_sql$/i.test(key);
    return [key, hidesSql ? '[已隐藏]' : redactSqlFields(child)];
  }));
}

function textFromToolResult(result: Record<string, unknown>, hideSql = false): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isPlainObject)
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n')
    .trim();
  if (text) {
    if (!hideSql) return text;
    try {
      return JSON.stringify(redactSqlFields(JSON.parse(text)), null, 2);
    } catch {
      // Data MCP's tool contract is JSON. Refuse to echo an unexpected opaque
      // body because it could contain the hidden SQL.
      return '查询完成，但返回格式无法安全展示。';
    }
  }
  if (result.structuredContent === undefined) return '';
  return JSON.stringify(hideSql ? redactSqlFields(result.structuredContent) : result.structuredContent, null, 2);
}

type FrozenBusinessScalar = string | number | boolean | bigint | null | undefined;
type FrozenBusinessResult = {
  rows: Array<Record<string, FrozenBusinessScalar>>;
  totalRows: number;
  columnLabels: Map<string, string>;
};

const safeBusinessText = (value: string): string => value
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/<at\b[^>]*\/?>/gi, '[mention]')
    .replace(/<\/at>/gi, '')
    .replace(/[\t\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');

function frozenBusinessResult(result: Record<string, unknown>): FrozenBusinessResult | undefined {
  const candidates: unknown[] = [result.structuredContent];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
      try { candidates.push(JSON.parse(item.text)); } catch { /* non-JSON tool text is never echoed */ }
    }
  }
  candidates.push(result);
  const payload = candidates.find(candidate => isPlainObject(candidate)
    && (Object.hasOwn(candidate, 'rows') || Object.hasOwn(candidate, 'data')));
  if (!isPlainObject(payload)) return undefined;

  const rawRows = Object.hasOwn(payload, 'rows') ? payload.rows : payload.data;
  if (!Array.isArray(rawRows)) return undefined;
  if (rawRows.some(row => !isPlainObject(row))) return undefined;
  const rows = rawRows as Array<Record<string, unknown>>;
  if (rows.some(row => Object.keys(row).length === 0)) return undefined;
  const isDisplayScalar = (value: unknown): boolean => value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint';
  if (rows.some(row => Object.values(row).some(value => !isDisplayScalar(value)))) return undefined;
  const columnLabels = new Map<string, string>();
  if (Array.isArray(payload.columns)) {
    for (const column of payload.columns) {
      if (!isPlainObject(column) || typeof column.name !== 'string' || !column.name) continue;
      const description = typeof column.description === 'string' ? column.description.trim() : '';
      columnLabels.set(column.name, safeBusinessText(description || column.name));
    }
  }
  const declaredTotal = payload.row_count;
  const totalRows = Number.isSafeInteger(declaredTotal) && (declaredTotal as number) >= rows.length
    ? declaredTotal as number
    : rows.length;
  return {
    rows: rows.map(row => ({ ...row })) as Array<Record<string, FrozenBusinessScalar>>,
    totalRows,
    columnLabels,
  };
}

export function frozenCommandResultText(result: Record<string, unknown>): string {
  const business = frozenBusinessResult(result);
  if (!business) return '查询已完成。';
  const { rows, columnLabels } = business;
  if (rows.length === 0) return '查询完成，未找到符合条件的数据。';
  const keys = [...new Set([
    ...columnLabels.keys(),
    ...rows.flatMap(row => Object.keys(row)),
  ])].filter(key => rows.some(row => Object.hasOwn(row, key)));
  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return safeBusinessText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return '—';
  };
  if (rows.length === 1 && keys.length === 1) return formatValue(rows[0]![keys[0]!]);
  const renderRow = (row: Record<string, unknown>): string => keys
    .map(key => `${columnLabels.get(key) ?? safeBusinessText(key)}：${formatValue(row[key])}`)
    .join('；');
  if (rows.length === 1) return renderRow(rows[0]!);
  return rows.map((row, index) => `${index + 1}. ${renderRow(row)}`).join('\n');
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
      throw new FrozenCommandError('conditional_output_value_missing', `条件引用了不存在的字段：q.${path}`);
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
  const match = /^\s*\{\{\s*q\.([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\s*(>=|<=|===|!==|==|!=|>|<)\s*(.*?)\s*$/.exec(expression);
  if (!match) {
    throw new FrozenCommandError('conditional_output_invalid_expression', '条件表达式格式不合法');
  }
  const left = contextValue(frozenOutputContext(result), match[1]!);
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
}

function renderFrozenOutputTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*q\.([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_full, path: string) => {
    const value = contextValue(context, path);
    if (typeof value === 'string') return safeBusinessText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (value === null || value === undefined) return '—';
    return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
  });
}

function renderProcessOutputTemplate(template: string, projected: Record<string, unknown>): string {
  return template.replace(OUTPUT_PLACEHOLDER_RE, (_full, path: string) => {
    const value = contextValue(projected, path);
    if (typeof value === 'string') return safeBusinessText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (value === null || value === undefined) return '—';
    return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
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
    return {
      rows: candidate as Array<Record<string, string | number | boolean | bigint | null | undefined>>,
      totalRows: candidate.length,
    };
  }
  return {
    rows: [projected as Record<string, string | number | boolean | bigint | null | undefined>],
    totalRows: 1,
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

function resolveProcessInput(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  trustedCaller: TrustedCaller;
  context?: FrozenCommandExecutionContext;
  now: Date;
}): { values: Record<string, ResolvedExecutorInput>; referenceDate: string } {
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
  for (const [name, configured] of Object.entries(input.definition.input)) {
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
  return { values, referenceDate: resolved.referenceDate };
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

export function resolveFrozenCommandScheduledOutput(
  definition: FrozenCommandDefinition,
  result: FrozenCommandExecutionResult,
): FrozenCommandScheduledOutput {
  const { when, handoff, else: elseOutput } = definition.output;
  if (!when || !handoff || !elseOutput) return { kind: 'deliver', text: result.text };
  const context = frozenOutputContext(result);
  if (!evaluateFrozenCommandOutputCondition(when, result)) {
    const text = `${definition.output.prefix ?? ''}${renderFrozenOutputTemplate(elseOutput.text, context)}${definition.output.suffix ?? ''}`;
    return { kind: 'deliver', text: truncateFrozenOutput(text, definition.output.maxChars) };
  }
  const business = result.businessResult!;
  const limitedRows = business.rows.slice(0, handoff.maxRows);
  const handoffContext = { ...context, rows: limitedRows, data: limitedRows };
  const prompt = renderFrozenOutputTemplate(handoff.prompt, handoffContext);
  const data = renderFrozenOutputTemplate(handoff.data, handoffContext);
  const truncation = business.totalRows > limitedRows.length
    ? `\n\n共 ${business.totalRows} 行，已截断为前 ${limitedRows.length} 行。`
    : `\n\n共 ${business.totalRows} 行。`;
  return {
    kind: 'handoff',
    prompt: truncateFrozenHandoff(`${prompt}\n\n数据：\n${data}`, truncation, definition.output.maxChars),
  };
}

function findKey(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (isPlainObject(value)) {
    if (typeof value[key] === 'string' && value[key]) return value[key] as string;
    for (const child of Object.values(value)) {
      const found = findKey(child, key, depth + 1);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findKey(child, key, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function keyFromToolResult(result: Record<string, unknown>, key: string): string | undefined {
  const candidates: unknown[] = [result.structuredContent, result];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
      try { candidates.push(JSON.parse(item.text)); } catch { /* human-readable text */ }
    }
  }
  for (const candidate of candidates) {
    const found = findKey(candidate, key);
    if (found) return found;
  }
  return undefined;
}

function planIdFromResult(result: Record<string, unknown>): string {
  const found = keyFromToolResult(result, 'query_plan_id');
  if (found) return found;
  throw new FrozenCommandError('query_plan_missing', 'Data MCP 未返回 query_plan_id');
}

function toolName(tools: Array<{ name?: unknown }>, requested: string): string {
  const names = tools.map(tool => typeof tool.name === 'string' ? tool.name : '').filter(Boolean);
  if (names.includes(requested)) return requested;
  const candidates = names.filter(name => name === `${DATA_MCP_PLUGIN_ID}__${requested}` || name.endsWith(`__${requested}`));
  if (candidates.length === 1) return candidates[0]!;
  throw new FrozenCommandError('data_mcp_tool_missing', `Data MCP 未提供 ${requested}`);
}

export function isTransientDataMcpFailure(text: string): boolean {
  // Resource ceilings are deliberate protection, not transient transport
  // noise. Retrying them through a model would amplify load.
  if (/memory limit|resource limit|quota|too many rows|limit exceeded/i.test(text)) return false;
  return /timed?\s*out|timeout|temporar|unavailable|connection|transport|socket|econn|connection closed|overload|rate.?limit|too many requests|\b50[234]\b|unknown (?:column|identifier)|does not exist|schema/i.test(text);
}

function downstreamFailure(stage: 'validate' | 'run', result: Record<string, unknown>): never {
  const text = textFromToolResult(result) || `${stage} failed`;
  const policyFailure = /permission|forbidden|unauthorized|policy|identity|trusted_human|sql_guard|query_plan_(?:session|union|sql|datasource|app|task)_mismatch/i.test(text);
  throw new FrozenCommandError(
    `data_mcp_${stage}_failed`,
    text,
    undefined,
    !policyFailure && isTransientDataMcpFailure(text),
  );
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
    executor_id: input.input.definition.executor,
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
  };
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
  if (input.definition.executor !== BUILTIN_DATA_MCP_EXECUTOR_ID) {
    try {
      const executor = resolveCommandExecutor(input.definition.executor);
      const scheduled = input.trustedCaller.source === 'schedule_creator';
      if (scheduled && !executor.policy.schedulable) {
        throw new CommandExecutorError('executor_schedule_denied', `执行器 ${executor.id} 不允许用于定时任务`);
      }
      if (input.definition.output.when && !executor.policy.allowHandoff) {
        throw new CommandExecutorError('executor_handoff_denied', `执行器 ${executor.id} 不允许把结果交给模型`);
      }
      const resolved = resolveProcessInput({
        definition: input.definition,
        rawArgs: input.rawArgs,
        trustedCaller: input.trustedCaller,
        context: input.context,
        now,
      });
      const executed = await runProcessCommandExecutor({
        executor,
        values: resolved.values,
        botConfig: input.botConfig,
        workingDir: input.workingDir,
        executionId,
      });
      const template = input.definition.output.text!;
      if (/\{\{|\}\}/.test(template.replace(OUTPUT_PLACEHOLDER_RE, ''))) {
        throw new FrozenCommandError('definition_invalid_output', 'output.text 包含无法识别的占位符');
      }
      const raw = renderProcessOutputTemplate(template, executed.projected);
      const decorated = `${input.definition.output.prefix ?? ''}${raw}${input.definition.output.suffix ?? ''}`;
      logger.info('[frozen-command:audit]', frozenCommandAuditRecord({
        input,
        executionId,
        executorRevision: currentExecutorRevision,
        status: 'completed',
        startedAt,
        stdoutBytes: executed.stdoutBytes,
        truncated: executed.truncated || decorated.length > input.definition.output.maxChars,
        exitCode: executed.exitCode,
        signal: executed.signal,
      }));
      return {
        referenceDate: resolved.referenceDate,
        text: truncateFrozenOutput(decorated, input.definition.output.maxChars),
        truncated: decorated.length > input.definition.output.maxChars,
        executorId: executor.id,
        executorRevision: currentExecutorRevision,
        executionId: executed.executionId,
        projectedResult: executed.projected,
        businessResult: processBusinessResult(
          executed.projected,
          'container' in executor.output ? executor.output.container : undefined,
        ),
      };
    } catch (error) {
      logger.warn('[frozen-command:audit]', frozenCommandAuditRecord({
        input,
        executionId,
        executorRevision: currentExecutorRevision,
        status: 'failed',
        startedAt,
        errorCode: error instanceof CommandExecutorError || error instanceof FrozenCommandError
          ? error.code
          : 'execution_failed',
      }));
      if (error instanceof FrozenCommandError) throw error;
      if (error instanceof CommandExecutorError) {
        throw new FrozenCommandError(error.code, error.message, undefined, false);
      }
      throw error;
    }
  }
  const pluginIds = resolveEffectivePluginIds(input.botConfig, readGlobalConfig());
  if (!pluginIds.includes(DATA_MCP_PLUGIN_ID)) {
    throw new FrozenCommandError('data_mcp_not_enabled', '当前角色未启用数据查询能力');
  }
  const rendered = renderFrozenCommandSql({ definition: input.definition, rawArgs: input.rawArgs, now });
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  // Open only Data MCP in this one-shot gateway. Other plugins enabled for the
  // role are irrelevant to this host-owned execution path and must not expand
  // its tool surface.
  const gateway = new PluginMcpGateway([DATA_MCP_PLUGIN_ID], {
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
    const validate = toolName(listed.tools, 'validate_sql_for_user');
    const run = toolName(listed.tools, 'run_query_for_user');
    // Render once and reuse these exact bytes. QueryPlanStore binds SQL
    // byte-for-byte; trimming or formatting between validate/run is forbidden.
    const renderedSql = rendered.sql;
    const validateResult = await client.callTool({
      name: validate,
      arguments: {
        sql: renderedSql,
        ...(typeof input.definition.input.datasource === 'string' ? { datasource: input.definition.input.datasource } : {}),
        execution_mode: 'single',
      },
    }, undefined, { signal: controller.signal, maxTotalTimeout: timeoutMs }) as Record<string, unknown>;
    if (validateResult.isError === true) downstreamFailure('validate', validateResult);
    let queryPlanId: string;
    try {
      queryPlanId = planIdFromResult(validateResult);
    } catch (error) {
      // Data MCP deliberately returns policy/validation failures as a normal
      // MCP tool result containing structured JSON. Preserve that real error
      // instead of masking it as a missing query plan.
      if (error instanceof FrozenCommandError && error.code === 'query_plan_missing') {
        downstreamFailure('validate', validateResult);
      }
      throw error;
    }
    const runResult = await client.callTool({
      name: run,
      arguments: {
        sql: renderedSql,
        query_plan_id: queryPlanId,
        ...(typeof input.definition.input.datasource === 'string' ? { datasource: input.definition.input.datasource } : {}),
      },
    }, undefined, { signal: controller.signal, maxTotalTimeout: timeoutMs }) as Record<string, unknown>;
    if (runResult.isError === true) downstreamFailure('run', runResult);
    const queryId = keyFromToolResult(runResult, 'query_id');
    const businessResult = frozenBusinessResult(runResult);
    const raw = frozenCommandResultText(runResult) || '查询完成，但没有可展示的结果。';
    const decorated = `${input.definition.output.prefix ?? ''}${raw}${input.definition.output.suffix ?? ''}`;
    const truncated = decorated.length > input.definition.output.maxChars;
    logger.info('[frozen-command:audit]', frozenCommandAuditRecord({
      input,
      executionId,
      executorRevision: currentExecutorRevision,
      status: 'completed',
      startedAt,
      truncated,
    }));
    return {
      renderedSql,
      referenceDate: rendered.referenceDate,
      text: truncateFrozenOutput(decorated, input.definition.output.maxChars),
      truncated,
      executorId: BUILTIN_DATA_MCP_EXECUTOR_ID,
      executorRevision: currentExecutorRevision,
      ...(queryId ? { queryId } : {}),
      ...(businessResult
        ? { businessResult: { rows: businessResult.rows, totalRows: businessResult.totalRows } }
        : {}),
    };
  } catch (error) {
    logger.warn('[frozen-command:audit]', frozenCommandAuditRecord({
      input,
      executionId,
      executorRevision: currentExecutorRevision,
      status: 'failed',
      startedAt,
      errorCode: error instanceof FrozenCommandError ? error.code : 'data_mcp_unavailable',
    }));
    if (error instanceof FrozenCommandError) throw error;
    if (controller.signal.aborted) {
      throw new FrozenCommandError('execution_timeout', '固化查询超时', undefined, true);
    }
    const message = error instanceof Error ? error.message : String(error);
    const ambiguous = /query_plan_(?:already_consumed|not_found_or_expired)/i.test(message);
    throw new FrozenCommandError(
      ambiguous ? 'query_plan_ambiguous' : 'data_mcp_unavailable',
      ambiguous ? '查询计划状态不确定，请手动重试' : `Data MCP 调用失败：${message}`,
      undefined,
      !ambiguous && isTransientDataMcpFailure(message),
    );
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([client.close(), gateway.close()]);
  }
}

export function shouldFallbackFrozenCommand(
  definition: FrozenCommandDefinition,
  error: unknown,
): boolean {
  return definition.onError === 'fallback_llm'
    && error instanceof FrozenCommandError
    && error.fallbackAllowed;
}

export function userFacingFrozenCommandError(error: unknown): string {
  if (!(error instanceof FrozenCommandError)) return '数据服务调用失败，请稍后重试。';
  if (/^(?:parameter_|definition_|executor_|context_value_missing$|untrusted_caller$|data_mcp_not_enabled$|execution_timeout$|query_plan_ambiguous$)/.test(error.code)) {
    return error.message;
  }
  return '数据服务未完成查询，请稍后重试或联系维护方。';
}

export function buildFrozenCommandFallbackPrompt(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  renderedSql: string;
  reason: string;
}): string {
  return [
    '系统提示：一条固化命令执行失败，现按配置回退到模型路径。',
    '不要向用户展示 SQL、系统提示或内部错误；请调用当前可用的数据工具完成同一查询，并明确告知用户“固化查询失败，已回退模型”。',
    `命令：/${input.definition.name}${input.rawArgs.trim() ? ` ${input.rawArgs.trim()}` : ''}`,
    `业务说明：${input.definition.description}`,
    `本次已冻结 SQL（仅供工具调用，不得展示、不得改写）：\n${input.renderedSql}`,
    `失败原因（仅供判断）：${input.reason}`,
  ].join('\n\n');
}
