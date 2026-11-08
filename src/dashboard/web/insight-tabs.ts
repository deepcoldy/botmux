// 数据洞察页的 tab 列表单独成模块：insights.ts 依赖 markdown-it 等重模块，而侧边栏 /
// ⌘K 索引（入口包）也要按 tab 生成子页面条目，只能从这份轻量常量取。

export type InsightTab = 'overview' | 'sessions' | 'flow' | 'dist' | 'hot';

export const INSIGHT_TABS: Array<{ key: InsightTab; label: string }> = [
  { key: 'overview', label: 'insights.tabOverview' },
  { key: 'sessions', label: 'insights.tabSessions' },
  { key: 'flow', label: 'insights.tabFlow' },
  { key: 'dist', label: 'insights.tabDist' },
  { key: 'hot', label: 'insights.tabHot' },
];

export const INSIGHT_TAB_KEYS: InsightTab[] = INSIGHT_TABS.map(tab => tab.key);
