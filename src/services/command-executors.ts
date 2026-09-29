import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  mkdtempSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { BotConfig } from '../bot-registry.js';
import { assertValidPluginId } from '../core/plugins/ids.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';

const EXECUTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARGUMENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_EXECUTORS = 256;
const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_PROJECTED_ROWS = 1_000;
const MAX_PROJECTED_FIELDS = 64;
const MAX_STRING_ARGUMENT_LENGTH = 10_000;
// Large plugin templates are administrator-authored literals. Keep every
// dynamic source and all process/script arguments on the smaller limit.
const MAX_PLUGIN_LITERAL_ARGUMENT_LENGTH = 200_000;
const JSON_PATH_RE = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_PLUGIN_IDENTITY_ARGUMENTS = new Set([
  'caller',
  'calleropenid',
  'callerunionid',
  'email',
  'openid',
  'phone',
  'phonenumber',
  'mobile',
  'requestuseropenid',
  'requestuserunionid',
  'requestuseremail',
  'requestuserid',
  'unionid',
  'userid',
  'useropenid',
  'userunionid',
]);

function isForbiddenPluginIdentityArgument(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (FORBIDDEN_PLUGIN_IDENTITY_ARGUMENTS.has(normalized)) return true;
  return /^(?:caller|requestuser|user|sender|actor|principal)(?:id|openid|unionid|email|mail|phone|phonenumber|mobile)$/u.test(normalized);
}

export class CommandExecutorError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommandExecutorError';
  }
}

export type ExecutorArgumentSource = 'literal' | 'param' | `context:${string}`;

export interface CommandExecutorArgument {
  flag?: string;
  type: 'string' | 'integer' | 'enum';
  required: boolean;
  pattern?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: Array<string | number>;
  default?: string | number;
  accepts: ExecutorArgumentSource[];
}

export interface CommandExecutorOutput {
  /** `markdown` means the complete stdout/tool text. Any other value is a
   * JSON field path containing markdown. */
  content?: 'markdown' | string;
  exposeFields?: string[];
  container?: string;
  exposeRowFields?: string[];
  labels?: Record<string, string>;
  labelsFrom?: string;
  totalRowsField?: string;
  auditFields: string[];
  errorField?: string;
  maxContentBytes?: number;
}

export interface CommandExecutorOutputResult {
  projected: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  columns: Array<{ key: string; label: string }>;
  totalRows: number;
  content?: string;
  audit: Record<string, unknown>;
  errorCode?: string;
}

export interface ProcessCommandExecutor {
  id: string;
  kind: 'process' | 'script';
  executable: { realpath: string };
  fixedArgs: string[];
  arguments: Record<string, CommandExecutorArgument>;
  scriptArtifacts: Array<{ realpath: string; sha256: string; size: number }>;
  policy: {
    schedulable: boolean;
    allowHandoff: boolean;
    handoffIncludesInput: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
  };
  output: CommandExecutorOutput;
  revision: string;
}

export interface PluginToolCommandExecutor {
  id: string;
  kind: 'plugin-tool';
  plugin: string;
  tool: string;
  minimumVersion: string;
  output: CommandExecutorOutput;
  arguments: Record<string, CommandExecutorArgument>;
  policy: {
    schedulable: boolean;
    allowHandoff: boolean;
    handoffIncludesInput: boolean;
    timeoutMs: number;
  };
  revision: string;
}

export type CommandExecutor = ProcessCommandExecutor | PluginToolCommandExecutor;

export interface CommandExecutorRegistry {
  filePath: string;
  executors: Map<string, CommandExecutor>;
  renderers: Map<string, CommandRenderer>;
}

export interface CommandRenderer {
  id: string;
  executable: { realpath: string };
  fixedArgs: string[];
  scriptArtifacts: Array<{ realpath: string; sha256: string; size: number }>;
  policy: {
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  };
  revision: string;
}

export interface CommandExecutorAuthoringSchema {
  id: string;
  arguments: Array<{
    name: string;
    type: CommandExecutorArgument['type'];
    required: boolean;
    accepts: ExecutorArgumentSource[];
    pattern?: string;
    maxLength?: number;
    min?: number;
    max?: number;
    values?: Array<string | number>;
    default?: string | number;
  }>;
}

export interface ResolvedExecutorInput {
  value: string | number;
  source: ExecutorArgumentSource;
}

export interface ProcessExecutorResult {
  executorId: string;
  executorRevision: string;
  executionId: string;
  projected: Record<string, unknown>;
  output: CommandExecutorOutputResult;
  stdoutBytes: number;
  truncated: boolean;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface CommandRendererResult {
  rendererId: string;
  rendererRevision: string;
  markdown: string;
  stdoutBytes: number;
  durationMs: number;
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
    throw new CommandExecutorError('executor_unknown_field', `${context} 包含未知字段：${unknown.join(', ')}`);
  }
}

function nonBlank(value: unknown, field: string, max = 1_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandExecutorError('executor_invalid_field', `${field} 必须是非空字符串`);
  }
  if (value.length > max || value.includes('\0')) {
    throw new CommandExecutorError('executor_invalid_field', `${field} 格式或长度不合法`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new CommandExecutorError('executor_invalid_field', `${field} 必须在 ${min}-${max} 之间`);
  }
  return value as number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

const binaryDigestCache = new Map<string, { fingerprint: string; digest: string }>();

/** Observability only. Binary drift warns but never changes the blocking
 * executor revision. Cache by immutable-enough local stat metadata so normal
 * command lookup does not repeatedly hash a large third-party executable. */
export function commandExecutorBinaryDigest(executor: ProcessCommandExecutor): string {
  const stat = statSync(executor.executable.realpath);
  const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = binaryDigestCache.get(executor.executable.realpath);
  if (cached?.fingerprint === fingerprint) return cached.digest;
  const digest = sha256File(executor.executable.realpath);
  binaryDigestCache.set(executor.executable.realpath, { fingerprint, digest });
  return digest;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalRegularFile(path: string, field: string, maxBytes?: number, readContent = true): {
  realpath: string;
  bytes: Buffer;
} {
  if (!isAbsolute(path)) {
    throw new CommandExecutorError('executor_path_invalid', `${field} 必须是绝对路径`);
  }
  if (!existsSync(path)) throw new CommandExecutorError('executor_path_missing', `${field} 不存在`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CommandExecutorError('executor_path_invalid', `${field} 必须是普通文件且禁止符号链接`);
  }
  const actual = realpathSync(path);
  if (actual !== resolve(path)) {
    throw new CommandExecutorError('executor_path_not_canonical', `${field} 必须填写 canonical realpath`);
  }
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new CommandExecutorError('executor_artifact_too_large', `${field} 超过 ${maxBytes} 字节`);
  }
  return { realpath: actual, bytes: readContent ? readFileSync(actual) : Buffer.alloc(0) };
}

function parseAccepts(value: unknown, field: string): ExecutorArgumentSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new CommandExecutorError('executor_argument_invalid', `${field} 必须是非空数组`);
  }
  const accepts = value.map((candidate) => {
    if (candidate === 'literal' || candidate === 'param') return candidate;
    if (typeof candidate === 'string' && /^context:(?:caller\.(?:open_id|union_id|name)|chat\.(?:id|type)|message\.id|today|now)$/.test(candidate)) {
      return candidate as ExecutorArgumentSource;
    }
    throw new CommandExecutorError('executor_argument_invalid', `${field} 包含未知来源：${String(candidate)}`);
  });
  return [...new Set(accepts)];
}

function parseArgument(
  name: string,
  value: unknown,
  options: { allowLargePluginLiteral: boolean },
): CommandExecutorArgument {
  if (!ARGUMENT_NAME_RE.test(name) || !isPlainObject(value)) {
    throw new CommandExecutorError('executor_argument_invalid', `arguments.${name} 不合法`);
  }
  onlyKeys(value, ['flag', 'type', 'required', 'pattern', 'maxLength', 'min', 'max', 'values', 'default', 'accepts'], `arguments.${name}`);
  const flag = value.flag === undefined ? undefined : nonBlank(value.flag, `arguments.${name}.flag`, 100);
  if (flag && (!/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag) || flag === '--')) {
    throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.flag 不合法`);
  }
  const required = value.required === true;
  const accepts = parseAccepts(value.accepts, `arguments.${name}.accepts`);
  if (value.type === 'string') {
    const maxAllowedLength = options.allowLargePluginLiteral
      && accepts.length === 1
      && accepts[0] === 'literal'
      ? MAX_PLUGIN_LITERAL_ARGUMENT_LENGTH
      : MAX_STRING_ARGUMENT_LENGTH;
    const maxLength = positiveInteger(value.maxLength ?? 1_000, `arguments.${name}.maxLength`, 1, maxAllowedLength);
    if (value.pattern !== undefined) {
      const pattern = nonBlank(value.pattern, `arguments.${name}.pattern`, 2_000);
      try { new RegExp(pattern, 'u'); } catch {
        throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.pattern 不是有效正则`);
      }
    }
    if (value.default !== undefined && typeof value.default !== 'string') {
      throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.default 必须是字符串`);
    }
    return {
      ...(flag ? { flag } : {}), type: 'string', required, accepts, maxLength,
      ...(value.pattern === undefined ? {} : { pattern: value.pattern as string }),
      ...(value.default === undefined ? {} : { default: value.default as string }),
    };
  }
  if (value.type === 'integer') {
    const min = positiveInteger(value.min, `arguments.${name}.min`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const max = positiveInteger(value.max, `arguments.${name}.max`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (min > max) throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.min 不能大于 max`);
    if (value.default !== undefined && (!Number.isSafeInteger(value.default) || (value.default as number) < min || (value.default as number) > max)) {
      throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.default 超出范围`);
    }
    return {
      ...(flag ? { flag } : {}), type: 'integer', required, accepts, min, max,
      ...(value.default === undefined ? {} : { default: value.default as number }),
    };
  }
  if (value.type === 'enum') {
    if (!Array.isArray(value.values) || value.values.length === 0 || value.values.length > 100) {
      throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.values 必须有 1-100 项`);
    }
    const values = value.values.map((candidate) => {
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1_000 && !candidate.includes('\0')) return candidate;
      throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.values 含非法值`);
    });
    if (value.default !== undefined && !values.some(candidate => candidate === value.default)) {
      throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.default 不在 values 中`);
    }
    return {
      ...(flag ? { flag } : {}), type: 'enum', required, accepts, values,
      ...(value.default === undefined ? {} : { default: value.default as string | number }),
    };
  }
  throw new CommandExecutorError('executor_argument_invalid', `arguments.${name}.type 不支持`);
}

function parseOutput(value: unknown, executorId: string): CommandExecutorOutput {
  if (!isPlainObject(value)) throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 必须是对象`);
  onlyKeys(value, [
    'content', 'exposeFields', 'container', 'exposeRowFields', 'labels', 'labelsFrom',
    'totalRowsField', 'auditFields', 'errorField', 'maxContentBytes',
  ], `${executorId}.output`);
  const flat = Array.isArray(value.exposeFields);
  const collection = value.container !== undefined || value.exposeRowFields !== undefined;
  const hasContent = value.content !== undefined;
  if (flat && collection) throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 不能同时声明 exposeFields 和 container`);
  if (!flat && !collection && !hasContent) {
    throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 必须声明 content、exposeFields 或 container+exposeRowFields`);
  }
  if (collection && (value.container === undefined || value.exposeRowFields === undefined)) {
    throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 的 container 与 exposeRowFields 必须同时声明`);
  }
  const parseFields = (candidate: unknown, field: string): string[] => {
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > MAX_PROJECTED_FIELDS) {
      throw new CommandExecutorError('executor_output_invalid', `${field} 必须有 1-${MAX_PROJECTED_FIELDS} 项`);
    }
    const fields = candidate.map((item, index) => nonBlank(item, `${field}[${index}]`, 128));
    if (fields.some(item => !JSON_PATH_RE.test(item)
      || item.split('.').some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment)))
      || new Set(fields).size !== fields.length) {
      throw new CommandExecutorError('executor_output_invalid', `${field} 含非法或重复字段`);
    }
    return fields;
  };
  const parsePath = (candidate: unknown, field: string): string => {
    const path = nonBlank(candidate, field, 128);
    if (!JSON_PATH_RE.test(path) || path.split('.').some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
      throw new CommandExecutorError('executor_output_invalid', `${field} 不合法`);
    }
    return path;
  };
  const content = value.content === undefined
    ? undefined
    : value.content === 'markdown'
      ? 'markdown'
      : parsePath(value.content, `${executorId}.output.content`);
  const exposeFields = flat
    ? parseFields(value.exposeFields, `${executorId}.output.exposeFields`)
    : undefined;
  const container = collection ? parsePath(value.container, `${executorId}.output.container`) : undefined;
  const exposeRowFields = collection
    ? parseFields(value.exposeRowFields, `${executorId}.output.exposeRowFields`)
    : undefined;
  let labels: Record<string, string> | undefined;
  if (value.labels !== undefined) {
    if (!isPlainObject(value.labels) || Object.keys(value.labels).length > MAX_PROJECTED_FIELDS) {
      throw new CommandExecutorError('executor_output_invalid', `${executorId}.output.labels 必须是最多 ${MAX_PROJECTED_FIELDS} 项的对象`);
    }
    labels = Object.fromEntries(Object.entries(value.labels).map(([key, label]) => [
      parsePath(key, `${executorId}.output.labels.${key}`),
      nonBlank(label, `${executorId}.output.labels.${key}`, 256),
    ]));
  }
  if (labels && value.labelsFrom !== undefined) {
    throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 的 labels 与 labelsFrom 不能同时声明`);
  }
  if ((labels || value.labelsFrom !== undefined || value.totalRowsField !== undefined) && !flat && !collection) {
    throw new CommandExecutorError('executor_output_invalid', `${executorId}.output 的表格元数据只能用于数据输出`);
  }
  const maxContentBytes = hasContent
    ? positiveInteger(value.maxContentBytes, `${executorId}.output.maxContentBytes`, 1, 10 * 1024 * 1024)
    : undefined;
  if (!hasContent && value.maxContentBytes !== undefined) {
    throw new CommandExecutorError('executor_output_invalid', `${executorId}.output.maxContentBytes 只能与 content 一起声明`);
  }
  return {
    ...(content === undefined ? {} : { content }),
    ...(exposeFields === undefined ? {} : { exposeFields }),
    ...(container === undefined ? {} : { container }),
    ...(exposeRowFields === undefined ? {} : { exposeRowFields }),
    ...(labels === undefined ? {} : { labels }),
    ...(value.labelsFrom === undefined ? {} : { labelsFrom: parsePath(value.labelsFrom, `${executorId}.output.labelsFrom`) }),
    ...(value.totalRowsField === undefined ? {} : { totalRowsField: parsePath(value.totalRowsField, `${executorId}.output.totalRowsField`) }),
    auditFields: value.auditFields === undefined
      ? []
      : parseFields(value.auditFields, `${executorId}.output.auditFields`),
    ...(value.errorField === undefined ? {} : { errorField: parsePath(value.errorField, `${executorId}.output.errorField`) }),
    ...(maxContentBytes === undefined ? {} : { maxContentBytes }),
  };
}

function parseArguments(
  value: unknown,
  id: string,
  options: { allowLargePluginLiteral?: boolean } = {},
): Record<string, CommandExecutorArgument> {
  if (!isPlainObject(value)) throw new CommandExecutorError('executor_argument_invalid', `${id}.arguments 必须是对象`);
  if (Object.keys(value).length > 32) throw new CommandExecutorError('executor_argument_invalid', `${id}.arguments 最多 32 项`);
  return Object.fromEntries(Object.entries(value).map(([name, argument]) => [
    name,
    parseArgument(name, argument, { allowLargePluginLiteral: options.allowLargePluginLiteral === true }),
  ]));
}

function parseCommonPolicy(value: unknown, id: string): {
  schedulable: boolean;
  allowHandoff: boolean;
  handoffIncludesInput: boolean;
  timeoutMs: number;
} {
  if (!isPlainObject(value)) throw new CommandExecutorError('executor_policy_invalid', `${id}.policy 必须是对象`);
  for (const field of ['schedulable', 'allowHandoff', 'handoffIncludesInput'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      throw new CommandExecutorError('executor_policy_invalid', `${id}: ${field} 必须是布尔值`);
    }
  }
  return {
    schedulable: value.schedulable === true,
    allowHandoff: value.allowHandoff === true,
    handoffIncludesInput: value.handoffIncludesInput === true,
    timeoutMs: positiveInteger(value.timeoutMs ?? 120_000, `${id}.policy.timeoutMs`, 100, 10 * 60_000),
  };
}

function parsePluginToolExecutor(
  value: Record<string, unknown>,
  id: string,
  index: number,
): PluginToolCommandExecutor {
  onlyKeys(value, ['id', 'kind', 'plugin', 'tool', 'minimumVersion', 'arguments', 'policy', 'output'], `executors[${index}]`);
  let pluginId: string;
  try {
    pluginId = assertValidPluginId(value.plugin, `${id}.plugin`);
  } catch {
    throw new CommandExecutorError('executor_plugin_invalid', `${id}.plugin 不合法`);
  }
  const tool = nonBlank(value.tool, `${id}.tool`, 128);
  if (!TOOL_NAME_RE.test(tool)) {
    throw new CommandExecutorError('executor_plugin_invalid', `${id}.tool 不合法`);
  }
  const minimumVersion = nonBlank(value.minimumVersion, `${id}.minimumVersion`, 64);
  if (!STABLE_VERSION_RE.test(minimumVersion)) {
    throw new CommandExecutorError('executor_plugin_invalid', `${id}.minimumVersion 必须是稳定语义版本 x.y.z`);
  }
  const output = parseOutput(value.output, id);
  const argumentsSchema = parseArguments(value.arguments, id, { allowLargePluginLiteral: true });
  const declaresIdentityArgument = Object.keys(argumentsSchema).some(isForbiddenPluginIdentityArgument);
  if (declaresIdentityArgument
    || Object.values(argumentsSchema).some(argument => argument.accepts.some(source => source.startsWith('context:caller.')))) {
    throw new CommandExecutorError(
      'executor_identity_invalid',
      `${id}: plugin-tool 身份只允许由宿主通过可信 _meta 注入，arguments 不得声明 caller 身份来源`,
    );
  }
  if (!isPlainObject(value.policy)) {
    throw new CommandExecutorError('executor_policy_invalid', `${id}.policy 必须是对象`);
  }
  onlyKeys(value.policy, ['schedulable', 'allowHandoff', 'handoffIncludesInput', 'timeoutMs'], `${id}.policy`);
  const normalized = {
    id,
    kind: 'plugin-tool',
    plugin: pluginId,
    tool,
    minimumVersion,
    output,
    arguments: argumentsSchema,
    policy: parseCommonPolicy(value.policy, id),
  } satisfies Omit<PluginToolCommandExecutor, 'revision'>;
  return { ...normalized, revision: sha256(canonicalJson(normalized)) };
}

function parseProcessExecutor(
  value: Record<string, unknown>,
  id: string,
  index: number,
): ProcessCommandExecutor {
  onlyKeys(value, ['id', 'kind', 'executable', 'fixedArgs', 'arguments', 'scriptArtifacts', 'policy', 'output'], `executors[${index}]`);
  if (value.kind !== 'process' && value.kind !== 'script') {
    throw new CommandExecutorError('executor_kind_invalid', `${id}.kind 必须是 process、script 或 plugin-tool`);
  }
  if (!isPlainObject(value)) throw new CommandExecutorError('executor_invalid', `executors[${index}] 必须是对象`);
  if (!isPlainObject(value.executable)) throw new CommandExecutorError('executor_path_invalid', `${id}.executable 必须是对象`);
  onlyKeys(value.executable, ['realpath'], `${id}.executable`);
  const executable = assertCanonicalRegularFile(
    nonBlank(value.executable.realpath, `${id}.executable.realpath`, 4_096),
    `${id}.executable.realpath`,
    undefined,
    false,
  );
  if (!Array.isArray(value.fixedArgs) || value.fixedArgs.length > 64) {
    throw new CommandExecutorError('executor_invalid_fixed_args', `${id}.fixedArgs 必须是最多 64 项的数组`);
  }
  const fixedArgs = value.fixedArgs.map((arg, argIndex) => nonBlank(arg, `${id}.fixedArgs[${argIndex}]`, 4_096));
  const args = parseArguments(value.arguments, id);
  if (basename(executable.realpath) === 'lark-cli') {
    const asIndex = fixedArgs.indexOf('--as');
    if (asIndex < 0 || fixedArgs[asIndex + 1] !== 'bot' || Object.values(args).some(arg => arg.flag === '--as')) {
      throw new CommandExecutorError(
        'executor_identity_invalid',
        `${id}: lark-cli 必须在 fixedArgs 中钉死 --as bot，arguments 不得覆盖身份模式`,
      );
    }
  }
  if (!isPlainObject(value.policy)) throw new CommandExecutorError('executor_policy_invalid', `${id}.policy 必须是对象`);
  onlyKeys(value.policy, ['schedulable', 'allowHandoff', 'handoffIncludesInput', 'timeoutMs', 'maxOutputBytes'], `${id}.policy`);
  const scriptPaths = value.scriptArtifacts ?? [];
  if (!Array.isArray(scriptPaths) || scriptPaths.length > MAX_ARTIFACTS) {
    throw new CommandExecutorError('executor_artifacts_invalid', `${id}.scriptArtifacts 最多 ${MAX_ARTIFACTS} 项`);
  }
  const scriptArtifacts = scriptPaths.map((path, artifactIndex) => {
    const artifact = assertCanonicalRegularFile(
      nonBlank(path, `${id}.scriptArtifacts[${artifactIndex}]`, 4_096),
      `${id}.scriptArtifacts[${artifactIndex}]`,
      MAX_ARTIFACT_BYTES,
    );
    return { realpath: artifact.realpath, sha256: sha256(artifact.bytes), size: artifact.bytes.length };
  });
  if (new Set(scriptArtifacts.map(item => item.realpath)).size !== scriptArtifacts.length) {
    throw new CommandExecutorError('executor_artifacts_invalid', `${id}.scriptArtifacts 禁止重复`);
  }
  if (value.kind === 'script') {
    if (scriptArtifacts.length === 0) throw new CommandExecutorError('executor_artifacts_required', `${id}: script 执行器必须声明 scriptArtifacts`);
    const fixedPaths = new Set(fixedArgs.filter(isAbsolute).map(path => resolve(path)));
    if (!scriptArtifacts.some(item => fixedPaths.has(item.realpath))) {
      throw new CommandExecutorError('executor_entry_artifact_missing', `${id}: fixedArgs 中的入口脚本必须声明在 scriptArtifacts`);
    }
  }
  const normalized = {
    id,
    kind: value.kind,
    executable: { realpath: executable.realpath },
    fixedArgs,
    arguments: args,
    scriptArtifacts,
    policy: {
      ...parseCommonPolicy(value.policy, id),
      maxOutputBytes: positiveInteger(value.policy.maxOutputBytes ?? 1024 * 1024, `${id}.policy.maxOutputBytes`, 1_024, 10 * 1024 * 1024),
    },
    output: parseOutput(value.output, id),
  } satisfies Omit<ProcessCommandExecutor, 'revision'>;
  const revision = sha256(canonicalJson(normalized));
  return { ...normalized, revision };
}

function parseExecutor(value: unknown, index: number): CommandExecutor {
  if (!isPlainObject(value)) throw new CommandExecutorError('executor_invalid', `executors[${index}] 必须是对象`);
  const id = nonBlank(value.id, `executors[${index}].id`, 128);
  if (!EXECUTOR_ID_RE.test(id) || id.startsWith('builtin.')) {
    throw new CommandExecutorError('executor_id_invalid', `非法 executor id：${id}`);
  }
  if (value.kind === 'plugin-tool') return parsePluginToolExecutor(value, id, index);
  return parseProcessExecutor(value, id, index);
}

function parseRenderer(value: unknown, index: number): CommandRenderer {
  if (!isPlainObject(value)) throw new CommandExecutorError('renderer_invalid', `renderers[${index}] 必须是对象`);
  onlyKeys(value, ['id', 'executable', 'fixedArgs', 'scriptArtifacts', 'policy'], `renderers[${index}]`);
  const id = nonBlank(value.id, `renderers[${index}].id`, 128);
  if (!EXECUTOR_ID_RE.test(id) || id.startsWith('builtin.')) {
    throw new CommandExecutorError('renderer_id_invalid', `非法 renderer id：${id}`);
  }
  if (!isPlainObject(value.executable)) throw new CommandExecutorError('renderer_path_invalid', `${id}.executable 必须是对象`);
  onlyKeys(value.executable, ['realpath'], `${id}.executable`);
  const executable = assertCanonicalRegularFile(
    nonBlank(value.executable.realpath, `${id}.executable.realpath`, 4_096),
    `${id}.executable.realpath`,
    undefined,
    false,
  );
  if (!Array.isArray(value.fixedArgs) || value.fixedArgs.length > 64) {
    throw new CommandExecutorError('renderer_invalid_fixed_args', `${id}.fixedArgs 必须是最多 64 项的数组`);
  }
  const fixedArgs = value.fixedArgs.map((arg, argIndex) => nonBlank(arg, `${id}.fixedArgs[${argIndex}]`, 4_096));
  const scriptPaths = value.scriptArtifacts ?? [];
  if (!Array.isArray(scriptPaths) || scriptPaths.length === 0 || scriptPaths.length > MAX_ARTIFACTS) {
    throw new CommandExecutorError('renderer_artifacts_invalid', `${id}.scriptArtifacts 必须有 1-${MAX_ARTIFACTS} 项`);
  }
  const scriptArtifacts = scriptPaths.map((path, artifactIndex) => {
    const artifact = assertCanonicalRegularFile(
      nonBlank(path, `${id}.scriptArtifacts[${artifactIndex}]`, 4_096),
      `${id}.scriptArtifacts[${artifactIndex}]`,
      MAX_ARTIFACT_BYTES,
    );
    return { realpath: artifact.realpath, sha256: sha256(artifact.bytes), size: artifact.bytes.length };
  });
  if (new Set(scriptArtifacts.map(item => item.realpath)).size !== scriptArtifacts.length) {
    throw new CommandExecutorError('renderer_artifacts_invalid', `${id}.scriptArtifacts 禁止重复`);
  }
  const fixedPaths = new Set(fixedArgs.filter(isAbsolute).map(path => resolve(path)));
  if (!scriptArtifacts.some(item => fixedPaths.has(item.realpath))) {
    throw new CommandExecutorError('renderer_entry_artifact_missing', `${id}: fixedArgs 中的入口脚本必须声明在 scriptArtifacts`);
  }
  if (!isPlainObject(value.policy)) throw new CommandExecutorError('renderer_policy_invalid', `${id}.policy 必须是对象`);
  onlyKeys(value.policy, ['timeoutMs', 'maxInputBytes', 'maxOutputBytes'], `${id}.policy`);
  const normalized = {
    id,
    executable: { realpath: executable.realpath },
    fixedArgs,
    scriptArtifacts,
    policy: {
      timeoutMs: positiveInteger(value.policy.timeoutMs, `${id}.policy.timeoutMs`, 100, 10 * 60_000),
      maxInputBytes: positiveInteger(value.policy.maxInputBytes, `${id}.policy.maxInputBytes`, 1_024, 10 * 1024 * 1024),
      maxOutputBytes: positiveInteger(value.policy.maxOutputBytes, `${id}.policy.maxOutputBytes`, 1_024, 10 * 1024 * 1024),
    },
  } satisfies Omit<CommandRenderer, 'revision'>;
  return { ...normalized, revision: sha256(canonicalJson(normalized)) };
}

export function commandExecutorRegistryPath(): string {
  return process.env.BOTMUX_COMMAND_EXECUTORS_FILE || join(homedir(), '.botmux', 'command-executors.yaml');
}

export function loadCommandExecutorRegistry(filePath = commandExecutorRegistryPath()): CommandExecutorRegistry {
  if (!existsSync(filePath)) {
    return { filePath, executors: new Map(), renderers: new Map() };
  }
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new CommandExecutorError('executor_registry_invalid', '执行器白名单必须是小于 1 MiB 的普通文件，且禁止符号链接');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(filePath, 'utf8'), { strict: true, uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new CommandExecutorError('executor_registry_yaml_invalid', `执行器白名单 YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) throw new CommandExecutorError('executor_registry_invalid', '执行器白名单必须是对象');
  onlyKeys(parsed, ['schemaVersion', 'executors', 'renderers'], 'executor registry');
  if (parsed.schemaVersion !== 2) {
    throw new CommandExecutorError('executor_registry_version_unsupported', '执行器白名单仅支持 schemaVersion=2');
  }
  if (!Array.isArray(parsed.executors) || parsed.executors.length > MAX_EXECUTORS) {
    throw new CommandExecutorError('executor_registry_invalid', `executors 必须是最多 ${MAX_EXECUTORS} 项的数组`);
  }
  const items = parsed.executors.map(parseExecutor);
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new CommandExecutorError('executor_registry_duplicate', 'executor id 不能重复');
  }
  const rendererValues = parsed.renderers ?? [];
  if (!Array.isArray(rendererValues) || rendererValues.length > MAX_EXECUTORS) {
    throw new CommandExecutorError('executor_registry_invalid', `renderers 必须是最多 ${MAX_EXECUTORS} 项的数组`);
  }
  const renderers = rendererValues.map(parseRenderer);
  if (new Set(renderers.map(item => item.id)).size !== renderers.length) {
    throw new CommandExecutorError('renderer_registry_duplicate', 'renderer id 不能重复');
  }
  return {
    filePath: realpathSync(filePath),
    executors: new Map(items.map(item => [item.id, item])),
    renderers: new Map(renderers.map(item => [item.id, item])),
  };
}

export function resolveCommandExecutor(executorId: string): CommandExecutor {
  const registry = loadCommandExecutorRegistry();
  const executor = registry.executors.get(executorId);
  if (!executor) throw new CommandExecutorError('executor_not_found', `执行器白名单中不存在：${executorId}`);
  return executor;
}

export function resolveCommandRenderer(rendererId: string): CommandRenderer | 'builtin.table' | 'builtin.content' {
  if (rendererId === 'builtin.table' || rendererId === 'builtin.content') return rendererId;
  const renderer = loadCommandExecutorRegistry().renderers.get(rendererId);
  if (!renderer) throw new CommandExecutorError('renderer_not_found', `渲染器白名单中不存在：${rendererId}`);
  return renderer;
}

export function isPluginToolCommandExecutor(executor: CommandExecutor): executor is PluginToolCommandExecutor {
  return executor.kind === 'plugin-tool';
}

export function pluginVersionAtLeast(installedVersion: string, minimumVersion: string): boolean {
  const installed = STABLE_VERSION_RE.exec(installedVersion);
  const minimum = STABLE_VERSION_RE.exec(minimumVersion);
  if (!installed || !minimum) return false;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(installed[index]);
    const right = Number(minimum[index]);
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Model-safe, read-only authoring view. Deliberately excludes executable
 * paths, fixed arguments, artifact paths/digests, output projection and
 * registry location; callers receive only the public input contract needed to
 * draft a compatible Frozen Command definition.
 */
export function listCommandExecutorAuthoringSchemas(): CommandExecutorAuthoringSchema[] {
  return [...loadCommandExecutorRegistry().executors.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(executor => ({
      id: executor.id,
      arguments: Object.entries(executor.arguments).map(([name, argument]) => ({
        name,
        type: argument.type,
        required: argument.required,
        accepts: [...argument.accepts],
        ...(argument.pattern === undefined ? {} : { pattern: argument.pattern }),
        ...(argument.maxLength === undefined ? {} : { maxLength: argument.maxLength }),
        ...(argument.min === undefined ? {} : { min: argument.min }),
        ...(argument.max === undefined ? {} : { max: argument.max }),
        ...(argument.values === undefined ? {} : { values: [...argument.values] }),
        ...(argument.default === undefined ? {} : { default: argument.default }),
      })),
    }));
}

export function verifyCommandExecutorArtifacts(executor: ProcessCommandExecutor): void {
  for (const expected of executor.scriptArtifacts) {
    const actual = assertCanonicalRegularFile(expected.realpath, `${executor.id}.scriptArtifacts`, MAX_ARTIFACT_BYTES);
    if (actual.bytes.length !== expected.size || sha256(actual.bytes) !== expected.sha256) {
      throw new CommandExecutorError('executor_artifact_changed', `执行器 ${executor.id} 的脚本制品已变化，必须重新确认依赖命令`);
    }
  }
}

function normalizeArgumentValue(name: string, schema: CommandExecutorArgument, input: ResolvedExecutorInput | undefined): string | undefined {
  const candidate = input?.value ?? schema.default;
  if (candidate === undefined) {
    if (schema.required) throw new CommandExecutorError('executor_argument_required', `缺少执行器参数：${name}`);
    return undefined;
  }
  if (input && !schema.accepts.includes(input.source)) {
    throw new CommandExecutorError('executor_argument_source_denied', `${name} 不接受来源 ${input.source}`);
  }
  if (schema.type === 'integer') {
    const text = String(candidate);
    if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw new CommandExecutorError('executor_argument_invalid', `${name} 必须是整数`);
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < schema.min! || number > schema.max!) {
      throw new CommandExecutorError('executor_argument_invalid', `${name} 超出允许范围`);
    }
    return String(number);
  }
  if (schema.type === 'enum') {
    const matched = schema.values!.find(value => String(value) === String(candidate));
    if (matched === undefined) throw new CommandExecutorError('executor_argument_invalid', `${name} 不在允许枚举中`);
    return String(matched);
  }
  const text = String(candidate);
  if (text.length > schema.maxLength! || text.includes('\0')) throw new CommandExecutorError('executor_argument_invalid', `${name} 格式或长度不合法`);
  if (schema.pattern && !new RegExp(schema.pattern, 'u').test(text)) {
    throw new CommandExecutorError('executor_argument_invalid', `${name} 不符合格式约束`);
  }
  return text;
}

export function buildCommandExecutorArgv(
  executor: ProcessCommandExecutor,
  input: Record<string, ResolvedExecutorInput>,
): string[] {
  const unknown = Object.keys(input).filter(name => !Object.hasOwn(executor.arguments, name));
  if (unknown.length > 0) throw new CommandExecutorError('executor_input_unknown', `执行器不接受 input：${unknown.join(', ')}`);
  const argv = [...executor.fixedArgs];
  for (const [name, schema] of Object.entries(executor.arguments)) {
    const value = normalizeArgumentValue(name, schema, input[name]);
    if (value === undefined) continue;
    if (schema.flag) argv.push(schema.flag);
    argv.push(value);
  }
  return argv;
}

function safeJsonDepth(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw new CommandExecutorError('executor_output_too_deep', `执行器 JSON 嵌套超过 ${MAX_JSON_DEPTH} 层`);
  if (Array.isArray(value)) {
    for (const child of value) safeJsonDepth(child, depth + 1);
  } else if (isPlainObject(value)) {
    for (const child of Object.values(value)) safeJsonDepth(child, depth + 1);
  }
}

function projectedPathValue(value: Record<string, unknown>, path: string, error: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      throw new CommandExecutorError('executor_output_field_missing', error);
    }
    current = current[segment];
  }
  return current;
}

function assignProjectedPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const existing = current[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
      continue;
    }
    if (!isPlainObject(existing)) {
      throw new CommandExecutorError('executor_output_projection_conflict', `投影路径冲突：${path}`);
    }
    current = existing;
  }
  current[segments.at(-1)!] = value;
}

export function projectCommandExecutorOutput(
  output: CommandExecutorOutput,
  parsed: unknown,
): Record<string, unknown> {
  if (!isPlainObject(parsed)) throw new CommandExecutorError('executor_output_invalid', '执行器 stdout 必须是 JSON 对象');
  safeJsonDepth(parsed);
  if (output.exposeFields) {
    const projected: Record<string, unknown> = {};
    for (const field of output.exposeFields) {
      assignProjectedPath(
        projected,
        field,
        projectedPathValue(parsed, field, `执行器输出缺少字段：${field}`),
      );
    }
    return projected;
  }
  if (!output.container || !output.exposeRowFields) return {};
  const rawRows = projectedPathValue(
    parsed,
    output.container,
    `执行器输出缺少容器：${output.container}`,
  );
  if (!Array.isArray(rawRows) || rawRows.some(row => !isPlainObject(row))) {
    throw new CommandExecutorError('executor_output_container_invalid', `执行器输出 ${output.container} 必须是对象数组`);
  }
  const rows = rawRows.slice(0, MAX_PROJECTED_ROWS).map((row, index) => {
    const projected: Record<string, unknown> = {};
    for (const field of output.exposeRowFields!) {
      assignProjectedPath(
        projected,
        field,
        projectedPathValue(row, field, `执行器输出第 ${index + 1} 行缺少字段：${field}`),
      );
    }
    return projected;
  });
  const projected: Record<string, unknown> = {};
  assignProjectedPath(projected, output.container, rows);
  return projected;
}

function optionalProjectedPath(value: Record<string, unknown>, path: string): unknown {
  try {
    return projectedPathValue(value, path, `执行器输出缺少字段：${path}`);
  } catch (error) {
    if (error instanceof CommandExecutorError && error.code === 'executor_output_field_missing') return undefined;
    throw error;
  }
}

export function materializeCommandExecutorOutput(
  output: CommandExecutorOutput,
  raw: unknown,
): CommandExecutorOutputResult {
  if (output.content === 'markdown') {
    if (typeof raw !== 'string') throw new CommandExecutorError('executor_output_invalid', 'content: markdown 要求执行器输出 UTF-8 文本');
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > output.maxContentBytes!) throw new CommandExecutorError('executor_content_limit', '执行器内容超过 maxContentBytes');
    return { projected: {}, rows: [], columns: [], totalRows: 0, content: raw, audit: {} };
  }
  if (!isPlainObject(raw)) throw new CommandExecutorError('executor_output_invalid', '执行器输出必须是 JSON 对象');
  safeJsonDepth(raw);
  const sourceRows = output.container
    ? projectedPathValue(raw, output.container, `执行器输出缺少容器：${output.container}`)
    : undefined;
  if (output.container && (!Array.isArray(sourceRows) || sourceRows.some(row => !isPlainObject(row)))) {
    throw new CommandExecutorError('executor_output_container_invalid', `执行器输出 ${output.container} 必须是对象数组`);
  }
  const projected = projectCommandExecutorOutput(output, raw);
  const rows = output.container
    ? (projectedPathValue(projected, output.container, `执行器输出缺少容器：${output.container}`) as Array<Record<string, unknown>>)
    : output.exposeFields
      ? [projected]
      : [];
  let labels = output.labels ?? {};
  if (output.labelsFrom) {
    const rawLabels = projectedPathValue(raw, output.labelsFrom, `执行器输出缺少字段：${output.labelsFrom}`);
    if (!Array.isArray(rawLabels) || rawLabels.length > MAX_PROJECTED_FIELDS) {
      throw new CommandExecutorError('executor_output_invalid', `${output.labelsFrom} 必须是列说明数组`);
    }
    labels = Object.fromEntries(rawLabels.map((item, index) => {
      if (!isPlainObject(item) || typeof item.name !== 'string' || !item.name
        || (item.description !== undefined && item.description !== null
          && (typeof item.description !== 'string' || item.description.length > 256))) {
        throw new CommandExecutorError('executor_output_invalid', `${output.labelsFrom}[${index}] 必须包含 name，description 必须是字符串或 null`);
      }
      return [item.name, typeof item.description === 'string' && item.description ? item.description : item.name];
    }));
  }
  const keys = output.container ? output.exposeRowFields! : output.exposeFields ?? [];
  const columns = keys.map(key => ({ key, label: labels[key] ?? key }));
  const sourceRowCount = Array.isArray(sourceRows) ? sourceRows.length : rows.length;
  const rawTotalRows = output.totalRowsField ? projectedPathValue(raw, output.totalRowsField, `执行器输出缺少字段：${output.totalRowsField}`) : sourceRowCount;
  if (!Number.isSafeInteger(rawTotalRows) || (rawTotalRows as number) < sourceRowCount) {
    throw new CommandExecutorError('executor_output_invalid', '执行器输出总行数不合法');
  }
  if (output.totalRowsField) assignProjectedPath(projected, output.totalRowsField, rawTotalRows);
  const audit = Object.fromEntries(output.auditFields.map(path => [path, projectedPathValue(raw, path, `执行器输出缺少字段：${path}`)]));
  const rawError = output.errorField ? optionalProjectedPath(raw, output.errorField) : undefined;
  if (rawError !== undefined && rawError !== null && typeof rawError !== 'string') {
    throw new CommandExecutorError('executor_output_invalid', `${output.errorField} 必须是字符串或 null`);
  }
  let content: string | undefined;
  if (output.content) {
    const rawContent = projectedPathValue(raw, output.content, `执行器输出缺少字段：${output.content}`);
    if (typeof rawContent !== 'string') throw new CommandExecutorError('executor_output_invalid', `${output.content} 必须是字符串`);
    if (Buffer.byteLength(rawContent, 'utf8') > output.maxContentBytes!) {
      throw new CommandExecutorError('executor_content_limit', '执行器内容超过 maxContentBytes');
    }
    content = rawContent;
  }
  return {
    projected,
    rows,
    columns,
    totalRows: rawTotalRows as number,
    ...(content === undefined ? {} : { content }),
    audit,
    ...(typeof rawError === 'string' && rawError ? { errorCode: rawError } : {}),
  };
}

function terminateProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* direct fallback below */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
}

function runnerEnv(input: { botConfig: Pick<BotConfig, 'larkAppId' | 'larkAppSecret'>; home: string; executable: string; fixedArgs: string[] }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: input.home,
    TMPDIR: input.home,
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  applySessionOwnerEnv(env, undefined);
  if (basename(input.executable) === 'lark-cli') {
    if (!input.botConfig.larkAppId || !input.botConfig.larkAppSecret) {
      throw new CommandExecutorError('executor_identity_unavailable', '当前 Bot 身份凭证不可用，拒绝启动 lark-cli');
    }
    env.LARKSUITE_CLI_APP_ID = input.botConfig.larkAppId;
    env.LARKSUITE_CLI_APP_SECRET = input.botConfig.larkAppSecret;
  }
  return env;
}

export async function runProcessCommandExecutor(input: {
  executor: ProcessCommandExecutor;
  values: Record<string, ResolvedExecutorInput>;
  botConfig: Pick<BotConfig, 'larkAppId' | 'larkAppSecret'>;
  workingDir?: string;
  executionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ProcessExecutorResult> {
  if (input.signal?.aborted) {
    throw new CommandExecutorError('executor_cancelled', `执行器 ${input.executor.id} 已取消`);
  }
  verifyCommandExecutorArtifacts(input.executor);
  const argv = buildCommandExecutorArgv(input.executor, input.values);
  const executionId = input.executionId ?? randomUUID();
  const startedAt = Date.now();
  const home = mkdtempSync(join(tmpdir(), 'botmux-executor-'));
  const env = runnerEnv({
    botConfig: input.botConfig,
    home,
    executable: input.executor.executable.realpath,
    fixedArgs: input.executor.fixedArgs,
  });
  try {
    return await new Promise<ProcessExecutorResult>((resolvePromise, rejectPromise) => {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let terminalError: CommandExecutorError | undefined;
      let settled = false;
      const child = spawn(input.executor.executable.realpath, argv, {
        cwd: input.workingDir || process.cwd(),
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finishError = (error: CommandExecutorError): void => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };
      const onAbort = (): void => {
        if (settled) return;
        terminalError = new CommandExecutorError('executor_cancelled', `执行器 ${input.executor.id} 已取消`);
        terminateProcessGroup(child);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        terminalError = new CommandExecutorError('executor_timeout', `执行器 ${input.executor.id} 超时`);
        terminateProcessGroup(child);
      }, Math.min(input.timeoutMs ?? input.executor.policy.timeoutMs, input.executor.policy.timeoutMs));
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > input.executor.policy.maxOutputBytes) {
          terminalError = new CommandExecutorError('executor_output_limit', `执行器 ${input.executor.id} 输出超过上限`);
          terminateProcessGroup(child);
          return;
        }
        stdout.push(buffer);
      });
      child.stderr?.resume();
      child.on('error', (error) => {
        clearTimeout(timer);
        finishError(new CommandExecutorError('executor_spawn_failed', `执行器 ${input.executor.id} 启动失败`, { cause: error }));
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        if (settled) return;
        if (terminalError) return finishError(terminalError);
        if (exitCode !== 0) return finishError(new CommandExecutorError('executor_non_zero_exit', `执行器 ${input.executor.id} 退出码 ${String(exitCode)}`));
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
        } catch (error) {
          return finishError(new CommandExecutorError('executor_output_encoding', '执行器 stdout 不是有效 UTF-8', { cause: error }));
        }
        try {
          let raw: unknown = text;
          if (input.executor.output.content !== 'markdown') {
            try { raw = JSON.parse(text); } catch (error) {
              return finishError(new CommandExecutorError('executor_output_json', '执行器 stdout 不是有效 JSON', { cause: error }));
            }
          }
          const output = materializeCommandExecutorOutput(input.executor.output, raw);
          settled = true;
          input.signal?.removeEventListener('abort', onAbort);
          resolvePromise({
            executorId: input.executor.id,
            executorRevision: input.executor.revision,
            executionId,
            projected: output.projected,
            output,
            stdoutBytes,
            truncated: false,
            exitCode: exitCode ?? 0,
            signal,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          finishError(error instanceof CommandExecutorError
            ? error
            : new CommandExecutorError('executor_output_invalid', error instanceof Error ? error.message : String(error)));
        }
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function verifyCommandRendererArtifacts(renderer: CommandRenderer): void {
  for (const expected of renderer.scriptArtifacts) {
    const actual = assertCanonicalRegularFile(expected.realpath, `${renderer.id}.scriptArtifacts`, MAX_ARTIFACT_BYTES);
    if (actual.bytes.length !== expected.size || sha256(actual.bytes) !== expected.sha256) {
      throw new CommandExecutorError('renderer_artifact_changed', `渲染器 ${renderer.id} 的脚本制品已变化，必须重新确认依赖命令`);
    }
  }
}

export async function runCommandRenderer(input: {
  renderer: CommandRenderer;
  payload: unknown;
  workingDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CommandRendererResult> {
  if (input.signal?.aborted) {
    throw new CommandExecutorError('renderer_cancelled', `渲染器 ${input.renderer.id} 已取消`);
  }
  verifyCommandRendererArtifacts(input.renderer);
  const stdin = Buffer.from(JSON.stringify(input.payload), 'utf8');
  if (stdin.length > input.renderer.policy.maxInputBytes) {
    throw new CommandExecutorError('renderer_input_limit', `渲染器 ${input.renderer.id} 输入超过上限`);
  }
  const startedAt = Date.now();
  const home = mkdtempSync(join(tmpdir(), 'botmux-renderer-'));
  try {
    return await new Promise<CommandRendererResult>((resolvePromise, rejectPromise) => {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let terminalError: CommandExecutorError | undefined;
      let settled = false;
      const child = spawn(input.renderer.executable.realpath, input.renderer.fixedArgs, {
        cwd: input.workingDir || process.cwd(),
        env: {
          HOME: home,
          TMPDIR: home,
          PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const fail = (error: CommandExecutorError): void => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };
      const onAbort = (): void => {
        if (settled) return;
        terminalError = new CommandExecutorError('renderer_cancelled', `渲染器 ${input.renderer.id} 已取消`);
        terminateProcessGroup(child);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        terminalError = new CommandExecutorError('renderer_timeout', `渲染器 ${input.renderer.id} 超时`);
        terminateProcessGroup(child);
      }, Math.min(input.timeoutMs ?? input.renderer.policy.timeoutMs, input.renderer.policy.timeoutMs));
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > input.renderer.policy.maxOutputBytes) {
          terminalError = new CommandExecutorError('renderer_output_limit', `渲染器 ${input.renderer.id} 输出超过上限`);
          terminateProcessGroup(child);
          return;
        }
        stdout.push(buffer);
      });
      child.stderr?.resume();
      child.stdin?.on('error', error => {
        terminalError ??= new CommandExecutorError('renderer_stdin_failed', `渲染器 ${input.renderer.id} 无法读取输入`, { cause: error });
        terminateProcessGroup(child);
      });
      child.on('error', error => {
        clearTimeout(timer);
        fail(new CommandExecutorError('renderer_spawn_failed', `渲染器 ${input.renderer.id} 启动失败`, { cause: error }));
      });
      child.on('close', exitCode => {
        clearTimeout(timer);
        if (settled) return;
        if (terminalError) return fail(terminalError);
        if (exitCode !== 0) return fail(new CommandExecutorError('renderer_non_zero_exit', `渲染器 ${input.renderer.id} 退出码 ${String(exitCode)}`));
        try {
          const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
          settled = true;
          input.signal?.removeEventListener('abort', onAbort);
          resolvePromise({
            rendererId: input.renderer.id,
            rendererRevision: input.renderer.revision,
            markdown,
            stdoutBytes,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          fail(new CommandExecutorError('renderer_output_encoding', '渲染器 stdout 不是有效 UTF-8', { cause: error }));
        }
      });
      child.stdin?.end(stdin);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function isExecutorRevision(value: string | undefined): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}
