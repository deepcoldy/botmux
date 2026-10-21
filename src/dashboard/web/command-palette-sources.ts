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
import type { SkillRow } from './skills/types.js';
import type { PaletteItem, PaletteTone } from './command-palette-model.js';

export interface PalettePageEntry {
  id: string;
  href: string;
  label: string;
  /** 有 i18n key 的页面额外用另一种语言的名字参与匹配（中文界面搜 settings 也能命中）。 */
  labelKey?: string;
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
      s.larkAppId,
      s.botName,
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
  return [...bots]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(bot => ({
      key: `bot:${bot.larkAppId}`,
      kind: 'bot' as const,
      title: bot.name,
      subtitle: bot.larkAppId,
      avatar: { name: bot.name, larkAppId: bot.larkAppId },
      primary: { label: t('palette.actionOpenBot'), href: `#/bot-defaults?bot=${encodeURIComponent(bot.larkAppId)}` },
    }));
}

// ── 设置 ─────────────────────────────────────────────────────────────────────

export interface SettingsSearchEntry {
  /** settings 页 SettingsBlock 的 DOM id，深链 `#/settings?section=<id>` 滚到它。 */
  id: string;
  module: string;
  section: string;
  /** 区块内字段标题的 i18n key；深链带 `field=<key>` 时页面会闪烁定位到该行。 */
  fields: readonly string[];
}

/** 全局设置的可搜索索引。settings 页新增区块 / 字段时同步这里（单测校验 key 都有译文）。 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { id: 'settings-access', module: 'settings.moduleGeneral', section: 'settings.sectionAccess', fields: ['settings.publicReadOnly', 'settings.remoteAccess', 'settings.oauthRedirectBase'] },
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
  { id: 'settings-update', module: 'settings.moduleSystem', section: 'settings.sectionUpdate', fields: [] },
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
      keywords: [...bilingual(entry.section), ...bilingual(entry.module), ...bilingual('nav.settings')],
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
    title: page.label,
    subtitle: page.groupLabel,
    keywords: [...(page.labelKey ? bilingual(page.labelKey) : []), page.id],
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
