// ⌘K 全局搜索面板。壳层（app.tsx）只挂唤起快捷键与顶栏入口，首次唤起才懒加载本模块；
// 匹配排序规则在 command-palette-model，条目映射在 command-palette-sources。
import type React from 'react';
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ModalDialog } from './modal-dialog.js';
import { navigateToHash } from './leave-guard.js';
import { Html } from './dashboard-components.js';
import { useDashboardLocale, useDashboardStore } from './react-hooks.js';
import { botAvatarHtml, loadNameMaps, nameMapsVersion, t, ui } from './ui.js';
import type { SkillRow } from './skills/types.js';
import {
  PALETTE_SCOPES,
  expandGroup,
  modifierKeyLabel,
  paletteVisibility,
  nextScope,
  pushRecentKey,
  readRecentKeys,
  searchPalette,
  splitHighlights,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
  type PaletteKind,
  type PaletteRow,
  type PaletteScope,
  type TextRange,
} from './command-palette-model.js';
import {
  buildActionItems,
  buildAgentItems,
  buildBotDefaultsSectionItems,
  buildBotDefaultsTabItems,
  buildBotItems,
  buildPageItems,
  buildPreferenceItems,
  buildSessionItems,
  buildSettingItems,
  buildSkillItems,
  type PaletteAgentRow,
  type PaletteShellContext,
} from './command-palette-sources.js';

// ── Skill / Agent 远端数据：面板打开时拉取，模块级缓存 30s（重复唤起不重复请求） ──

interface RemoteSnapshot {
  skills: SkillRow[] | null;
  agents: { agents: PaletteAgentRow[]; links: Record<string, string> } | null;
  /** 在此之前再次唤起直接用缓存：成功 30s；任一路失败只退避 5s（旧 daemon 恒 404 的那一路不会让每次唤起都重拉）。 */
  freshUntil: number;
}

const REMOTE_TTL_MS = 30_000;
const REMOTE_RETRY_MS = 5_000;
/** 接口挂住时按失败处理（沿用上次数据），别让面板一直停在「加载中」。 */
const REMOTE_TIMEOUT_MS = 8_000;
let remoteCache: RemoteSnapshot = { skills: null, agents: null, freshUntil: 0 };
let remoteInFlight: Promise<RemoteSnapshot> | null = null;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REMOTE_TIMEOUT_MS) : undefined;
    const response = await fetch(url, { cache: 'no-store', signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function loadRemote(): Promise<RemoteSnapshot> {
  remoteInFlight ??= (async () => {
    const [skillsBody, agentsBody] = await Promise.all([fetchJson('/api/skills'), fetchJson('/api/agents')]);
    // 某一路失败就沿用上次的数据，搜索照常可用；失败只短暂退避，过后再唤起会重试。
    const ok = Array.isArray(skillsBody?.skills) && Array.isArray(agentsBody?.agents);
    remoteCache = {
      skills: Array.isArray(skillsBody?.skills) ? skillsBody.skills as SkillRow[] : remoteCache.skills,
      agents: Array.isArray(agentsBody?.agents)
        ? {
            agents: agentsBody.agents as PaletteAgentRow[],
            links: agentsBody.links && typeof agentsBody.links === 'object' ? agentsBody.links : {},
          }
        : remoteCache.agents,
      freshUntil: Date.now() + (ok ? REMOTE_TTL_MS : REMOTE_RETRY_MS),
    };
    return remoteCache;
  })().finally(() => { remoteInFlight = null; });
  return remoteInFlight;
}

export function __testOnly_resetPaletteRemoteCache(): void {
  remoteCache = { skills: null, agents: null, freshUntil: 0 };
  remoteInFlight = null;
}

function useRemoteSources(open: boolean, enabled: boolean): { remote: RemoteSnapshot; loading: boolean } {
  const [remote, setRemote] = useState(remoteCache);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !enabled) return undefined;
    if (Date.now() < remoteCache.freshUntil) {
      setRemote(remoteCache);
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    void loadRemote().then(next => {
      if (!alive) return;
      setRemote(next);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [enabled, open]);
  return { remote, loading };
}

// ── 图标 ─────────────────────────────────────────────────────────────────────

function svg(children: ReactNode): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>;
}

const KIND_ICONS: Record<string, React.JSX.Element> = {
  session: svg(<path d="M2 3.5h12v7H6l-3 3v-3H2z" />),
  skill: svg(<><path d="M3 2.5h10v3H3zM3 7h10v6.5H3z" /><path d="M5.4 9.2h5.2M5.4 11.2h3.8" /></>),
  agent: svg(<><rect x="1.8" y="2.6" width="5.2" height="4.4" rx="1.4" /><rect x="9" y="1.8" width="5.2" height="3.6" rx="1.2" /><rect x="9" y="10.6" width="5.2" height="3.6" rx="1.2" /><path d="M7 4.8c1.2 0 1.2-1.2 2-1.2M7 4.8c1.4 0 .6 7.6 2 7.6" /></>),
  setting: svg(<><path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" /><circle cx="11" cy="4.5" r="1.5" /><circle cx="5" cy="11.5" r="1.5" /></>),
  bot: svg(<><rect x="2.5" y="5" width="11" height="8" rx="2" /><circle cx="5.8" cy="9" r="1" /><circle cx="10.2" cy="9" r="1" /><path d="M8 5V2.5" /></>),
  page: svg(<><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" /><path d="M2.2 5.6h11.6" /></>),
  action: svg(<path d="M9 1.8 3.6 9h4l-.8 5.2L12.4 7h-4z" />),
  theme: svg(<><circle cx="8" cy="8" r="5.8" /><path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2z" fill="currentColor" stroke="none" /></>),
  locale: svg(<><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c-2 1.7-2 10.3 0 12 2-1.7 2-10.3 0-12z" /></>),
  'create-session': svg(<><path d="M2 3.5h12v7H6l-3 3v-3H2z" /><path d="M8 4.9v4.2M5.9 7h4.2" /></>),
  'create-bot': svg(<><rect x="2.5" y="6" width="11" height="7.5" rx="2" /><circle cx="5.8" cy="9.75" r="1" /><circle cx="10.2" cy="9.75" r="1" /><path d="M8 6V3.8M6.3 1.9h3.4" /></>),
  docs: svg(<><path d="M3.2 2.2h6.2l3.4 3.4v8.2H3.2z" /><path d="M9.2 2.4v3.4h3.4" /><path d="M5.4 9h4M5.4 11.2h2.6" /></>),
  more: svg(<path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />),
  search: svg(<><circle cx="7" cy="7" r="4.6" /><path d="m10.4 10.4 3.6 3.6" /></>),
};

function itemIcon(item: PaletteItem, pageIcons: ReadonlyMap<string, ReactNode>): ReactNode {
  if (item.avatar) {
    return <Html html={botAvatarHtml({ name: item.avatar.name, larkAppId: item.avatar.larkAppId, size: 'sm' })} />;
  }
  if (item.kind === 'page' && item.iconId && pageIcons.has(item.iconId)) {
    return <svg viewBox="0 0 16 16" aria-hidden="true">{pageIcons.get(item.iconId)}</svg>;
  }
  return (item.iconId && KIND_ICONS[item.iconId]) || KIND_ICONS[item.kind];
}

// ── 渲染辅助 ─────────────────────────────────────────────────────────────────

const GROUP_LABEL_KEYS: Record<PaletteGroup['id'], string> = {
  recent: 'palette.groupRecent',
  session: 'palette.groupSession',
  skill: 'palette.groupSkill',
  agent: 'palette.groupAgent',
  setting: 'palette.groupSetting',
  bot: 'palette.groupBot',
  page: 'palette.groupPage',
  action: 'palette.groupAction',
};

const SCOPE_LABEL_KEYS: Record<PaletteScope, string> = {
  all: 'palette.scopeAll',
  session: 'palette.scopeSession',
  skill: 'palette.scopeSkill',
  agent: 'palette.scopeAgent',
  setting: 'palette.scopeSetting',
};

function Highlighted(props: { text: string; ranges: readonly TextRange[] }): React.JSX.Element {
  return (
    <>
      {splitHighlights(props.text, props.ranges).map((part, index) => (
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
      ))}
    </>
  );
}

function moreRowLabel(row: Extract<PaletteRow, { type: 'more' }>): string {
  return row.scope
    ? t('palette.more', { count: row.count, scope: t(SCOPE_LABEL_KEYS[row.scope]) })
    : t('palette.moreExpand', { count: row.next, total: row.count });
}

function rowKey(row: PaletteRow): string {
  return row.type === 'item' ? row.item.key : `more:${row.kind}`;
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function openInNewTab(action: PaletteAction): void {
  if (!action.href) return;
  const url = action.external ? action.href : new URL(action.href, location.href).href;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── 面板 ─────────────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  context: PaletteShellContext;
  /** macOS 显示 ⌘，其余平台 Ctrl。 */
  mac: boolean;
}

/**
 * 壳层每次唤起都换 key 重新挂载，所以查询 / 分类 / 选中项天然从零开始；关闭只是
 * `open=false` 让原生 `<dialog>` close()，浏览器把焦点还给唤起前的元素。
 */
export function CommandPalette(props: CommandPaletteProps): React.JSX.Element {
  const { open, onClose, context, mac } = props;
  const locale = useDashboardLocale();
  const snapshot = useDashboardStore();
  const authed = ui.authed;
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PaletteScope>('all');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recentKeys, setRecentKeys] = useState<string[]>(() => readRecentKeys(storage()));
  const [expanded, setExpanded] = useState<ReadonlyMap<PaletteKind, number>>(() => new Map());
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const manageReady = authed && context.manageDataReady;
  const { remote, loading } = useRemoteSources(open, manageReady);
  // 机器人条目来自名称映射：首屏那次加载失败或还没回来时，唤起面板补一次（有缓存，已加载则立即返回）。
  const [, bumpNames] = useState(0);
  useEffect(() => {
    if (!open || !manageReady) return undefined;
    let alive = true;
    void loadNameMaps().then(() => { if (alive) bumpNames(value => value + 1); });
    return () => { alive = false; };
  }, [manageReady, open]);
  // bot / 群名映射晚到（冷启动时 /api/groups 还没回来）时，按行缓存的会话条目要跟着失效。
  const namesVersion = nameMapsVersion();

  // Skill / Agent 是管理页，未登录（含公开只读访客）不出这两个分类。
  const scopes = useMemo(
    () => PALETTE_SCOPES.filter(value => authed || (value !== 'skill' && value !== 'agent')),
    [authed],
  );

  // 每次唤起都是新实例：会话条目按行对象缓存到本次关闭为止，相对时间以唤起时刻为准。
  const sessionCacheRef = useRef<{ key: string; now: number; items: WeakMap<object, PaletteItem> } | null>(null);
  const sessionItems = useMemo(() => {
    if (!open) return [];
    const cacheKey = `${locale}:${ui.workbenchAuthed}:${namesVersion}`;
    if (sessionCacheRef.current?.key !== cacheKey) {
      sessionCacheRef.current = { key: cacheKey, now: Date.now(), items: new WeakMap() };
    }
    const cache = sessionCacheRef.current;
    return buildSessionItems(snapshot.sessions.values(), cache.now, cache.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store 原地更新 Map，version 才是变化信号
  }, [open, snapshot.version, locale, authed, namesVersion]);
  const remoteItems = useMemo(() => (open && authed ? [
    ...buildSkillItems(remote.skills ?? []),
    ...buildAgentItems(remote.agents?.agents ?? [], remote.agents?.links ?? {}),
  ] : []), [authed, locale, open, remote]);
  const localItems = useMemo(() => (open ? [
    ...buildActionItems(context),
    ...buildSettingItems(),
    ...buildBotDefaultsTabItems(),
    ...buildBotDefaultsSectionItems(),
    ...buildPreferenceItems(context),
    ...buildBotItems(),
    ...buildPageItems(context.pages),
  ] : []), [authed, context, locale, namesVersion, open, ui.theme]);
  const items = useMemo(() => [...sessionItems, ...remoteItems, ...localItems], [localItems, remoteItems, sessionItems]);
  const pageIcons = useMemo(
    () => new Map(context.pages.filter(page => page.icon).map(page => [page.id, page.icon])),
    [context.pages],
  );

  const result = useMemo(
    () => searchPalette({ items, query: deferredQuery, scope, recentKeys, expanded }),
    [deferredQuery, expanded, items, recentKeys, scope],
  );
  const { rows, groups, counts } = result;
  const foundIndex = activeKey ? rows.findIndex(row => rowKey(row) === activeKey) : -1;
  const activeIndex = rows.length === 0 ? -1 : Math.max(0, foundIndex);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const hasQuery = deferredQuery.trim().length > 0;

  // 查询或分类变了，选中回到第一条（不沿用旧 key：旧条目可能恰好还在、却已不是最佳匹配），
  // 原地展开过的组也收回去——展开是针对上一组结果的。
  useEffect(() => {
    setActiveKey(null);
    setExpanded(new Map());
  }, [deferredQuery, scope]);

  // Esc 在 window 捕获阶段拦：它先于任何 document 级捕获监听（Skill 库多选态、排程群选择器
  // 都在那里吞 Escape），否则一次 Esc 关掉的是面板底下的浮层，面板反而还开着。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, open]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    if (activeIndex === 0) {
      list.scrollTop = 0;
      return;
    }
    list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, groups]);

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const next = activeIndex < 0
      ? 0
      : Math.abs(delta) === 1
        ? (activeIndex + delta + rows.length) % rows.length
        : Math.min(rows.length - 1, Math.max(0, activeIndex + delta));
    setActiveKey(rowKey(rows[next]!));
  };

  const changeScope = (next: PaletteScope) => {
    setScope(next);
    inputRef.current?.focus();
  };

  const runAction = (item: PaletteItem, action: PaletteAction, newTab = false) => {
    setRecentKeys(pushRecentKey(storage(), item.key));
    if (action.href && (newTab || action.external)) {
      // 新标签 / 外链必须在这次点击、回车的同步段里 window.open：推迟到 setTimeout 就脱离了
      // 用户手势，Safari 会当弹窗拦掉（同 sessions.ts 打开终端的做法）。新标签不碰本页的
      // <dialog>，先开窗再关面板。
      openInNewTab(action);
      onClose();
      return;
    }
    onClose();
    // 等面板的 <dialog> 真正 close（焦点归还）之后再执行：动作本身可能再弹一个
    // 原生模态框（创建会话 / 创建机器人），先后顺序反了焦点会被抢回已失效的元素上。
    window.setTimeout(() => {
      if (action.run) action.run();
      // 目标与当前相同时会重挂载页面重新消费深链，navigateToHash 先过未保存编辑的守卫。
      else if (action.href) navigateToHash(action.href);
    }, 0);
  };

  const choose = (row: PaletteRow | undefined, options: { alternate?: boolean; newTab?: boolean } = {}) => {
    if (!row) return;
    if (row.type === 'more') {
      if (row.scope) {
        changeScope(row.scope);
        return;
      }
      // 原地再展开一段；「再显示」那一行的位置正好换成该组第一条原先被截掉的条目，
      // 选中它，键盘接着往下走。
      const grown = expandGroup(expanded, row.kind);
      setExpanded(grown);
      const next = searchPalette({ items, query: deferredQuery, scope, recentKeys, expanded: grown });
      const replacement = next.rows[rows.indexOf(row)];
      setActiveKey(replacement ? rowKey(replacement) : null);
      inputRef.current?.focus();
      return;
    }
    const action = options.alternate ? row.item.secondary ?? row.item.primary : row.item.primary;
    runAction(row.item, action, options.newTab);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组字期间的方向键 / 回车属于候选框，不能抢。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'ArrowDown' || (mac && ctrlOnly && event.key === 'n')) {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || (mac && ctrlOnly && event.key === 'p')) {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      move(8);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      move(-8);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeRow, { alternate: event.metaKey || event.ctrlKey });
    } else if (event.key === 'Tab') {
      event.preventDefault();
      setScope(current => nextScope(current, event.shiftKey ? -1 : 1, scopes));
    } else if (event.key === 'Backspace' && query === '' && scope !== 'all') {
      event.preventDefault();
      setScope('all');
    }
  };

  const activeItem = activeRow?.type === 'item' ? activeRow.item : null;
  // 读屏：可见几条、还有几条没展开。空查询且没截断时不播报（起始面板不是「结果」）。
  const { visible, hidden } = paletteVisibility(result);
  const srAnnouncement = hidden > 0
    ? t('palette.srVisibleHidden', { visible, hidden })
    : hasQuery ? t('palette.srVisible', { visible }) : '';
  const mod = modifierKeyLabel(mac);
  let optionIndex = -1;

  return (
    <ModalDialog
      open={open}
      className="command-palette-dialog"
      aria-label={t('palette.dialogLabel')}
      onClose={onClose}
      onRequestClose={onClose}
      onOpen={() => inputRef.current?.focus()}
    >
      <div className="cmdk">
        <div className="cmdk-search">
          <span className="cmdk-search-icon">{KIND_ICONS.search}</span>
          {scope !== 'all' ? (
            <button
              type="button"
              className="cmdk-scope-pill"
              tabIndex={-1}
              onMouseDown={event => event.preventDefault()}
              onClick={() => changeScope('all')}
              aria-label={`${t(SCOPE_LABEL_KEYS[scope])} ×`}
            >
              {t(SCOPE_LABEL_KEYS[scope])}
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={scope === 'all'
              ? t('palette.placeholder')
              : t('palette.placeholderScope', { scope: t(SCOPE_LABEL_KEYS[scope]) })}
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="cmdk-esc" aria-hidden="true">Esc</kbd>
          {loading ? <span className="cmdk-progress" aria-hidden="true" /> : null}
        </div>
        <div className="cmdk-scopes" role="tablist" aria-label={t('palette.hintScope')}>
          {scopes.map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={scope === value}
              className={`cmdk-scope${scope === value ? ' is-active' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => changeScope(value)}
            >
              <span>{t(SCOPE_LABEL_KEYS[value])}</span>
              {hasQuery ? <span className="cmdk-scope-count">{counts[value]}</span> : null}
            </button>
          ))}
        </div>
        <div className="cmdk-list" id={listId} role="listbox" ref={listRef} aria-label={t('palette.dialogLabel')}>
          {rows.length === 0 ? (
            loading && scope !== 'session' && scope !== 'setting' ? (
              <div className="cmdk-empty">
                <span className="page-loading-spin" aria-hidden="true" />
                <span>{t('palette.loading')}</span>
              </div>
            ) : hasQuery ? (
              <div className="cmdk-empty">
                <span className="cmdk-empty-icon">{KIND_ICONS.search}</span>
                <strong>{t('palette.empty', { query: deferredQuery.trim() })}</strong>
                <span>{t('palette.emptyHint')}</span>
              </div>
            ) : (
              <div className="cmdk-empty"><span>{t('palette.emptyScope')}</span></div>
            )
          ) : groups.map(group => {
            const labelId = `${baseId}-group-${group.id}`;
            return (
              <div key={group.id} className="cmdk-group" role="group" aria-labelledby={labelId}>
                <div className="cmdk-group-label" id={labelId}>
                  <span>{t(GROUP_LABEL_KEYS[group.id])}</span>
                  {hasQuery && group.total > 1 ? <span className="cmdk-group-count">{group.total}</span> : null}
                </div>
                {group.rows.map(row => {
                  optionIndex += 1;
                  const index = optionIndex;
                  const active = index === activeIndex;
                  const common = {
                    id: optionId(index),
                    role: 'option' as const,
                    'aria-selected': active,
                    'data-index': index,
                    onPointerMove: () => { if (!active) setActiveKey(rowKey(row)); },
                    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
                  };
                  if (row.type === 'more') {
                    return (
                      <div
                        key={rowKey(row)}
                        {...common}
                        className={`cmdk-item cmdk-more${active ? ' is-active' : ''}`}
                        onClick={() => choose(row)}
                      >
                        <span className="cmdk-item-icon">{KIND_ICONS.more}</span>
                        <span className="cmdk-item-main">
                          <span className="cmdk-item-title">{moreRowLabel(row)}</span>
                        </span>
                        <span className="cmdk-item-tail"><kbd className="cmdk-enter" aria-hidden="true">↵</kbd></span>
                      </div>
                    );
                  }
                  const { item, match } = row;
                  return (
                    <div
                      key={rowKey(row)}
                      {...common}
                      className={`cmdk-item cmdk-kind-${item.kind}${active ? ' is-active' : ''}`}
                      onClick={event => choose(row, { newTab: event.metaKey || event.ctrlKey })}
                      onAuxClick={event => { if (event.button === 1) choose(row, { newTab: true }); }}
                    >
                      <span className={`cmdk-item-icon${item.avatar ? ' has-avatar' : ''}`}>
                        {itemIcon(item, pageIcons)}
                      </span>
                      <span className="cmdk-item-main">
                        <span className="cmdk-item-title">
                          <Highlighted text={item.title} ranges={match?.titleRanges ?? []} />
                        </span>
                        {item.subtitle ? (
                          <span className="cmdk-item-sub">
                            <Highlighted text={item.subtitle} ranges={match?.subtitleRanges ?? []} />
                          </span>
                        ) : null}
                      </span>
                      <span className="cmdk-item-tail">
                        {item.badge ? <span className={`cmdk-badge tone-${item.badge.tone}`}>{item.badge.text}</span> : null}
                        {item.meta ? <span className="cmdk-meta">{item.meta}</span> : null}
                        <kbd className="cmdk-enter" aria-hidden="true">↵</kbd>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer className="cmdk-footer" aria-hidden="true">
          <span className="cmdk-hint"><kbd>↑</kbd><kbd>↓</kbd>{t('palette.hintNavigate')}</span>
          {activeRow ? (
            <span className="cmdk-hint">
              <kbd>↵</kbd>
              {activeRow.type === 'more' ? moreRowLabel(activeRow) : activeRow.item.primary.label}
            </span>
          ) : null}
          {activeItem?.secondary ? (
            <span className="cmdk-hint"><kbd>{mod}</kbd><kbd>↵</kbd>{activeItem.secondary.label}</span>
          ) : null}
          <span className="cmdk-hint cmdk-hint-end"><kbd>Tab</kbd>{t('palette.hintScope')}</span>
          <span className="cmdk-hint"><kbd>Esc</kbd>{t('palette.hintClose')}</span>
        </footer>
        <div className="cmdk-sr-only" aria-live="polite">
          {srAnnouncement}
        </div>
      </div>
    </ModalDialog>
  );
}
