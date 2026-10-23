// ⌘K 全局搜索的数据源：把会话 / Skill / Agent / 设置 / 机器人 / 页面 / 快捷操作
// 各自的原始数据转成统一的 PaletteItem。只做「数据 → 条目」的映射与跳转目标，
// 匹配排序规则在 command-palette-model，渲染与交互在 command-palette。
import type { ReactNode } from 'react';
import {
  attentionReason,
  attentionWaitSince,
  botDisplayName,
  chatDisplayTitle,
  knownBots,
  relTime,
  stripMentionPrefix,
  t,
  ui,
} from './ui.js';
import { createDashboardTranslator, type DashboardLocale } from './i18n.js';
import { THEME_OPTIONS } from './theme-menu.js';
import { sourceLabel } from './skills/shared.js';
import { BOT_DEFAULTS_SECTIONS, BOT_DEFAULTS_TABS, BOT_DEFAULTS_TAB_LABEL_KEYS, botDefaultsHref } from './bot-defaults.js';
import { BOT_DEFAULTS_ALIASES } from './nav-items.js';
import type { SkillRow } from './skills/types.js';
import type { PaletteItem, PaletteTone } from './command-palette-model.js';

export interface PalettePageEntry {
  id: string;
  href: string;
  label: string;
  /** 有 i18n key 的页面额外用另一种语言的名字参与匹配（中文界面搜 settings 也能命中）。 */
  labelKey?: string;
  /** 界面上不显示、但参与匹配的叫法（如「机器人配置」之于「Bot 配置」）。 */
  aliases?: readonly string[];
  /**
   * 子页面 / 页内 tab 所属的页面：标题与两种语言的关键词都写成「父页面 › 子页面」。
   * 「会话」「分布」这类短名单独做标题会全等命中，把「会话控制」等主页面挤下首条。
   */
  parent?: { label: string; labelKey?: string };
  groupLabel?: string;
  icon?: ReactNode;
}

/** 壳层（app.tsx）注入的能力：页面清单与只有壳层才拿得到的动作。 */
export interface PaletteShellContext {
  pages: PalettePageEntry[];
  /**
   * 登录态已经从 `/api/settings` 确认且是管理身份，才去拉 Skill / Agent。`ui.authed` 在
   * 确认前默认 true；那个窗口里按 ⌘K 会让公开只读访客吃到 401、被全局 fetch 包装弹出登录浮层。
   */
  manageDataReady: boolean;
  setLocale(locale: DashboardLocale): void;
  openCreateSession(): void;
  openCreateBot(): void;
}

export interface PaletteAgentRow {
  id: string;
  name?: string;
  description?: string;
}

const translators = {
  zh: createDashboardTranslator('zh'),
  en: createDashboardTranslator('en'),
};

/** 同一个 key 在两种语言下的文案（去重）。 */
function bilingual(key: string): string[] {
  return [...new Set([translators.zh(key), translators.en(key)])];
}

/**
 * 子页面 / 页内分类在两种语言下的全名「父 › 子」（去重），拿来做关键词。不收光秃秃的短名：
 * 英文界面搜「会话」时，短名「会话」全等命中会压过只在关键词里前缀命中的「会话控制」。
 */
function bilingualPath(parent: { label: string; labelKey?: string }, childKey: string): string[] {
  const path = (tr: (key: string) => string) => `${parent.labelKey ? tr(parent.labelKey) : parent.label} › ${tr(childKey)}`;
  return [...new Set([path(translators.zh), path(translators.en)])];
}

/** 多级路径「A › B › C」在两种语言下的写法（去重），按文案键逐级翻译。 */
function bilingualTrail(keys: readonly string[]): string[] {
  return [...new Set([translators.zh, translators.en].map(tr => keys.map(key => tr(key)).join(' › ')))];
}

function compact(text: unknown, limit = 140): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function basename(path: unknown): string {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// ── 会话 ─────────────────────────────────────────────────────────────────────

const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);

export function sessionDetailHref(sessionId: string): string {
  return `#/sessions?session=${encodeURIComponent(sessionId)}`;
}

export function workbenchSessionHref(sessionId: string): string {
  return `#/agent-workbench/${encodeURIComponent(sessionId)}`;
}

function sessionLastActive(s: Record<string, any>): number {
  const value = Number(s.lastMessageAt ?? s.closedAt ?? s.spawnedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 推荐顺序：待处理（等得最久的在前）→ 其余活跃会话（最近活动在前）→ 已关闭（最近在前）。
 * 空查询时「全部」取前几条做推荐，「会话」分类整列都按它排。
 */
export function orderSessionsForPalette<T extends Record<string, any>>(rows: Iterable<T>): T[] {
  const attention: T[] = [];
  const active: T[] = [];
  const closed: T[] = [];
  for (const row of rows) {
    if (row.status === 'closed') closed.push(row);
    else if (attentionReason(row)) attention.push(row);
    else active.push(row);
  }
  attention.sort((a, b) => attentionWaitSince(a) - attentionWaitSince(b));
  active.sort((a, b) => sessionLastActive(b) - sessionLastActive(a));
  closed.sort((a, b) => sessionLastActive(b) - sessionLastActive(a));
  return [...attention, ...active, ...closed];
}

function sessionStatusLabel(status: string): string {
  const key = `sessions.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

function sessionBadge(s: Record<string, any>): { text: string; tone: PaletteTone } {
  const status = String(s.status ?? 'unknown');
  if (status === 'closed') return { text: sessionStatusLabel(status), tone: 'closed' };
  if (attentionReason(s)) return { text: t('palette.badgeAttention'), tone: 'need' };
  if (BUSY_STATUSES.has(status)) return { text: sessionStatusLabel(status), tone: 'work' };
  return { text: sessionStatusLabel(status), tone: 'idle' };
}

/**
 * `cache` 以会话行对象为键：store 更新只替换变化的那一行，面板开着时每条 SSE 就只重建
 * 一个条目（数千会话下整表重建 + 重新小写化要几十毫秒）。缓存由面板实例持有、每次唤起
 * 重建，所以条目里的相对时间不会跨次唤起过期。
 */
export function buildSessionItems(
  rows: Iterable<Record<string, any>>,
  now = Date.now(),
  cache?: WeakMap<object, PaletteItem>,
): PaletteItem[] {
  return orderSessionsForPalette(rows).map(s => {
    const cached = cache?.get(s);
    if (cached) return cached;
    const item = buildSessionItem(s, now);
    cache?.set(s, item);
    return item;
  });
}

function buildSessionItem(s: Record<string, any>, now: number): PaletteItem {
  const id = String(s.sessionId);
  const closed = s.status === 'closed';
  const location = chatDisplayTitle(s) ?? (s.chatType === 'p2p' ? t('sessions.directChat') : '');
  const repo = compact(s.workspace?.displayName, 40) || basename(s.workingDir);
  const title = compact(stripMentionPrefix(s.title), 120) || location || id;
  const lastActive = sessionLastActive(s);
  const ageDays = lastActive ? Math.max(0, (now - lastActive) / 86_400_000) : 30;
  const recency = Math.max(0, 1 - ageDays / 30);
  const feishuLink = String(s.feishuThreadLink || s.feishuChatLink || '');
  const item: PaletteItem = {
    key: `session:${id}`,
    kind: 'session',
    title,
    subtitle: [botDisplayName(s), location, repo, s.cliId].filter(Boolean).join(' · '),
    keywords: [
      id,
      s.chatId,
      s.title,
      s.workingDir,
      s.workspace?.rootPath,
      s.workspace?.branch,
      // 不放 larkAppId：按 app id 搜要直达那个 bot，不该被一串会话抢在前面；会话仍可按 bot 名（副标题）搜到。
    ].filter(Boolean).map(String),
    meta: lastActive ? relTime(lastActive) : undefined,
    badge: sessionBadge(s),
    avatar: { name: botDisplayName(s), larkAppId: s.larkAppId },
    boost: (closed ? 0.1 : 0.6) + recency * 0.3 + (attentionReason(s) ? 0.1 : 0),
    primary: { label: t('palette.actionOpenSession'), href: sessionDetailHref(id) },
  };
  if (!closed && ui.workbenchAuthed) {
    item.secondary = { label: t('palette.actionOpenWorkbench'), href: workbenchSessionHref(id) };
  } else if (feishuLink.startsWith('https://')) {
    item.secondary = { label: t('palette.actionOpenFeishu'), href: feishuLink, external: true };
  }
  return item;
}

// ── Skill / Agent / 机器人 ───────────────────────────────────────────────────

export function skillHref(name: string): string {
  return `#/skills?skill=${encodeURIComponent(name)}`;
}

export function buildSkillItems(skills: readonly SkillRow[]): PaletteItem[] {
  return [...skills]
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name))
    .map(skill => {
      const source = sourceLabel(skill, t);
      return {
        key: `skill:${skill.name}`,
        kind: 'skill' as const,
        title: skill.displayName || skill.name,
        subtitle: compact(skill.description) || source,
        keywords: [skill.name, ...(skill.tags ?? []), source].filter(Boolean),
        meta: skill.displayName && skill.displayName !== skill.name ? skill.name : undefined,
        primary: { label: t('palette.actionOpenSkill'), href: skillHref(skill.name) },
      };
    });
}

export function agentHref(id: string): string {
  return `#/agents?agent=${encodeURIComponent(id)}`;
}

export function buildAgentItems(agents: readonly PaletteAgentRow[], links: Record<string, string> = {}): PaletteItem[] {
  const linkedCount = new Map<string, number>();
  for (const agentId of Object.values(links)) linkedCount.set(agentId, (linkedCount.get(agentId) ?? 0) + 1);
  return agents
    .filter(agent => agent && typeof agent.id === 'string' && agent.id)
    .map(agent => {
      const bots = linkedCount.get(agent.id) ?? 0;
      return {
        key: `agent:${agent.id}`,
        kind: 'agent' as const,
        title: agent.name || agent.id,
        subtitle: compact(agent.description) || undefined,
        keywords: [agent.id],
        meta: bots > 0 ? t('palette.linkedBots', { count: bots }) : undefined,
        primary: { label: t('palette.actionOpenAgent'), href: agentHref(agent.id) },
      };
    });
}

export function buildBotItems(bots: ReadonlyArray<{ larkAppId: string; name: string }> = knownBots()): PaletteItem[] {
  if (!ui.authed) return [];
  const botConfig = t('nav.botDefaults');
  return [...bots]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(bot => {
      const named = bot.name !== bot.larkAppId;
      return {
        key: `bot:${bot.larkAppId}`,
        kind: 'bot' as const,
        title: bot.name,
        subtitle: named ? `${botConfig} · ${bot.larkAppId}` : botConfig,
        // app id 进关键词：按 cli_xxx 搜时直达，排在带同一 app id 的会话之前。
        keywords: [bot.larkAppId, ...bilingual('nav.botDefaults')],
        avatar: { name: bot.name, larkAppId: bot.larkAppId },
        primary: { label: t('palette.actionOpenBot'), href: botDefaultsHref({ bot: bot.larkAppId }) },
      };
    });
}

/** Bot 配置页内的分类（常用 / 会话 / 权限与安全 / 消息卡片 / 高级），直接按 BOT_DEFAULTS_TABS 生成。 */
export function buildBotDefaultsTabItems(): PaletteItem[] {
  if (!ui.authed) return [];
  const botConfig = t('nav.botDefaults');
  return BOT_DEFAULTS_TABS.map(tab => ({
    key: `setting:bot-defaults:${tab}`,
    kind: 'setting' as const,
    // 带上父页面名：「常用」「会话」「高级」单独做标题会全等命中，抢掉「会话控制」等主页面的首条。
    title: `${botConfig} › ${t(BOT_DEFAULTS_TAB_LABEL_KEYS[tab])}`,
    keywords: [...bilingualPath({ label: botConfig, labelKey: 'nav.botDefaults' }, BOT_DEFAULTS_TAB_LABEL_KEYS[tab]), ...BOT_DEFAULTS_ALIASES],
    // 同分时让「Bot 配置」整页排在分类前面（只搜「机器人配置」时首条应是页面本身）。
    boost: -0.05,
    iconId: 'bot',
    primary: { label: t('palette.actionGoto'), href: botDefaultsHref({ tab }) },
  }));
}

/**
 * Bot 配置页各分类里的区块和区块里的配置项，按 BOT_DEFAULTS_SECTIONS 生成。标题同样带「Bot 配置 ›」：
 * 「模型」「沙盒」这类短名单独做标题会抢主页面的首条。但这段前缀只算上下文（titleContext）：
 * 搜「Bot 配置」时五个分类在前，搜「new bot」时「新建机器人」不被配置项挤下去。
 * 区块不拿分类名做副标题，否则搜「常用」「高级」时区块会全等命中、排在分类本身前面。
 * 同一区块里译文重复的配置项只收第一个。
 */
export function buildBotDefaultsSectionItems(): PaletteItem[] {
  if (!ui.authed) return [];
  const botConfig = t('nav.botDefaults');
  const titleContext = `${botConfig} › `.length;
  const items: PaletteItem[] = [];
  for (const section of BOT_DEFAULTS_SECTIONS) {
    const tabKey = BOT_DEFAULTS_TAB_LABEL_KEYS[section.tab];
    const sectionTitle = t(section.titleKey);
    items.push({
      key: `setting:bot-defaults-section:${section.id}`,
      kind: 'setting',
      title: `${botConfig} › ${sectionTitle}`,
      titleContext,
      keywords: bilingualTrail(['nav.botDefaults', tabKey, section.titleKey]),
      // 同分时分类排在区块前面、区块排在配置项前面。
      boost: -0.1,
      iconId: 'bot',
      primary: { label: t('palette.actionGoto'), href: botDefaultsHref({ section: section.id }) },
    });
    const seen = new Set([sectionTitle]);
    for (const field of section.fieldKeys ?? []) {
      const fieldTitle = t(field);
      if (seen.has(fieldTitle)) continue;
      seen.add(fieldTitle);
      items.push({
        key: `setting:bot-defaults-field:${section.id}:${field}`,
        kind: 'setting',
        title: `${botConfig} › ${fieldTitle}`,
        titleContext,
        subtitle: `${t(tabKey)} › ${sectionTitle}`,
        keywords: bilingualTrail(['nav.botDefaults', tabKey, section.titleKey, field]),
        boost: -0.15,
        iconId: 'bot',
        primary: { label: t('palette.actionGoto'), href: botDefaultsHref({ section: section.id, field }) },
      });
    }
  }
  return items;
}

// ── 设置 ─────────────────────────────────────────────────────────────────────

export interface SettingsSearchEntry {
  /** settings 页 SettingsBlock 的 DOM id，深链 `#/settings?section=<id>` 滚到它。 */
  id: string;
  module: string;
  section: string;
  /** 区块内字段标题的 i18n key；深链带 `field=<key>` 时页面会闪烁定位到该行。 */
  fields: readonly string[];
  /** 区块的其它叫法（i18n key），例如页面标题和设置侧栏用词不同时两种都能搜到。 */
  aliasKeys?: readonly string[];
}

/** 全局设置的可搜索索引。settings 页新增区块 / 字段时同步这里（单测校验 key 都有译文）。 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { id: 'settings-access', module: 'settings.moduleGeneral', section: 'settings.sectionAccess', fields: ['settings.publicReadOnly', 'settings.remoteAccess', 'settings.oauthRedirectBase'] },
  { id: 'settings-session-env', module: 'settings.moduleGeneral', section: 'sessionEnv.sectionTitle', fields: ['sessionEnv.tmuxTitle'] },
  { id: 'settings-cards', module: 'settings.moduleGeneral', section: 'settings.sectionCards', fields: ['settings.cardBrandLabel', 'settings.openTerminalInFeishu', 'settings.enableLocalCliOpen', 'settings.localCliOpenMode'] },
  { id: 'settings-group-creation', module: 'settings.moduleGeneral', section: 'settings.sectionGroupCreation', fields: ['settings.groupNamePrefix'] },
  {
    id: 'settings-experimental',
    module: 'settings.moduleGeneral',
    section: 'settings.sectionExperimental',
    fields: [
      'settings.chatBotDiscovery',
      'settings.herdrTraexPlugin',
      'settings.codexRpcInput',
      'settings.autoUpgradeCodexSessions',
      'settings.bypassCodexHookTrust',
      'settings.hideCodexRateLimitModelNudge',
      'settings.codexNotifier',
      'settings.noVisibleOutputHint',
      'settings.crossPrincipalInterruption',
    ],
  },
  { id: 'settings-overload', module: 'settings.moduleGeneral', section: 'settings.sectionHostOverloadAlert', fields: ['settings.hostOverloadAlert'] },
  { id: 'settings-whiteboard', module: 'settings.moduleGeneral', section: 'settings.sectionWhiteboard', fields: ['settings.whiteboardEnable'] },
  { id: 'settings-workflow', module: 'settings.moduleGeneral', section: 'settings.sectionWorkflow', fields: ['settings.workflowEnable'] },
  { id: 'settings-multi-topic', module: 'settings.moduleGeneral', section: 'settings.sectionMultiTopic', fields: ['settings.multiTopicEnable'] },
  { id: 'settings-repo-picker', module: 'settings.moduleGeneral', section: 'settings.sectionRepoPicker', fields: ['settings.repoPickerMode'] },
  { id: 'settings-schedule', module: 'settings.moduleGeneral', section: 'settings.sectionSchedule', fields: ['settings.scheduleTimeZone', 'settings.sessionCleanupEnable', 'settings.sessionCleanupArchiveCodex'] },
  { id: 'settings-vc', module: 'settings.moduleMeeting', section: 'settings.sectionVcMeetingAgent', fields: ['settings.vcMeetingAgent'] },
  { id: 'settings-autostart', module: 'settings.moduleSystem', section: 'settings.sectionAutostart', fields: ['settings.autostartToggle'] },
  { id: 'settings-maintenance', module: 'settings.moduleSystem', section: 'settings.sectionMaintenance', fields: ['settings.autoUpdate', 'settings.autoRestart', 'settings.httpProxy'] },
  { id: 'settings-update', module: 'settings.moduleSystem', section: 'settings.sectionUpdate', fields: [], aliasKeys: ['update.section'] },
];

export function settingsHref(section: string, field?: string): string {
  const params = new URLSearchParams({ section });
  if (field) params.set('field', field);
  return `#/settings?${params.toString()}`;
}

export function buildSettingItems(index: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX): PaletteItem[] {
  const settingsTitle = t('nav.settings');
  const items: PaletteItem[] = [];
  for (const entry of index) {
    const sectionTitle = t(entry.section);
    items.push({
      key: `setting:${entry.id}`,
      kind: 'setting',
      title: sectionTitle,
      subtitle: `${settingsTitle} › ${t(entry.module)}`,
      keywords: [
        ...bilingual(entry.section),
        ...(entry.aliasKeys ?? []).flatMap(bilingual),
        ...bilingual(entry.module),
        ...bilingual('nav.settings'),
      ],
      primary: { label: t('palette.actionGoto'), href: settingsHref(entry.id) },
    });
    for (const field of entry.fields) {
      const fieldTitle = t(field);
      if (fieldTitle === sectionTitle) continue;
      items.push({
        key: `setting:${entry.id}:${field}`,
        kind: 'setting',
        title: fieldTitle,
        subtitle: `${settingsTitle} › ${sectionTitle}`,
        keywords: [...bilingual(field), ...bilingual(entry.section)],
        boost: -0.05,
        primary: { label: t('palette.actionGoto'), href: settingsHref(entry.id, field) },
      });
    }
  }
  return items;
}

/** 外观与语言：就地生效的偏好，归在「设置」分类里。 */
export function buildPreferenceItems(ctx: Pick<PaletteShellContext, 'setLocale'>): PaletteItem[] {
  const appearance = t('palette.subAppearance');
  const items: PaletteItem[] = THEME_OPTIONS.map(option => {
    const current = ui.theme === option.value;
    return {
      key: `setting:theme:${option.value}`,
      kind: 'setting' as const,
      title: t('palette.cmdTheme', { name: t(option.labelKey) }),
      subtitle: appearance,
      keywords: [...bilingual(option.labelKey), 'theme', '主题', '皮肤', 'skin', option.value],
      badge: current ? { text: t('palette.badgeCurrent'), tone: 'current' as const } : undefined,
      iconId: 'theme',
      primary: { label: t('palette.actionApply'), run: () => ui.setTheme(option.value) },
    };
  });
  const nextLocale: DashboardLocale = ui.locale === 'zh' ? 'en' : 'zh';
  items.push({
    key: 'setting:locale',
    kind: 'setting',
    title: t('palette.cmdSwitchLocale'),
    subtitle: t('palette.subLanguage'),
    keywords: ['language', 'locale', '语言', 'english', '中文', 'zh', 'en'],
    iconId: 'locale',
    primary: { label: t('palette.actionApply'), run: () => ctx.setLocale(nextLocale) },
  });
  return items;
}

// ── 页面与快捷操作 ───────────────────────────────────────────────────────────

export function buildPageItems(pages: readonly PalettePageEntry[]): PaletteItem[] {
  return pages.map(page => ({
    key: `page:${page.id}`,
    kind: 'page' as const,
    title: page.parent ? `${page.parent.label} › ${page.label}` : page.label,
    subtitle: page.groupLabel,
    keywords: [
      ...(page.labelKey ? (page.parent ? bilingualPath(page.parent, page.labelKey) : bilingual(page.labelKey)) : []),
      ...(page.aliases ?? []),
      page.id,
    ],
    iconId: page.id,
    primary: { label: t('palette.actionGoto'), href: page.href },
  }));
}

export function buildActionItems(ctx: Pick<PaletteShellContext, 'openCreateSession' | 'openCreateBot'>): PaletteItem[] {
  const items: PaletteItem[] = [];
  if (ui.authed) {
    items.push({
      key: 'action:create-session',
      kind: 'action',
      title: t('nav.createSession'),
      keywords: [...bilingual('nav.createSession'), 'new session', '新建会话'],
      iconId: 'create-session',
      primary: { label: t('palette.actionRun'), run: ctx.openCreateSession },
    });
    items.push({
      key: 'action:create-bot',
      kind: 'action',
      title: t('nav.createBot'),
      keywords: [...bilingual('nav.createBot'), 'new bot', '添加机器人', '新建机器人'],
      iconId: 'create-bot',
      primary: { label: t('palette.actionRun'), run: ctx.openCreateBot },
    });
  }
  items.push({
    key: 'action:docs',
    kind: 'action',
    title: t('palette.cmdDocs'),
    keywords: [...bilingual('nav.docs'), 'docs', 'help', '帮助'],
    iconId: 'docs',
    primary: { label: t('palette.actionOpenNewTab'), href: 'https://deepcoldy.github.io/botmux/', external: true },
  });
  return items;
}
