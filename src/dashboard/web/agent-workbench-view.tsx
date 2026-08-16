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
  type WorkbenchGroupDimension,
  type WorkbenchLayoutState,
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
import {
  buildChatAppLink,
  ensureFeishuJsApi,
  openWorkbenchChat,
  type FeishuJsApi,
  type WorkbenchH5Context,
} from './agent-workbench-chat.js';
import { createWorkbenchApi, type WorkbenchApi } from './agent-workbench-api.js';
import { WorkbenchSessionList } from './agent-workbench-session-list.js';
import {
  WorkbenchInfo,
  WorkbenchInfoDrawer,
  WorkbenchPaneRegion,
  paneLabel,
} from './agent-workbench-panes.js';

export interface AgentWorkbenchViewProps {
  sessions: readonly WorkbenchSessionRow[];
  online: boolean;
  authenticated: boolean;
  /** Sending a locate marker mutates Feishu and therefore remains a legacy
   *  Dashboard-owner action, outside the narrow H5/platform capability set. */
  canLocate?: boolean;
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

type MobilePage = 'sessions' | 'workspace' | 'info';

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

function layoutLevel(
  layout: WorkbenchLayoutState,
  paneMode: 'focus' | 'split',
  chatMode: 'native-split' | 'jump',
): string {
  const chatSplitActive = chatMode === 'native-split' && layout.chatRequested;
  if (paneMode === 'split') return chatSplitActive ? 'L3 · 面板 + 聊天' : 'L3 · 终端 / 网页';
  if (chatSplitActive) return 'L2 · 面板 + 原生聊天';
  return 'L1 · 专注';
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
  const [mobilePage, setMobilePage] = useState<MobilePage>('sessions');
  const [infoOpen, setInfoOpen] = useState(false);
  const [chatFeedback, setChatFeedback] = useState('原生聊天尚未打开。');
  const [chatBusy, setChatBusy] = useState(false);
  const [sdk, setSdk] = useState<FeishuJsApi | null>(props.sdk ?? null);
  const [h5Context, setH5Context] = useState<WorkbenchH5Context | null>(props.h5Context ?? null);
  const [autoTakeControlSessionId, setAutoTakeControlSessionId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const previousInitialSessionId = useRef(props.initialSessionId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
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

  const selected = useMemo(
    () => props.sessions.find(session => session.sessionId === selectedSessionId) ?? null,
    [props.sessions, selectedSessionId],
  );

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
    setInfoOpen(false);
    setAutoTakeControlSessionId(null);
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

  useEffect(() => {
    if (props.h5Context !== undefined) {
      setH5Context(props.h5Context);
      return undefined;
    }
    const controller = new AbortController();
    void api.getH5Context(controller.signal).then(setH5Context);
    return () => controller.abort();
  }, [api, props.h5Context]);

  useEffect(() => {
    if (props.sdk !== undefined) {
      setSdk(props.sdk);
      return undefined;
    }
    if (!h5Context?.enabled) {
      setSdk(null);
      return undefined;
    }
    let live = true;
    void ensureFeishuJsApi().then(value => { if (live) setSdk(value); });
    return () => { live = false; };
  }, [h5Context?.enabled, props.sdk]);

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

  const activateSession = (
    sessionId: string,
    patch?: Partial<WorkbenchLayoutState>,
  ) => {
    markSessionSeen(sessionId);
    setSelectedSessionId(sessionId);
    setInfoOpen(false);
    setAutoTakeControlSessionId(null);
    setMobilePage('workspace');
    setLayoutEnvelope(current => {
      const loaded = current.sessionId === sessionId
        ? current.layout
        : {
            ...loadWorkbenchLayout(sessionId, storage),
            railWidth: current.layout.railWidth,
            railCollapsed: current.layout.railCollapsed,
          };
      return {
        sessionId,
        layout: patch ? nextLayout(loaded, patch) : loaded,
      };
    });
    const hash = buildWorkbenchHash('main', sessionId);
    if (props.onRouteChange) props.onRouteChange(hash);
    else if (typeof window !== 'undefined') window.history.replaceState(window.history.state, '', hash);
  };

  const openChat = async (session: WorkbenchSessionRow | null = selected) => {
    if (!session?.chatId || chatBusy) return;
    const sessionId = session.sessionId;
    const wasRequested = layoutEnvelope.sessionId === sessionId && chatSplitActive;
    setChatBusy(true);
    setChatFeedback('正在打开原生聊天…');
    try {
      const result = await openWorkbenchChat({
        chatId: session.chatId,
        appLink: session.feishuChatLink || buildChatAppLink(session.chatId, h5Context?.brand),
        preferSplit: responsive.chatMode === 'native-split',
        nativeEnabled: props.sdk !== undefined || h5Context?.enabled === true,
        sdk,
        openExternal: url => {
          if (typeof window !== 'undefined') window.location.assign(url);
        },
      });
      if (selectedSessionIdRef.current !== sessionId) return;
      if (result.kind === 'native-split') {
        updateLayout({ chatRequested: !wasRequested });
        setChatFeedback(!wasRequested ? '原生聊天已在飞书右侧槽位打开。' : '原生聊天已关闭。');
      } else if (result.kind === 'native-jump') {
        updateLayout({ chatRequested: false });
        setChatFeedback('分栏不可用，已跳转到飞书原生聊天。');
      } else {
        updateLayout({ chatRequested: false });
        setChatFeedback('JSAPI 不可用，已使用 AppLink 打开聊天。');
      }
    } catch (error) {
      if (selectedSessionIdRef.current === sessionId) {
        setChatFeedback(`聊天打开失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setChatBusy(false);
    }
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
    if (event.key === 'Escape' && infoOpen) {
      event.preventDefault();
      setInfoOpen(false);
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
      // 桌面和移动两条渲染路径共用这一个 sessionList 常量，未读和维度天然同步。
      unreadIds={unreadIds}
      dimension={dimension}
      onDimensionChange={changeDimension}
      onSeen={markSessionSeen}
      onLocate={props.canLocate
        ? sessionId => api.locateSession(sessionId)
        : undefined}
      onSelect={activateSession}
      onOpenSurface={(sessionId, surface) => {
        const session = props.sessions.find(row => row.sessionId === sessionId) ?? null;
        if (surface === 'chat') {
          activateSession(sessionId);
          void openChat(session);
          return;
        }
        activateSession(sessionId, { focus: 'terminal', paneMode: 'focus' });
        setAutoTakeControlSessionId(surface === 'terminal-control' ? sessionId : null);
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
          <span className="wb-bot-mark" aria-hidden="true">B</span>
          <span>
            <strong title={String(selected.title || selected.sessionId)}>{String(selected.title || selected.sessionId)}</strong>
            <small>{selected.botName || selected.larkAppId || 'Bot'} · {selected.cliId || '未知'} · {selected.repoName || '无仓库'}</small>
          </span>
        </div>
        <div
          className="wb-layout-level"
          aria-label={`布局 ${layoutLevel(layout, responsive.paneMode, responsive.chatMode)}`}
        >
          {layoutLevel(layout, responsive.paneMode, responsive.chatMode)}
        </div>
      </header>
      <nav className="wb-pane-toolbar" aria-label="工作台布局">
        <div className="wb-toolbar-group" aria-label="专注面板">
          {(['terminal', 'web'] as const).map(kind => (
            <button
              key={kind}
              type="button"
              className={responsive.paneMode === 'focus' && layout.focus === kind ? 'is-active' : undefined}
              aria-pressed={responsive.paneMode === 'focus' && layout.focus === kind}
              onClick={() => updateLayout({ focus: kind, paneMode: 'focus' })}
            >{paneLabel(kind)}</button>
          ))}
        </div>
        <div className="wb-toolbar-group" aria-label="终端与网页分屏">
          <button
            type="button"
            className={responsive.paneMode === 'split' && layout.splitAxis === 'horizontal' ? 'is-active' : undefined}
            aria-pressed={responsive.paneMode === 'split' && layout.splitAxis === 'horizontal'}
            disabled={responsive.step === 'focus' || responsive.step === 'chat-jump' || responsive.step === 'mobile-stack'}
            onClick={() => updateLayout({ paneMode: 'split', splitAxis: 'horizontal' })}
          ><span aria-hidden="true">◫</span> 左右</button>
          <button
            type="button"
            className={responsive.paneMode === 'split' && layout.splitAxis === 'vertical' ? 'is-active' : undefined}
            aria-pressed={responsive.paneMode === 'split' && layout.splitAxis === 'vertical'}
            disabled={responsive.step === 'focus' || responsive.step === 'chat-jump' || responsive.step === 'mobile-stack'}
            onClick={() => updateLayout({ paneMode: 'split', splitAxis: 'vertical' })}
          ><span aria-hidden="true">⬒</span> 上下</button>
        </div>
        <div className="wb-toolbar-spacer" />
        <button
          type="button"
          aria-pressed={responsive.mode === 'mobile' ? mobilePage === 'info' : infoOpen}
          onClick={() => {
            if (responsive.mode === 'mobile') setMobilePage('info');
            else setInfoOpen(value => !value);
          }}
        >{responsive.mode === 'mobile' ? '信息' : '信息抽屉'}</button>
        <button
          type="button"
          className={chatSplitActive ? 'is-active' : undefined}
          aria-pressed={chatSplitActive}
          disabled={!selected.chatId || chatBusy}
          onClick={() => void openChat()}
        >
          <span aria-hidden="true">▣</span> {responsive.chatMode === 'native-split' ? '原生聊天' : '打开聊天'}
        </button>
      </nav>
      <div className="wb-chat-contract" role="status" aria-live="polite">
        <span className={chatSplitActive ? 'is-open' : undefined} aria-hidden="true">{chatSplitActive ? '◆' : '◇'}</span>
        <strong>{responsive.chatMode === 'native-split' ? '聊天 · 飞书外部右侧槽位' : '聊天 · 原生跳转'}</strong>
        <span>{chatFeedback}</span>
      </div>
      <WorkbenchPaneRegion
        key={selected.sessionId}
        session={selected}
        api={api}
        authenticated={props.authenticated}
        now={now}
        layout={layout}
        effectivePaneMode={responsive.paneMode}
        location={location}
        autoTakeControl={autoTakeControlSessionId === selected.sessionId}
        scaleTerminal={responsive.mode === 'mobile'}
        onAutoTakeControlConsumed={() => setAutoTakeControlSessionId(null)}
        onRatioChange={splitRatio => updateLayout({ splitRatio })}
      />
      {responsive.mode === 'desktop'
        ? <WorkbenchInfoDrawer session={selected} open={infoOpen} onClose={() => setInfoOpen(false)} />
        : null}
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
        <div className="wb-mobile-stack">
          {mobileContent}
          <nav className="wb-mobile-nav" aria-label="工作台页面">
            {(['sessions', 'workspace', 'info'] as const).map(page => (
              <button
                key={page}
                type="button"
                aria-current={mobilePage === page ? 'page' : undefined}
                onClick={() => setMobilePage(page)}
              >{page === 'sessions' ? '会话' : page === 'workspace' ? '工作区' : '信息'}</button>
            ))}
          </nav>
        </div>
      ) : (
        <div className={`wb-desktop-layout${forcedRailCollapsed ? ' is-rail-collapsed' : ''}`}>
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
