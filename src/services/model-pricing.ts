/**
 * Model pricing — token→金额估算的内置公开价格表与解析函数。
 *
 * 价格采集日：2026-08-21。来源（USD / 1M token，公开标价）：
 *   - https://www.anthropic.com/pricing
 *   - https://openai.com/api/pricing/
 *   - https://ai.google.dev/pricing
 * 汇率默认 USD→CNY = 7.2（DEFAULT_USD_CNY），可被 bots.json 的 pricing.usdCny 覆盖。
 *
 * 纯函数模块：禁止 import bot-registry / daemon / lark client，保证
 * cost-calculator、usage-ledger 与单测的依赖图不被污染。未收录模型一律
 * fail-closed（resolveModelPrice 返回 null，绝不猜价），调用方据此省略金额
 * 字段而非错报。新模型发布需补 BUILT_IN_MODEL_PRICES。
 */

/** USD / 1M token。cacheRead/cacheWrite 缺省时回退 input 价。 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** bots.json `pricing` 块经宽松解析后的形态。 */
export interface PricingOverrides {
  usdCny?: number;
  /** 键为模型族前缀（如 'claude-sonnet-4'），整项替换内置同键。 */
  models?: Record<string, ModelPrice>;
}

/** 一次定价解析的结果：汇率 + 可选覆盖表。 */
export interface ResolvedModelPricing {
  usdCny: number;
  overrides?: PricingOverrides;
}

/** estimateCostCny 的输入（与 SessionTokenUsage 结构兼容）。 */
export interface TokenUsagePricingInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
}

export const DEFAULT_USD_CNY = 7.2;

/**
 * 内置价格表，键用模型族前缀（resolveModelPrice 做精确 + 最长前缀匹配）。
 * 每项为 [input, output, cacheRead?, cacheWrite?]，单位 USD/1M token；
 * cacheWrite 缺省 = input。
 */
export const BUILT_IN_MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Claude（anthropic.com/pricing）──
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // ── GPT（openai.com/api/pricing）──
  'gpt-5.1-codex': { input: 2, output: 15, cacheRead: 0.5 },
  'gpt-5.1': { input: 2, output: 15, cacheRead: 0.5 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'o3': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // ── Gemini（ai.google.dev/pricing）──
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.219 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
};

// ─── 宽松解析 ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseModelPrice(raw: unknown): ModelPrice | null {
  if (!isPlainObject(raw)) return null;
  const { input, output } = raw;
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null;
  if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0) return null;
  const price: ModelPrice = { input, output };
  // 非法 cache 字段直接丢弃（不写进结果），不影响 input/output 生效。
  for (const key of ['cacheRead', 'cacheWrite'] as const) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) price[key] = v;
  }
  return price;
}

/**
 * 宽松解析 bots.json 的 `pricing` 块：对象才接受；usdCny 须为有限正数；
 * models 逐项校验（非法项丢弃）。没有任何有效字段时返回 undefined
 * （整体非法 → 功能关闭，fail-open 回退内置表），绝不抛错。
 */
export function normalizePricingOverrides(raw: unknown): PricingOverrides | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: PricingOverrides = {};
  const usdCny = raw.usdCny;
  if (typeof usdCny === 'number' && Number.isFinite(usdCny) && usdCny > 0) {
    result.usdCny = usdCny;
  }
  if (isPlainObject(raw.models)) {
    const models: Record<string, ModelPrice> = {};
    for (const [key, value] of Object.entries(raw.models)) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      const price = parseModelPrice(value);
      if (price) models[key] = price;
    }
    if (Object.keys(models).length > 0) result.models = models;
  }
  if (result.usdCny === undefined && result.models === undefined) return undefined;
  return result;
}

// ─── 模型名归一化与匹配 ───────────────────────────────────────────────────────

/** provider 前缀：'model_hub/claude-...' → 'claude-...'。 */
const PROVIDER_PREFIX_RE = /^[a-z0-9][a-z0-9._-]*\//;
/** 日期后缀：'claude-sonnet-4-5-20250929' → 'claude-sonnet-4-5'。 */
const DATE_SUFFIX_RE = /-20\d{6}$/;

/** 剥掉 provider 前缀与日期后缀，得到可匹配内置表的规范形态。 */
export function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(PROVIDER_PREFIX_RE, '').replace(DATE_SUFFIX_RE, '');
}

function exactPrice(table: Record<string, ModelPrice> | undefined, id: string): ModelPrice | null {
  const p = table?.[id];
  return p ? { ...p } : null;
}

/** 最长前缀匹配：id 须以 key + '-' 或 '.' 边界开头（如 'claude-sonnet-4'
 *  匹配 'claude-sonnet-4-5'，但不匹配 'claude-sonnet-40'）。返回拷贝。 */
function longestPrefixPrice(table: Record<string, ModelPrice> | undefined, id: string): ModelPrice | null {
  if (!table) return null;
  let bestKey: string | null = null;
  for (const key of Object.keys(table)) {
    if (id.length <= key.length) continue;
    if (!id.startsWith(key)) continue;
    const boundary = id.charAt(key.length);
    if (boundary !== '-' && boundary !== '.') continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? { ...table[bestKey] } : null;
}

/**
 * 解析模型单价（USD/1M token）。匹配顺序：
 *   overrides 精确 → 内置精确 → overrides 最长前缀 → 内置最长前缀 → null。
 * 未定价模型返回 null（fail-closed，绝不猜价）。
 */
export function resolveModelPrice(modelId: string, overrides?: PricingOverrides): ModelPrice | null {
  if (typeof modelId !== 'string') return null;
  const id = normalizeModelId(modelId);
  if (!id) return null;
  return (
    exactPrice(overrides?.models, id)
    ?? exactPrice(BUILT_IN_MODEL_PRICES, id)
    ?? longestPrefixPrice(overrides?.models, id)
    ?? longestPrefixPrice(BUILT_IN_MODEL_PRICES, id)
  );
}

// ─── 金额估算 ─────────────────────────────────────────────────────────────────

/**
 * 按四桶 token × 单价估算人民币金额：
 *   (input*p.input + output*p.output + cacheRead*p.cacheRead + cacheWrite*p.cacheWrite)
 *   / 1e6 * usdCny
 * cacheRead/cacheWrite 缺省回退 input 价。无 pricing 或模型未定价 → null
 * （调用方省略金额字段，绝不错报）。
 */
export function estimateCostCny(usage: TokenUsagePricingInput, pricing?: ResolvedModelPricing): number | null {
  if (!pricing) return null;
  const price = resolveModelPrice(usage.model, pricing.overrides);
  if (!price) return null;
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  const usd = (
    usage.inputTokens * price.input
    + usage.outputTokens * price.output
    + usage.cacheReadTokens * cacheRead
    + usage.cacheCreateTokens * cacheWrite
  ) / 1e6;
  return usd * pricing.usdCny;
}
