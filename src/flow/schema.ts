/**
 * JSON Schema draft-07 子集校验器（设计文档 §4.7）。
 *
 * 支持：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、
 * `minimum`/`maximum`、`minLength`/`maxLength`、`anyOf`/`oneOf`；另外接受纯注释性的
 * `title`/`description`/`default`/`examples`/`$schema`/`$comment`。**不含 `pattern`**，也不含
 * `$ref`、`patternProperties`、`dependencies` 等——线性时间是硬要求。
 *
 * 上限：schema 32KB（canonical JSON）、深度 32。schema 非法是硬错误（由调用方转换）。
 */
import { canonicalJson } from './identity.js';
import { SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH } from './types.js';

export interface SchemaIssue {
  path: string;
  message: string;
}

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'anyOf',
  'oneOf',
  'title',
  'description',
  'default',
  'examples',
  '$schema',
  '$comment',
]);

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export class SchemaInvalidError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(`invalid schema: ${issues.map((i) => `${i.path || '$'}: ${i.message}`).join('; ')}`);
    this.name = 'SchemaInvalidError';
  }
}

/** 检查 schema 本身；不合法抛 `SchemaInvalidError`。返回 canonical 字节数。 */
export function assertSchema(schema: unknown): number {
  const issues: SchemaIssue[] = [];
  checkSchemaNode(schema, '$', 0, issues);
  if (issues.length > 0) throw new SchemaInvalidError(issues);
  const bytes = Buffer.byteLength(canonicalJson(schema), 'utf8');
  if (bytes > SCHEMA_MAX_BYTES) throw new SchemaInvalidError([{ path: '$', message: `schema is ${bytes} bytes, limit ${SCHEMA_MAX_BYTES}` }]);
  return bytes;
}

function checkSchemaNode(node: unknown, path: string, depth: number, issues: SchemaIssue[]): void {
  if (depth > SCHEMA_MAX_DEPTH) {
    issues.push({ path, message: `schema deeper than ${SCHEMA_MAX_DEPTH}` });
    return;
  }
  if (typeof node === 'boolean') return; // draft-07 允许 true/false 作为 schema
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    issues.push({ path, message: 'schema must be an object or boolean' });
    return;
  }
  const s = node as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key)) issues.push({ path, message: `unsupported keyword "${key}"` });
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0) issues.push({ path: `${path}.type`, message: 'empty type list' });
    for (const t of types) {
      if (typeof t !== 'string' || !TYPES.has(t)) issues.push({ path: `${path}.type`, message: `unknown type ${JSON.stringify(t)}` });
    }
  }
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) {
      issues.push({ path: `${path}.properties`, message: 'must be an object' });
    } else {
      for (const [name, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        checkSchemaNode(sub, `${path}.properties.${name}`, depth + 1, issues);
      }
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) {
      issues.push({ path: `${path}.required`, message: 'must be an array of strings' });
    }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') {
    checkSchemaNode(s.additionalProperties, `${path}.additionalProperties`, depth + 1, issues);
  }
  if (s.items !== undefined) {
    if (Array.isArray(s.items)) issues.push({ path: `${path}.items`, message: 'tuple form is not supported' });
    else checkSchemaNode(s.items, `${path}.items`, depth + 1, issues);
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    issues.push({ path: `${path}.enum`, message: 'must be a non-empty array' });
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) {
    if (s[key] !== undefined && typeof s[key] !== 'number') issues.push({ path: `${path}.${key}`, message: 'must be a number' });
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (s[key] === undefined) continue;
    if (!Array.isArray(s[key]) || (s[key] as unknown[]).length === 0) {
      issues.push({ path: `${path}.${key}`, message: 'must be a non-empty array' });
      continue;
    }
    (s[key] as unknown[]).forEach((sub, i) => checkSchemaNode(sub, `${path}.${key}[${i}]`, depth + 1, issues));
  }
}

/** 校验值；返回问题列表（空即通过）。schema 必须已经过 `assertSchema`。 */
export function validateValue(schema: unknown, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateNode(schema, value, '$', 0, issues);
  return issues;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // object | string | number | boolean | undefined
}

function matchesType(t: string, value: unknown): boolean {
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function validateNode(schema: unknown, value: unknown, path: string, depth: number, issues: SchemaIssue[]): void {
  if (depth > SCHEMA_MAX_DEPTH) {
    issues.push({ path, message: `value deeper than ${SCHEMA_MAX_DEPTH}` });
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: 'schema false rejects every value' });
    return;
  }
  const s = schema as Record<string, unknown>;

  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!types.some((t) => matchesType(t, value))) {
      issues.push({ path, message: `expected ${types.join('|')}, got ${typeOf(value)}` });
      return; // 类型都不对，后面的结构检查没有意义
    }
  }
  if (s.const !== undefined && !deepEqual(s.const, value)) {
    issues.push({ path, message: `expected const ${canonicalJson(s.const)}` });
  }
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => deepEqual(e, value))) {
    issues.push({ path, message: `expected one of ${canonicalJson(s.enum)}` });
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) issues.push({ path, message: `must be >= ${s.minimum}` });
    if (typeof s.maximum === 'number' && value > s.maximum) issues.push({ path, message: `must be <= ${s.maximum}` });
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) issues.push({ path, message: `must be at least ${s.minLength} characters` });
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) issues.push({ path, message: `must be at most ${s.maxLength} characters` });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj)) issues.push({ path, message: `missing required property "${key}"` });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateNode(sub, obj[key], `${path}.${key}`, depth + 1, issues);
    }
    if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
      for (const key of Object.keys(obj)) {
        if (key in props) continue;
        if (s.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: 'additional property not allowed' });
        else validateNode(s.additionalProperties, obj[key], `${path}.${key}`, depth + 1, issues);
      }
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => validateNode(s.items, item, `${path}[${i}]`, depth + 1, issues));
  }
  if (Array.isArray(s.anyOf)) {
    const ok = (s.anyOf as unknown[]).some((sub) => validateValue(sub, value).length === 0);
    if (!ok) issues.push({ path, message: 'matches none of anyOf' });
  }
  if (Array.isArray(s.oneOf)) {
    const matched = (s.oneOf as unknown[]).filter((sub) => validateValue(sub, value).length === 0).length;
    if (matched !== 1) issues.push({ path, message: `matches ${matched} of oneOf, expected exactly 1` });
  }
}

/**
 * 从 CLI 的最终回复里取**最后一个平衡的** JSON 块（对象或数组）。CLI 常在 JSON 前后夹叙述，
 * 也可能包在 ``` 代码栏里。找不到返回 null。
 */
export function extractLastJsonBlock(text: string): unknown | null {
  // 单次正向扫描，记录每个顶层平衡块；块内跳过字符串。JSON 字符串里不允许裸换行，
  // 所以字符串未闭合就遇到换行说明当前不是 JSON，整体重置——散文里的引号不会吞掉后面的块。
  const blocks: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      else if (ch === '\n') {
        inString = false;
        depth = 0;
        start = -1;
      }
      continue;
    }
    if (depth === 0) {
      if (ch === '{' || ch === '[') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) blocks.push([start, i]);
    }
  }
  for (let k = blocks.length - 1; k >= 0; k--) {
    const [s, e] = blocks[k]!;
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {
      // 平衡但不是合法 JSON（比如 `[x]` 这种散文）：看前一个
    }
  }
  return null;
}
