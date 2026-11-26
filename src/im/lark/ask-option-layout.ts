/**
 * Per-bot `askOptionLayout` setting (`compact` / `vertical`).
 *
 * It no longer changes how Ask cards look: every option is now its own row with
 * a checker (see ask-card-look.ts), so there is no row of buttons left to lay out.
 * The key is still accepted, validated and saved (bots.json, Dashboard) so existing
 * configurations keep loading; it simply has no visible effect.
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
