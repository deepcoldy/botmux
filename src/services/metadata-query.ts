import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_METADATA_ENV_FILE = join(homedir(), '.config', 'ksher-agent-data-mcp', 'env');
const DEFAULT_METADATA_PORT = 8123;
const DEFAULT_METADATA_DATABASE = 'ksher_bi_dense';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_METADATA_LIMIT = 10_000;

const ALLOWED_METADATA_TABLES = new Set([
  'ksher_bi_dense.s_indicator_dict_detail_info',
]);

const FORBIDDEN_SQL_RE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|attach|optimize|rename|exchange|undrop|system|kill|use)\b/i;

export interface MetadataQueryConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  timeoutMs: number;
  envFile: string;
}

export interface MetadataQueryResult {
  sql: string;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  statistics?: Record<string, unknown>;
}

export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export function resolveMetadataQueryConfig(envFile: string = DEFAULT_METADATA_ENV_FILE): MetadataQueryConfig {
  if (!existsSync(envFile)) {
    throw new Error(`metadata env file not found: ${envFile}`);
  }
  const vars = parseEnvFile(readFileSync(envFile, 'utf8'));
  const addr = vars.AGENT_METADATA_CK_ADDR?.trim();
  const username = vars.AGENT_METADATA_CK_USERNAME?.trim();
  const password = vars.AGENT_METADATA_CK_PASSWORD?.trim();
  if (!addr) throw new Error('missing AGENT_METADATA_CK_ADDR');
  if (!username) throw new Error('missing AGENT_METADATA_CK_USERNAME');
  if (!password) throw new Error('missing AGENT_METADATA_CK_PASSWORD');

  if (/^[a-z]+:\/\//i.test(addr) || addr.includes('/') || addr.includes('?')) {
    throw new Error(`invalid AGENT_METADATA_CK_ADDR: ${addr} (expected host:port)`);
  }

  const match = /^(?<host>[a-zA-Z0-9._-]+)(?::(?<port>\d+))?$/.exec(addr);
  if (!match?.groups?.host) {
    throw new Error(`invalid AGENT_METADATA_CK_ADDR: ${addr}`);
  }

  return {
    host: match.groups.host,
    port: Number(match.groups.port) || DEFAULT_METADATA_PORT,
    username,
    password,
    database: DEFAULT_METADATA_DATABASE,
    timeoutMs: Number(vars.AGENT_METADATA_CK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    envFile,
  };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+$/, '');
}

function normalizeTableRef(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[`"']/g, '')
    .replace(/\s+(?:as\s+)?[a-zA-Z_][\w]*$/i, '')
    .trim();
  if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?$/.test(cleaned)) return null;
  return cleaned.includes('.')
    ? cleaned.toLowerCase()
    : `${DEFAULT_METADATA_DATABASE}.${cleaned.toLowerCase()}`;
}

function splitTopLevelCommas(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function extractTableToken(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.startsWith('(')) return null;
  const [first, second] = trimmed.split(/\s+/, 2);
  if (!first) return null;
  // Table functions and other dynamic sources are outside the metadata helper's scope.
  if (second?.startsWith('(') || first.includes('(')) return null;
  return normalizeTableRef(first);
}

function extractReferencedTables(sql: string): string[] {
  const refs = new Set<string>();
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const normalized = normalizeTableRef(match[1]);
    if (normalized) refs.add(normalized);
  }
  const fromSections = sql.split(/\bfrom\b/i).slice(1);
  for (const section of fromSections) {
    const end = section.search(/\b(where|group\s+by|having|order\s+by|limit|format|union|settings)\b/i);
    const fromList = end >= 0 ? section.slice(0, end) : section;
    const beforeJoins = fromList.split(/\b(?:inner|left|right|full|cross|any|all|asof)?\s*join\b/i)[0];
    for (const part of splitTopLevelCommas(beforeJoins)) {
      const normalized = extractTableToken(part);
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

function extractLimit(sql: string): number | null {
  const match = /\blimit\s+(\d+)\b/i.exec(sql);
  if (!match) return null;
  return Number(match[1]);
}

export function validateMetadataSql(sql: string): string {
  const normalized = normalizeSql(sql);
  if (!normalized) throw new Error('empty sql');
  if (!/^select\b/i.test(normalized)) {
    throw new Error('metadata query only allows SELECT');
  }
  if (/\bwith\b/i.test(normalized)) {
    throw new Error('metadata query does not allow CTE');
  }
  if (/\bfrom\s*\(/i.test(normalized)) {
    throw new Error('metadata query does not allow subquery sources');
  }
  if (FORBIDDEN_SQL_RE.test(normalized)) {
    throw new Error('metadata query contains forbidden keywords');
  }
  const refs = extractReferencedTables(normalized);
  if (refs.length === 0) {
    throw new Error('metadata query must reference at least one allowed metadata table');
  }
  for (const ref of refs) {
    if (!ALLOWED_METADATA_TABLES.has(ref)) {
      throw new Error(`metadata query references disallowed table: ${ref}`);
    }
  }
  const limit = extractLimit(normalized);
  if (limit === null) {
    throw new Error('metadata query must include LIMIT');
  }
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_METADATA_LIMIT) {
    throw new Error(`metadata query LIMIT must be between 1 and ${MAX_METADATA_LIMIT}`);
  }
  return `${normalized} FORMAT JSON`;
}

export async function runMetadataQuery(
  sql: string,
  cfg: MetadataQueryConfig = resolveMetadataQueryConfig(),
): Promise<MetadataQueryResult> {
  const query = validateMetadataSql(sql);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const url = new URL(`http://${cfg.host}:${cfg.port}/`);
    url.searchParams.set('database', cfg.database);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-clickhouse-user': cfg.username,
        'x-clickhouse-key': cfg.password,
      },
      body: query,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`clickhouse http ${res.status}: ${text.trim() || 'unknown error'}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('clickhouse response is not valid JSON');
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : [];
    return {
      sql: query,
      rows,
      rowCount: Number(parsed?.rows) || rows.length,
      truncated: false,
      statistics: parsed?.statistics && typeof parsed.statistics === 'object'
        ? parsed.statistics as Record<string, unknown>
        : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
