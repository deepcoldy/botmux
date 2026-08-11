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
  type WorkbenchLayoutState,
  type WorkbenchSessionRow,
  type WorkbenchTerminalLocation,
} from './agent-workbench-model.js';
import { loadWorkbenchLayout, saveWorkbenchLayout, type WorkbenchStorage } from './agent-workbench-storage.js';
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
  if (paneMode === 'split') return chatSplitActive ? 'L3 · PANES + CHAT' : 'L3 · TERMINAL / WEB';
  if (chatSplitActive) return 'L2 · PANE + NATIVE CHAT';
  return 'L1 · FOCUS';
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
  const [layoutEnvelope, setLayoutEnvelope] = useState(() => ({
    sessionId: initial,
    layout: initial ? loadWorkbenchLayout(initial, storage) : loadWorkbenchLayout('', null),
  }));
  const [infoOpen, setInfoOpen] = useState(false);
  const [mobilePage, setMobilePage] = useState<MobilePage>('workspace');
  const [chatFeedback, setChatFeedback] = useState('Native chat is closed.');
  const [chatBusy, setChatBusy] = useState(false);
  const [sdk, setSdk] = useState<FeishuJsApi | null>(props.sdk ?? null);
  const [h5Context, setH5Context] = useState<WorkbenchH5Context | null>(props.h5Context ?? null);
  const rootRef = useRef<HTMLElement | null>(null);
  const previousInitialSessionId = useRef(props.initialSessionId);

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
    setLayoutEnvelope({
      sessionId: selectedSessionId,
      layout: selectedSessionId ? loadWorkbenchLayout(selectedSessionId, storage) : loadWorkbenchLayout('', null),
    });
    setInfoOpen(false);
  }, [layoutEnvelope.sessionId, selectedSessionId, storage]);

  useEffect(() => {
    if (!layoutEnvelope.sessionId) return;
    saveWorkbenchLayout(layoutEnvelope.sessionId, layoutEnvelope.layout, storage);
  }, [layoutEnvelope, storage]);

  useEffect(() => {
    if (props.sdk !== undefined) return undefined;
    let live = true;
    void ensureFeishuJsApi().then(value => { if (live) setSdk(value); });
    return () => { live = false; };
  }, [props.sdk]);

  useEffect(() => {
    if (props.h5Context !== undefined) { setH5Context(props.h5Context); return undefined; }
    const controller = new AbortController();
    void api.getH5Context(controller.signal).then(setH5Context);
    return () => controller.abort();
  }, [api, props.h5Context]);

  const updateLayout = (patch: Partial<WorkbenchLayoutState>) => {
    setLayoutEnvelope(current => ({ ...current, layout: nextLayout(current.layout, patch) }));
  };

  const selectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setMobilePage('workspace');
    const hash = buildWorkbenchHash('main', sessionId);
    if (props.onRouteChange) props.onRouteChange(hash);
    else if (typeof window !== 'undefined') window.history.replaceState(window.history.state, '', hash);
  };

  const openChat = async () => {
    if (!selected?.chatId || chatBusy) return;
    setChatBusy(true);
    setChatFeedback('Opening native chat…');
    try {
      const wasRequested = chatSplitActive;
      const result = await openWorkbenchChat({
        chatId: selected.chatId,
        appLink: selected.feishuChatLink || buildChatAppLink(selected.chatId, h5Context?.brand),
        preferSplit: responsive.chatMode === 'native-split',
        sdk,
        openExternal: url => {
          if (typeof window !== 'undefined') window.location.assign(url);
        },
      });
      if (result.kind === 'native-split') {
        updateLayout({ chatRequested: !wasRequested });
        setChatFeedback(!wasRequested ? 'Native chat is open in the external right slot.' : 'Native chat was toggled closed.');
      } else if (result.kind === 'native-jump') {
        updateLayout({ chatRequested: false });
        setChatFeedback('Chat opened as a native page because split chat is unavailable.');
      } else {
        updateLayout({ chatRequested: false });
        setChatFeedback('Chat opened with an AppLink fallback.');
      }
    } finally {
      setChatBusy(false);
    }
  };

  const resizeRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = layout.railWidth;
    const move = (next: PointerEvent) => updateLayout({ railWidth: startWidth + next.clientX - startX });
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
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
      onSelect={selectSession}
      onToggleCollapsed={responsive.mode === 'desktop' && responsive.step === 'full'
        ? () => updateLayout({ railCollapsed: !layout.railCollapsed })
        : undefined}
    />
  );

  const workspace = selected ? (
    <section className="wb-workspace" aria-label={`Workbench for ${selected.title || selected.sessionId}`}>
      <header className="wb-workspace-header">
        <div className="wb-workspace-title">
          <span className="wb-bot-mark" aria-hidden="true">O</span>
          <span>
            <strong title={String(selected.title || selected.sessionId)}>{String(selected.title || selected.sessionId)}</strong>
            <small>{selected.botName || selected.larkAppId || 'Bot'} · {selected.cliId || 'unknown'} · {selected.repoName || 'no repo'}</small>
          </span>
        </div>
        <div className="wb-layout-level" aria-label={`Layout ${layoutLevel(layout, responsive.paneMode, responsive.chatMode)}`}>
          {layoutLevel(layout, responsive.paneMode, responsive.chatMode)}
        </div>
      </header>
      <nav className="wb-pane-toolbar" aria-label="Workbench layout">
        <div className="wb-toolbar-group" aria-label="Focus pane">
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
        <div className="wb-toolbar-group" aria-label="Split Terminal and Web">
          <button
            type="button"
            className={responsive.paneMode === 'split' && layout.splitAxis === 'horizontal' ? 'is-active' : undefined}
            aria-pressed={responsive.paneMode === 'split' && layout.splitAxis === 'horizontal'}
            disabled={responsive.step === 'focus' || responsive.step === 'chat-jump' || responsive.step === 'mobile-stack'}
            onClick={() => updateLayout({ paneMode: 'split', splitAxis: 'horizontal' })}
          ><span aria-hidden="true">◫</span> Side by side</button>
          <button
            type="button"
            className={responsive.paneMode === 'split' && layout.splitAxis === 'vertical' ? 'is-active' : undefined}
            aria-pressed={responsive.paneMode === 'split' && layout.splitAxis === 'vertical'}
            disabled={responsive.step === 'focus' || responsive.step === 'chat-jump' || responsive.step === 'mobile-stack'}
            onClick={() => updateLayout({ paneMode: 'split', splitAxis: 'vertical' })}
          ><span aria-hidden="true">⬒</span> Top / bottom</button>
        </div>
        <div className="wb-toolbar-spacer" />
        <button type="button" aria-pressed={infoOpen} onClick={() => setInfoOpen(value => !value)}>Info drawer</button>
        <button type="button" className={chatSplitActive ? 'is-active' : undefined} aria-pressed={chatSplitActive} disabled={!selected.chatId || chatBusy} onClick={() => void openChat()}>
          <span aria-hidden="true">▣</span> {responsive.chatMode === 'native-split' ? 'Native chat' : 'Open chat'}
        </button>
      </nav>
      <div className="wb-chat-contract" role="status" aria-live="polite">
        <span className={chatSplitActive ? 'is-open' : undefined} aria-hidden="true">{chatSplitActive ? '◆' : '◇'}</span>
        <strong>{responsive.chatMode === 'native-split' ? 'CHAT · EXTERNAL RIGHT SLOT' : 'CHAT · NATIVE JUMP'}</strong>
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
        onRatioChange={splitRatio => updateLayout({ splitRatio })}
      />
      {responsive.mode === 'desktop' ? <WorkbenchInfoDrawer session={selected} open={infoOpen} onClose={() => setInfoOpen(false)} /> : null}
    </section>
  ) : (
    <section className="wb-workspace wb-no-selection" aria-live="polite">
      <span aria-hidden="true">⌁</span>
      <h2>{selectedSessionId ? 'Session not found' : 'Choose a session'}</h2>
      <p>{selectedSessionId ? 'The selected session disappeared during snapshot reconciliation.' : 'Use the session rail, then inspect Terminal or Web.'}</p>
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
      <header className="wb-app-header">
        <a className="wb-brand" href="#/agent-workbench" aria-label="Orca Workbench home">
          <span aria-hidden="true">◖</span><strong>ORCA</strong><em>/ WORKBENCH</em>
        </a>
        <div className="wb-app-status">
          <span className={props.online ? 'is-online' : 'is-offline'} aria-hidden="true">{props.online ? '●' : '○'}</span>
          <span>{props.online ? 'LIVE' : 'OFFLINE · LAST SNAPSHOT'}</span>
          <span className="wb-degrade-state">{responsive.step.replace('-', ' ').toUpperCase()}</span>
        </div>
      </header>
      {responsive.mode === 'mobile' ? (
        <div className="wb-mobile-stack">
          <nav className="wb-mobile-nav" aria-label="Workbench pages">
            {(['sessions', 'workspace', 'info'] as const).map(page => (
              <button key={page} type="button" aria-current={mobilePage === page ? 'page' : undefined} onClick={() => setMobilePage(page)}>
                {page === 'sessions' ? 'Sessions' : page === 'workspace' ? 'Workspace' : 'Info'}
              </button>
            ))}
          </nav>
          {mobileContent}
        </div>
      ) : (
        <div className={`wb-desktop-layout${forcedRailCollapsed ? ' is-rail-collapsed' : ''}`}>
          {sessionList}
          {!forcedRailCollapsed ? (
            <button
              type="button"
              className="wb-rail-separator"
              role="separator"
              aria-label="Resize session rail"
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
