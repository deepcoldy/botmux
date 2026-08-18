/**
 * 工作台外观：4 套配色（skin）× 明暗模式（mode）× 终端渲染风格（termStyle）。
 *
 * 三件事永远一起读、一起写，所以共用一条 localStorage 记录
 * （`botmux.agent-workbench.appearance.v1`），命名沿用工作台既有的
 * `botmux.agent-workbench.<域>.v<n>` 家族（见 agent-workbench-storage.ts）。
 *
 * 与全站明暗机制的关系（preferences.ts / ui.ts）：
 * - `mode` 与全站 `ThemeMode` 同形（system / light / dark），决定**明暗族**；
 * - `skin` 决定**深色族里的哪一套**——浅色族只有 `light-frost` 一个候选，
 *   所以色板上选的那一枚只是「夜里用哪套」，跟随系统时在它与 light-frost 之间切；
 * - 首次进工作台没有本地记录时，`mode` 继承全站 `readStoredThemeMode()` 的值，
 *   之后工作台存自己的一份，全站再改浅色/深色不覆盖工作台的显式选择。
 */
import {
  normalizeThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from './preferences.js';
import type { WorkbenchStorage } from './agent-workbench-storage.js';

export type WorkbenchSkinId = 'ink' | 'slate-blue' | 'warm-graphite' | 'light-frost';
/** 终端画布的渲染取向：`reader` 低饱和大行距、跟随工作台配色，`classic` 保持终端本色
 *  （现状渲染）。首版这两个值叫 `orca` / `orca-ink`，见下面的 LEGACY_* 迁移表。 */
export type WorkbenchTermStyle = 'reader' | 'classic';

export interface WorkbenchAppearance {
  skin: WorkbenchSkinId;
  mode: ThemeMode;
  termStyle: WorkbenchTermStyle;
}

export const WORKBENCH_APPEARANCE_STORAGE_KEY = 'botmux.agent-workbench.appearance.v1';

export const WORKBENCH_SKIN_IDS: readonly WorkbenchSkinId[] = [
  'ink',
  'slate-blue',
  'warm-graphite',
  'light-frost',
];

export const WORKBENCH_TERM_STYLES: readonly WorkbenchTermStyle[] = ['reader', 'classic'];

/**
 * 首版命名 → 现命名。存量浏览器的 localStorage 里还写着 `termStyle: 'orca'` /
 * `skin: 'orca-ink'`，读到时静默换成新值即可 —— 用户选的是「那一套外观」，不是那个
 * 名字，弹提示或回落默认都等于无故把人家的选择清掉。写回去的是新值（save 前必过
 * normalize），所以每台机器只迁一次。
 */
const LEGACY_SKIN_IDS: Readonly<Record<string, WorkbenchSkinId>> = { 'orca-ink': 'ink' };
const LEGACY_TERM_STYLES: Readonly<Record<string, WorkbenchTermStyle>> = { orca: 'reader' };

/** 认新值，也认旧值；都不认返回 null。类型守卫本身保持严格，只认新值。 */
export function migrateWorkbenchSkin(value: unknown): WorkbenchSkinId | null {
  if (isWorkbenchSkin(value)) return value;
  return typeof value === 'string' ? LEGACY_SKIN_IDS[value] ?? null : null;
}

export function migrateWorkbenchTermStyle(value: unknown): WorkbenchTermStyle | null {
  if (isWorkbenchTermStyle(value)) return value;
  return typeof value === 'string' ? LEGACY_TERM_STYLES[value] ?? null : null;
}

/** 浅色族唯一的一套：`mode` 落到 light 时恒用它，不占色板的「深色代表」名额。 */
export const WORKBENCH_LIGHT_SKIN: WorkbenchSkinId = 'light-frost';
/** 默认深色代表：与现有品牌观感最接近的一套，迁移成本最低。 */
export const DEFAULT_WORKBENCH_SKIN: WorkbenchSkinId = 'slate-blue';
/** 默认终端渲染：`classic` 即现状渲染，存量用户零变化。 */
export const DEFAULT_WORKBENCH_TERM_STYLE: WorkbenchTermStyle = 'classic';

export function isWorkbenchSkin(value: unknown): value is WorkbenchSkinId {
  return typeof value === 'string' && (WORKBENCH_SKIN_IDS as readonly string[]).includes(value);
}

export function isWorkbenchTermStyle(value: unknown): value is WorkbenchTermStyle {
  return value === 'reader' || value === 'classic';
}

/** 皮肤所属明暗族。`light-frost` 是浅色，其余三套都是深色。 */
export function workbenchSkinFamily(skin: WorkbenchSkinId): ResolvedTheme {
  return skin === WORKBENCH_LIGHT_SKIN ? 'light' : 'dark';
}

export function defaultWorkbenchAppearance(inheritedMode: ThemeMode = 'dark'): WorkbenchAppearance {
  return {
    skin: DEFAULT_WORKBENCH_SKIN,
    mode: normalizeThemeMode(inheritedMode) ?? 'dark',
    termStyle: DEFAULT_WORKBENCH_TERM_STYLE,
  };
}

/** 未知 skin / mode / termStyle 一律逐字段回落默认，绝不整份丢弃、更不抛错——
 *  手改过 localStorage 或旧版本残留只该丢掉那一个字段，不该让工作台白屏。
 *  首版命名（`orca` / `orca-ink`）在这里被认成新值，不算「未知」。
 *  这是**唯一**的入口：loadWorkbenchAppearance、saveWorkbenchAppearance 与跨 tab 的
 *  storage 事件全部经过它，所以三条路径的迁移行为天然一致。 */
export function normalizeWorkbenchAppearance(
  value: unknown,
  inheritedMode: ThemeMode = 'dark',
): WorkbenchAppearance {
  const fallback = defaultWorkbenchAppearance(inheritedMode);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const input = value as Partial<Record<keyof WorkbenchAppearance, unknown>>;
  return {
    skin: migrateWorkbenchSkin(input.skin) ?? fallback.skin,
    mode: normalizeThemeMode(input.mode) ?? fallback.mode,
    termStyle: migrateWorkbenchTermStyle(input.termStyle) ?? fallback.termStyle,
  };
}

export function loadWorkbenchAppearance(
  storage: WorkbenchStorage | null | undefined,
  inheritedMode: ThemeMode = 'dark',
): WorkbenchAppearance {
  if (!storage) return defaultWorkbenchAppearance(inheritedMode);
  try {
    const raw = storage.getItem(WORKBENCH_APPEARANCE_STORAGE_KEY);
    return raw
      ? normalizeWorkbenchAppearance(JSON.parse(raw), inheritedMode)
      : defaultWorkbenchAppearance(inheritedMode);
  } catch {
    return defaultWorkbenchAppearance(inheritedMode);
  }
}

export function saveWorkbenchAppearance(
  storage: WorkbenchStorage | null | undefined,
  appearance: WorkbenchAppearance,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WORKBENCH_APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeWorkbenchAppearance(appearance)));
    return true;
  } catch {
    // localStorage 不可用时只在当前页生效
    return false;
  }
}

/** 实际生效的那一套配色：先由 mode（+ 系统偏好）定明暗族，再在族内取色。 */
export function resolveWorkbenchSkin(
  appearance: WorkbenchAppearance,
  systemPrefersDark: boolean,
): WorkbenchSkinId {
  if (resolveThemeMode(appearance.mode, systemPrefersDark) === 'light') return WORKBENCH_LIGHT_SKIN;
  // 存量脏值/跨 tab 写入可能把浅色那套留在 skin 上，深色族里它不是候选。
  return appearance.skin === WORKBENCH_LIGHT_SKIN ? DEFAULT_WORKBENCH_SKIN : appearance.skin;
}

/**
 * 点色板。三条规则来自设计规范「五 5.2」，不写会出「点了没反应」的投诉：
 * 1. 跟随系统 / 深色下点浅色那套 → 视为「我要一直浅色」，mode 切到 light；
 * 2. 跟随系统下点任一深色 → 只换深色代表，mode 保持 system（说的是「夜里用这套」）；
 * 3. 浅色下点任一深色 → mode 切到 dark（规则 1 的镜像）。
 * 选浅色时 `skin` 保持原来的深色代表不动 —— 再切回深色/跟随系统时还是用户上次选的那套。
 */
export function selectWorkbenchSkin(
  current: WorkbenchAppearance,
  skin: WorkbenchSkinId,
): WorkbenchAppearance {
  if (skin === WORKBENCH_LIGHT_SKIN) {
    return current.mode === 'light' ? current : { ...current, mode: 'light' };
  }
  const mode = current.mode === 'light' ? 'dark' : current.mode;
  return { ...current, skin, mode };
}

export function selectWorkbenchMode(current: WorkbenchAppearance, mode: ThemeMode): WorkbenchAppearance {
  return current.mode === mode ? current : { ...current, mode };
}

export function selectWorkbenchTermStyle(
  current: WorkbenchAppearance,
  termStyle: WorkbenchTermStyle,
): WorkbenchAppearance {
  return current.termStyle === termStyle ? current : { ...current, termStyle };
}

/** 终端容器 class：几何（行距 / 内边距）差异全部由样式侧的这两个类承担。 */
export function workbenchTermContainerClass(termStyle: WorkbenchTermStyle): string {
  return termStyle === 'reader' ? 'wb-term-reader' : 'wb-term-classic';
}

// ── 色板缩影 ────────────────────────────────────────────────────────────────
// 未选中的那几套配色在页面上并不生效，swatch 只能拿字面量画：左 2/3 = --bg-l1、
// 右上 1/3 = --bg-l3、右下 1/3 = --accent，一眼看出色相和 accent。
export interface WorkbenchSkinPreview {
  bg: string;
  raise: string;
  accent: string;
}

export const WORKBENCH_SKIN_PREVIEWS: Record<WorkbenchSkinId, WorkbenchSkinPreview> = {
  ink: { bg: '#212121', raise: '#3C3C3C', accent: '#FF8B63' },
  'slate-blue': { bg: '#19212C', raise: '#333F4E', accent: '#6FCBF7' },
  'warm-graphite': { bg: '#24211A', raise: '#443E34', accent: '#F2A33C' },
  'light-frost': { bg: '#F3F6F9', raise: '#C9D7E8', accent: '#0B5F8F' },
};

// ── 终端 xterm theme 预设 ───────────────────────────────────────────────────
/** xterm.js `ITheme` 的子集：只给两套预设真正用到的键，避免把 xterm 类型拖进来。 */
export interface WorkbenchTermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}

/**
 * `classic` = 终端页现有配色**原样**（Tokyo Night，src/worker.ts 里那份字面量）。
 * 存量用户切不切主题都看不出变化，这也是默认风格。
 */
export const WORKBENCH_CLASSIC_TERM_THEME: WorkbenchTermTheme = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
};

/**
 * `reader`（「阅读」）= 低饱和 muted 版：直接映射该套配色的 token（--term-bg /
 * --text-1 / --text-3 / --accent / --ok / --warn / --err），所以终端和工作台是同一套色。
 * `light-frost` 的终端画布仍是深色（彩色 ANSI 放浅底上不可读，业界通行做法），
 * 所以它这一行用的是规范里为它单列的那组亮色终端令牌。
 */
export const WORKBENCH_READER_TERM_THEMES: Record<WorkbenchSkinId, WorkbenchTermTheme> = {
  ink: {
    background: '#030303',
    foreground: '#EDEDED',
    cursor: '#FF8B63',
    selectionBackground: '#3C3C3C',
    black: '#181818',
    red: '#FF8C8F',
    green: '#3ED598',
    yellow: '#EFC260',
    blue: '#FF8B63',
    magenta: '#D8A0FF',
    cyan: '#7FD8D0',
    white: '#A6A6A6',
  },
  'slate-blue': {
    background: '#030407',
    foreground: '#E4EBF2',
    cursor: '#6FCBF7',
    selectionBackground: '#333F4E',
    black: '#141922',
    red: '#F58A94',
    green: '#63D6A0',
    yellow: '#EDB95C',
    blue: '#6FCBF7',
    magenta: '#C0A6F5',
    cyan: '#7FD8D0',
    white: '#A2B2C3',
  },
  'warm-graphite': {
    background: '#040402',
    foreground: '#F0EBE1',
    cursor: '#F2A33C',
    selectionBackground: '#443E34',
    black: '#1B1912',
    red: '#FF9186',
    green: '#5FCE9B',
    yellow: '#EAC14F',
    blue: '#F2A33C',
    magenta: '#D9A7DA',
    cyan: '#7FD8D0',
    white: '#B3AA9C',
  },
  'light-frost': {
    background: '#16202B',
    foreground: '#E8EEF5',
    cursor: '#6FCBF7',
    selectionBackground: '#33465C',
    black: '#16202B',
    red: '#F58A94',
    green: '#63D6A0',
    yellow: '#EDB95C',
    blue: '#6FCBF7',
    magenta: '#C0A6F5',
    cyan: '#7FD8D0',
    white: '#A7B6C6',
  },
};

export function workbenchTermTheme(
  termStyle: WorkbenchTermStyle,
  skin: WorkbenchSkinId,
): WorkbenchTermTheme {
  return termStyle === 'reader' ? WORKBENCH_READER_TERM_THEMES[skin] : WORKBENCH_CLASSIC_TERM_THEME;
}

/**
 * xterm 的 `lineHeight`。这是**唯一**的出处：终端页那段监听器（src/worker.ts 的模板
 * 字符串，没法 import）必须照抄同样的数字，接缝测试按这张表比对它的字面量；
 * `.wb-term-classic / .wb-term-reader` 的 `--term-line-height` 同样按这张表对齐。
 *
 * 阅读风从 1.55 降到 1.3：1.55 下单元格高 ≈24.5px，CLI 的底部 chrome（提示 + 输入框 +
 * 状态条，固定占 8 个终端行）就要吃掉约 196px —— 900 高的窗口里四分之一屏全是 chrome。
 * 1.3 仍比经典的 1.0 松三成，正文呼吸感在，chrome 收回约 16%、可视行数多出两成。
 * `classic` 恒为 1 = xterm 默认，「经典 = 原样」的一部分。
 */
export const WORKBENCH_TERM_LINE_HEIGHTS: Record<WorkbenchTermStyle, number> = {
  reader: 1.3,
  classic: 1,
};

export function workbenchTermLineHeight(termStyle: WorkbenchTermStyle): number {
  return WORKBENCH_TERM_LINE_HEIGHTS[termStyle] ?? WORKBENCH_TERM_LINE_HEIGHTS.classic;
}

/** 终端外壳（安全边距那圈）要刷的底色变量名。见 `workbenchTermCanvasStyle`。 */
export const WORKBENCH_TERM_CANVAS_BG_VAR = '--term-canvas-bg';

/**
 * 终端面板外壳的底色 —— 跟着**实际生效的终端渲染风格**走，而不是跟着皮肤令牌走。
 *
 * 外壳（`.wb-pane-frame-shell`）给字形留了 8px 安全边距，这圈底色原本刷的是皮肤的
 * `--term-bg`。阅读风时两者本来就同色（`WORKBENCH_READER_TERM_THEMES[skin].background`
 * 逐套等于该皮肤的 `--term-bg`），可经典渲染的 xterm 底色是它自己的 Tokyo Night
 * `#1a1b26`，和 `--term-bg`（如 slate-blue 的 `#030407`）差一大截，画布外就露出一圈
 * 更黑的边框 —— 用户看到的「经典终端黑色边框」就是它。
 *
 * 取值直接来自 `workbenchTermTheme()`，也就是同一次下发给终端 iframe 的那份 theme：
 * 外壳和画布永远同源同色，不存在第二份字面量。
 */
export function workbenchTermCanvasStyle(
  termStyle: WorkbenchTermStyle,
  skin: WorkbenchSkinId,
): Record<string, string> {
  return { [WORKBENCH_TERM_CANVAS_BG_VAR]: workbenchTermTheme(termStyle, skin).background };
}

/** 父页 → 终端 iframe 的一次外观下发。终端页只认这一个消息类型。 */
export const WORKBENCH_TERM_APPEARANCE_MESSAGE = 'botmux:wb-appearance';

export interface WorkbenchTermAppearanceMessage {
  type: typeof WORKBENCH_TERM_APPEARANCE_MESSAGE;
  termStyle: WorkbenchTermStyle;
  skin: WorkbenchSkinId;
  theme: WorkbenchTermTheme;
}

export function workbenchTermAppearanceMessage(
  termStyle: WorkbenchTermStyle,
  skin: WorkbenchSkinId,
): WorkbenchTermAppearanceMessage {
  return {
    type: WORKBENCH_TERM_APPEARANCE_MESSAGE,
    termStyle,
    skin,
    theme: workbenchTermTheme(termStyle, skin),
  };
}

/**
 * 把外观推给终端 iframe。终端画布住在跨文档的 `/s/<sessionId>` 里，父页换 class
 * 它收不到，不推过去就会出现「工作台换了配色、终端还是旧色」的半截状态。
 * 目标 origin 从 iframe 自己的 URL 推导（触屏走的 viewToken 链接可能是别的
 * host/port），推导不出来就放弃这次下发——绝不用 `*` 广播。
 */
export function postWorkbenchTermAppearance(
  frame: { contentWindow?: { postMessage(data: unknown, targetOrigin: string): void } | null } | null | undefined,
  frameUrl: string | null | undefined,
  termStyle: WorkbenchTermStyle,
  skin: WorkbenchSkinId,
  baseUrl?: string,
): boolean {
  const target = frame?.contentWindow;
  if (!target || !frameUrl) return false;
  let origin: string;
  try {
    origin = new URL(frameUrl, baseUrl).origin;
  } catch {
    return false;
  }
  if (!origin || origin === 'null') return false;
  try {
    target.postMessage(workbenchTermAppearanceMessage(termStyle, skin), origin);
    return true;
  } catch {
    return false;
  }
}

// ── 落到文档根 ──────────────────────────────────────────────────────────────
/** 只用到 dataset 的最小结构，方便单测注入一个假根节点。 */
export interface WorkbenchAppearanceRoot {
  readonly dataset: Record<string, string | undefined>;
}

export interface WorkbenchRootAttributes {
  /** 生效的配色，写进 `data-skin`。 */
  skin: WorkbenchSkinId;
  /** 生效的明暗族，写进 `data-theme`，让既有的明暗组件规则跟着走。 */
  theme: ResolvedTheme;
}

/** 进工作台前文档根上原本挂着什么（全站 skin / 明暗），离开时原样放回去。 */
export interface WorkbenchRootSnapshot {
  skin?: string;
  theme?: string;
}

export function applyWorkbenchRootAttributes(
  root: WorkbenchAppearanceRoot | null | undefined,
  attributes: WorkbenchRootAttributes,
): WorkbenchRootSnapshot {
  if (!root) return {};
  const snapshot: WorkbenchRootSnapshot = { skin: root.dataset.skin, theme: root.dataset.theme };
  root.dataset.skin = attributes.skin;
  root.dataset.theme = attributes.theme;
  return snapshot;
}

export function restoreWorkbenchRootAttributes(
  root: WorkbenchAppearanceRoot | null | undefined,
  snapshot: WorkbenchRootSnapshot,
): void {
  if (!root) return;
  if (snapshot.skin === undefined) delete root.dataset.skin;
  else root.dataset.skin = snapshot.skin;
  if (snapshot.theme === undefined) delete root.dataset.theme;
  else root.dataset.theme = snapshot.theme;
}

// ── 单一状态源 ──────────────────────────────────────────────────────────────
/**
 * 外观只有一个状态源：桌面 `⋯ → 外观`、移动列表页 `◐`、终端标题栏的
 * 「阅读｜经典」分段控件全部读写这一个 store，任一处改动另外两处立刻跟着变。
 * 跨 tab 同步靠 `storage` 事件；跟随系统靠 `matchMedia` 的 change。
 */
export interface WorkbenchAppearanceSnapshot {
  appearance: WorkbenchAppearance;
  /** 实际生效的配色（已解析 mode + 系统偏好）。 */
  skin: WorkbenchSkinId;
  theme: ResolvedTheme;
}

export interface WorkbenchAppearanceEnvironment {
  storage: WorkbenchStorage | null;
  root: WorkbenchAppearanceRoot | null;
  /** 首次进工作台、本地还没有记录时 mode 的初值（全站 ThemeMode）。 */
  inheritedMode: ThemeMode;
  prefersDark(): boolean;
  /** 订阅系统明暗变化；返回退订函数。 */
  onSystemThemeChange?(listener: () => void): () => void;
  /** 订阅跨 tab 的 localStorage 变化；返回退订函数。 */
  onStorageChange?(listener: (key: string | null, value: string | null) => void): () => void;
}

/** 浏览器环境。没有 window（组件测试跑在 node 上）时返回 null，一切走默认值。 */
export function browserAppearanceEnvironment(): WorkbenchAppearanceEnvironment | null {
  if (typeof window === 'undefined') return null;
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  return {
    storage,
    root: typeof document === 'undefined' ? null : document.documentElement,
    // 本地还没有工作台自己的记录时，mode 的初值继承全站选择（之后各存各的）。
    inheritedMode: readStoredThemeMode(storage ?? undefined),
    prefersDark: () => !!media?.matches,
    onSystemThemeChange: listener => {
      media?.addEventListener('change', listener);
      return () => media?.removeEventListener('change', listener);
    },
    onStorageChange: listener => {
      const handler = (event: StorageEvent) => listener(event.key, event.newValue);
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
  };
}

export class WorkbenchAppearanceStore {
  private env: WorkbenchAppearanceEnvironment | null = null;
  private envResolved = false;
  private value: WorkbenchAppearance = defaultWorkbenchAppearance();
  private snapshot: WorkbenchAppearanceSnapshot = this.buildSnapshot(false);
  private readonly listeners = new Set<() => void>();
  private mounted = 0;
  private disposers: Array<() => void> = [];
  private rootSnapshot: WorkbenchRootSnapshot | null = null;

  /** 环境只认一次：测试注入假实现，浏览器里第一次取值时自己接上真的。 */
  configure(env: WorkbenchAppearanceEnvironment | null): void {
    if (this.envResolved) return;
    this.envResolved = true;
    this.env = env;
    if (!env) return;
    this.value = loadWorkbenchAppearance(env.storage, env.inheritedMode);
    this.snapshot = this.buildSnapshot(env.prefersDark());
  }

  getSnapshot(): WorkbenchAppearanceSnapshot {
    this.ensureEnv();
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.ensureEnv();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(next: WorkbenchAppearance): void {
    this.ensureEnv();
    if (next === this.value) return;
    this.value = next;
    saveWorkbenchAppearance(this.env?.storage, next);
    this.refresh();
  }

  /**
   * 把外观挂到文档根上，并接好系统明暗 / 跨 tab 两个监听。返回卸载函数：
   * 离开工作台时把 `data-skin` / `data-theme` 原样还给全站机制（工作台的 4 套
   * 配色是局部调色板，不该在别的页面继续生效）。
   */
  mount(): () => void {
    this.ensureEnv();
    this.mounted += 1;
    if (this.mounted === 1) this.bind();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.mounted -= 1;
      if (this.mounted === 0) this.unbind();
    };
  }

  /** 测试用：把 store 恢复到「还没接过环境」的状态。 */
  reset(): void {
    this.unbind();
    this.mounted = 0;
    this.env = null;
    this.envResolved = false;
    this.value = defaultWorkbenchAppearance();
    this.snapshot = this.buildSnapshot(false);
    this.listeners.clear();
  }

  private ensureEnv(): void {
    if (this.envResolved) return;
    this.configure(browserAppearanceEnvironment());
  }

  private bind(): void {
    const env = this.env;
    if (!env) return;
    this.rootSnapshot = applyWorkbenchRootAttributes(env.root, {
      skin: this.snapshot.skin,
      theme: this.snapshot.theme,
    });
    // 系统监听故意在这里注册：全站那一个（ui.ts）在启动时就挂上了，注册晚的后跑，
    // 工作台自己的解析结果才不会被全站的仲裁盖掉。两个监听各自独立、互不订阅。
    if (env.onSystemThemeChange) this.disposers.push(env.onSystemThemeChange(() => this.refresh()));
    if (env.onStorageChange) {
      this.disposers.push(env.onStorageChange((key, raw) => {
        if (key !== null && key !== WORKBENCH_APPEARANCE_STORAGE_KEY) return;
        // 别的 tab 改了外观（或整份清空）——用同一条 normalize 读回来，脏值不炸页面。
        let parsed: unknown = null;
        if (raw) {
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
        }
        this.value = raw
          ? normalizeWorkbenchAppearance(parsed, env.inheritedMode)
          : loadWorkbenchAppearance(env.storage, env.inheritedMode);
        this.refresh();
      }));
    }
  }

  private unbind(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.rootSnapshot) {
      restoreWorkbenchRootAttributes(this.env?.root, this.rootSnapshot);
      this.rootSnapshot = null;
    }
  }

  /**
   * 重新解析并落地。全站那套明暗仲裁（ui.ts）也在写 `data-theme`，工作台在场时
   * 由这里把自己的解析结果盖回去 —— 所以它必须幂等：没变化就不换快照对象、也不
   * 通知订阅者，免得每来一次全站事件就把工作台整页重绘。
   */
  reapply(): void {
    this.refresh();
  }

  private refresh(): void {
    const next = this.buildSnapshot(this.env?.prefersDark() ?? false);
    const previous = this.snapshot;
    const unchanged = previous.skin === next.skin
      && previous.theme === next.theme
      && previous.appearance.skin === next.appearance.skin
      && previous.appearance.mode === next.appearance.mode
      && previous.appearance.termStyle === next.appearance.termStyle;
    // 内容相同就把旧对象留住：快照身份不变，useSyncExternalStore 才不会白重绘一次。
    if (unchanged) this.value = previous.appearance;
    else this.snapshot = next;
    if (this.rootSnapshot) {
      applyWorkbenchRootAttributes(this.env?.root, {
        skin: this.snapshot.skin,
        theme: this.snapshot.theme,
      });
    }
    if (!unchanged) for (const listener of this.listeners) listener();
  }

  private buildSnapshot(prefersDark: boolean): WorkbenchAppearanceSnapshot {
    const skin = resolveWorkbenchSkin(this.value, prefersDark);
    return { appearance: this.value, skin, theme: workbenchSkinFamily(skin) };
  }
}

export const workbenchAppearance = new WorkbenchAppearanceStore();
