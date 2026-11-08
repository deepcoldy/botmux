// ⌘K 全局搜索的纯逻辑层：匹配打分、高亮区间、分组排序、作用域切换、最近记录、
// 快捷键判定。不碰 DOM / React / store——数据源（command-palette-sources）和
// 组件（command-palette）都从这里取规则，单测直接覆盖。

export type PaletteKind = 'session' | 'skill' | 'agent' | 'setting' | 'bot' | 'page' | 'action';
export type PaletteScope = 'all' | 'session' | 'skill' | 'agent' | 'setting';
export type PaletteTone = 'need' | 'work' | 'idle' | 'closed' | 'current';

/** Tab / Shift+Tab 循环的顺序，也是分类 tab 的渲染顺序。 */
export const PALETTE_SCOPES: readonly PaletteScope[] = ['all', 'session', 'skill', 'agent', 'setting'];

/** 空查询 / 同分时的分组顺序。 */
const KIND_ORDER: readonly PaletteKind[] = ['session', 'action', 'skill', 'agent', 'setting', 'bot', 'page'];

/**
 * 「全部」作用域下每组最多展示几条。超出时补一行「查看全部」：有对应分类 tab 的切过去，
 * 没有的（机器人 / 页面 / 快捷操作）原地展开。单一分类同理——超过上限就给一行「再显示」
 * 按 EXPAND_TIERS 分档放开（面板没有虚拟滚动，数千会话不能一次铺满 DOM），保证每个命中都够得着。
 */
const ALL_SCOPE_GROUP_LIMIT: Record<PaletteKind, number> = {
  session: 5,
  skill: 4,
  agent: 4,
  // 5：搜「Bot 配置」时它的五个分类能一屏全部露出。
  setting: 5,
  bot: 3,
  page: 4,
  action: 3,
};

/** 单一作用域下先渲染多少条（会话可能上千）；更多的走「再显示」分步展开。 */
export const SCOPE_RESULT_LIMIT = 60;
/** 「再显示」逐档放开到的上限：60 → 180 → 600 → 全部，都从 SCOPE_RESULT_LIMIT 派生；最后一档后不再有「再显示」。 */
export const EXPAND_TIERS: readonly number[] = [SCOPE_RESULT_LIMIT, SCOPE_RESULT_LIMIT * 3, SCOPE_RESULT_LIMIT * 10, Infinity];
/** 「全部」空查询时推荐的会话条数。 */
const EMPTY_SESSION_SUGGESTIONS = 5;

export interface PaletteAction {
  label: string;
  /** hash 路由（`#/...`）或外链；与 run 二选一。 */
  href?: string;
  /** 外链：新标签打开。 */
  external?: boolean;
  /** 就地执行的动作（切主题、打开弹窗）。 */
  run?: () => void;
}

export interface PaletteItem {
  /** 全局唯一：`<kind>:<id>`，也是「最近」记录的键。 */
  key: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  /** 参与匹配但不展示：另一语言的文案、id、路径等。 */
  keywords?: readonly string[];
  /** 行尾弱化信息（相对时间、来源）。 */
  meta?: string;
  badge?: { text: string; tone: PaletteTone };
  /** 会话 / 机器人行用 bot 头像代替类型图标。 */
  avatar?: { name: string; larkAppId?: string };
  /** 页面行沿用侧边栏图标的 id（组件按 id 取图标）。 */
  iconId?: string;
  /** 同分时的排序先验（0..1）：活跃、最近、待处理更高。 */
  boost?: number;
  /**
   * 标题开头从父级继承来的那一段（如「Bot 配置 › 」）的长度。命中只落在这段里时按副标题的分量算，
   * 也不算「整串都在标题里」：搜父级名字时，层级更深的条目不能和父级的直接子项一样强。
   */
  titleContext?: number;
  primary: PaletteAction;
  secondary?: PaletteAction;
}

export interface TextRange { start: number; end: number }

export interface ItemMatch {
  score: number;
  titleRanges: TextRange[];
  subtitleRanges: TextRange[];
}

export type PaletteRow =
  | { type: 'item'; item: PaletteItem; match: ItemMatch | null }
  /**
   * `scope` 非空：「全部」里切到该分类看全。为 null：原地放开到下一档，多露出 `next` 条（没有
   * 分类 tab 的组，或已经在单一分类里）。`count` 是该组命中总数。
   */
  | { type: 'more'; scope: PaletteScope | null; kind: PaletteKind; count: number; next: number };

export interface PaletteGroup {
  /** `recent` 或某个 kind。 */
  id: 'recent' | PaletteKind;
  rows: PaletteRow[];
  /** 该组命中总数（含被截断的部分）。 */
  total: number;
}

export interface PaletteSearchResult {
  groups: PaletteGroup[];
  /** 扁平化后的可选行，键盘上下键就在它上面移动。 */
  rows: PaletteRow[];
  /** 各作用域的命中数；仅在有查询时有意义（tab 上的计数）。 */
  counts: Record<PaletteScope, number>;
}

export function scopeOfKind(kind: PaletteKind): PaletteScope | null {
  switch (kind) {
    case 'session':
    case 'skill':
    case 'agent':
    case 'setting':
      return kind;
    default:
      return null;
  }
}

/** 在可用作用域里循环（未登录时没有 Skill / Agent 分类）；当前值不在列表里就回到第一个。 */
export function nextScope(scope: PaletteScope, delta: 1 | -1, scopes: readonly PaletteScope[] = PALETTE_SCOPES): PaletteScope {
  const index = scopes.indexOf(scope);
  if (index < 0) return scopes[0] ?? 'all';
  return scopes[(index + delta + scopes.length) % scopes.length]!;
}

// ── 匹配 ─────────────────────────────────────────────────────────────────────

const CJK_RE = /[⺀-鿿가-힯豈-﫿]/;
const SEPARATOR_RE = /[\s\-_./\\:·@#()[\]{}|,，。、：（）《》「」【】›>]/;
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/;

export function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 词首：串首、分隔符之后、或 CJK/非 CJK 交界（「飞书bot」里的 b）。 */
function isWordStart(hay: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = hay[index - 1]!;
  if (SEPARATOR_RE.test(prev)) return true;
  return CJK_RE.test(prev) !== CJK_RE.test(hay[index]!);
}

function substringMatch(hay: string, token: string, from = 0): { index: number; wordStart: boolean } | null {
  let index = hay.indexOf(token, from);
  if (index < 0) return null;
  const first = index;
  // 同一 token 可能出现多次：优先取落在词首的那一处，高亮也跟着它。
  while (index >= 0) {
    if (isWordStart(hay, index)) return { index, wordStart: true };
    index = hay.indexOf(token, index + 1);
  }
  return { index: first, wordStart: false };
}

/**
 * 子序列模糊匹配（`sesctl` → 「**ses**sion **c**on**t**ro**l**」）。只对 ≥3 个可打印
 * ASCII 字符的 token 开启：更短的 token 或 CJK 子序列几乎处处命中，只会制造噪音。
 * 跨度过大也拒绝，避免长描述里零散字母拼出伪命中。
 */
function fuzzyMatch(hay: string, token: string): TokenMatch | null {
  if (token.length < 3 || !ASCII_PRINTABLE_RE.test(token)) return null;
  const positions: number[] = [];
  let from = 0;
  for (const ch of token) {
    // 先找词首处的该字符，找不到再退回任意位置——让 `wb` 命中 work**b**ench 之前先试 **w**ork-**b**ench。
    let pos = -1;
    for (let i = hay.indexOf(ch, from); i >= 0; i = hay.indexOf(ch, i + 1)) {
      if (isWordStart(hay, i)) { pos = i; break; }
    }
    if (pos < 0) pos = hay.indexOf(ch, from);
    if (pos < 0) return null;
    positions.push(pos);
    from = pos + 1;
  }
  const span = positions[positions.length - 1]! - positions[0]! + 1;
  if (span > token.length * 4 + 4) return null;
  let contiguous = 0;
  let wordStarts = 0;
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && positions[i] === positions[i - 1]! + 1) contiguous++;
    if (isWordStart(hay, positions[i]!)) wordStarts++;
  }
  const score = 20 + contiguous * 3 + wordStarts * 4 - (span - token.length) * 0.5;
  return {
    score: Math.max(5, Math.min(45, score)),
    ranges: mergeRanges(positions.map(p => ({ start: p, end: p + 1 }))),
    tier: 'fuzzy',
  };
}

export type MatchTier = 'exact' | 'prefix' | 'word' | 'substring' | 'fuzzy';
export interface TokenMatch { score: number; ranges: TextRange[]; tier: MatchTier }

/**
 * 单个 token 在单个（已小写）字段里的匹配。分档：全等 > 前缀 > 词首 > 子串 > 模糊。
 * `from` 只找这个下标之后的出现（分档仍按它在整个字段里的位置算），找不到时不做模糊。
 */
export function matchToken(hay: string, token: string, from = 0): TokenMatch | null {
  if (!token || !hay) return null;
  const hit = substringMatch(hay, token, from);
  if (hit) {
    const coverage = (token.length / hay.length) * 10;
    const tier: MatchTier = hit.index === 0
      ? (token.length === hay.length ? 'exact' : 'prefix')
      : hit.wordStart ? 'word' : 'substring';
    const base = tier === 'exact' ? 100
      : tier === 'prefix' ? 90
        : tier === 'word' ? 75
          : 60 - Math.min(15, hit.index / 4);
    return { score: base + coverage, ranges: [{ start: hit.index, end: hit.index + token.length }], tier };
  }
  return from > 0 ? null : fuzzyMatch(hay, token);
}

/**
 * 看不见的字段（关键词、副标题）只认「像样」的命中：不做模糊；1~2 个拉丁字母的短 token
 * 还必须落在词首——否则 `ag` 会经由 mess**ag**e / Man**ag**ement 把一堆无关条目拖进来，
 * 用户在标题上又看不到命中点。CJK 没有词边界，子串照常算。
 */
function hiddenFieldMatch(hay: string, token: string): TokenMatch | null {
  const hit = matchToken(hay, token);
  if (!hit || hit.tier === 'fuzzy') return null;
  if (hit.tier === 'substring' && token.length < 3 && ASCII_PRINTABLE_RE.test(token)) return null;
  return hit;
}

export function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TextRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

interface PreparedFields {
  title: string;
  subtitle: string;
  keywords: string[];
  /** 全部字段拼成的一串：token 不在其中、又不够格做标题模糊匹配的条目直接跳过。 */
  haystack: string;
  /** toLowerCase 改变了长度（极少数 Unicode）时下标对不上，放弃该字段高亮。 */
  titleAligned: boolean;
  subtitleAligned: boolean;
}

const prepared = new WeakMap<PaletteItem, PreparedFields>();

function prepare(item: PaletteItem): PreparedFields {
  let fields = prepared.get(item);
  if (!fields) {
    const title = item.title.toLowerCase();
    const subtitle = (item.subtitle ?? '').toLowerCase();
    const keywords = (item.keywords ?? []).filter(Boolean).map(k => String(k).toLowerCase());
    fields = {
      title,
      subtitle,
      keywords,
      haystack: [title, subtitle, ...keywords].join('\n'),
      titleAligned: title.length === item.title.length,
      subtitleAligned: subtitle.length === (item.subtitle ?? '').length,
    };
    prepared.set(item, fields);
  }
  return fields;
}

const TITLE_WEIGHT = 1;
const KEYWORD_WEIGHT = 0.85;
const SUBTITLE_WEIGHT = 0.7;

/**
 * 多 token 是 AND：每个 token 都要在标题 / 关键词 / 副标题之一命中，取各自最优字段的
 * 加权分再求平均（不让 token 多的查询天然高分）。整串查询连续出现在标题里额外加分。
 */
export function matchItem(item: PaletteItem, tokens: readonly string[]): ItemMatch | null {
  if (tokens.length === 0) return { score: 0, titleRanges: [], subtitleRanges: [] };
  const fields = prepare(item);
  const titleRanges: TextRange[] = [];
  const subtitleRanges: TextRange[] = [];
  let total = 0;
  let allInTitle = true;
  const context = item.titleContext ?? 0;
  for (const token of tokens) {
    // 粗筛：任何字段都不含这个 token 时，只剩标题模糊匹配一条路（短 token / CJK 连它也没有）。
    if (!fields.haystack.includes(token) && (token.length < 3 || !ASCII_PRINTABLE_RE.test(token))) return null;
    let inTitle = matchToken(fields.title, token);
    // 命中落在继承来的前缀里：条目自己的名字里也有就用那一处，否则只算上下文。
    let inContext = !!inTitle && inTitle.ranges.every(range => range.end <= context);
    if (inContext) {
      const own = matchToken(fields.title, token, context);
      if (own) { inTitle = own; inContext = false; }
    }
    const inSubtitle = hiddenFieldMatch(fields.subtitle, token);
    let best = inTitle ? inTitle.score * (inContext ? SUBTITLE_WEIGHT : TITLE_WEIGHT) : 0;
    for (const keyword of fields.keywords) {
      const hit = hiddenFieldMatch(keyword, token);
      if (hit) best = Math.max(best, hit.score * KEYWORD_WEIGHT);
    }
    if (inSubtitle) best = Math.max(best, inSubtitle.score * SUBTITLE_WEIGHT);
    if (best <= 0) return null;
    total += best;
    if (inTitle) titleRanges.push(...inTitle.ranges);
    if (!inTitle || inContext) allInTitle = false;
    if (inSubtitle && !inTitle) subtitleRanges.push(...inSubtitle.ranges);
  }
  let score = total / tokens.length;
  const phrase = tokens.join(' ');
  if (tokens.length > 1 && allInTitle) {
    score += fields.title.includes(phrase) ? 10 : 4;
  }
  // 快捷操作的多词别名整句打全（「new session」之于「创建会话」）：和单词别名打全一样算全等。
  // 只对快捷操作：别的条目的多词关键词多是父级名字（「Global Settings」挂在十几个设置区块上），
  // 抬成全等会和只靠关键词命中的页面打平，把页面本身挤下去。
  if (tokens.length > 1 && item.kind === 'action' && fields.keywords.includes(phrase)) {
    score = Math.max(score, matchToken(phrase, phrase)!.score * KEYWORD_WEIGHT);
  }
  return {
    score,
    titleRanges: fields.titleAligned ? mergeRanges(titleRanges) : [],
    subtitleRanges: fields.subtitleAligned ? mergeRanges(subtitleRanges) : [],
  };
}

/** 把文本按高亮区间切成片段，组件逐段渲染 `<mark>`。 */
export function splitHighlights(text: string, ranges: readonly TextRange[]): Array<{ text: string; hit: boolean }> {
  if (ranges.length === 0) return text ? [{ text, hit: false }] : [];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

// ── 搜索与分组 ───────────────────────────────────────────────────────────────

function emptyCounts(): Record<PaletteScope, number> {
  return { all: 0, session: 0, skill: 0, agent: 0, setting: 0 };
}

function kindRank(kind: PaletteKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
}

function inScope(kind: PaletteKind, scope: PaletteScope): boolean {
  return scope === 'all' || scopeOfKind(kind) === scope;
}

/** 「再显示」：某组再放开一档（组件持有这张表，换查询 / 分类时清空）。 */
export function expandGroup(expanded: ReadonlyMap<PaletteKind, number>, kind: PaletteKind): Map<PaletteKind, number> {
  const next = new Map(expanded);
  next.set(kind, (next.get(kind) ?? 0) + 1);
  return next;
}

/** 某组放开 `level` 档后的上限：0 档是作用域的首屏上限，之后依次取 EXPAND_TIERS 里比它大的档。 */
function groupLimit(scope: PaletteScope, kind: PaletteKind, level: number): number {
  const base = scope === 'all' ? ALL_SCOPE_GROUP_LIMIT[kind] : SCOPE_RESULT_LIMIT;
  if (level <= 0) return base;
  const tiers = EXPAND_TIERS.filter(tier => tier > base);
  return tiers[Math.min(level, tiers.length) - 1]!;
}

/** 按作用域上限 + 已放开的档位截断一组；还有剩余时补一行「查看全部 / 再显示」。 */
function groupRows(
  kind: PaletteKind,
  entries: ReadonlyArray<{ item: PaletteItem; match: ItemMatch | null }>,
  scope: PaletteScope,
  expanded: ReadonlyMap<PaletteKind, number> | undefined,
): PaletteGroup {
  const level = expanded?.get(kind) ?? 0;
  const limit = groupLimit(scope, kind, level);
  const rows: PaletteRow[] = entries.slice(0, limit).map(({ item, match }) => ({ type: 'item', item, match }));
  if (entries.length > limit) {
    const nextLimit = groupLimit(scope, kind, level + 1);
    rows.push({
      type: 'more',
      scope: scope === 'all' ? scopeOfKind(kind) : null,
      kind,
      count: entries.length,
      next: Math.min(nextLimit, entries.length) - limit,
    });
  }
  return { id: kind, total: entries.length, rows };
}

function flatten(groups: PaletteGroup[]): PaletteRow[] {
  return groups.flatMap(group => group.rows);
}

/**
 * 空查询：「全部」给「最近 → 推荐会话 → 快捷操作 → 页面」的起始面板（技能 / Agent /
 * 设置条目太多，等用户开始输入或切分类再出）；单一分类则按数据源给定的顺序列出。
 * 有查询：按分数排序，组与组之间按各组最高分排（打「设置」时设置组浮到最前），
 * 「全部」下每组截断并补一行「查看全部」。
 */
export function searchPalette(input: {
  items: readonly PaletteItem[];
  query: string;
  scope: PaletteScope;
  recentKeys?: readonly string[];
  /** 各组被「再显示」放开了几档（见 expandGroup）。 */
  expanded?: ReadonlyMap<PaletteKind, number>;
}): PaletteSearchResult {
  const { items, scope } = input;
  const tokens = tokenizeQuery(input.query);
  const counts = emptyCounts();

  if (tokens.length === 0) {
    const groups: PaletteGroup[] = [];
    if (scope === 'all') {
      const byKey = new Map(items.map(item => [item.key, item]));
      const recent = (input.recentKeys ?? [])
        .map(key => byKey.get(key))
        .filter((item): item is PaletteItem => !!item);
      const recentKeys = new Set(recent.map(item => item.key));
      if (recent.length) {
        groups.push({ id: 'recent', total: recent.length, rows: recent.map(item => ({ type: 'item', item, match: null })) });
      }
      for (const kind of ['session', 'action', 'page'] as const) {
        const ofKind = items.filter(item => item.kind === kind && !recentKeys.has(item.key));
        const shown = kind === 'session' ? ofKind.slice(0, EMPTY_SESSION_SUGGESTIONS) : ofKind;
        if (!shown.length) continue;
        const rows: PaletteRow[] = shown.map(item => ({ type: 'item', item, match: null }));
        if (kind === 'session' && ofKind.length > shown.length) {
          rows.push({ type: 'more', scope: 'session', kind, count: ofKind.length, next: ofKind.length - shown.length });
        }
        groups.push({ id: kind, total: ofKind.length, rows });
      }
    } else {
      const ofScope = items.filter(item => inScope(item.kind, scope));
      for (const kind of KIND_ORDER) {
        const ofKind = ofScope.filter(item => item.kind === kind);
        if (!ofKind.length) continue;
        groups.push(groupRows(kind, ofKind.map(item => ({ item, match: null })), scope, input.expanded));
      }
    }
    return { groups, rows: flatten(groups), counts };
  }

  const matchedByKind = new Map<PaletteKind, Array<{ item: PaletteItem; match: ItemMatch; order: number }>>();
  items.forEach((item, order) => {
    const match = matchItem(item, tokens);
    if (!match) return;
    counts.all++;
    const itemScope = scopeOfKind(item.kind);
    if (itemScope) counts[itemScope]++;
    if (!inScope(item.kind, scope)) return;
    const list = matchedByKind.get(item.kind) ?? [];
    list.push({ item, match, order });
    matchedByKind.set(item.kind, list);
  });

  const ranked = [...matchedByKind.entries()].map(([kind, list]) => {
    list.sort((a, b) =>
      b.match.score - a.match.score
      || (b.item.boost ?? 0) - (a.item.boost ?? 0)
      || a.order - b.order);
    return { kind, list, best: list[0]!.match.score + (list[0]!.item.boost ?? 0) };
  });
  ranked.sort((a, b) => b.best - a.best || kindRank(a.kind) - kindRank(b.kind));

  const groups: PaletteGroup[] = ranked.map(({ kind, list }) => groupRows(kind, list, scope, input.expanded));
  return { groups, rows: flatten(groups), counts };
}

/**
 * 读屏播报用：可见 = 实际渲染出来的条目行数，另有 = 各组命中（或候选）总数里没渲染的部分。
 * 有查询 / 空查询、全部 / 单一分类都按同一口径算，和界面上能看到的行一一对应。
 */
export function paletteVisibility(result: Pick<PaletteSearchResult, 'groups' | 'rows'>): { visible: number; hidden: number } {
  const visible = result.rows.filter(row => row.type === 'item').length;
  const total = result.groups.reduce((sum, group) => sum + group.total, 0);
  return { visible, hidden: Math.max(0, total - visible) };
}

// ── 最近使用 ─────────────────────────────────────────────────────────────────

export const PALETTE_RECENT_STORAGE_KEY = 'botmux.commandPalette.recent.v1';
export const PALETTE_RECENT_LIMIT = 6;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readRecentKeys(storage: StorageLike | null | undefined): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(PALETTE_RECENT_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string' && key.length > 0).slice(0, PALETTE_RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function pushRecentKey(storage: StorageLike | null | undefined, key: string): string[] {
  const next = [key, ...readRecentKeys(storage).filter(existing => existing !== key)].slice(0, PALETTE_RECENT_LIMIT);
  try { storage?.setItem(PALETTE_RECENT_STORAGE_KEY, JSON.stringify(next)); } catch { /* 配额 / 隐私模式 */ }
  return next;
}

// ── 快捷键 ───────────────────────────────────────────────────────────────────

export function isMacLike(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** 唤起键：macOS 是 ⌘K，其余平台 Ctrl+K；带 Shift / Alt 的组合留给浏览器与页面。 */
export function isPaletteHotkey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (event.key !== 'k' && event.key !== 'K') return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function paletteShortcutLabel(mac: boolean): string {
  return mac ? '⌘K' : 'Ctrl K';
}

export function modifierKeyLabel(mac: boolean): string {
  return mac ? '⌘' : 'Ctrl';
}
