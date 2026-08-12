import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import {
  clampSplitRatio,
  formatWorkbenchRelativeTime,
  paneTreeForLayout,
  workbenchExternalTerminalHref,
  workbenchPreviewHref,
  workbenchSessionTitle,
  workbenchTerminalHref,
  type WorkbenchLayoutState,
  type WorkbenchPaneKind,
  type WorkbenchPaneTree,
  type WorkbenchSessionRow,
  type WorkbenchTerminalLocation,
} from './agent-workbench-model.js';
import {
  WorkbenchApiError,
  type PreviewInteractionState,
  type TerminalControlState,
  type WorkbenchApi,
} from './agent-workbench-api.js';

interface PaneCommonProps {
  session: WorkbenchSessionRow;
  api: WorkbenchApi;
  authenticated: boolean;
  now: number;
}

function apiErrorText(error: unknown): string {
  if (error instanceof WorkbenchApiError) {
    const known: Record<string, string> = {
      authentication_required: 'Authentication required',
      session_not_active: 'Session is no longer active',
      daemon_offline: 'Owning daemon is offline',
      terminal_unavailable: 'Terminal is unavailable',
      control_busy: 'Another browser controls this terminal',
      preview_not_registered: 'No Web preview is registered',
    };
    return known[error.code] ?? error.code.replaceAll('_', ' ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function TerminalPane(props: PaneCommonProps & { location: WorkbenchTerminalLocation | null }): JSX.Element {
  const [control, setControl] = useState<TerminalControlState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [error, setError] = useState('');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const controlRef = useRef<TerminalControlState | null>(null);
  const requestGeneration = useRef(0);
  const terminalUrl = workbenchTerminalHref(props.session, props.location);
  const externalTerminalUrl = workbenchExternalTerminalHref(props.session);

  const applyControl = useCallback((next: TerminalControlState, reloadOnDowngrade = true) => {
    const previous = controlRef.current;
    controlRef.current = next;
    setControl(next);
    if (reloadOnDowngrade
      && previous?.mode === 'controlled' && previous.owned
      && (next.mode !== 'controlled' || !next.owned)) {
      setFrameGeneration(value => value + 1);
    }
  }, []);

  const refresh = useCallback(async (source: 'load' | 'poll', signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    if (!terminalUrl || externalTerminalUrl) {
      setPhase('ready');
      applyControl({ mode: 'readonly', owned: false });
      return;
    }
    if (source === 'load') setPhase('loading');
    try {
      const next = await props.api.getTerminalControl(props.session.sessionId, signal);
      if (generation !== requestGeneration.current) return;
      applyControl(next);
      setError('');
      setPhase('ready');
    } catch (cause) {
      if (signal?.aborted || generation !== requestGeneration.current) return;
      applyControl({ mode: 'readonly', owned: false });
      setError(apiErrorText(cause));
      setPhase('error');
    }
  }, [applyControl, externalTerminalUrl, props.api, props.session.sessionId, terminalUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh('load', controller.signal);
    const timer = setInterval(() => { void refresh('poll', controller.signal); }, 15_000);
    return () => {
      requestGeneration.current += 1;
      clearInterval(timer);
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (control?.mode !== 'controlled' || !control.owned || !control.expiresAt) return undefined;
    const timer = setTimeout(() => { void refresh('poll'); }, Math.max(0, control.expiresAt - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [control?.expiresAt, control?.mode, control?.owned, refresh]);

  const mutate = async (action: 'takeover' | 'release') => {
    const generation = ++requestGeneration.current;
    setPhase('busy');
    try {
      const next = action === 'takeover'
        ? await props.api.takeoverTerminal(props.session.sessionId)
        : await props.api.releaseTerminal(props.session.sessionId);
      if (generation !== requestGeneration.current) return;
      applyControl(next, false);
      setError('');
      setFrameGeneration(value => value + 1);
      setPhase('ready');
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      applyControl({ mode: 'readonly', owned: false });
      setError(apiErrorText(cause));
      setPhase('error');
    }
  };

  const controlled = control?.mode === 'controlled' && control.owned;
  const status = controlled ? 'CONTROLLED' : 'READ ONLY';
  const expires = controlled && control?.expiresAt
    ? formatWorkbenchRelativeTime(control.expiresAt, props.now)
    : null;

  return (
    <section className="wb-pane wb-terminal-pane" aria-label="Terminal pane">
      <header className="wb-pane-titlebar">
        <div className="wb-pane-identity">
          <span className="wb-pane-glyph" aria-hidden="true">›_</span>
          <strong>TERMINAL</strong>
          <span className={`wb-mode-chip ${controlled ? 'is-controlled' : 'is-readonly'}`}>
            <span aria-hidden="true">{controlled ? '◆' : '◌'}</span>{status}
          </span>
          {expires ? <span className="wb-lease-time">expires {expires}</span> : null}
        </div>
        <div className="wb-pane-actions">
          {terminalUrl ? <a href={terminalUrl} target="_blank" rel="noopener noreferrer">Open tab</a> : null}
          {!externalTerminalUrl && terminalUrl && props.authenticated && !control?.fixed ? (
            controlled
              ? <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('release')}>Release</button>
              : <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('takeover')}>Take control</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-feedback" role="status" aria-live="polite">
        {phase === 'loading' ? 'Checking terminal access…' : error || (control?.fixed
          ? 'Keyboard input is enabled for the authenticated platform owner.'
          : controlled ? 'Keyboard input is enabled for this lease.' : 'Viewing without input permission.')}
      </div>
      <div className="wb-pane-frame-shell">
        {externalTerminalUrl ? (
          <div className="wb-pane-empty">
            <span aria-hidden="true">↗</span>
            <strong>External Riff terminal</strong>
            <p>This backend stays outside the Workbench pane boundary.</p>
            <a href={externalTerminalUrl} target="_blank" rel="noopener noreferrer">Open external terminal</a>
          </div>
        ) : terminalUrl ? (
          <iframe
            key={`${props.session.sessionId}-${frameGeneration}`}
            className="wb-pane-frame"
            src={terminalUrl}
            title={`Terminal — ${workbenchSessionTitle(props.session)}`}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="wb-pane-empty" role="status">
            <span aria-hidden="true">□</span>
            <strong>Terminal unavailable</strong>
            <p>{props.session.status === 'closed' ? 'This session is closed.' : 'The worker has not published a terminal endpoint.'}</p>
          </div>
        )}
      </div>
    </section>
  );
}

const CLOSED_PREVIEW: PreviewInteractionState = {
  mode: 'preview',
  label: 'PREVIEW',
  securityNotice: 'The interaction overlay prevents accidental input; it is not an application security boundary.',
};

export function WebPane(props: PaneCommonProps): JSX.Element {
  const previewPath = workbenchPreviewHref(props.session);
  const [interaction, setInteraction] = useState<PreviewInteractionState>(CLOSED_PREVIEW);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [feedback, setFeedback] = useState('Preview mode is locked.');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const previousMode = useRef<'preview' | 'interactive'>('preview');
  const lastActivityAt = useRef(0);
  const requestGeneration = useRef(0);

  const applyState = useCallback((next: PreviewInteractionState, source: 'load' | 'action' | 'poll') => {
    const was = previousMode.current;
    previousMode.current = next.mode;
    setInteraction(next);
    setPhase('ready');
    if (was === 'interactive' && next.mode === 'preview') {
      setFeedback(source === 'poll' ? 'Relocked after inactivity.' : 'Preview relocked.');
    } else if (next.mode === 'interactive') {
      setFeedback('Interactive mode enabled. Activity extends the 15 minute lease.');
    } else {
      setFeedback('Preview mode is locked.');
    }
  }, []);

  const refresh = useCallback(async (source: 'load' | 'poll', signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    if (!previewPath) {
      setInteraction(CLOSED_PREVIEW);
      setPhase('ready');
      return;
    }
    try {
      const next = await props.api.getPreviewInteraction(props.session.sessionId, signal);
      if (generation !== requestGeneration.current) return;
      applyState(next, source);
    } catch (cause) {
      if (signal?.aborted || generation !== requestGeneration.current) return;
      previousMode.current = 'preview';
      setInteraction(CLOSED_PREVIEW);
      setFeedback(`Relocked safely: ${apiErrorText(cause)}`);
      setPhase('error');
    }
  }, [applyState, previewPath, props.api, props.session.sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('loading');
    void refresh('load', controller.signal);
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void refresh('poll', controller.signal);
    }, 15_000);
    return () => {
      requestGeneration.current += 1;
      clearInterval(timer);
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (interaction.mode !== 'interactive' || !interaction.idleExpiresAt) return undefined;
    const timer = setTimeout(
      () => { void refresh('poll'); },
      Math.max(0, interaction.idleExpiresAt - Date.now()) + 25,
    );
    return () => clearTimeout(timer);
  }, [interaction.idleExpiresAt, interaction.mode, refresh]);

  const mutate = async (action: 'unlock' | 'lock' | 'activity') => {
    const generation = ++requestGeneration.current;
    setPhase('busy');
    try {
      const next = action === 'unlock'
        ? await props.api.unlockPreview(props.session.sessionId)
        : action === 'lock'
          ? await props.api.lockPreview(props.session.sessionId)
          : await props.api.touchPreview(props.session.sessionId);
      if (generation !== requestGeneration.current) return;
      applyState(next, 'action');
      if (action === 'unlock' || action === 'lock') {
        // The same-origin guard shell owns the actual click-blocking overlay.
        // Remount it after an outer titlebar mutation so explicit Lock/Unlock is
        // enforced immediately rather than waiting for its background poll.
        setFrameGeneration(value => value + 1);
      }
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      previousMode.current = 'preview';
      setInteraction(CLOSED_PREVIEW);
      setFeedback(`Relocked safely: ${apiErrorText(cause)}`);
      setPhase('error');
    }
  };

  const noteActivity = (event: SyntheticEvent<HTMLElement>) => {
    if (typeof Element !== 'undefined' && event.target instanceof Element
      && event.target.closest('.wb-pane-titlebar')) return;
    if (interaction.mode !== 'interactive' || Date.now() - lastActivityAt.current < 20_000) return;
    lastActivityAt.current = Date.now();
    void mutate('activity');
  };

  const remaining = interaction.mode === 'interactive' && interaction.idleExpiresAt
    ? formatWorkbenchRelativeTime(interaction.idleExpiresAt, props.now)
    : null;
  const statusLabel = interaction.mode === 'interactive' ? 'INTERACTIVE' : 'PREVIEW';

  return (
    <section className="wb-pane wb-web-pane" aria-label="Web preview pane" onPointerDown={noteActivity} onKeyDown={noteActivity}>
      <header className="wb-pane-titlebar">
        <div className="wb-pane-identity">
          <span className="wb-pane-glyph" aria-hidden="true">◎</span>
          <strong>WEB</strong>
          <span className={`wb-mode-chip ${interaction.mode === 'interactive' ? 'is-interactive' : 'is-preview'}`}>
            <span aria-hidden="true">{interaction.mode === 'interactive' ? '◆' : '◉'}</span>{statusLabel}
          </span>
          {remaining ? <span className="wb-lease-time">relocks {remaining}</span> : null}
        </div>
        <div className="wb-pane-actions">
          {previewPath ? <a href={previewPath} target="_blank" rel="noopener noreferrer">Open tab</a> : null}
          {previewPath && props.authenticated ? (
            interaction.mode === 'interactive'
              ? <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('lock')}>Lock now</button>
              : <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('unlock')}>Enable interaction</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-feedback" role="status" aria-live="polite">
        <strong>{statusLabel}:</strong> {feedback}{' '}
        <span title={interaction.securityNotice}>{interaction.securityNotice}</span>
      </div>
      <div className="wb-pane-frame-shell">
        {previewPath ? (
          <iframe
            key={`${props.session.sessionId}-${frameGeneration}`}
            className="wb-pane-frame"
            src={previewPath}
            data-interaction-generation={frameGeneration}
            title={`Web preview — ${workbenchSessionTitle(props.session)} — ${statusLabel}`}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="wb-pane-empty" role="status">
            <span aria-hidden="true">◎</span>
            <strong>No Web preview registered</strong>
            <p>Run <code>botmux preview &lt;port&gt;</code> inside this session.</p>
          </div>
        )}
      </div>
    </section>
  );
}

interface PaneTreeProps extends PaneCommonProps {
  tree: WorkbenchPaneTree;
  location: WorkbenchTerminalLocation | null;
  onRatioChange(ratio: number): void;
}

function SplitPane(props: PaneTreeProps & { tree: Extract<WorkbenchPaneTree, { type: 'split' }> }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ratio = props.tree.axis === 'horizontal'
        ? (next.clientX - rect.left) / rect.width
        : (next.clientY - rect.top) / rect.height;
      props.onRatioChange(clampSplitRatio(ratio));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  };
  const keyResize = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const negative = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const positive = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!negative && !positive) return;
    event.preventDefault();
    props.onRatioChange(clampSplitRatio(props.tree.ratio + (negative ? -0.04 : 0.04)));
  };
  const splitStyle = {
    '--wb-split-first': `${props.tree.ratio * 100}%`,
    '--wb-split-second': `${(1 - props.tree.ratio) * 100}%`,
  } as CSSProperties;
  const childProps = {
    session: props.session,
    api: props.api,
    authenticated: props.authenticated,
    now: props.now,
    location: props.location,
    onRatioChange: props.onRatioChange,
  };
  return (
    <div ref={rootRef} className={`wb-pane-split is-${props.tree.axis}`} style={splitStyle}>
      <PaneTreeNode tree={props.tree.first} {...childProps} />
      <button
        type="button"
        className="wb-pane-separator"
        role="separator"
        aria-label={`Resize ${props.tree.axis === 'horizontal' ? 'left and right' : 'top and bottom'} panes`}
        aria-orientation={props.tree.axis === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuemin={28}
        aria-valuemax={72}
        aria-valuenow={Math.round(props.tree.ratio * 100)}
        onPointerDown={drag}
        onKeyDown={keyResize}
      ><span aria-hidden="true">⋮</span></button>
      <PaneTreeNode tree={props.tree.second} {...childProps} />
    </div>
  );
}

function PaneTreeNode(props: PaneTreeProps): JSX.Element {
  if (props.tree.type === 'split') return <SplitPane {...props} tree={props.tree} />;
  return props.tree.pane === 'terminal'
    ? <TerminalPane session={props.session} api={props.api} authenticated={props.authenticated} now={props.now} location={props.location} />
    : <WebPane session={props.session} api={props.api} authenticated={props.authenticated} now={props.now} />;
}

export function WorkbenchPaneRegion(props: PaneCommonProps & {
  layout: WorkbenchLayoutState;
  effectivePaneMode: 'focus' | 'split';
  location: WorkbenchTerminalLocation | null;
  onRatioChange(ratio: number): void;
}): JSX.Element {
  const effective = useMemo(
    () => paneTreeForLayout({ ...props.layout, paneMode: props.effectivePaneMode }),
    [props.effectivePaneMode, props.layout],
  );
  return (
    <div className="wb-pane-region" data-pane-mode={props.effectivePaneMode}>
      <PaneTreeNode
        tree={effective}
        session={props.session}
        api={props.api}
        authenticated={props.authenticated}
        now={props.now}
        location={props.location}
        onRatioChange={props.onRatioChange}
      />
    </div>
  );
}

export function WorkbenchInfo(props: { session: WorkbenchSessionRow }): JSX.Element {
  const session = props.session;
  const entries = [
    ['Session', session.sessionId],
    ['Status', session.status],
    ['Bot', session.botName || session.larkAppId || '—'],
    ['CLI', session.cliId || 'unknown'],
    ['Repository', session.repoName || session.workingDir || '—'],
    ['Branch', session.gitBranch || '—'],
    ['Chat', session.chatDisplayName || session.chatId || '—'],
    ['Scope', session.scope || 'thread'],
  ];
  return (
    <div className="wb-info-content">
      <h2>{workbenchSessionTitle(session)}</h2>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={String(value)}>{String(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="wb-info-note">Info is a drawer/page. It is never stored inside the Terminal/Web pane tree.</p>
    </div>
  );
}

export function WorkbenchInfoDrawer(props: { session: WorkbenchSessionRow; open: boolean; onClose(): void }): JSX.Element | null {
  if (!props.open) return null;
  return (
    <aside className="wb-info-drawer" role="dialog" aria-modal="false" aria-labelledby="wb-info-title">
      <header>
        <strong id="wb-info-title">SESSION INFO</strong>
        <button type="button" aria-label="Close session info" onClick={props.onClose}>×</button>
      </header>
      <WorkbenchInfo session={props.session} />
    </aside>
  );
}

export function paneLabel(kind: WorkbenchPaneKind): string {
  return kind === 'terminal' ? 'Terminal' : 'Web';
}
