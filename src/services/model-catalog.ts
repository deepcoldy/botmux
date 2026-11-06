/**
 * model-catalog.ts
 *
 * Dashboard 模型选择器的后端目录服务：把「某个 CLI 选择键能用哪些模型」拆成两层——
 *   - static：与适配器共用的模型元数据（或 ttadk 网关的建议列表），shell-free、
 *     同步读取，不构造适配器（部分构造器会同步解析 CLI 路径）；
 *   - live：适配器可选的 detectModels()/detectModelCapabilities() 按需探测
 *     （如 `traex debug models`），单进程短超时、fail-soft，成功结果按选择键、
 *     Bot runtime/env 与可执行文件指纹缓存 10 分钟；live 成功时只使用 live
 *     目录，失败时才回退 static。
 *
 * 只探测「当前选中的单个 CLI」，绝不做全量扫描（20+ CLI 各自 shell out 会让
 * 打开表单卡到不可用）。所有公开函数都 fail-soft：任何异常都回退到静态候选，
 * 绝不向调用方抛错。
 */
import {
  lookupCliSelection,
  lookupCliSelectionForBotShape,
  isTtadkWrapper,
  ttadkAcceptsModel,
  TTADK_MODEL_SUGGESTIONS,
} from '../setup/cli-selection.js';
import { createCliAdapterSync, rawCliExecutable, resolveCommand } from '../adapters/cli/registry.js';
import { CLI_MODEL_CHOICES } from '../adapters/cli/model-choices.js';
import type { DebugModelCapabilities } from '../adapters/cli/model-catalog-json.js';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';
import { detectAidenCodexModels } from './aiden-model-catalog.js';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isCodexReasoningEffort, reasoningEffortsForCliModel } from './codex-reasoning-effort.js';

export type ModelSource = 'static' | 'live';

/** live 探测成功结果的缓存时长（毫秒）。导出供测试断言 TTL 行为。 */
export const MODEL_DETECT_TTL_MS = 10 * 60 * 1000;

/** detectModels 的可选注入依赖（生产代码不传，测试用 fake 验证缓存/去重）。 */
export interface DetectModelsOptions {
  /** 时钟注入（TTL 判定用），默认 Date.now。 */
  readonly now?: () => number;
  /** 适配器工厂注入，默认 createCliAdapterSync。 */
  readonly adapterFactory?: (cliId: CliId, pathOverride?: string) => CliAdapter;
  /** Aiden AIPROXY 探测器注入，默认调用 `aiden x models --codex --json`。 */
  readonly aidenCodexDetector?: () => Promise<readonly string[] | null>;
  /** Bot-specific runtime identity; never returned to clients. */
  readonly runtimeContext?: string;
  /** Bot-specific environment for a capability probe. */
  readonly probeEnv?: NodeJS.ProcessEnv;
  /** Trusted executable selected from the target Bot's persisted native runtime. */
  readonly runtimeExecutable?: string;
  /** Command resolver injection for deterministic cache-identity tests. */
  readonly resolveExecutable?: (command: string) => string;
}

export interface DetectedModelCatalog {
  readonly models: readonly string[];
  readonly modelCapabilities?: readonly DebugModelCapabilities[];
}

export interface PersistedBotRuntimeSelection {
  readonly cliId: CliId;
  readonly cliRuntime?: { readonly executable: string } | null;
  readonly cliPathOverride?: string | null;
  readonly wrapperCli?: string | null;
  readonly cliLaunchMode?: import('../core/cli-launch-mode.js').CliLaunchMode | null;
}

/** Return a persisted executable only for an exactly registered native shape. */
export function runtimeExecutableForBotSelection(
  key: string,
  bot: PersistedBotRuntimeSelection | null | undefined,
): string | undefined {
  if (!bot) return undefined;
  const requested = lookupCliSelection(key);
  const persisted = lookupCliSelectionForBotShape(bot.cliId, bot.wrapperCli, bot.cliLaunchMode);
  if (!requested || !persisted || persisted.key !== requested.key) return undefined;
  if (persisted.wrapperCli || persisted.cliLaunchMode) return undefined;
  return bot.cliRuntime?.executable ?? bot.cliPathOverride ?? undefined;
}

// ─── 静态候选 ────────────────────────────────────────────────────────────────

/**
 * 按 CLI 选择键取静态模型候选（shell-free，同步，绝不抛异常）。
 * key 来自 CLI_SELECT_OPTIONS（普通 cliId 或 'ttadk-x-claude' 这类网关键）。
 *  - ttadk 网关项：ttadkAcceptsModel(wrapperCli) 为真 → [...TTADK_MODEL_SUGGESTIONS]，否则 []
 *  - 其它：读取 CLI_MODEL_CHOICES 元数据（无候选 → []）
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
    // Aiden 的可用模型由登录账号和 AIPROXY 动态决定，不能回退到原生 Codex 快照。
    if (opt.key === 'aiden-x-codex') return [];
    return [...(CLI_MODEL_CHOICES[opt.cliId] ?? [])];
  } catch {
    return [];
  }
}

// ─── live 探测（on-demand，带 TTL 缓存 + in-flight 去重）─────────────────────

interface DetectCacheEntry {
  /** 探测完成时刻（epoch millis）。 */
  readonly at: number;
  readonly models: readonly string[];
  readonly modelCapabilities?: readonly DebugModelCapabilities[];
}

function runtimeCacheIdentity(
  executable: string | undefined,
  resolveExecutable: (command: string) => string,
): string {
  if (!executable) return 'default';
  try {
    const resolved = realpathSync(resolveExecutable(executable));
    const stat = statSync(resolved);
    return `${resolved}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return executable;
  }
}

/**
 * On-demand live 目录探测的核心实现，缓存表由调用方持有——模块级单例给生产用，
 * {@link createModelCatalog} 给需要隔离缓存的测试用。
 * 绝不抛异常：未知 key / ttadk 网关项 / 适配器无 detectModels / 任何异常 → null。
 */
async function detectModelCatalogWith(
  key: string,
  opts: DetectModelsOptions | undefined,
  cache: Map<string, DetectCacheEntry>,
  inFlight: Map<string, Promise<DetectedModelCatalog | null>>,
): Promise<DetectedModelCatalog | null> {
  const now = opts?.now ?? (() => Date.now());
  const factory = opts?.adapterFactory
    ?? ((cliId: CliId, pathOverride?: string) => createCliAdapterSync(cliId, pathOverride));
  try {
    const opt = lookupCliSelection(key);
    // Only ttadk owns its model list. Other registered wrappers (including
    // cjadk) retain the underlying adapter's live slug discovery; Aiden Codex
    // is handled by its dedicated detector below.
    if (!opt || isTtadkWrapper(opt.wrapperCli)) return null;

    const adapter = opt.key === 'aiden-x-codex'
      ? undefined
      : factory(opt.cliId, opts?.runtimeExecutable);
    // Confirm discovery capability before resolving/fingerprinting a command.
    // This keeps non-discoverable CLIs (for example claude-code) shell-free.
    if (opt.key !== 'aiden-x-codex'
      && !adapter?.detectModelCapabilities
      && !adapter?.detectModels) return null;

    // TTL 内的成功缓存直接复用。
    const envKey = opts?.probeEnv
      ? createHash('sha256').update(JSON.stringify(
        Object.keys(opts.probeEnv).sort().map(key => [key, opts.probeEnv![key]]),
      )).digest('hex')
      : '';
    const runtimeIdentity = opt.key === 'aiden-x-codex'
      ? 'aiden'
      : runtimeCacheIdentity(
          opts?.runtimeExecutable ?? rawCliExecutable(opt.cliId),
          opts?.resolveExecutable ?? resolveCommand,
        );
    const cacheKey = `${opt.key}\0${opts?.runtimeContext ?? ''}\0${envKey}\0${runtimeIdentity}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < MODEL_DETECT_TTL_MS) {
      return { models: cached.models, ...(cached.modelCapabilities ? { modelCapabilities: cached.modelCapabilities } : {}) };
    }

    // 同一 key 并发调用复用 in-flight Promise（去重）。
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const promise = (async (): Promise<DetectedModelCatalog | null> => {
      try {
        const capabilities = adapter?.detectModelCapabilities
          ? await adapter.detectModelCapabilities({ env: opts?.probeEnv })
          : undefined;
        const models = opt.key === 'aiden-x-codex'
          ? await (opts?.aidenCodexDetector ?? detectAidenCodexModels)()
          : adapter?.detectModelCapabilities
            ? capabilities?.map(model => model.slug) ?? null
            : await adapter?.detectModels?.() ?? null;
        // 只缓存非空成功结果；失败（null/空数组/异常）不缓存，下次调用重试。
        if (models === null) return null;
        if (models.length === 0) return { models: [] };
        const detected = {
          models: [...models],
          // A wrapper can remap models or credentials. Until its probe runs
          // through the real launcher, expose only the legacy slug list.
          ...(!opt.wrapperCli && capabilities && capabilities.length > 0
            ? { modelCapabilities: capabilities }
            : {}),
        };
        cache.set(cacheKey, { at: now(), ...detected });
        return detected;
      } catch {
        return null;
      } finally {
        inFlight.delete(cacheKey);
      }
    })();

    inFlight.set(cacheKey, promise);
    return promise;
  } catch {
    return null;
  }
}

/** 进程级单例的缓存表（生产路径共用）。 */
const singletonCache = new Map<string, DetectCacheEntry>();
const singletonInFlight = new Map<string, Promise<DetectedModelCatalog | null>>();

/**
 * On-demand live 探测（异步，fail-soft，绝不抛异常）。
 *  - 未知 key / ttadk 网关项 / 适配器无目录探测能力 → null
 *  - 调用 adapter 的 richer capabilities 或 slug-only 探测，任何异常 → null
 *  - 同一 runtime/env/executable 身份的并发调用去重（in-flight Promise 复用）
 *  - 成功结果按选择键、Bot runtime/env 与可执行文件指纹缓存 10 分钟；失败不缓存
 */
export function detectModels(
  key: string,
  opts?: DetectModelsOptions,
): Promise<readonly string[] | null> {
  return detectModelCatalogWith(key, opts, singletonCache, singletonInFlight).then(detected => detected?.models ?? null);
}

/**
 * 独立缓存实例：测试用它隔离 TTL/in-flight 状态，避免污染模块级单例。
 * （staticModelChoices 无状态，故不在此重复。）
 */
export interface ModelCatalog {
  detectModels(key: string, opts?: DetectModelsOptions): Promise<readonly string[] | null>;
  detectModelCatalog(key: string, opts?: DetectModelsOptions): Promise<DetectedModelCatalog | null>;
}

export function createModelCatalog(): ModelCatalog {
  const cache = new Map<string, DetectCacheEntry>();
  const inFlight = new Map<string, Promise<DetectedModelCatalog | null>>();
  return {
    detectModels: (key, opts) => detectModelCatalogWith(key, opts, cache, inFlight).then(detected => detected?.models ?? null),
    detectModelCatalog: (key, opts) => detectModelCatalogWith(key, opts, cache, inFlight),
  };
}

// ─── 合并 ────────────────────────────────────────────────────────────────────

/**
 * live 非空时视为当前 runtime 的权威目录；只有探测不可用时才回退静态候选。
 */
export function mergeModelChoices(
  staticChoices: readonly string[],
  live: readonly string[] | null,
): { models: string[]; source: ModelSource } {
  const candidates = live && live.length > 0 ? live : staticChoices;
  const models: string[] = [];
  const seen = new Set<string>();
  for (const m of candidates) {
    if (!seen.has(m)) {
      seen.add(m);
      models.push(m);
    }
  }
  return { models, source: live && live.length > 0 ? 'live' : 'static' };
}

// ─── dashboard 端点辅助 ──────────────────────────────────────────────────────

/** 选择键是否已知（GET /api/cli-options/models 的 400 分支判定）。 */
export function isKnownSelectionKey(key: string): boolean {
  return lookupCliSelection(key) !== undefined;
}

/** GET /api/cli-options/models 的 200 响应体：live 成功时只用 live，否则回退静态；
 *  detectedAt 为目录决策完成时刻（epoch millis）。fail-soft 语义同上游三个函数。 */
export interface ModelChoicesResponse {
  readonly models: string[];
  readonly source: ModelSource;
  readonly detectedAt: number;
  readonly modelCapabilities?: readonly DebugModelCapabilities[];
  readonly reasoningEffortsByModel?: Readonly<Record<string, readonly string[]>>;
}

export async function buildModelChoicesResponse(
  key: string,
  opts?: DetectModelsOptions,
): Promise<ModelChoicesResponse> {
  const now = opts?.now ?? (() => Date.now());
  const staticChoices = staticModelChoices(key);
  const live = await detectModelCatalogWith(key, opts, singletonCache, singletonInFlight);
  const { models, source } = mergeModelChoices(staticChoices, live?.models ?? null);
  const selectedCliId = lookupCliSelection(key)?.cliId;
  const reasoningEffortsByModel = Object.fromEntries(
    (live?.modelCapabilities ?? [])
      .map(entry => {
        const detected = (entry.reasoningEfforts ?? []).filter(isCodexReasoningEffort);
        const enforced = reasoningEffortsForCliModel(selectedCliId, entry.slug);
        return detected.length > 0
          && detected.length === enforced.length
          && detected.every((effort, index) => effort === enforced[index])
          ? [entry.slug, detected] as const
          : null;
      })
      .filter((entry): entry is readonly [string, import('./codex-reasoning-effort.js').CodexReasoningEffort[]] => entry !== null),
  );
  const browserCapabilities = live?.modelCapabilities?.map(entry => ({
    slug: entry.slug,
    serviceTiers: entry.serviceTiers,
    ...(selectedCliId === 'traex' ? {
      ...(entry.reasoningEfforts ? { reasoningEfforts: entry.reasoningEfforts } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.contextVariants ? { contextVariants: entry.contextVariants } : {}),
    } : {}),
  }));
  return {
    models,
    source,
    detectedAt: now(),
    ...(browserCapabilities && browserCapabilities.length > 0 ? { modelCapabilities: browserCapabilities } : {}),
    ...(Object.keys(reasoningEffortsByModel).length > 0 ? { reasoningEffortsByModel } : {}),
  };
}
