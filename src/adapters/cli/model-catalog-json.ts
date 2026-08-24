/**
 * 共享的 `xxx debug models` JSON 目录解析。
 *
 * traex / codex / coco（codex 家族，coco 与 traex 共用同一 traecli 二进制）
 * 的 `debug models` 子命令输出同构 JSON：
 * `{"models":[{"slug":"...","visibility":"list",...]}`。
 * 各适配器的 detectModels 复用本解析，过滤逻辑保持一致。
 */

/**
 * 解析 `debug models` 的 JSON 输出为模型 slug 列表。
 * 过滤：slug 必须为非空字符串，且 visibility === 'list'（隐藏内部模型）。
 * 容错：JSON 非法 / 顶层结构不符 / models 不是数组 → 返回 []；
 * 单个元素缺 slug、slug 非字符串或 visibility 非 'list' 则跳过该元素
 * （一条坏数据不影响其余模型，避免整个目录因单条异常而不可选）。
 */
export function parseDebugModelsJson(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const slugs: string[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const slug = (entry as { slug?: unknown }).slug;
    const visibility = (entry as { visibility?: unknown }).visibility;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    if (visibility !== 'list') continue;
    slugs.push(slug);
  }
  return slugs;
}
