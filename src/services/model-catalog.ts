/**
 * model-catalog.ts
 *
 * Dashboard 模型选择器的后端目录服务：把「某个 CLI 选择键能用哪些模型」拆成两层——
 *   - static：适配器自带的 modelChoices（或 ttadk 网关的建议列表），shell-free、
 *     同步、构造适配器即取（适配器的 resolvedBin 是懒解析，构造不 shell out）；
 *   - live：适配器可选的 detectModels() 按需探测（如 `traex debug models`），
 *     单进程短超时、fail-soft，成功结果按 key 缓存 10 分钟。
 *
 * 只探测「当前选中的单个 CLI」，绝不做全量扫描（20+ CLI 各自 shell out 会让
 * 打开表单卡到不可用）。所有公开函数都 fail-soft：任何异常都回退到静态候选，
 * 绝不向调用方抛错。
 */
import {
  lookupCliSelection,
  isTtadkWrapper,
  ttadkAcceptsModel,
  TTADK_MODEL_SUGGESTIONS,
} from '../setup/cli-selection.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';

export type ModelSource = 'static' | 'live';

/** live 探测成功结果的缓存时长（毫秒）。导出供测试断言 TTL 行为。 */
export const MODEL_DETECT_TTL_MS = 10 * 60 * 1000;

/** detectModels 的可选注入依赖（生产代码不传，测试用 fake 验证缓存/去重）。 */
export interface DetectModelsOptions {
  /** 时钟注入（TTL 判定用），默认 Date.now。 */
  readonly now?: () => number;
  /** 适配器工厂注入，默认 createCliAdapterSync。 */
  readonly adapterFactory?: (cliId: CliId) => CliAdapter;
}

// ─── 静态候选 ────────────────────────────────────────────────────────────────

/**
 * 按 CLI 选择键取静态模型候选（shell-free，同步，绝不抛异常）。
 * key 来自 CLI_SELECT_OPTIONS（普通 cliId 或 'ttadk-x-claude' 这类网关键）。
 *  - ttadk 网关项：ttadkAcceptsModel(wrapperCli) 为真 → [...TTADK_MODEL_SUGGESTIONS]，否则 []
 *  - 其它：createCliAdapterSync(cliId).modelChoices ?? []（构造失败/无候选 → []）
 *  - 未知 key → []
 */
export function staticModelChoices(key: string): readonly string[] {
  try {
    const opt = lookupCliSelection(key);
    if (!opt) return [];
    // ttadk 网关项的模型由网关建议列表承载（账号不同会变），不读底层适配器；
    // CoCo 等不接受 -m 的子命令 → []（前端不渲染模型下拉）。
    if (isTtadkWrapper(opt.wrapperCli)) {
      return ttadkAcceptsModel(opt.wrapperCli) ? [...TTADK_MODEL_SUGGESTIONS] : [];
    }
    const adapter = createCliAdapterSync(opt.cliId);
    return adapter.modelChoices ? [...adapter.modelChoices] : [];
  } catch {
    return [];
  }
}

// ─── live 探测（on-demand，带 TTL 缓存 + in-flight 去重）─────────────────────

interface DetectCacheEntry {
  /** 探测完成时刻（epoch millis）。 */
  readonly at: number;
  readonly models: readonly string[];
}

/**
 * On-demand live 探测的核心实现，缓存表由调用方持有——模块级单例给生产用，
 * {@link createModelCatalog} 给需要隔离缓存的测试用。
 * 绝不抛异常：未知 key / ttadk 网关项 / 适配器无 detectModels / 任何异常 → null。
 */
async function detectModelsWith(
  key: string,
  opts: DetectModelsOptions | undefined,
  cache: Map<string, DetectCacheEntry>,
  inFlight: Map<string, Promise<readonly string[] | null>>,
): Promise<readonly string[] | null> {
  const now = opts?.now ?? (() => Date.now());
  const factory = opts?.adapterFactory ?? ((cliId: CliId) => createCliAdapterSync(cliId));
  try {
    const opt = lookupCliSelection(key);
    // 未知 key / ttadk 网关项（模型由网关建议列表承载，不探测底层 CLI）→ null。
    if (!opt || isTtadkWrapper(opt.wrapperCli)) return null;

    // TTL 内的成功缓存直接复用。
    const cached = cache.get(opt.key);
    if (cached && now() - cached.at < MODEL_DETECT_TTL_MS) {
      return cached.models;
    }

    // 同一 key 并发调用复用 in-flight Promise（去重）。
    const pending = inFlight.get(opt.key);
    if (pending) return pending;

    const promise = (async (): Promise<readonly string[] | null> => {
      try {
        const adapter = factory(opt.cliId);
        // 适配器未声明 detectModels = 该 CLI 无法枚举模型 → null。
        const models = adapter.detectModels ? await adapter.detectModels() : null;
        // 只缓存非空成功结果；失败（null/空数组/异常）不缓存，下次调用重试。
        if (models && models.length > 0) {
          cache.set(opt.key, { at: now(), models: [...models] });
        }
        return models;
      } catch {
        return null;
      } finally {
        inFlight.delete(opt.key);
      }
    })();

    inFlight.set(opt.key, promise);
    return promise;
  } catch {
    return null;
  }
}

/** 进程级单例的缓存表（生产路径共用）。 */
const singletonCache = new Map<string, DetectCacheEntry>();
const singletonInFlight = new Map<string, Promise<readonly string[] | null>>();

/**
 * On-demand live 探测（异步，fail-soft，绝不抛异常）。
 *  - 未知 key / ttadk 网关项 / 适配器无 detectModels → null
 *  - 调用 adapter.detectModels()，任何异常 → null
 *  - 同一 key 并发调用去重（in-flight Promise 复用）
 *  - 成功结果按 key 缓存 10 分钟（TTL）；失败不缓存
 */
export function detectModels(
  key: string,
  opts?: DetectModelsOptions,
): Promise<readonly string[] | null> {
  return detectModelsWith(key, opts, singletonCache, singletonInFlight);
}

/**
 * 独立缓存实例：测试用它隔离 TTL/in-flight 状态，避免污染模块级单例。
 * （staticModelChoices 无状态，故不在此重复。）
 */
export interface ModelCatalog {
  detectModels(key: string, opts?: DetectModelsOptions): Promise<readonly string[] | null>;
}

export function createModelCatalog(): ModelCatalog {
  const cache = new Map<string, DetectCacheEntry>();
  const inFlight = new Map<string, Promise<readonly string[] | null>>();
  return {
    detectModels: (key: string, opts?: DetectModelsOptions) =>
      detectModelsWith(key, opts, cache, inFlight),
  };
}

// ─── 合并 ────────────────────────────────────────────────────────────────────

/**
 * 合并静态 + live：静态顺序在前，live 多出的追加在后，整体去重。
 * live 为 null 或空数组 → source='static'，否则 source='live'。
 */
export function mergeModelChoices(
  staticChoices: readonly string[],
  live: readonly string[] | null,
): { models: string[]; source: ModelSource } {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const m of staticChoices) {
    if (!seen.has(m)) {
      seen.add(m);
      models.push(m);
    }
  }
  if (live && live.length > 0) {
    for (const m of live) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push(m);
      }
    }
    return { models, source: 'live' };
  }
  return { models, source: 'static' };
}

// ─── dashboard 端点辅助 ──────────────────────────────────────────────────────

/** 选择键是否已知（GET /api/cli-options/models 的 400 分支判定）。 */
export function isKnownSelectionKey(key: string): boolean {
  return lookupCliSelection(key) !== undefined;
}

/** GET /api/cli-options/models 的 200 响应体：静态候选 + live 增量合并，
 *  detectedAt 为合并完成时刻（epoch millis）。fail-soft 语义同上游三个函数。 */
export interface ModelChoicesResponse {
  readonly models: string[];
  readonly source: ModelSource;
  readonly detectedAt: number;
}

export async function buildModelChoicesResponse(
  key: string,
  opts?: DetectModelsOptions,
): Promise<ModelChoicesResponse> {
  const now = opts?.now ?? (() => Date.now());
  const staticChoices = staticModelChoices(key);
  const live = await detectModels(key, opts);
  const { models, source } = mergeModelChoices(staticChoices, live);
  return { models, source, detectedAt: now() };
}
