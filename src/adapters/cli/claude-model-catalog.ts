/**
 * claude-model-catalog.ts
 *
 * Claude Code 的「用户能用哪些模型」有两个可读来源，按可靠性排序：
 *
 *   1. **bot 实际指向的 Anthropic 兼容端点**（`ANTHROPIC_BASE_URL` + token）。
 *      走网关 / 代理（coding-plan、GLM 等）的 bot，可选集合只有网关知道，
 *      `GET /v1/models` 是唯一权威来源 —— 官方目录里那些 id 在这类 bot 上根本跑不到。
 *   2. **CLI 自己缓存的签名模型目录**
 *      `<CLAUDE_CONFIG_DIR>/cache/model-catalog/published-*.json`。官方账户没有
 *      base override，`/model` 选择器就是按这份目录渲染的，与用户本机 `claude` 一致。
 *
 * 两者都失败才由调用方回退 `CLI_MODEL_CHOICES` 的静态快照（项目维护，不取自任何一台机器）。
 *
 * 目录里的 `document` 形如：
 *   { surfaces: { cc: { model_selector_config: [{ models: [{ id, name, section }] }] } } }
 * `section` 为 `main` / `overflow`；同一 surface 内已按选择器顺序排好，直接保序。
 *
 * 完全 fail-soft：文件缺失、JSON 损坏、网络/鉴权失败都返回 null，绝不抛异常。
 * 目录刻意不校验 `expires_at`：缓存过期只影响 CLI 的发网刷新，不代表列表失效，
 * 而过期列表仍比静态快照更贴近本机。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHomePath } from '../../utils/working-dir.js';

/** 缓存相对 CLI 数据根（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）的目录。 */
const CATALOG_SUBDIR = join('cache', 'model-catalog');
/** Claude Code 本体在目录里的 surface id（另有 ccd/ccr/chat/cowork）。 */
const CLAUDE_CODE_SURFACE = 'cc';
/** 端点探测的超时：模型下拉是同步等待的，宁可回退也不能挂住请求。 */
const ENDPOINT_TIMEOUT_MS = 3_000;
/** 端点响应的上限，防止异常端点把内存打满。 */
const ENDPOINT_MAX_BYTES = 1_000_000;

type FetchImpl = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `document` 在缓存里是对象；个别版本落盘成字符串，两种都接。 */
function decodeDocumentString(text: string): Record<string, unknown> | null {
  const direct = parseJsonRecord(text);
  if (direct) return direct;
  try {
    return parseJsonRecord(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** 剥掉 `{ version, etag, document }` 缓存外壳，得到目录文档本身。 */
function unwrapDocument(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const nested = input.document;
  if (isRecord(nested)) return nested;
  if (typeof nested === 'string') {
    const parsed = decodeDocumentString(nested);
    if (parsed) return parsed;
  }
  return 'surfaces' in input ? input : null;
}

/**
 * 从模型目录文档里取出某个 surface 的模型 id 列表（保序、去重）。
 * surface 不存在时退回所有 surface 的并集；没有任何 id 时返回 null。
 */
export function parseClaudeModelCatalog(
  input: unknown,
  surface: string = CLAUDE_CODE_SURFACE,
): readonly string[] | null {
  const document = unwrapDocument(input);
  if (!document) return null;
  const surfaces = document.surfaces;
  if (!isRecord(surfaces)) return null;

  const preferred = surfaces[surface];
  const chosen = isRecord(preferred)
    ? [preferred]
    : Object.values(surfaces).filter(isRecord);

  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of chosen) {
    const configs = entry.model_selector_config;
    if (!Array.isArray(configs)) continue;
    for (const config of configs) {
      if (!isRecord(config) || !Array.isArray(config.models)) continue;
      for (const model of config.models) {
        if (!isRecord(model)) continue;
        const id = model.id;
        if (typeof id !== 'string') continue;
        const slug = id.trim();
        if (slug === '' || seen.has(slug)) continue;
        seen.add(slug);
        models.push(slug);
      }
    }
  }
  return models.length > 0 ? models : null;
}

/**
 * 依次尝试的 CLI 数据根：显式配置（`configDir` 或 `CLAUDE_CONFIG_DIR`）优先。
 *
 * 指定了 profile 目录时**不再**追加 `~/.claude`：那是另一个账户的数据根，
 * 拿它兜底会把别的账户的模型列到当前 bot 上。
 */
function catalogRoots(options: { env?: NodeJS.ProcessEnv; configDir?: string }): string[] {
  const explicit = [options.configDir, options.env?.CLAUDE_CONFIG_DIR]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
    .map(candidate => resolve(expandHomePath(candidate.trim())));
  const candidates = explicit.length > 0 ? explicit : [join(homedir(), '.claude')];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

/** 读一个数据根下 mtime 最新的 `published-*.json`；没有可用文件时返回 null。 */
export function readClaudeModelCatalogFromRoot(root: string): readonly string[] | null {
  const dir = join(root, CATALOG_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let newestPath: string | null = null;
  let newestMtime = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    if (!name.startsWith('published-') || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.mtimeMs <= newestMtime) continue;
      newestPath = path;
      newestMtime = stat.mtimeMs;
    } catch {
      continue;
    }
  }
  if (!newestPath) return null;
  try {
    return parseClaudeModelCatalog(parseJsonRecord(readFileSync(newestPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * 读取本机 Claude CLI 的模型目录。所有数据根都没有可用缓存时返回 null
 * （调用方回退静态候选），绝不抛异常。
 */
export async function readClaudeModelCatalog(
  options: { env?: NodeJS.ProcessEnv; configDir?: string } = {},
): Promise<readonly string[] | null> {
  try {
    for (const root of catalogRoots(options)) {
      const models = readClaudeModelCatalogFromRoot(root);
      if (models) return models;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 端点探测（bot 实际指向的 Anthropic 兼容网关）─────────────────────────────

/** 读 `<root>/settings.json` 里的 `env` 块（CLI 启动时确实会应用它）。 */
function readSettingsEnvFile(root: string): Record<string, string> {
  try {
    const parsed = parseJsonRecord(readFileSync(join(root, 'settings.json'), 'utf8'));
    const env = parsed?.env;
    if (!isRecord(env)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 端点探测用的有效环境：bot 自己的启动环境优先；没有 base override 时，按 CLI 的
 * 解析顺序补上 `<config dir>/settings.json` 的 env —— 用户级 settings 的
 * `ANTHROPIC_BASE_URL`/`AUTH_TOKEN` 在 CLI 启动时同样生效，只读 process.env 会漏掉它。
 */
export function resolveEndpointEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  configDir?: string,
): NodeJS.ProcessEnv {
  if (env?.ANTHROPIC_BASE_URL?.trim()) return env;
  for (const root of catalogRoots({ env, configDir })) {
    const fileEnv = readSettingsEnvFile(root);
    if (fileEnv.ANTHROPIC_BASE_URL?.trim()) return { ...fileEnv, ...env };
  }
  return env ?? {};
}

/** 从 bot 环境里取探测目标；没有 base override 或没有凭据时返回 null。 */
export function endpointTarget(env: NodeJS.ProcessEnv | undefined): { base: string; token: string } | null {
  const rawBase = env?.ANTHROPIC_BASE_URL?.trim();
  if (!rawBase) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const token = (env?.ANTHROPIC_AUTH_TOKEN ?? env?.ANTHROPIC_API_KEY ?? '').trim();
  if (token === '') return null;
  return { base: rawBase.replace(/\/+$/, ''), token };
}

/**
 * `GET <base>/v1/models` 的响应 → 模型 id 列表。
 * 同时兼容 OpenAI / Anthropic 的 `{ data: [{ id }] }` 与裸 `{ models: [...] }`。
 */
export function parseEndpointModelsJson(body: unknown): readonly string[] | null {
  if (!isRecord(body)) return null;
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
  if (!list) return null;
  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const raw = isRecord(entry) ? entry.id : entry;
    if (typeof raw !== 'string') continue;
    const slug = raw.trim();
    if (slug === '' || seen.has(slug)) continue;
    seen.add(slug);
    models.push(slug);
  }
  return models.length > 0 ? models : null;
}

/**
 * 读取响应体并在超过上限时立刻放弃。
 *
 * 不能先 `text()` 再比长度：那已经把整个响应读进内存了，上限只是事后否决。
 * 有流就按块累加、超限 cancel；测试里的假 response 没有流，退回整读后按
 * **字节数**（不是 UTF-16 码元数）判定。
 */
async function readCappedBody(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) return null;
  const stream = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  const reader = stream?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > limit ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 已取消/已释放 */ }
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

/**
 * 问 bot 自己指向的端点要模型清单。这是网关 / 代理场景的唯一权威来源：
 * 官方目录里的 id 在 coding-plan 这类网关上根本跑不到。
 *
 * 凭据只发给 bot 已配置的 base URL，不落日志；超时、非 2xx、网络错误一律
 * 返回 null（调用方继续往下一层回退）。
 */
export async function detectModelsViaEndpoint(
  env: NodeJS.ProcessEnv | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<readonly string[] | null> {
  const target = endpointTarget(env);
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  // 探针不该让进程多活 3 秒（daemon 里这会是每个请求的尾巴）。
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await fetchImpl(`${target.base}/v1/models`, {
      method: 'GET',
      // Fetch can retain custom headers such as x-api-key across redirects.
      redirect: 'error',
      headers: {
        authorization: `Bearer ${target.token}`,
        'x-api-key': target.token,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await readCappedBody(response, ENDPOINT_MAX_BYTES);
    if (text === null) return null;
    return parseEndpointModelsJson(parseJsonRecord(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claude Code 的模型探测入口：端点 → 磁盘目录 → null（调用方回退静态表）。
 * 绝不抛异常。
 */
export async function detectClaudeModels(
  options: { env?: NodeJS.ProcessEnv; configDir?: string; fetchImpl?: FetchImpl } = {},
): Promise<readonly string[] | null> {
  const viaEndpoint = await detectModelsViaEndpoint(
    resolveEndpointEnvironment(options.env, options.configDir),
    options.fetchImpl,
  );
  if (viaEndpoint) return viaEndpoint;
  // bot 自己注入了 base URL，说明它指向的是网关：可选集合只有网关知道，
  // 而磁盘目录是官方账户的签名目录。端点一次失败就退回官方列表，会让网关
  // bot 拿到一批根本跑不到的模型，所以这里直接回退静态表。
  // base URL 来自用户自己的 settings.json 时不设限——那正是「本机 CLI」。
  if (options.env?.ANTHROPIC_BASE_URL?.trim()) return null;
  return readClaudeModelCatalog({ env: options.env, configDir: options.configDir });
}
