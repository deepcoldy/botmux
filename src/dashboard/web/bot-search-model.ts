/**
 * 可搜索的 Bot 选择器（工作流草稿页的各处选 Bot）：选项与过滤规则。
 *
 * 过滤按显示名、appId、CLI 类型做大小写不敏感的子串匹配（中文名直接按子串）。
 * 拼音 / 拼音首字母不支持：仓库与依赖里没有拼音工具，也不为它新增依赖。
 * 不能用的 Bot 照样列出（带原因、不可选），过滤对它们一视同仁。
 */

export interface BotSearchOption {
  larkAppId: string;
  name: string;
  cliId?: string;
  /** 主 Bot 等标记（显示在名称后）。 */
  suffix?: string;
  /** 不能选的原因（选项照样显示、不可选）。 */
  disabledWhy?: string;
  /** 能选但要提示的事（例如最近一次调用模型失败）。 */
  hint?: string;
}

/** 选项是否匹配查询：显示名、appId、CLI 任一包含查询（大小写不敏感，忽略首尾空白）。 */
export function botOptionMatches(option: BotSearchOption, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [option.name, option.larkAppId, option.cliId ?? '']
    .some((field) => field.toLocaleLowerCase().includes(needle));
}

export function filterBotOptions<T extends BotSearchOption>(options: readonly T[], query: string): T[] {
  return options.filter((option) => botOptionMatches(option, query));
}

/** 触发器上显示的名字：选中项，或（不在列表里时）它的 appId。 */
export function botOptionLabel(option: BotSearchOption): string {
  return `${option.name}${option.cliId ? ` · ${option.cliId}` : ''}${option.suffix ?? ''}`;
}
