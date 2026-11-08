import { isCodexReasoningEffort } from '../../services/codex-reasoning-effort.js';

/**
 * 共享的 `xxx debug models` JSON 目录解析。
 *
 * traex / codex / coco（codex 家族，coco 与 traex 共用同一 traecli 二进制）
 * 的 `debug models` 子命令输出同构 JSON：
 * `{"models":[{"slug":"...","visibility":"list",...]}`。
 * 各适配器的 detectModels 复用本解析，过滤逻辑保持一致。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  contextWindow?: number;
  contextVariants?: Array<{
    id: 'standard' | 'max';
    contextWindow: number;
    reasoningEfforts?: string[];
  }>;
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
      context_window?: unknown;
      business_metadata?: { variants?: Record<string, unknown> };
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
    const contextWindow = Number.isSafeInteger(record.context_window) && (record.context_window as number) > 0
      ? record.context_window as number : undefined;
    const variants = record.business_metadata?.variants;
    const contextVariants: NonNullable<DebugModelCapabilities['contextVariants']> = [];
    for (const id of ['standard', 'max'] as const) {
      const capacity = variants?.[`${id}_context_window`];
      if (!Number.isSafeInteger(capacity) || (capacity as number) <= 0) continue;
      const levels = variants?.[`${id}_supported_reasoning_levels`];
      const efforts = Array.isArray(levels)
        ? levels.flatMap(level => level && typeof level === 'object'
          && isCodexReasoningEffort(level.effort) ? [level.effort] : [])
        : undefined;
      contextVariants.push({ id, contextWindow: capacity as number,
        ...(efforts ? { reasoningEfforts: efforts } : {}) });
    }
    capabilities.push({
      slug,
      serviceTiers,
      ...(contextWindow ? { contextWindow } : {}),
      ...(contextVariants.length ? { contextVariants } : {}),
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

/**
 * 各适配器 `detectModels` 共用的两种实现。
 *
 * 之前 coco / traex（`<bin> debug models`）与 opencode（`<bin> models`）各抄一份「lazy promisify +
 * execFile + 8s 超时 + 16MB 缓冲 + fail-soft」，codex / codex-app 各抄一份「能力目录 → slug 列表」。
 */

/**
 * 执行 `<bin> <args>` 枚举模型：仅 dashboard 在用户选中该 CLI 时按需调用，不在 daemon / worker 启动路径上；
 * 任何异常（spawn 失败 / 超时 / 输出非法或为空）一律 fail-soft 返回 null，picker 回退到适配器的 modelChoices。
 * 整包目录可达数百 KB，故 maxBuffer 给到 16MB、8s 超时兜底。
 */
export async function detectModelsViaExec(
  bin: string,
  args: readonly string[],
  parse: (stdout: string) => string[],
): Promise<readonly string[] | null> {
  try {
    // lazy promisify：顶层 promisify(execFile) 会在部分 mock child_process
    // 的测试 import 阶段炸（mock 无 execFile 导出）；推迟到调用时，fail-soft
    // 的 try/catch 兜住（契约：任何异常 → null）。
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(bin, [...args], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const models = parse(String(stdout));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export async function detectModelCapabilitiesViaExec(
  bin: string,
  env?: NodeJS.ProcessEnv,
): Promise<readonly DebugModelCapabilities[] | null> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['debug', 'models'], {
      env, timeout: 8_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    const catalog = parseDebugModelCapabilitiesJson(String(stdout));
    return catalog.length ? catalog : null;
  } catch { return null; }
}

/** 能力目录（`detectModelCapabilities` 的结果）→ `detectModels` 的 slug 列表；目录不可用时为 null。 */
export function capabilitySlugs(
  catalog: readonly DebugModelCapabilities[] | null | undefined,
): readonly string[] | null {
  return catalog?.map(model => model.slug) ?? null;
}
