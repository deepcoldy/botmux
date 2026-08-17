import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  WORKBENCH_RAIL_COLLAPSED,
  WORKBENCH_RAIL_MAX,
  WORKBENCH_RAIL_MIN,
  buildWorkbenchHash,
  clampRailWidth,
  clampSplitRatio,
  deriveResponsiveWorkbenchLayout,
  groupWorkbenchSessions,
  sessionActivityAt,
  validWorkbenchSessionId,
  workbenchPreviewHref,
  type WorkbenchGroupDimension,
  type WorkbenchLayoutState,
  type WorkbenchPaneKind,
  type WorkbenchSessionRow,
  type WorkbenchTerminalLocation,
} from './agent-workbench-model.js';
import {
  loadWorkbenchGroupDimension,
  loadWorkbenchLayout,
  loadWorkbenchRailPrefs,
  loadWorkbenchSeenLedger,
  pruneWorkbenchSeenLedger,
  saveWorkbenchGroupDimension,
  saveWorkbenchLayout,
  saveWorkbenchRailPrefs,
  saveWorkbenchSeenLedger,
  type WorkbenchSeenLedger,
  type WorkbenchStorage,
} from './agent-workbench-storage.js';
import type { FeishuJsApi, WorkbenchH5Context } from './agent-workbench-chat.js';
import { createWorkbenchApi, type WorkbenchApi } from './agent-workbench-api.js';
import { WorkbenchSessionList } from './agent-workbench-session-list.js';
import {
  TerminalPane,
  WebPane,
  WorkbenchInfo,
} from './agent-workbench-panes.js';

export interface AgentWorkbenchViewProps {
  sessions: readonly WorkbenchSessionRow[];
  online: boolean;
  authenticated: boolean;
  initialSessionId?: string | null;
  locale?: string;
  now?: number;
  viewportWidth?: number;
  api?: WorkbenchApi;
  storage?: WorkbenchStorage | null;
  location?: WorkbenchTerminalLocation | null;
  h5Context?: WorkbenchH5Context | null;
  sdk?: FeishuJsApi | null;
  demo?: boolean;
  onRouteChange?(hash: string): void;
}

type MobilePage = 'sessions' | 'workspace' | 'preview' | 'info';

/**
 * 终端面板的完整意图：开在**哪个会话**上，以及这次开是否**带接管**。
 * 两者必须原子地一起变。拆成两个 state 时，「面板跟随选中切会话」只改了会话 id，
 * 接管意图原封不动留着 —— 于是在 A 行点过「接管」之后，普通点击选中 B 会把这份意图
 * 带过去，对 B 自动发起接管（用户从没为 B 要过写权限）。
 */
type WorkbenchTerminalIntent = { sessionId: string; wantsControl: boolean };

/** A drag emits a pointermove per pixel; only the resting value is worth a write. */
const LAYOUT_SAVE_DEBOUNCE_MS = 250;

/** 一波快照往往连着改好几个会话的状态，逐条写 localStorage 没必要。 */
const SEEN_SAVE_DEBOUNCE_MS = 250;

/**
 * 「正在干活」的状态集合（daemon 侧 IdleDetector 驱动这些流转）。
 * 从其中任意一个跌到 'idle'，就是这一轮活干完了 —— 这是未读的**主信号**：
 * 它直接对应「bot 回复完了」，而且靠实时快照推过来，页面开着时最准。
 */
const BUSY_STATUSES = new Set(['starting', 'working', 'analyzing']);

function browserLocation(): WorkbenchTerminalLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

function browserStorage(): WorkbenchStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function useViewportWidth(override?: number): number {
  const [width, setWidth] = useState(override ?? (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    if (override !== undefined) { setWidth(override); return undefined; }
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener('resize', update, { passive: true });
    return () => window.removeEventListener('resize', update);
  }, [override]);
  return width;
}

function preferredSessionId(sessions: readonly WorkbenchSessionRow[]): string | null {
  const groups = groupWorkbenchSessions(sessions);
  return groups['needs-you'][0]?.sessionId ?? groups.active[0]?.sessionId ?? groups.recent[0]?.sessionId ?? null;
}

function nextLayout(
  current: WorkbenchLayoutState,
  patch: Partial<WorkbenchLayoutState>,
): WorkbenchLayoutState {
  return {
    ...current,
    ...patch,
    version: 1,
    railWidth: clampRailWidth(Number(patch.railWidth ?? current.railWidth)),
    splitRatio: clampSplitRatio(Number(patch.splitRatio ?? current.splitRatio)),
  };
}

export function AgentWorkbenchView(props: AgentWorkbenchViewProps): JSX.Element {
  const api = useMemo(() => props.api ?? createWorkbenchApi(), [props.api]);
  const storage = props.storage === undefined ? browserStorage() : props.storage;
  const location = props.location === undefined ? browserLocation() : props.location;
  const now = props.now ?? Date.now();
  const viewportWidth = useViewportWidth(props.viewportWidth);
  const initial = props.initialSessionId ?? preferredSessionId(props.sessions);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initial);
  const [layoutEnvelope, setLayoutEnvelope] = useState(() => {
    const loaded = initial ? loadWorkbenchLayout(initial, storage) : loadWorkbenchLayout('', null);
    // The global rail record wins; the per-session copy only survives as the
    // migration fallback for anyone whose width predates that record.
    const rail = loadWorkbenchRailPrefs(storage);
    return {
      sessionId: initial,
      layout: rail
        ? { ...loaded, railWidth: rail.railWidth, railCollapsed: rail.railCollapsed }
        : loaded,
    };
  });
  // Session management is the home surface — narrow layouts open on the list,
  // and only an explicit surface button moves to the workspace.
  const [mobilePage, setMobilePage] = useState<MobilePage>('sessions');
  const rootRef = useRef<HTMLElement | null>(null);
  const previousInitialSessionId = useRef(props.initialSessionId);
  // effect 里要用「这一帧的 now」，但把 now 放进依赖会让 effect 每次渲染都跑
  // （props.now 缺省时它每次都是新的 Date.now()）。用 ref 顺手带过去。
  const nowRef = useRef(now);
  nowRef.current = now;
  // 从没点开过的会话，用挂载时刻当已读基线：页面打开之前就躺在那儿的旧会话不该
  // 报未读，打开之后才有新动静的才算。
  const baselineRef = useRef(now);

  const [dimension, setDimension] = useState<WorkbenchGroupDimension>(
    () => loadWorkbenchGroupDimension(storage) ?? 'status',
  );
  const [seenLedger, setSeenLedger] = useState<WorkbenchSeenLedger>(() => {
    const loaded = loadWorkbenchSeenLedger(storage);
    if (loaded) return loaded;
    // 首次没有账本：把当前快照全部记成已读。否则第一次打开工作台，满屏历史会话
    // 会因为「活动时间 > 空的已读时间」被一股脑判成未读。
    const seen: Record<string, number> = {};
    for (const session of props.sessions) {
      if (validWorkbenchSessionId(session.sessionId)) seen[session.sessionId] = now;
    }
    return pruneWorkbenchSeenLedger({ seen, unread: {} });
  });
  const previousStatusRef = useRef<Map<string, string>>(new Map());

  // Keeps the native chat pointed at whatever row is selected — always on, no
  // toggle. The follow itself is the row's own real anchor, not a scripted
  // open: the client gives a trusted click the standard chat panel, while an
  // open the page initiates (even a synthesised anchor click) is demoted to the
  // narrow attached container — that demotion was the "chat opens narrow" bug.

  // One terminal fills the workspace at a time; the row button toggles it.
  // Stacking panes in-page was the wrong model — Feishu owns multi-column
  // layout, and chat opens through it rather than inside this document.
  const [terminal, setTerminal] = useState<WorkbenchTerminalIntent | null>(null);
  const terminalSessionId = terminal?.sessionId ?? null;
  const terminalWantsControl = terminal?.wantsControl ?? false;

  /** 只有行内的「终端 / 接管」按钮走这里 —— 接管意图只能由这条路产生。 */
  const toggleTerminal = (sessionId: string, wantsControl: boolean) => {
    setTerminal(current => {
      // Re-clicking the same button closes; switching mode or session keeps it
      // open and applies the new intent. 比较用的是 updater 里的**最新**意图，不是
      // 这一帧的闭包快照：onOpenSurface 先调 selectSession 把面板跟过来（并压回只
      // 读），紧接着这次比较必须看到那一步的结果，否则「A 接管中 → 点 B 的接管」会
      // 被误判成同一个按钮的二次点击而把面板关掉。
      if (current && current.sessionId === sessionId && current.wantsControl === wantsControl) return null;
      return { sessionId, wantsControl };
    });
  };

  // Drop the pane if its session vanished during snapshot reconciliation.
  const terminalSession = useMemo(
    () => props.sessions.find(row => row.sessionId === terminalSessionId) ?? null,
    [props.sessions, terminalSessionId],
  );

  const selected = useMemo(
    () => props.sessions.find(session => session.sessionId === selectedSessionId) ?? null,
    [props.sessions, selectedSessionId],
  );
  const selectedHasPreview = !!selected && workbenchPreviewHref(selected) !== null;
  // Web only appears once the session has registered a dev-server port; an
  // always-present tab that opens an empty pane is worse than no tab.
  const mobileSurfaces = useMemo(() => (
    selectedHasPreview
      ? (['workspace', 'preview', 'info'] as const)
      : (['workspace', 'info'] as const)
  ), [selectedHasPreview]);

  const layout = layoutEnvelope.layout;
  const responsive = deriveResponsiveWorkbenchLayout(viewportWidth, layout);
  const chatSplitActive = responsive.chatMode === 'native-split' && layout.chatRequested;
  const forcedRailCollapsed = responsive.railCollapsed;
  const railWidth = forcedRailCollapsed ? WORKBENCH_RAIL_COLLAPSED : layout.railWidth;

  useEffect(() => {
    const changed = previousInitialSessionId.current !== props.initialSessionId;
    previousInitialSessionId.current = props.initialSessionId;
    if (!changed || props.initialSessionId === undefined) return;
    setSelectedSessionId(props.initialSessionId);
  }, [props.initialSessionId]);

  useEffect(() => {
    if (layoutEnvelope.sessionId === selectedSessionId) return;
    setLayoutEnvelope(current => {
      const loaded = selectedSessionId
        ? loadWorkbenchLayout(selectedSessionId, storage)
        : loadWorkbenchLayout('', null);
      return {
        sessionId: selectedSessionId,
        // Everything else comes from the session's own record, but the rail keeps
        // the width and collapsed state it had a moment ago — loading the next
        // session's copy is exactly what made the sidebar jump on every switch.
        layout: {
          ...loaded,
          railWidth: current.layout.railWidth,
          railCollapsed: current.layout.railCollapsed,
        },
      };
    });
  }, [layoutEnvelope.sessionId, selectedSessionId, storage]);

  // Switching to a session without a preview must not strand the user on an
  // empty Web page — fall back to the terminal surface.
  useEffect(() => {
    if (mobilePage === 'preview' && !selectedHasPreview) setMobilePage('workspace');
  }, [mobilePage, selectedHasPreview]);

  useEffect(() => {
    const sessionId = layoutEnvelope.sessionId;
    if (!sessionId) return undefined;
    const layoutSnapshot = layoutEnvelope.layout;
    const timer = setTimeout(() => { saveWorkbenchLayout(sessionId, layoutSnapshot, storage); }, LAYOUT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layoutEnvelope, storage]);

  // Rail geometry is stored once for the window, not per session.
  useEffect(() => {
    const prefs = { railWidth: layout.railWidth, railCollapsed: layout.railCollapsed };
    const timer = setTimeout(() => { saveWorkbenchRailPrefs(storage, prefs); }, LAYOUT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout.railWidth, layout.railCollapsed, storage]);

  // 未读主信号：实时侦测 starting/working/analyzing → idle 的跃迁。
  // 上一帧的状态只存在内存里，所以它只覆盖「页面开着」的这段时间；页面关着时
  // 发生的事由下面 unreadIds 里的活动时间兜底。当前选中的会话不标——你正看着它。
  useEffect(() => {
    const previous = previousStatusRef.current;
    const next = new Map<string, string>();
    const finished: string[] = [];
    for (const session of props.sessions) {
      const sessionId = session.sessionId;
      if (!validWorkbenchSessionId(sessionId)) continue;
      const status = String(session.status ?? '');
      next.set(sessionId, status);
      const before = previous.get(sessionId);
      if (before && BUSY_STATUSES.has(before) && status === 'idle' && sessionId !== selectedSessionId) {
        finished.push(sessionId);
      }
    }
    previousStatusRef.current = next;
    if (finished.length === 0) return;
    const at = nowRef.current;
    setSeenLedger(current => {
      const unread = { ...current.unread };
      for (const sessionId of finished) unread[sessionId] = at;
      return pruneWorkbenchSeenLedger({ seen: current.seen, unread });
    });
  }, [props.sessions, selectedSessionId]);

  useEffect(() => {
    const snapshot = seenLedger;
    const timer = setTimeout(() => { saveWorkbenchSeenLedger(storage, snapshot); }, SEEN_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [seenLedger, storage]);

  /**
   * 两个信号合成最终的未读集合：
   * 1) 状态跃迁（主）：本次会话内侦测到 bot 干完活，unread 比 seen 新。
   * 2) 活动时间（兜底）：`lastMessageAt` 只在**入站**消息（用户/定时/触发器发进来的）
   *    时更新，bot 出站回复不会动它 —— 所以这条抓不到「bot 回复了」，它抓的是
   *    「页面关着的时候这个会话有过新动静」。两条职责不同，缺一不可。
   */
  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of props.sessions) {
      const sessionId = session.sessionId;
      if (!validWorkbenchSessionId(sessionId) || sessionId === selectedSessionId) continue;
      // 已关闭的会话不会再有新回复，和 attentionSummary 的口径保持一致：
      // 否则它会顶着蓝点却待在「最近」组里，点和分组自相矛盾。
      if (session.status === 'closed') continue;
      const seenAt = seenLedger.seen[sessionId];
      const markedAt = seenLedger.unread[sessionId];
      // >= 而不是 >：点开会话时 unread 那条是被删掉的，不会留下陈旧标记，所以同
      // 一毫秒内「刚标未读」和「已读时间」撞上时，按未读算才不会漏提示。
      if (markedAt !== undefined && markedAt >= (seenAt ?? 0)) {
        ids.add(sessionId);
        continue;
      }
      if (sessionActivityAt(session) > (seenAt ?? baselineRef.current)) ids.add(sessionId);
    }
    return ids;
  }, [props.sessions, seenLedger, selectedSessionId]);

  /** 点开即已读。已读时间取 max(本地此刻, 该会话活动时间)：daemon 的钟可能比
   *  浏览器快，直接写本地 now 会让这一行刚点完就又被兜底规则判回未读。 */
  const markSessionSeen = (sessionId: string) => {
    if (!validWorkbenchSessionId(sessionId)) return;
    const session = props.sessions.find(row => row.sessionId === sessionId);
    const at = Math.max(nowRef.current, session ? sessionActivityAt(session) : 0);
    setSeenLedger(current => {
      if (current.seen[sessionId] === at && current.unread[sessionId] === undefined) return current;
      const unread = { ...current.unread };
      delete unread[sessionId];
      return pruneWorkbenchSeenLedger({ seen: { ...current.seen, [sessionId]: at }, unread });
    });
  };

  const changeDimension = (next: WorkbenchGroupDimension) => {
    setDimension(next);
    // 维度是一次显式选择，不像拖拽会连发，直接落盘即可。
    saveWorkbenchGroupDimension(storage, next);
  };

  const updateLayout = (patch: Partial<WorkbenchLayoutState>) => {
    setLayoutEnvelope(current => ({ ...current, layout: nextLayout(current.layout, patch) }));
  };

  const selectSession = (sessionId: string) => {
    // 选中行 = 点开会话，未读在这里清掉。行内的「终端 / 接管」也走 onOpenSurface
    // → selectSession，所以这一处就覆盖了所有会改变选中态的入口。
    markSessionSeen(sessionId);
    setSelectedSessionId(sessionId);
    // The session list is the primary surface — picking a row must not navigate
    // away from it on narrow layouts. Only an explicit surface button moves to
    // the workspace.
    // An already-open terminal follows the selection instead of staying pinned
    // to the previous session —— 但只跟到**只读**。接管意图属于「你在那一行按下
    // 接管」的那个会话，普通选中（行点击 / j-k 键盘选择 / 路由选中）不是要写权限的
    // 表示；让它跟着漂到新会话，就等于替用户对一个他只是点开看看的会话发起接管。
    // 同一个会话内重复选中不动意图：正在接管 A 时点 A 的行不该把自己的写权限收掉。
    setTerminal(current => {
      if (current === null) return null;
      if (current.sessionId === sessionId) return current;
      return { sessionId, wantsControl: false };
    });
    const hash = buildWorkbenchHash('main', sessionId);
    if (props.onRouteChange) props.onRouteChange(hash);
    else if (typeof window !== 'undefined') window.history.replaceState(window.history.state, '', hash);
  };

  const resizeRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    // React nulls currentTarget once the handler returns, so grab the separator now.
    const separator = event.currentTarget;
    // Without capture the pointer slides into the terminal iframe and the moves
    // are delivered to that document instead — the drag simply stops following.
    separator.setPointerCapture?.(event.pointerId);
    const root = rootRef.current;
    root?.classList.add('is-rail-dragging');
    const startX = event.clientX;
    const startWidth = layout.railWidth;
    // Coalesce to one state update per frame: a setState per pointermove re-rendered
    // the whole page and, with the old effect, wrote localStorage on every pixel.
    let pendingX = startX;
    let appliedX = startX;
    let frame = 0;
    const apply = () => {
      frame = 0;
      appliedX = pendingX;
      updateLayout({ railWidth: startWidth + appliedX - startX });
    };
    const move = (next: PointerEvent) => {
      pendingX = next.clientX;
      if (frame === 0) frame = window.requestAnimationFrame(apply);
    };
    const stop = () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      // Land on the last sample even when the pointer came to rest between frames.
      if (pendingX !== appliedX) apply();
      root?.classList.remove('is-rail-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      separator.removeEventListener('lostpointercapture', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    // Losing capture (element detached, browser-cancelled gesture) never reaches
    // pointerup, and the dragging class must come off there too.
    separator.addEventListener('lostpointercapture', stop);
  };

  const railKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    updateLayout({ railWidth: layout.railWidth + (event.key === 'ArrowLeft' ? -8 : 8) });
  };

  const rootKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      rootRef.current?.querySelector<HTMLInputElement>('.wb-session-search input')?.focus();
    }
  };

  const rootStyle = {
    '--wb-rail-width': `${railWidth}px`,
  } as CSSProperties;

  const sessionList = (
    <WorkbenchSessionList
      sessions={props.sessions}
      selectedSessionId={selectedSessionId}
      collapsed={responsive.mode === 'desktop' && forcedRailCollapsed}
      locale={props.locale}
      now={now}
      online={props.online}
      chatFollowNavigates={responsive.mode !== 'mobile'}
      // 桌面和移动两条渲染路径共用这一个 sessionList 常量，未读和维度天然同步。
      unreadIds={unreadIds}
      dimension={dimension}
      onDimensionChange={changeDimension}
      onSeen={markSessionSeen}
      onLocate={sessionId => api.locateSession(sessionId)}
      onSelect={sessionId => {
        selectSession(sessionId);
        // Touch layouts drill in on tap; pointer layouts keep selection and
        // workspace independent so the list stays usable while reading a pane.
        if (responsive.mode === 'mobile') {
          // 钻进工作区是「打开看看」，不是要写权限：手机端一律只读打开。
          setTerminal({ sessionId, wantsControl: false });
          setMobilePage('workspace');
          // Chat is a full-screen page on a phone. Following the selection here
          // would hand the user to Feishu at the same moment they asked to open
          // the workspace — two destinations for one tap. Chat stays an explicit
          // action from the row's own button.
          return;
        }
        // Chat-follow rides the row's own anchor (a trusted click the client
        // honours with the standard panel); nothing to script from here.
      }}
      onOpenSurface={(sessionId, surface) => {
        selectSession(sessionId);
        toggleTerminal(sessionId, surface === 'terminal-control');
        setMobilePage('workspace');
      }}
      onToggleCollapsed={responsive.mode === 'desktop' && responsive.step === 'full'
        ? () => updateLayout({ railCollapsed: !layout.railCollapsed })
        : undefined}
    />
  );

  const workspace = selected ? (
    <section className="wb-workspace" aria-label={`工作台 — ${selected.title || selected.sessionId}`}>
      <header className="wb-workspace-header">
        <div className="wb-workspace-title">
          <span>
            <strong title={String(selected.title || selected.sessionId)}>{String(selected.title || selected.sessionId)}</strong>
            <small>{selected.botName || selected.larkAppId || 'Bot'} · {selected.cliId || '未知'} · {selected.repoName || '无仓库'}</small>
          </span>
        </div>
        <div className="wb-workspace-controls">
          {terminalSession ? (
            <button
              type="button"
              className="wb-layout-level wb-terminal-toggle"
              aria-pressed="true"
              title="关闭终端面板"
              onClick={() => setTerminal(null)}
            >关闭终端 ✕</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-stack">
        {terminalSession ? (
          <TerminalPane
            key={`${terminalSession.sessionId}:${terminalWantsControl ? 'rw' : 'ro'}`}
            session={terminalSession}
            api={api}
            authenticated={props.authenticated}
            now={now}
            location={location}
            autoTakeControl={terminalWantsControl}
          />
        ) : (
          <div className="wb-pane-placeholder" role="status">
            <span aria-hidden="true">›_</span>
            <p>在左侧会话行点击终端图标打开终端</p>
          </div>
        )}
      </div>
    </section>
  ) : (
    <section className="wb-workspace wb-no-selection" aria-live="polite">
      <span aria-hidden="true">⌁</span>
      <h2>{selectedSessionId ? '会话不存在' : '选择一个会话'}</h2>
      <p>{selectedSessionId ? '该会话已结束或被清理' : '从左侧列表选择会话，查看终端或网页预览'}</p>
    </section>
  );

  const mobileContent = mobilePage === 'sessions'
    ? sessionList
    : mobilePage === 'info' && selected
      ? <main className="wb-mobile-info"><WorkbenchInfo session={selected} /></main>
      : workspace;

  return (
    <main
      ref={rootRef}
      className="agent-workbench-page"
      data-surface="appCenter"
      data-responsive-step={responsive.step}
      data-demo={props.demo ? 'true' : undefined}
      style={rootStyle}
      onKeyDown={rootKeyDown}
    >
      {responsive.mode === 'mobile' ? (
        // Drill-down, not tabs. When this page is pinned into Feishu's own
        // mobile tab bar, a second in-page bar would stack two navigations and
        // eat terminal height. The list is the home level; a session pushes a
        // workspace with an explicit back control.
        <div className="wb-mobile-stack">
          {mobilePage === 'sessions' ? sessionList : (
            <div className="wb-mobile-detail">
              <div className="wb-mobile-detail-bar">
                <button type="button" className="wb-mobile-back" onClick={() => setMobilePage('sessions')}>‹ 会话列表</button>
                {selected ? (
                  <span className="wb-mobile-detail-title" title={String(selected.title || selected.sessionId)}>
                    {String(selected.title || selected.sessionId)}
                  </span>
                ) : null}
                <span className="wb-mobile-detail-seg">
                  {mobileSurfaces.map(page => (
                    <button
                      key={page}
                      type="button"
                      aria-current={mobilePage === page ? 'page' : undefined}
                      onClick={() => setMobilePage(page)}
                    >{page === 'workspace' ? '终端' : page === 'preview' ? '网页' : '信息'}</button>
                  ))}
                </span>
              </div>
              {mobilePage === 'info' && selected
                ? <main className="wb-mobile-info"><WorkbenchInfo session={selected} /></main>
                : mobilePage === 'preview' && selected
                  ? (
                    <main className="wb-mobile-preview">
                      <WebPane session={selected} api={api} authenticated={props.authenticated} now={now} />
                    </main>
                  )
                  : workspace}
            </div>
          )}
        </div>
      ) : (
        <div className={`wb-desktop-layout${forcedRailCollapsed ? ' is-rail-collapsed' : ''}${terminalSession ? '' : ' is-terminal-closed'}`}>
          {sessionList}
          {!forcedRailCollapsed ? (
            <button
              type="button"
              className="wb-rail-separator"
              role="separator"
              aria-label="调整列表宽度"
              aria-orientation="vertical"
              aria-valuemin={WORKBENCH_RAIL_MIN}
              aria-valuemax={WORKBENCH_RAIL_MAX}
              aria-valuenow={layout.railWidth}
              onPointerDown={resizeRail}
              onKeyDown={railKeyDown}
            ><span aria-hidden="true">⋮</span></button>
          ) : null}
          {workspace}
        </div>
      )}
    </main>
  );
}
