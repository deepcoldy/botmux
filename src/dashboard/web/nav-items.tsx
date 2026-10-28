// 侧边栏导航的数据定义：条目、分组，以及 ⌘K 索引额外收录的子页面。独立成无副作用模块，
// app.tsx（渲染）和测试（覆盖检查）都直接 import，不必再按文本解析 app.tsx。
import type { ReactNode } from 'react';
import { INSIGHT_TABS } from './insight-tabs.js';

export type NavItem = {
  id: string;
  href: string;
  labelKey?: string;
  label?: string;
  manage?: boolean;
  plugin?: boolean;
  icon: ReactNode;
  /** ⌘K 里额外参与匹配的叫法（界面上不显示），例如「机器人配置」之于「Bot 配置」。 */
  aliases?: readonly string[];
};

/**
 * 「Bot 配置」的其它叫法：页面条目和页内分类条目（command-palette-sources）共用这一份。
 * 不收「Bot 设置」：「设置」会落在它的词首，把「全局设置」从「设置」的首条挤下去。
 */
export const BOT_DEFAULTS_ALIASES: readonly string[] = ['机器人配置', '机器人设置', 'bot settings', 'bot configuration'];

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    href: '#/',
    labelKey: 'nav.overview',
    icon: (
      <>
        <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.5" />
        <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.5" />
        <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.5" />
        <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.5" />
      </>
    ),
  },
  { id: 'sessions', href: '#/sessions', labelKey: 'nav.sessions', aliases: ['对话', 'conversations', 'chats'], icon: <path d="M2 3.5h12v7H6l-3 3v-3H2z" /> },
  // 决策看板：只有至少一个 Bot 设为管家时才出现在侧边栏（见 app.tsx 的 sidebarNavItems）。
  // 不是 manage 项：飞书 H5 免登的 owner 也要能从侧边栏进来。
  {
    id: 'decision-board',
    href: '#/board',
    labelKey: 'nav.decisionBoard',
    aliases: ['拍板', 'decisions'],
    icon: <><rect x="2.5" y="2" width="11" height="12" rx="1.8" /><path d="M5 5.6l1.1 1.1 2.1-2.1M5 10.4l1.1 1.1 2.1-2.1M9.9 5.7h1.6M9.9 10.5h1.6" /></>,
  },
  {
    // 驾驶舱（Agent Workbench）：桌面/移动壳内与带沉浸式标记的直达入口是无边框壳
    // （见 workbenchSurface），从侧边栏进入时走正常壳。不属于 manage 项。
    id: 'agent-workbench',
    href: '#/agent-workbench',
    labelKey: 'nav.workbench',
    icon: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3" /></>,
  },
  {
    id: 'groups',
    href: '#/groups',
    labelKey: 'nav.groups',
    icon: (
      <>
        <circle cx="5.6" cy="5.8" r="2.4" />
        <circle cx="11" cy="6.8" r="1.9" />
        <path d="M1.8 13.2c.5-2.4 2-3.6 3.8-3.6s3.3 1.2 3.8 3.6M9.8 12.6c.4-1.7 1.5-2.6 2.8-2.6 1 0 1.9.5 2.4 1.6" />
      </>
    ),
  },
  { id: 'roles', href: '#/roles', labelKey: 'nav.roles', manage: true, icon: <><path d="M8 1.8l5.2 2v3.4c0 3.4-2.2 5.9-5.2 7-3-1.1-5.2-3.6-5.2-7V3.8z" /><path d="M5.8 8l1.6 1.6 2.8-3" /></> },
  { id: 'message-listeners', href: '#/message-listeners', labelKey: 'nav.messageListeners', manage: true, icon: <><circle cx="8" cy="8" r="5.5" /><path d="M8 4.7v3.7l2.4 1.5" /></> },
  {
    id: 'monitoring',
    href: '#/monitoring',
    labelKey: 'nav.monitoring',
    icon: (
      <>
        <path d="M2 9.2h2.3l1.3-4.8 2.5 8.4 1.8-5.1h4.1" />
        <path d="M2 2.5h12v11H2z" />
      </>
    ),
  },
  { id: 'insights', href: '#/insights', labelKey: 'nav.insights', manage: true, icon: <><path d="M2 2v12h12M5 11V7M8.5 11V4.5M12 11V8.5" /></> },
  { id: 'feedback', href: '#/feedback', labelKey: 'nav.feedback', manage: true, icon: <><path d="M2.2 3.2h11.6v8H8l-3.2 2.6v-2.6H2.2z" /><path d="M5 6.2h6M5 8.3h4" /></> },
  {
    id: 'workflows',
    href: '#/workflows',
    labelKey: 'nav.workflows',
    icon: (
      <>
        <circle cx="3.4" cy="3.6" r="1.9" />
        <circle cx="3.4" cy="12.4" r="1.9" />
        <circle cx="12.6" cy="8" r="1.9" />
        <path d="M5.2 4.4l5.6 2.8M5.2 11.6l5.6-2.8" />
      </>
    ),
  },
  { id: 'schedules', href: '#/schedules', labelKey: 'nav.schedules', icon: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.5V8l2.4 1.6" /></> },
  { id: 'whiteboards', href: '#/whiteboards', labelKey: 'nav.whiteboards', manage: true, icon: <><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" /><path d="M4.8 5.2h6.4M4.8 8h6.4M4.8 10.8h4" /></> },
  { id: 'doc-watches', href: '#/doc-watches', labelKey: 'nav.docWatches', manage: true, icon: <><path d="M3.2 2.2h6.2l3.4 3.4v8.2H3.2z" /><path d="M9.2 2.4v3.4h3.4" /><path d="M5.4 9h4M5.4 11.2h2.6" /></> },
  { id: 'bot-defaults', href: '#/bot-defaults', labelKey: 'nav.botDefaults', aliases: BOT_DEFAULTS_ALIASES, manage: true, icon: <><rect x="2.5" y="5" width="11" height="8" rx="2" /><circle cx="5.8" cy="9" r="1" /><circle cx="10.2" cy="9" r="1" /><path d="M8 5V2.5M5.5 13v1.2M10.5 13v1.2" /></> },
  { id: 'agents', href: '#/agents', labelKey: 'nav.agents', aliases: ['智能体'], manage: true, icon: <><rect x="1.8" y="2.6" width="5.2" height="4.4" rx="1.4" /><rect x="9" y="1.8" width="5.2" height="3.6" rx="1.2" /><rect x="9" y="10.6" width="5.2" height="3.6" rx="1.2" /><path d="M7 4.8c1.2 0 1.2-1.2 2-1.2M7 4.8c1.4 0 .6 7.6 2 7.6" /></> },
  { id: 'skills', href: '#/skills', labelKey: 'nav.skills', aliases: ['技能'], manage: true, icon: <><path d="M3 2.5h10v3H3zM3 7h10v6.5H3z" /><path d="M5.4 9.2h5.2M5.4 11.2h3.8" /></> },
  { id: 'customization', href: '#/customization', labelKey: 'nav.customization', manage: true, icon: <><path d="M11.5 2.5l2 2-7 7-2.6.6.6-2.6z" /><path d="M2.5 13.5h5" /></> },
  { id: 'plugins', href: '#/plugins', label: '插件', manage: true, icon: <><path d="M6.4 1.8h3.2v3h2.8v3.2H9.6v2.8H6.4V8H3.6V4.8h2.8z" /><path d="M2.2 11.8h11.6v2.4H2.2z" /></> },
  { id: 'team', href: '#/team', labelKey: 'nav.team', manage: true, icon: <><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c-2 1.8-2 10.6 0 12.4 2-1.8 2-10.6 0-12.4z" /></> },
  { id: 'connectors', href: '#/connectors', labelKey: 'nav.connectors', manage: true, icon: <><path d="M5.5 6.5v-3a2.5 2.5 0 0 1 5 0v3" /><rect x="3.5" y="6.5" width="9" height="7" rx="2" /></> },
  // 宿主网页终端：本机 shell / tmux / herdr。只给本机 owner（ui.hostTerminal），客户端壳里不出现。
  { id: 'terminal', href: '#/terminal', labelKey: 'nav.terminal', manage: true, icon: <><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" /><path d="M4.4 6.2l2.2 1.8-2.2 1.8M8 10.6h3.4" /></> },
  { id: 'settings', href: '#/settings', labelKey: 'nav.settings', icon: <><path d="M8 1.75 9.35 2.05 10 3.28l1.38.3 1.04-.96.96.96-.96 1.04.3 1.38 1.23.65L14.25 8l-.3 1.35-1.23.65-.3 1.38.96 1.04-.96.96-1.04-.96-1.38.3-.65 1.23L8 14.25l-1.35-.3L6 12.72l-1.38-.3-1.04.96-.96-.96.96-1.04-.3-1.38-1.23-.65L1.75 8l.3-1.35 1.23-.65.3-1.38-.96-1.04.96-.96 1.04.96 1.38-.3.65-1.23z" /><circle cx="8" cy="8" r="2" /></> },
];

/**
 * 侧边栏分组（顺序即渲染顺序）。组内只存 NavItem id，渲染时从
 * {@link sidebarNavItems} 的结果里按 id 取——manage 过滤、client-shell 过滤、
 * pinned plugin 插入都仍由那条链路负责，这里不复制任何权限/可见性逻辑。
 * pinned plugin 项没有自己的组，统一挂在「管理」组的「插件」之后。
 */
export const NAV_GROUPS: Array<{ id: string; labelKey: string; items: string[] }> = [
  { id: 'overview', labelKey: 'nav.group.overview', items: ['overview'] },
  { id: 'collab', labelKey: 'nav.group.collab', items: ['sessions', 'decision-board', 'agent-workbench', 'groups', 'schedules', 'workflows'] },
  { id: 'workforce', labelKey: 'nav.group.workforce', items: ['roles', 'skills', 'customization', 'message-listeners', 'doc-watches', 'bot-defaults', 'agents'] },
  { id: 'analytics', labelKey: 'nav.group.analytics', items: ['monitoring', 'insights', 'feedback'] },
  { id: 'manage', labelKey: 'nav.group.manage', items: ['terminal', 'connectors', 'team', 'plugins', 'whiteboards', 'settings'] },
];

/**
 * 不在侧边栏、但有独立地址的页面 / 页内 tab，⌘K 照样收录。父项在侧边栏里不可见（没权限、
 * 客户端壳过滤）时子页面也不收录；客户端壳会重定向走的地址同样跳过（见 app.tsx paletteNavPages）。
 */
export interface NavSubPage {
  id: string;
  /** 所属侧边栏条目 id，图标和分组都跟它走。 */
  parentId: string;
  href: string;
  labelKey: string;
  aliases?: readonly string[];
}

export const NAV_SUBPAGES: readonly NavSubPage[] = [
  { id: 'monitor-room', parentId: 'sessions', href: '#/monitor-room', labelKey: 'monitorRoom.title' },
  { id: 'roles-profile', parentId: 'roles', href: '#/roles/profile', labelKey: 'roles.tabProfiles', aliases: ['角色 Profile', 'role profiles'] },
  { id: 'team-manage', parentId: 'team', href: '#/team/manage', labelKey: 'team.navManage' },
  { id: 'connectors-logs', parentId: 'connectors', href: '#/connectors/logs', labelKey: 'connectors.tabLogs', aliases: ['Webhook 日志', 'webhook logs'] },
  // 数据洞察的 tab 直接按 INSIGHT_TABS 生成，新加 tab 自动进索引；overview 就是 #/insights 本身。
  ...INSIGHT_TABS.filter(tab => tab.key !== 'overview').map(tab => ({
    id: `insights-${tab.key}`,
    parentId: 'insights',
    href: `#/insights?tab=${tab.key}`,
    labelKey: tab.label,
  })),
];

/**
 * 路由表里有意不进 ⌘K 索引的路由及原因。覆盖测试要求 dashboardRoutes 的每一项要么在侧边栏 /
 * NAV_SUBPAGES 里，要么写在这里——新加页面忘了登记会直接红。
 */
export const PALETTE_UNINDEXED_ROUTES: Readonly<Record<string, string>> = {
  'agent-workbench-dock': '桌面壳 / 沉浸式入口嵌入的驾驶舱界面，不是独立页面',
  'webhook-logs': '#/connectors/logs 的旧别名',
};
