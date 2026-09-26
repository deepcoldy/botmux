/**
 * `botmux ask` 选项按钮的 per-bot 布局：
 *
 *   compact  — 每行最多 4 个按钮的 `action` 行（历史形态，默认）
 *   vertical — 每行 1 个按钮，各自包在单列 `column_set` 里占满整行宽度，
 *              长选项标签不被挤压换行
 *
 * 本模块是**叶子模块**（零 import）：ask-card.ts 在 daemon 进程内渲染卡片，
 * 但不能 import bot-registry 取配置——ask-card → turn-reply-ask → bot-registry
 * 的既有依赖链会因此成环。所以镜像 i18n 的 setBotLookup：bot-registry 在模块
 * 加载时把 lookup 推进来，渲染侧经它按 larkAppId 读配置。
 */

export const ASK_OPTION_LAYOUTS = ['compact', 'vertical'] as const;
export type AskOptionLayout = (typeof ASK_OPTION_LAYOUTS)[number];

export const DEFAULT_ASK_OPTION_LAYOUT: AskOptionLayout = 'compact';

/** 配置体积极小（一个枚举值），1KB 上限绰绰有余；防止已认证的 Dashboard
 *  请求在 daemon / dashboard 任一侧缓冲任意大的排版配置 payload。 */
export const ASK_OPTION_LAYOUT_REQUEST_MAX_BYTES = 1024;

export function isAskOptionLayout(value: unknown): value is AskOptionLayout {
  return typeof value === 'string'
    && (ASK_OPTION_LAYOUTS as readonly string[]).includes(value);
}

/**
 * fail-soft 校验手改的 bots.json 值：任何非法值都被丢弃（layout 缺省），
 * 一个排版配置的笔误永远不能影响发卡或 daemon 启动。warnings 交给调用方
 * 决定记到哪里。
 */
export function normalizeAskOptionLayout(
  raw: unknown,
): { layout?: AskOptionLayout; warnings: string[] } {
  if (raw === undefined || raw === null) return { warnings: [] };
  if (isAskOptionLayout(raw)) return { layout: raw, warnings: [] };
  return {
    warnings: [`askOptionLayout 不支持“${String(raw)}”，已回退 ${DEFAULT_ASK_OPTION_LAYOUT}`],
  };
}

type BotLookup = (larkAppId: string) => { config: { askOptionLayout?: unknown } } | undefined;

let botLookup: BotLookup | undefined;

export function setAskOptionLayoutLookup(lookup: BotLookup): void {
  botLookup = lookup;
}

/**
 * 解析某 bot 当前生效的布局。lookup 未注册 / bot 未知 / 值非法 / lookup 抛错，
 * 一律回退 compact——与 localeForBot 同款防御。
 */
export function askOptionLayoutForBot(larkAppId: string | undefined): AskOptionLayout {
  if (!larkAppId || !botLookup) return DEFAULT_ASK_OPTION_LAYOUT;
  try {
    const raw = botLookup(larkAppId)?.config?.askOptionLayout;
    return isAskOptionLayout(raw) ? raw : DEFAULT_ASK_OPTION_LAYOUT;
  } catch {
    return DEFAULT_ASK_OPTION_LAYOUT;
  }
}
