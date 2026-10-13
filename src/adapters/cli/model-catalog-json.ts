import { isCodexReasoningEffort } from '../../services/codex-reasoning-effort.js';

/**
 * 共享的 `xxx debug models` JSON 目录解析。
 *
 * traex / codex / coco（codex 家族，coco 与 traex 共用同一 traecli 二进制）
 * 的 `debug models` 子命令输出同构 JSON：
 * `{"models":[{"slug":"...","visibility":"list",...]}`。
 * 各适配器的 detectModels 复用本解析，过滤逻辑保持一致。
 */

/**
 * 解析 `debug models` 的 JSON 输出为模型能力列表。
 * 过滤：slug 必须为非空字符串，且 visibility === 'list'（隐藏内部模型）。
 * 容错：JSON 非法 / 顶层结构不符 / models 不是数组 → 返回 []；
 * 单个元素缺 slug、slug 非字符串或 visibility 非 'list' 则跳过该元素
 * （一条坏数据不影响其余模型，避免整个目录因单条异常而不可选）。
 */
export interface DebugModelCapabilities {
  slug: string;
  serviceTiers: string[];
  reasoningEfforts?: string[];
  /** Parsed for future default-selection UX; deliberately not sent to Dashboard clients yet. */
  defaultReasoningEffort?: string;
}

export function parseDebugModelCapabilitiesJson(stdout: string): DebugModelCapabilities[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const capabilities: DebugModelCapabilities[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as {
      slug?: unknown;
      visibility?: unknown;
      service_tiers?: unknown;
      supported_reasoning_levels?: unknown;
      default_reasoning_level?: unknown;
    };
    const slug = record.slug;
    const visibility = record.visibility;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    if (visibility !== 'list') continue;
    const serviceTiers = Array.isArray(record.service_tiers)
      ? record.service_tiers
        .map(tier => (typeof tier === 'object' && tier !== null
          ? (tier as { id?: unknown }).id
          : undefined))
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const reasoningEfforts = Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels
        .map(level => (typeof level === 'object' && level !== null
          ? (level as { effort?: unknown }).effort
          : undefined))
        .filter(isCodexReasoningEffort)
      : [];
    capabilities.push({
      slug,
      serviceTiers,
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      ...(isCodexReasoningEffort(record.default_reasoning_level)
        ? { defaultReasoningEffort: record.default_reasoning_level }
        : {}),
    });
  }
  return capabilities;
}

/** Backward-compatible rich catalogue name used by callers interested in reasoning metadata. */
export const parseDebugModelCatalogJson = parseDebugModelCapabilitiesJson;

export function parseDebugModelsJson(stdout: string): string[] {
  return parseDebugModelCapabilitiesJson(stdout).map(model => model.slug);
}
