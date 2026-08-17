import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  WORKBENCH_GROUP_DIMENSIONS,
  attentionSummary,
  computeVirtualWindow,
  flattenWorkbenchGroups,
  formatWorkbenchRelativeTime,
  groupWorkbenchSessionsForDimension,
  isWorkbenchGroupDimension,
  sessionActivityAt,
  workbenchListItemHeight,
  workbenchSessionKind,
  workbenchSessionTitle,
  type WorkbenchGroupDimension,
  type WorkbenchListItem,
  type WorkbenchSessionGroup,
  type WorkbenchSessionKind,
  type WorkbenchSessionRow,
} from './agent-workbench-model.js';
import {
  loadWorkbenchCollapsedGroups,
  saveWorkbenchCollapsedGroups,
  type WorkbenchStorage,
} from './agent-workbench-storage.js';
import { buildChatAppLink } from './agent-workbench-chat.js';

/** 行操作按钮用短文字，不用图标——图标要靠猜，两个字直接说清楚做什么。 */

/** 会话类型徽标文案。键与 workbenchSessionKind 的返回值一一对应。 */
const KIND_COPY: Record<WorkbenchSessionKind, { label: string; title: string }> = {
  thread: { label: '话题', title: '话题会话' },
  group: { label: '群', title: '群会话' },
  p2p: { label: '单聊', title: '单聊会话' },
};

/** 与服务端 locateLimiter 对齐的按钮侧冷却；成功态只是短暂的视觉确认。 */
const LOCATE_COOLDOWN_MS = 30_000;
const LOCATE_SUCCESS_MS = 2_000;

/** 429 会把还需等待的秒数挂在错误对象上（WorkbenchApiError.retryAfterSeconds）。
 *  这里刻意用鸭子类型读取，避免展示组件反向依赖 api 模块。 */
function locateRetryAfterMs(error: unknown): number | null {
  const seconds = Number((error as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, LOCATE_COOLDOWN_MS) : null;
}

function locateErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || '未知错误';
}

/** 行前的状态记号。分组名本身由 model 给（动态维度下就是机器人名/会话名），
 *  这里只留图标，避免同一份文案在两处各写一遍、日子久了对不上。 */
const GROUP_ICON: Record<WorkbenchSessionGroup, string> = {
  'needs-you': '!',
  active: '●',
  recent: '↺',
};

/** 未读但没有 attention 理由时，行里说这一句——它替的是「有什么事」那一格。 */
const UNREAD_REASON = '有新回复';

/** 没传 unreadIds 时用同一个空集合，memo 依赖才不会每次渲染都变。 */
const NO_UNREAD: ReadonlySet<string> = new Set<string>();

/** 折叠状态是浏览器本地的一句偏好，列表自己读写（工作台和会话坞共用同一份）。
 *  没有 window（组件测试跑在 node 上）就当没存过，一切照常展开。 */
function browserStorage(): WorkbenchStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

/** 组头是真按钮，Enter / Space 该由浏览器派给它自己。列表的 keydown 挂在滚动容器
 *  上，事件会冒泡上来，不认一下就会「折叠一次 + 再选中一次」两件事一起发生。 */
function fromGroupToggle(target: EventTarget | null): boolean {
  const node = target as { closest?: (selector: string) => unknown } | null;
  return typeof node?.closest === 'function' && node.closest('.wb-session-group-toggle') !== null;
}

/** 分组头的图标：动态维度（机器人/会话/CLI）的组没有语义颜色，用中性圆点。 */
function headerIcon(item: Extract<WorkbenchListItem, { kind: 'header' }>): string {
  if (item.isNeedsYou) return GROUP_ICON['needs-you'];
  if (item.groupKey === 'active') return GROUP_ICON.active;
  if (item.groupKey === 'recent') return GROUP_ICON.recent;
  return '·';
}

/** 只有这三个保留 key 才允许拼进 class 名——bot/chat/cli 的组名是数据里的自由
 *  文本，绝不能直接拼类名。「待你处理」保留红色高亮，其余组走 .wb-session-group 默认色。 */
function headerClassName(item: Extract<WorkbenchListItem, { kind: 'header' }>): string {
  if (item.isNeedsYou) return 'wb-session-group wb-session-group-needs-you';
  if (item.groupKey === 'active') return 'wb-session-group wb-session-group-active';
  if (item.groupKey === 'recent') return 'wb-session-group wb-session-group-recent';
  return 'wb-session-group';
}

/** The one chat-opening element every Workbench surface shares. It must stay
 *  a plain anchor with exactly these semantics — the Dashboard's session page
 *  proved this shape (a real user click on target=_blank rel=noopener) is the
 *  only unsigned dispatch the Feishu client gives standard treatment; every
 *  scripted variant (window.open, hidden .click(), enterChat) gets demoted. */
function FeishuChatAnchor(props: {
  href: string;
  className: string;
  title?: string;
  ariaLabel: string;
  onActivate?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className={props.className}
      href={props.href}
      target="_blank"
      rel="noopener"
      title={props.title}
      aria-label={props.ariaLabel}
      onClick={event => {
        event.stopPropagation();
        props.onActivate?.();
      }}
    >{props.children}</a>
  );
}

export interface WorkbenchSessionListProps {
  sessions: readonly WorkbenchSessionRow[];
  selectedSessionId: string | null;
  collapsed?: boolean;
  locale?: string;
  now?: number;
  /** Drives the live/last-snapshot dot in the list heading — the page-level
   *  status bar that used to carry it is gone. */
  online?: boolean;
  onSelect(sessionId: string): void;
  onToggleCollapsed?(): void;
  /** Row-level shortcuts: jump straight to a surface instead of selecting the
   *  session and then hunting for the layout control. */
  onOpenSurface?(sessionId: string, surface: 'terminal' | 'terminal-control' | 'chat'): void;
  /** P1-4：显式传 false 时不渲染行内「接管」捷径（只留只读「终端」）——没有
   *  canControl 能力的身份（平台 teammate/guest、触屏 H5）接管必 403。不传按
   *  旧行为渲染（dock 等不带能力投影的精简形态）。 */
  canControlTerminal?: boolean;
  /** 话题会话专用：让 bot 在原话题里 @ 会话拥有者，用户点通知即可跳回话题。
   *  不传则不渲染定位按钮（dock 等精简形态就是这么用的）。 */
  onLocate?(sessionId: string): Promise<void>;
  /** Chat-follow renders each row's main surface as a real chat anchor, so the
   *  open is the user's own trusted click. Scripted opens (even a synthesised
   *  anchor.click(), which stays isTrusted=false) are demoted by the Feishu
   *  client; a real click is the only unsigned path with standard treatment. */
  chatFollowNavigates?: boolean;
  /** 未读会话 id（bot 干完活但你还没看）。不传就是全都已读。 */
  unreadIds?: ReadonlySet<string>;
  /** 当前分组维度，不传按「状态」分组（旧行为）。 */
  dimension?: WorkbenchGroupDimension;
  /** 不传就不渲染维度下拉——dock 这类精简形态用不上。 */
  onDimensionChange?(dimension: WorkbenchGroupDimension): void;
  /** 「看过了」的回执：行内那些不改变选中态的操作（打开飞书聊天、定位）也该
   *  清掉未读，但它们不能顺手把选中态挪过去（移动端选中会直接钻进工作区）。 */
  onSeen?(sessionId: string): void;
}

function useViewportHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(560);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setHeight(Math.max(120, node.clientHeight || 560));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function sessionOptionId(sessionId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `wb-session-${(hash >>> 0).toString(36)}`;
}

function sessionSecondary(session: WorkbenchSessionRow): string {
  return [session.botName, session.cliId, session.repoName].filter(Boolean).join(' · ') || session.sessionId;
}

/** Mirrors the 620px breakpoint the stylesheet uses for taller touch rows, so
 *  virtualisation and CSS never disagree about how tall a row is. */
function useTouchRowMetrics(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(max-width: 620px)');
    const sync = () => setTouch(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return touch;
}

export function WorkbenchSessionList(props: WorkbenchSessionListProps): JSX.Element {
  const touchRows = useTouchRowMetrics();
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledSelectionRef = useRef<string | null>(props.selectedSessionId ?? null);
  const viewportHeight = useViewportHeight(scrollerRef);
  // 冷却状态挂在列表上而不是按钮上：行是虚拟滚动的，按钮滚出视口就卸载，
  // 状态放按钮里会被一次滚动清空，用户就能连点绕过 30s 限流。
  const [locateAt, setLocateAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [locateError, setLocateError] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [, setLocateTick] = useState(0);
  // 折叠的组 key。存的是 model 给的稳定 key（`bot:Builder` 这种带维度前缀的），
  // 全维度唯一，所以一份集合天然按维度隔离，切维度不会互相影响。
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(loadWorkbenchCollapsedGroups(browserStorage()) ?? []),
  );
  const unreadIds = props.unreadIds ?? NO_UNREAD;
  const dimension = props.dimension ?? 'status';
  // 时间维度只认「今天/昨天/本周」这种天级边界。父级的 now 每渲染一次都是新值，
  // 直接进依赖会让 300+ 会话的列表每帧重排一次；量化到分钟就够用了。
  const bucketNow = Math.floor((props.now ?? Date.now()) / 60_000) * 60_000;
  const groups = useMemo(
    () => groupWorkbenchSessionsForDimension(props.sessions, { query, dimension, unreadIds, now: bucketNow }),
    [bucketNow, dimension, props.sessions, query, unreadIds],
  );
  const items = useMemo(() => flattenWorkbenchGroups(groups, collapsedGroups), [collapsedGroups, groups]);
  const visible = useMemo(
    () => computeVirtualWindow(items, scrollTop, viewportHeight, 240, touchRows),
    [items, scrollTop, touchRows, viewportHeight],
  );
  // 折叠掉的会话不在 items 里，j/k 于是自动跳过它们——这正是我们要的。
  const sessionItems = useMemo(
    () => items.filter((item): item is Extract<WorkbenchListItem, { kind: 'session' }> => item.kind === 'session'),
    [items],
  );
  // 「有没有匹配的会话」和收起态角标都要看折叠前的真实条数：全组折叠起来只是把行
  // 藏了，不代表搜不到东西，更不代表没有会话在等你。
  const matchedCount = useMemo(
    () => groups.reduce((total, group) => total + group.sessions.length, 0),
    [groups],
  );
  const needsYouCount = useMemo(
    () => groups.find(group => group.kind === 'needs-you')?.sessions.length ?? 0,
    [groups],
  );

  // 定位只在选中会话变化时发生一次，避免每次重渲染都把 scrollTop 拽回选中行、和用户滚动打架。
  // 初始选中不定位（列表保持置顶的「待你处理」可见），只有用户切换选中才滚动定位。
  useEffect(() => {
    if (!props.selectedSessionId) {
      lastScrolledSelectionRef.current = null;
      return;
    }
    if (lastScrolledSelectionRef.current === props.selectedSessionId) return;
    if (!sessionItems.some(item => item.session.sessionId === props.selectedSessionId)) return;
    lastScrolledSelectionRef.current = props.selectedSessionId;
    const index = items.findIndex(item => item.kind === 'session' && item.session.sessionId === props.selectedSessionId);
    const top = visible.positions[index] ?? 0;
    const bottom = top + workbenchListItemHeight(items[index], touchRows);
    const node = scrollerRef.current;
    if (!node || (top >= node.scrollTop && bottom <= node.scrollTop + node.clientHeight)) return;
    node.scrollTop = Math.max(0, top - Math.round(node.clientHeight / 3));
  }, [items, props.selectedSessionId, sessionItems, visible.positions]);

  // 冷却和成功态都是时间推导出来的，需要一个心跳把它们重绘掉。心跳只在真的有
  // 冷却时存在：过期条目在这里被剪掉，Map 空了 effect 自然清掉定时器。
  // 用裸的 setInterval 而不是 window.setInterval：这个 effect 在首次成功定位后
  // 才挂载，走 window 会让整个列表在没有 window 的环境（组件测试跑在 node 上）
  // 一点定位就崩。同目录的 panes 一直是这么写的，计时本来也不需要 DOM。
  useEffect(() => {
    if (locateAt.size === 0) return undefined;
    const timer = setInterval(() => {
      setLocateAt(previous => {
        const now = Date.now();
        const next = new Map([...previous].filter(([, at]) => now - at < LOCATE_COOLDOWN_MS));
        return next.size === previous.size ? previous : next;
      });
      setLocateTick(value => value + 1);
    }, 500);
    return () => clearInterval(timer);
  }, [locateAt]);

  const onLocate = props.onLocate;
  const startLocate = (sessionId: string) => {
    if (!onLocate) return;
    // 乐观进入冷却：请求还在飞的时候按钮就不可点，失败再放开。
    setLocateAt(previous => new Map(previous).set(sessionId, Date.now()));
    setLocateError(previous => {
      if (!previous.has(sessionId)) return previous;
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
    void onLocate(sessionId).then(
      () => {
        // 成功后把时间戳推到「此刻」：成功态从这里开始算 2s，冷却也从服务端
        // 真正受理的时刻开始算 30s，不会比服务端的限流窗口短。
        setLocateAt(previous => new Map(previous).set(sessionId, Date.now()));
      },
      (error: unknown) => {
        setLocateError(previous => new Map(previous).set(sessionId, locateErrorText(error)));
        const retryAfterMs = locateRetryAfterMs(error);
        setLocateAt(previous => {
          const next = new Map(previous);
          // 429 说明服务端还在限流窗口里，按它给的剩余时间继续禁用；
          // 其它错误立刻恢复可点，让用户能重试。
          if (retryAfterMs === null) next.delete(sessionId);
          else next.set(sessionId, Date.now() - (LOCATE_COOLDOWN_MS - retryAfterMs));
          return next;
        });
      },
    );
  };

  /** 折叠/展开一个组，并立刻落盘——这是用户按一下就该记住的偏好，没必要攒批。 */
  const toggleGroup = (groupKey: string) => {
    const next = new Set(collapsedGroups);
    // 新折叠的组加在末尾：数组按加入序存，封顶时先丢最早折叠的那些。
    if (!next.delete(groupKey)) next.add(groupKey);
    setCollapsedGroups(next);
    saveWorkbenchCollapsedGroups(browserStorage(), next);
  };

  const moveSelection = (delta: -1 | 1) => {
    if (sessionItems.length === 0) return;
    const current = sessionItems.findIndex(item => item.session.sessionId === props.selectedSessionId);
    const next = current < 0
      ? (delta > 0 ? 0 : sessionItems.length - 1)
      : Math.max(0, Math.min(sessionItems.length - 1, current + delta));
    props.onSelect(sessionItems[next].session.sessionId);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // 焦点在组头按钮上时，Enter / Space 是它自己的激活键，列表别再抢一次。
    // j/k 和方向键照旧生效，从组头也能直接开始上下走。
    if ((event.key === 'Enter' || event.key === ' ') && fromGroupToggle(event.target)) return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter' && props.selectedSessionId) {
      event.preventDefault();
      props.onSelect(props.selectedSessionId);
      // Hand focus to the row's real chat anchor; the user's next Enter is the
      // browser's own activation of a focused link — a trusted event. A script
      // .click() here would be isTrusted=false, the demoted dispatch again.
      if (props.chatFollowNavigates && typeof document !== 'undefined') {
        document.getElementById(sessionOptionId(props.selectedSessionId))
          ?.querySelector<HTMLAnchorElement>('a.wb-session-copy-link')
          ?.focus();
      }
    }
  };

  if (props.collapsed) {
    const collapsedLabel = (
      <>
        <span aria-hidden="true">»</span>
        <span className="wb-rail-vertical-label">会话</span>
      </>
    );
    return (
      <aside className="wb-session-rail is-collapsed" aria-label="会话列表（已收起）">
        {props.onToggleCollapsed ? (
          <button
            type="button"
            className="wb-rail-expand"
            aria-label="展开会话列表"
            title="展开会话列表"
            onClick={props.onToggleCollapsed}
          >{collapsedLabel}</button>
        ) : <div className="wb-rail-expand" aria-label="会话列表（已收起）">{collapsedLabel}</div>}
        <span className="wb-rail-count" aria-label={`${needsYouCount} 个会话需要处理`}>
          {needsYouCount}
        </span>
      </aside>
    );
  }

  return (
    <aside className="wb-session-rail" aria-label="会话列表">
      <div className="wb-rail-heading">
        <div>
          <span
            className={props.online ? 'is-online' : 'is-offline'}
            title={props.online ? '实时连接正常' : '已离线，显示最后快照'}
            aria-hidden="true"
          >{props.online ? '●' : '○'}</span>
          <strong>会话</strong>
          <span>{props.sessions.length}</span>
        </div>
        {props.onDimensionChange ? (
          <select
            className="wb-group-dim"
            aria-label="分组维度"
            value={dimension}
            onChange={event => {
              const value = event.currentTarget.value;
              if (isWorkbenchGroupDimension(value)) props.onDimensionChange?.(value);
            }}
          >
            {WORKBENCH_GROUP_DIMENSIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : null}
        {props.onToggleCollapsed ? (
          <button type="button" aria-label="收起会话列表" title="收起会话列表" onClick={props.onToggleCollapsed}>«</button>
        ) : null}
      </div>
      <label className="wb-session-search">
        <span className="wb-visually-hidden">搜索会话</span>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          placeholder="搜索…"
          value={query}
          onChange={event => changeQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              scrollerRef.current?.focus();
              moveSelection(1);
            }
          }}
        />
        {query ? <button type="button" aria-label="清除搜索" onClick={() => changeQuery('')}>×</button> : null}
      </label>
      <div
        ref={scrollerRef}
        className="wb-session-list"
        role="listbox"
        tabIndex={0}
        aria-label="工作台会话"
        aria-activedescendant={props.selectedSessionId ? sessionOptionId(props.selectedSessionId) : undefined}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onListKeyDown}
      >
        <div className="wb-session-list-space" style={{ height: visible.totalHeight }}>
          {items.slice(visible.start, visible.end).map((item, sliceIndex) => {
            const index = visible.start + sliceIndex;
            const style = { top: visible.positions[index], height: workbenchListItemHeight(item, touchRows) };
            if (item.kind === 'header') {
              const groupCollapsed = item.collapsed === true;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`${headerClassName(item)} wb-session-group-toggle`}
                  style={style}
                  aria-expanded={!groupCollapsed}
                  title={groupCollapsed ? `展开「${item.label}」` : `折叠「${item.label}」`}
                  onClick={() => toggleGroup(item.groupKey)}
                >
                  <span className="wb-session-group-caret" aria-hidden="true">{groupCollapsed ? '▸' : '▾'}</span>
                  <span aria-hidden="true">{headerIcon(item)}</span>
                  <strong>{item.label}</strong>
                  <span>{item.count}</span>
                </button>
              );
            }
            const session = item.session;
            const title = workbenchSessionTitle(session);
            const unread = unreadIds.has(session.sessionId);
            // attention 理由优先——它说的是「卡住了」，比「有新回复」重要得多。
            const reason = attentionSummary(session) ?? (unread ? UNREAD_REASON : null);
            const selected = session.sessionId === props.selectedSessionId;
            const statusText = item.group === 'needs-you' ? '待你处理' : item.group === 'active' ? session.status : '最近';
            const openSurface = props.onOpenSurface;
            const chatHref = session.feishuChatLink
              || (session.chatId ? buildChatAppLink(session.chatId) : null);
            const kind = workbenchSessionKind(session);
            return (
                <div
                  key={item.key}
                  id={sessionOptionId(session.sessionId)}
                  className={`wb-session-row wb-session-row-${item.group}${selected ? ' is-selected' : ''}${unread ? ' is-unread' : ''}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  aria-label={`${title}. ${statusText}${reason ? `. ${reason}` : ''}`}
                  style={style}
                  onClick={() => props.onSelect(session.sessionId)}
                >
                  <span className="wb-session-state-mark" aria-hidden="true">{GROUP_ICON[item.group]}</span>
                  {(() => {
                    const copy = (
                      <>
                        <span className="wb-session-title" title={title}>{title}</span>
                        <span className="wb-session-meta" title={sessionSecondary(session)}>
                          {kind ? (
                            <span className={`wb-session-kind is-${kind}`} title={KIND_COPY[kind].title}>
                              {KIND_COPY[kind].label}
                            </span>
                          ) : null}
                          {reason ? <span className="wb-session-reason">{reason}</span> : <span>{sessionSecondary(session)}</span>}
                          {unread ? <span className="wb-unread-dot" role="img" aria-label={UNREAD_REASON} /> : null}
                          <time dateTime={new Date(sessionActivityAt(session)).toISOString()}>
                            {formatWorkbenchRelativeTime(sessionActivityAt(session), props.now, props.locale)}
                          </time>
                        </span>
                      </>
                    );
                    if (!props.chatFollowNavigates || !chatHref) {
                      return <span className="wb-session-copy">{copy}</span>;
                    }
                    return (
                      <FeishuChatAnchor
                        className="wb-session-copy wb-session-copy-link"
                        href={chatHref}
                        ariaLabel={`选中并打开飞书聊天 — ${title}`}
                        onActivate={() => props.onSelect(session.sessionId)}
                      >{copy}</FeishuChatAnchor>
                    );
                  })()}
                  {openSurface ? (
                    <span className="wb-session-row-actions">
                      {/* A real anchor, not a scripted open: handing the AppLink
                          to the browser lets the Feishu client claim it and place
                          the chat in its own panel, leaving this page untouched.
                          This is exactly how the Dashboard's own "open chat"
                          control has always worked. */}
                      {chatHref ? (
                        <FeishuChatAnchor
                          className="wb-session-row-action is-chat"
                          href={chatHref}
                          title="打开飞书聊天"
                          ariaLabel={`打开飞书聊天 — ${title}`}
                          // 去飞书看聊天就是看过了；但不动选中态——移动端选中会直接
                          // 钻进工作区，一次点击给两个目的地。
                          onActivate={() => props.onSeen?.(session.sessionId)}
                        >聊天</FeishuChatAnchor>
                      ) : null}
                      {/* 定位只对话题会话有意义：群/单聊会话没有可回跳的话题锚点。
                          聊天按钮照旧开群，定位是它旁边的另一条路。 */}
                      {kind === 'thread' && onLocate ? (() => {
                        const at = locateAt.get(session.sessionId) ?? 0;
                        const elapsed = Date.now() - at;
                        const cooling = at > 0 && elapsed < LOCATE_COOLDOWN_MS;
                        const failure = locateError.get(session.sessionId);
                        const located = cooling && !failure && elapsed < LOCATE_SUCCESS_MS;
                        const label = cooling
                          ? '定位已发送，30 秒后可再次使用'
                          : failure
                            ? `定位失败：${failure}`
                            : '在话题里 @ 我定位';
                        return (
                          <button
                            type="button"
                            className={`wb-session-row-action is-locate${located ? ' is-located' : ''}`}
                            title={label}
                            aria-label={`${label} — ${title}`}
                            disabled={cooling}
                            onClick={event => {
                              event.stopPropagation();
                              props.onSeen?.(session.sessionId);
                              startLocate(session.sessionId);
                            }}
                          >{located ? '已发送' : '定位'}</button>
                        );
                      })() : null}
                      {([
                        ['terminal', '打开只读终端', '终端'] as const,
                        // 接管捷径只对有 canControl 能力的身份渲染（P1-4）；
                        // undefined（dock/旧调用方）保持旧行为。
                        ...(props.canControlTerminal !== false
                          ? [['terminal-control', '打开终端并接管输入', '接管'] as const]
                          : []),
                      ]).map(([surface, label, text]) => (
                        <button
                          key={surface}
                          type="button"
                          className={`wb-session-row-action is-${surface}`}
                          title={label}
                          aria-label={`${label} — ${title}`}
                          onClick={event => {
                            // The row itself selects; without this the click would
                            // also bubble and fire a redundant selection.
                            event.stopPropagation();
                            openSurface(session.sessionId, surface);
                          }}
                        >{text}</button>
                      ))}
                    </span>
                  ) : null}
                </div>
              );
          })}
        </div>
        {matchedCount === 0 ? <p className="wb-session-empty">没有匹配的会话</p> : null}
      </div>
    </aside>
  );
}
