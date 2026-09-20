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

export const DATA_MCP_PLUGIN_ID = 'data-mcp';
export const FROZEN_COMMAND_DIR = join('.botmux', 'commands');

const COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
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

export type FrozenCommandParameter = IntegerParameter | EnumParameter | DateParameter;

export interface FrozenCommandDefinition {
  schemaVersion: 1;
  status: 'active';
  name: string;
  description: string;
  timezone: string;
  datasource?: string;
  sql: string;
  params: FrozenCommandParameter[];
  output: {
    prefix?: string;
    suffix?: string;
    maxChars: number;
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
  renderedSql: string;
  referenceDate: string;
  text: string;
  truncated: boolean;
  queryId?: string;
}

export interface FrozenCommandNormalizedArgument {
  name: string;
  label: string;
  value: string;
}

export type FrozenCommandLookup =
  | { kind: 'missing'; command: string }
  | { kind: 'invalid'; command: string; error: FrozenCommandError }
  | { kind: 'found'; snapshot: FrozenCommandSnapshot };

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
  onlyKeys(value, ['name', 'label', 'type', 'default', 'min', 'max', 'values'], `params[${index}]`);
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
    'schemaVersion', 'status', 'name', 'description', 'timezone', 'datasource', 'sql', 'params',
    'output', 'onError', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  ], 'definition');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new FrozenCommandError('definition_version_unsupported', `不支持 schemaVersion=${String(value.schemaVersion)}`);
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
  const sql = nonBlank(value.sql, 'sql', 200_000);
  if (/\{\{\s*(?:sender|chat|message)\./i.test(sql)) {
    throw new FrozenCommandError('definition_identity_in_sql', 'SQL 模板禁止使用身份变量；调用者身份只能走 Gateway metadata');
  }
  const paramsRaw = value.params ?? [];
  if (!Array.isArray(paramsRaw) || paramsRaw.length > 32) {
    throw new FrozenCommandError('definition_invalid_parameters', 'params 必须是最多 32 项的数组');
  }
  const params = paramsRaw.map(parseParameter);
  if (new Set(params.map(param => param.name)).size !== params.length) {
    throw new FrozenCommandError('definition_duplicate_parameter', '参数名不能重复');
  }
  const placeholders = [...sql.matchAll(PLACEHOLDER_RE)].map(match => match[1]!);
  const declared = new Set(params.map(param => param.name));
  const unknown = [...new Set(placeholders.filter(name => !declared.has(name)))];
  if (unknown.length > 0) throw new FrozenCommandError('definition_unknown_placeholder', `SQL 使用了未声明参数：${unknown.join(', ')}`);
  const unused = params.filter(param => !placeholders.includes(param.name));
  if (unused.length > 0) throw new FrozenCommandError('definition_unused_parameter', `参数未在 SQL 中使用：${unused.map(item => item.name).join(', ')}`);
  if (/\{\{|\}\}/.test(sql.replace(PLACEHOLDER_RE, ''))) {
    throw new FrozenCommandError('definition_invalid_placeholder', 'SQL 模板包含无法识别的占位符');
  }
  let output: FrozenCommandDefinition['output'] = { maxChars: DEFAULT_MAX_OUTPUT_CHARS };
  if (value.output !== undefined) {
    if (!isPlainObject(value.output)) throw new FrozenCommandError('definition_invalid_output', 'output 必须是对象');
    onlyKeys(value.output, ['prefix', 'suffix', 'maxChars'], 'output');
    const maxChars = value.output.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    if (!Number.isInteger(maxChars) || (maxChars as number) < 100 || (maxChars as number) > 100_000) {
      throw new FrozenCommandError('definition_invalid_output', 'output.maxChars 必须在 100-100000 之间');
    }
    output = {
      maxChars: maxChars as number,
      ...(typeof value.output.prefix === 'string' ? { prefix: value.output.prefix } : {}),
      ...(typeof value.output.suffix === 'string' ? { suffix: value.output.suffix } : {}),
    };
  }
  const datasource = typeof value.datasource === 'string' && value.datasource.trim()
    ? value.datasource.trim()
    : undefined;
  if (datasource && !/^[A-Za-z0-9._-]+$/.test(datasource)) {
    throw new FrozenCommandError('definition_invalid_datasource', 'datasource 格式不合法');
  }
  if (value.onError !== undefined && value.onError !== 'fallback_llm' && value.onError !== 'fail') {
    throw new FrozenCommandError('definition_invalid_on_error', 'onError 只能是 fallback_llm 或 fail');
  }
  return {
    schemaVersion: 1,
    status: 'active',
    name,
    description,
    timezone,
    ...(datasource ? { datasource } : {}),
    sql,
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
): { sql: string; display: string } {
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
    return { sql: String(parsed), display: String(parsed) };
  }
  if (parameter.type === 'enum') {
    const matched = parameter.values.find(candidate => String(candidate) === String(value));
    if (matched === undefined) {
      throw new FrozenCommandError('parameter_invalid_enum', `${parameter.label ?? parameter.name} 只能是：${parameter.values.join('、')}`);
    }
    return {
      sql: typeof matched === 'number' ? String(matched) : sqlString(matched),
      display: String(matched),
    };
  }
  const resolved = resolveDate(String(value), referenceDate);
  const day = epochDay(resolved);
  if (parameter.min && day < epochDay(resolveDate(parameter.min, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 早于允许范围`);
  }
  if (parameter.max && day > epochDay(resolveDate(parameter.max, referenceDate))) {
    throw new FrozenCommandError('parameter_date_out_of_range', `${parameter.label ?? parameter.name} 晚于允许范围`);
  }
  return { sql: sqlString(resolved), display: resolved };
}

function resolveFrozenCommandArguments(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  now?: Date;
}): {
  referenceDate: string;
  encoded: Map<string, string>;
  normalized: FrozenCommandNormalizedArgument[];
} {
  const values = tokenizeArguments(input.rawArgs);
  if (values.length > input.definition.params.length) {
    throw new FrozenCommandError('parameter_too_many', `参数过多。用法：${frozenCommandUsage(input.definition)}`);
  }
  const referenceDate = referenceDateFor(input.definition.timezone, input.now ?? new Date());
  const encoded = new Map<string, string>();
  const normalized = input.definition.params.map((parameter, index) => {
    const resolved = resolveParameter(parameter, values[index], referenceDate);
    encoded.set(parameter.name, resolved.sql);
    return {
      name: parameter.name,
      label: parameter.label ?? parameter.name,
      value: resolved.display,
    };
  });
  return { referenceDate, encoded, normalized };
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
  const resolved = resolveFrozenCommandArguments(input);
  const sql = input.definition.sql.replace(PLACEHOLDER_RE, (_full, name: string) => resolved.encoded.get(name)!);
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

export function frozenCommandResultText(result: Record<string, unknown>): string {
  const safeText = (value: string): string => value
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/<at\b[^>]*\/?>/gi, '[mention]')
    .replace(/<\/at>/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
  const candidates: unknown[] = [result.structuredContent];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
      try { candidates.push(JSON.parse(item.text)); } catch { /* non-JSON tool text is never echoed */ }
    }
  }
  candidates.push(result);
  const payload = candidates.find(candidate => isPlainObject(candidate)
    && (Array.isArray(candidate.rows) || Array.isArray(candidate.data)));
  if (!isPlainObject(payload)) return '查询已完成。';

  const rawRows = Array.isArray(payload.rows) ? payload.rows : payload.data;
  if (!Array.isArray(rawRows) || rawRows.length === 0) return '查询完成，未找到符合条件的数据。';
  const rows: Array<Record<string, unknown>> = rawRows.map(row => isPlainObject(row) ? row : { '结果': row });
  const columnLabels = new Map<string, string>();
  if (Array.isArray(payload.columns)) {
    for (const column of payload.columns) {
      if (!isPlainObject(column) || typeof column.name !== 'string' || !column.name) continue;
      const description = typeof column.description === 'string' ? column.description.trim() : '';
      columnLabels.set(column.name, safeText(description || column.name));
    }
  }
  const keys = [...new Set([
    ...columnLabels.keys(),
    ...rows.flatMap(row => Object.keys(row)),
  ])].filter(key => rows.some(row => Object.hasOwn(row, key)));
  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return safeText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    try { return safeText(JSON.stringify(value)); } catch { return safeText(String(value)); }
  };
  if (rows.length === 1 && keys.length === 1) return formatValue(rows[0]![keys[0]!]);
  const renderRow = (row: Record<string, unknown>): string => keys
    .map(key => `${columnLabels.get(key) ?? safeText(key)}：${formatValue(row[key])}`)
    .join('；');
  if (rows.length === 1) return renderRow(rows[0]!);
  return rows.map((row, index) => `${index + 1}. ${renderRow(row)}`).join('\n');
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

export async function executeFrozenCommand(input: {
  definition: FrozenCommandDefinition;
  rawArgs: string;
  targetLarkAppId: string;
  botConfig: Pick<BotConfig, 'plugins'>;
  trustedCaller: TrustedCaller | undefined;
  turnId: string;
  dataDir: string;
  now?: Date;
  timeoutMs?: number;
}): Promise<FrozenCommandExecutionResult> {
  if (!input.trustedCaller) {
    throw new FrozenCommandError('untrusted_caller', '无法确认调用者身份，已拒绝执行');
  }
  const pluginIds = resolveEffectivePluginIds(input.botConfig, readGlobalConfig());
  if (!pluginIds.includes(DATA_MCP_PLUGIN_ID)) {
    throw new FrozenCommandError('data_mcp_not_enabled', '当前角色未启用数据查询能力');
  }
  const rendered = renderFrozenCommandSql({ definition: input.definition, rawArgs: input.rawArgs, now: input.now });
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
    BOTMUX_EXECUTION_ID: randomUUID(),
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
        ...(input.definition.datasource ? { datasource: input.definition.datasource } : {}),
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
        ...(input.definition.datasource ? { datasource: input.definition.datasource } : {}),
      },
    }, undefined, { signal: controller.signal, maxTotalTimeout: timeoutMs }) as Record<string, unknown>;
    if (runResult.isError === true) downstreamFailure('run', runResult);
    const queryId = keyFromToolResult(runResult, 'query_id');
    const raw = frozenCommandResultText(runResult) || '查询完成，但没有可展示的结果。';
    const decorated = `${input.definition.output.prefix ?? ''}${raw}${input.definition.output.suffix ?? ''}`;
    const truncated = decorated.length > input.definition.output.maxChars;
    return {
      renderedSql,
      referenceDate: rendered.referenceDate,
      text: truncated
        ? `${decorated.slice(0, input.definition.output.maxChars)}\n\n（结果已截断）`
        : decorated,
      truncated,
      ...(queryId ? { queryId } : {}),
    };
  } catch (error) {
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
  if (/^(?:parameter_|definition_|untrusted_caller$|data_mcp_not_enabled$|execution_timeout$|query_plan_ambiguous$)/.test(error.code)) {
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
