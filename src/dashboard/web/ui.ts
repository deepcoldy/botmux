import {
  fetchGroupsSnapshot,
} from './groups-api.js';

import {
  DASHBOARD_LOCALE_STORAGE_KEY,
  createDashboardTranslator,
  readStoredDashboardLocale,
  type DashboardLocale,
} from './i18n.js';
import {
  THEME_STORAGE_KEY,
  SKIN_STORAGE_KEY,
  readStoredThemeMode,
  readStoredSkin,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode,
  type SkinId,
} from './preferences.js';
import { applyCyberFx } from './cyber-fx.js';

type UiListener = () => void;

class DashboardUiState {
  locale: DashboardLocale = 'zh';
  themeMode: ThemeMode = 'system';
  resolvedTheme: ResolvedTheme = 'light';
  skin: SkinId = 'default';
  // Dashboard cookie-auth state, mirrored from /api/settings by app.tsx's
  // loadAuthState(). Gates write-only affordances rendered per-row (e.g. the
  // writable-terminal "🔑" segment in the sessions board) — read-only visitors
  // must not see a control whose endpoint they'd 401 on. Defaults true so a
  // transient probe failure never hides it from a real token holder.
  authed = true;
  // Effective dashboard sharing policy. When enabled, tokenless visitors may
  // read allow-listed dashboard data; it does not downgrade authenticated users.
  publicReadOnly = false;
  private listeners = new Set<UiListener>();
  private translate = createDashboardTranslator(this.locale);
  private mediaQuery: MediaQueryList | null = null;

  init(): void {
    const w = typeof window !== 'undefined' ? window : undefined;
    this.locale = readStoredDashboardLocale(w?.localStorage, navigatorLanguages());
    this.translate = createDashboardTranslator(this.locale);
    this.themeMode = readStoredThemeMode(w?.localStorage);
    this.skin = readStoredSkin(w?.localStorage);
    this.mediaQuery = w?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this.mediaQuery?.addEventListener('change', () => {
      this.applyTheme();
      this.emit();
    });
    this.applyTheme();
    this.applySkin();
    this.applyLocale();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.translate(key, params);
  }

  setLocale(locale: DashboardLocale): void {
    if (this.locale === locale) return;
    this.locale = locale;
    this.translate = createDashboardTranslator(locale);
    window.localStorage.setItem(DASHBOARD_LOCALE_STORAGE_KEY, locale);
    this.applyLocale();
    this.emit();
  }

  // The topbar exposes a single "Theme" dropdown whose value is either a base
  // colour mode (system/light/dark → the `default` skin) or a named skin id.
  get theme(): string {
    return this.skin === 'default' ? this.themeMode : this.skin;
  }

  setTheme(value: string): void {
    const isMode = value === 'system' || value === 'light' || value === 'dark';
    const nextSkin: SkinId = isMode ? 'default' : (value as SkinId);
    const skinChanged = nextSkin !== this.skin;
    if (isMode && this.themeMode !== value) {
      this.themeMode = value as ThemeMode;
      window.localStorage.setItem(THEME_STORAGE_KEY, this.themeMode);
    }
    if (skinChanged) {
      this.skin = nextSkin;
      window.localStorage.setItem(SKIN_STORAGE_KEY, this.skin);
    }
    this.applyTheme();
    this.applySkin(skinChanged);
    this.emit();
  }

  on(fn: UiListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private applyTheme(): void {
    this.resolvedTheme = resolveThemeMode(this.themeMode, !!this.mediaQuery?.matches);
    // A named skin ships its own light/dark palette, so drive data-theme from the
    // skin's intrinsic mode — that way the base theme's light/dark component rules
    // (incl. PR #123's dark-only overrides) match the skin instead of fighting it.
    // The default skin follows the user's system/light/dark choice.
    const themeAttr = this.skin === 'default' ? this.resolvedTheme : SKIN_THEME[this.skin];
    document.documentElement.dataset.theme = themeAttr;
    document.documentElement.dataset.themeMode = this.themeMode;
  }

  // `animate` plays the boot loader — true when the user actively switches in,
  // false on initial load so a refresh doesn't replay the 3s decrypt overlay.
  private applySkin(animate = false): void {
    document.documentElement.dataset.skin = this.skin;
    applyCyberFx(this.skin === 'cyber', animate);
  }

  private applyLocale(): void {
    document.documentElement.lang = this.locale === 'zh' ? 'zh-CN' : 'en';
  }
}

// Each named skin's intrinsic light/dark mode (drives the data-theme attribute).
const SKIN_THEME: Record<SkinId, ResolvedTheme> = {
  default: 'light',
  cyber: 'dark',
  fallout: 'dark',
};

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export const ui = new DashboardUiState();

export function t(key: string, params?: Record<string, string | number>): string {
  return ui.t(key, params);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

export function relTime(ms: number): string {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('common.now');
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}

// ── 数字员工视觉：每个 bot 一颗专属色相的"数字生命球" ─────────────────────
// 按名字 hash 从固定色板取渐变对，同名永远同色，跨页面一致。
const ORB_PALETTE: Array<{ c1: string; c2: string }> = [
  { c1: '#5be3ff', c2: '#4f8bff' },
  { c1: '#b89bff', c2: '#6b4df0' },
  { c1: '#7ce0c3', c2: '#2e9e8f' },
  { c1: '#8fb4ff', c2: '#3b62d8' },
  { c1: '#ffd28f', c2: '#d8783b' },
  { c1: '#7df0a8', c2: '#1f9e63' },
  { c1: '#9fd0ff', c2: '#4878c8' },
  { c1: '#ff9fb8', c2: '#d84a78' },
];

export function botOrbStyle(name: string): string {
  let h = 0;
  const key = String(name ?? '');
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const { c1, c2 } = ORB_PALETTE[h % ORB_PALETTE.length];
  return `--c1:${c1};--c2:${c2}`;
}

// 真实头像（飞书 /bot/v3/info 的 avatar_url）→ 渐变球。两套 key：larkAppId 优先，
// 再退回 botName，方便只拿得到名字的渲染点（会话行 / 角色树）也能命中。
const botAvatarByAppId = new Map<string, string>();
const botAvatarByName = new Map<string, string>();

/** 查 bot 头像 URL：larkAppId 是唯一稳定键，在场就只认它——绝不在 appId 落空时
 *  串到 botName 兜底，否则两个同名 bot 会互相借用头像（按名查 last-writer-wins）。
 *  只有完全没有 appId 的渲染点才退回按名查。 */
export function botAvatarUrlFor(name?: string, larkAppId?: string): string | undefined {
  if (larkAppId) return botAvatarByAppId.get(larkAppId);
  return name ? botAvatarByName.get(String(name)) : undefined;
}

export interface BotAvatarOpts {
  /** 展示名 —— 决定回退渐变球的色相，也用于按名查头像。 */
  name?: string;
  /** 主查询键。 */
  larkAppId?: string;
  /** 显式头像 URL（调用方已拿到时传，省一次 map 查询、首屏即出图）。 */
  avatarUrl?: string;
  /** 尺寸：md=42px（默认），sm=24px。 */
  size?: 'sm' | 'md';
  /** 右下角状态点；不传则不渲染圆点。 */
  dot?: 'ok' | 'busy' | 'warn' | 'off';
}

/** 全站统一的 bot 头像渲染：有头像出 <img>（盖在渐变球上、加载失败自动回退到
 *  渐变球），没有就直接渲染渐变球。避免"先球后头像"闪烁靠 CSS 的 .orb-has-img。 */
export function botAvatarHtml(opts: BotAvatarOpts): string {
  const name = opts.name ?? '';
  const url = opts.avatarUrl ?? botAvatarUrlFor(opts.name, opts.larkAppId);
  const sizeCls = opts.size === 'sm' ? ' orb-avatar-sm' : '';
  const hasImg = url ? ' orb-has-img' : '';
  const dot = opts.dot ? `<i class="orb-dot orb-dot-${opts.dot}"></i>` : '';
  const img = url
    ? `<img class="orb-img" src="${escapeHtml(url)}" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.orb-avatar')?.classList.remove('orb-has-img');this.remove()"/>`
    : '';
  return `<span class="orb-avatar${sizeCls}${hasImg}" style="${botOrbStyle(name)}" aria-hidden="true">${img}${dot}</span>`;
}

/** 查飞书群头像 URL（按 chatId）。 */
export function chatAvatarUrlFor(chatId?: string): string | undefined {
  return chatId ? chatAvatarById.get(chatId) : undefined;
}

export interface ChatAvatarOpts {
  chatId?: string;
  /** 群名 —— 决定回退占位的色相。 */
  name?: string;
  /** 显式群头像 URL（调用方已有时传，省一次 map 查询）。 */
  avatarUrl?: string;
  /** 尺寸：md=42px（默认），sm=24px。 */
  size?: 'sm' | 'md';
}

/** 飞书群头像渲染：圆角方形（.orb-square）以区别于圆形的 bot 头像；复用同一套
 *  占位 / 淡入 / 加载失败回退机制（.orb-has-img / .orb-img）。 */
export function chatAvatarHtml(opts: ChatAvatarOpts): string {
  const name = opts.name ?? opts.chatId ?? '';
  const url = opts.avatarUrl ?? chatAvatarUrlFor(opts.chatId);
  const sizeCls = opts.size === 'sm' ? ' orb-avatar-sm' : '';
  const hasImg = url ? ' orb-has-img' : '';
  const img = url
    ? `<img class="orb-img" src="${escapeHtml(url)}" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.orb-avatar')?.classList.remove('orb-has-img');this.remove()"/>`
    : '';
  return `<span class="orb-avatar orb-square${sizeCls}${hasImg}" style="${botOrbStyle(name)}" aria-hidden="true">${img}</span>`;
}

// ── 跨页共享的展示名解析（bot 友好名 / 群聊标题）────────────────────────────
// daemon IPC 上报的 SessionRow.botName 历史上填的是 larkAppId（friendly name
// probe 回来只回写了注册表 descriptor，没回填 IPC 的 cachedBotName），这里用
// /api/groups 的注册表 + 群列表把 id 解析成人话。加载失败静默降级显示原值——
// 纯展示增强，不挡核心功能。
const botNameByAppId = new Map<string, string>();
const chatNameById = new Map<string, string>();
const chatAvatarById = new Map<string, string>();
let nameMapsPromise: Promise<void> | null = null;

// 头像 URL / 展示名本地持久化：飞书 CDN 的图本身有 14 天 HTTP 缓存，但「先渲染
// 渐变球 + cli_xxx 原始 id、等 /api/groups 回来再换头像/友好名」这一刷会在每次
// 冷加载/切页时出现。把 URL 和名字映射都存进 localStorage 并在模块加载时同步
// 回灌，让任意页面首屏就拿得到头像 URL 与人话名字 —— 配合浏览器图片缓存即时
// 出图，彻底消除「球→头像」「cli_xxx→名字」那一刷。
const AVATAR_CACHE_KEY = 'botmux.avatarCache.v1';

function hydrateAvatarCache(): void {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(AVATAR_CACHE_KEY) : null;
    if (!raw) return;
    const c = JSON.parse(raw) as {
      botByAppId?: Record<string, string>;
      botByName?: Record<string, string>;
      chatById?: Record<string, string>;
      nameByAppId?: Record<string, string>;
      chatNameById?: Record<string, string>;
    };
    for (const [k, v] of Object.entries(c.botByAppId ?? {})) botAvatarByAppId.set(k, v);
    for (const [k, v] of Object.entries(c.botByName ?? {})) botAvatarByName.set(k, v);
    for (const [k, v] of Object.entries(c.chatById ?? {})) chatAvatarById.set(k, v);
    for (const [k, v] of Object.entries(c.nameByAppId ?? {})) botNameByAppId.set(k, v);
    for (const [k, v] of Object.entries(c.chatNameById ?? {})) chatNameById.set(k, v);
  } catch { /* 损坏/无 localStorage 时静默 */ }
}

function persistAvatarCache(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify({
      botByAppId: Object.fromEntries(botAvatarByAppId),
      botByName: Object.fromEntries(botAvatarByName),
      chatById: Object.fromEntries(chatAvatarById),
      nameByAppId: Object.fromEntries(botNameByAppId),
      chatNameById: Object.fromEntries(chatNameById),
    }));
  } catch { /* 配额/SSR 时静默 */ }
}

hydrateAvatarCache(); // 模块加载即回灌，先于任何页面渲染

export function loadNameMaps(): Promise<void> {
  nameMapsPromise ??= (async () => {
    try {
      const data = await fetchGroupsSnapshot();
      for (const b of data.bots ?? []) {
        if (b.larkAppId && b.botName && b.botName !== b.larkAppId) {
          botNameByAppId.set(b.larkAppId, String(b.botName));
        }
        if (b.botAvatarUrl) {
          if (b.larkAppId) botAvatarByAppId.set(b.larkAppId, String(b.botAvatarUrl));
          if (b.botName) botAvatarByName.set(String(b.botName), String(b.botAvatarUrl));
        }
      }
      for (const c of data.chats ?? []) {
        if (c.chatId && c.name) chatNameById.set(c.chatId, String(c.name));
        if (c.chatId && c.avatar) chatAvatarById.set(c.chatId, String(c.avatar));
      }
      persistAvatarCache(); // 刷新本地缓存，下次冷加载首屏即出头像
    } catch {
      // 失败不缓存（dashboard 刚启动 /api/groups 可能短暂 503）——
      // 清掉 memo，下一个页面 mount / strip 重绘再重试；期间显示原始 id。
      nameMapsPromise = null;
    }
  })();
  return nameMapsPromise;
}

/** 按 larkAppId 查注册表友好名（含 localStorage 回灌的缓存）；查不到返回 undefined。 */
export function botNameForAppId(appId?: string): string | undefined {
  return appId ? botNameByAppId.get(appId) : undefined;
}

/** 会话所属 bot 的显示名：注册表友好名 → 会话自带 botName（非 id 时）→ id。 */
export function botDisplayName(s: Record<string, any>): string {
  const mapped = s.larkAppId ? botNameByAppId.get(s.larkAppId) : undefined;
  if (mapped) return mapped;
  if (s.botName && s.botName !== s.larkAppId) return String(s.botName);
  return String(s.botName ?? s.larkAppId ?? '-');
}

/** 会话所在聊天的标题；p2p 优先使用后端行上的直聊显示名，群聊走 /api/groups 名字表。 */
export function chatDisplayTitle(s: Record<string, any>): string | null {
  const rowName = String(s.chatDisplayName ?? '').trim();
  if (rowName) return rowName;
  return (s.chatId && chatNameById.get(s.chatId)) || null;
}

/** 话题首条消息常以 "@bot " 开头（群里要 @ 才能触发）——展示时剥掉开头的
 *  连续 mention，只留真正的消息内容；剥空了（纯 @ 消息）就保留原文。 */
export function stripMentionPrefix(title: unknown): string {
  const raw = String(title ?? '');
  const out = raw.replace(/^(?:@\S+\s*)+/, '').trim();
  return out || raw;
}

/** 会话当前是否卡在等人，以及等什么（全局 strip 和工作台共用同一判定）。 */
export function attentionReason(s: Record<string, any>): string | null {
  if (s.status === 'closed') return null;
  if (s.agentAttention?.reason) return s.agentAttention.reason;
  if (s.agentAttention) return t('sessions.board.signalAgent');
  if (s.pendingRepo) return t('sessions.board.signalRepo');
  if (s.tuiPromptActive) return t('sessions.board.signalPrompt');
  if (s.status === 'limited') return t('sessions.board.signalLimited');
  return null;
}

export function attentionWaitSince(s: Record<string, any>): number {
  const ms = Number(s.agentAttention?.at ?? s.lastMessageAt ?? 0);
  if (Number.isFinite(ms)) return ms;
  const fallback = Number(s.lastMessageAt ?? 0);
  return Number.isFinite(fallback) ? fallback : 0;
}
