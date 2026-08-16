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
      authentication_required: '需要登录认证',
      session_not_active: '会话已不再活跃',
      daemon_offline: '所属 daemon 已离线',
      terminal_unavailable: '终端不可用',
      control_busy: '另一个浏览器正在控制该终端',
      preview_not_registered: '未注册网页预览',
    };
    return known[error.code] ?? error.code.replaceAll('_', ' ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** 虚拟布局宽度：保证 TUI 列数，等比缩放贴合手机屏。 */
const VIRTUAL_W = 720;

/** 没有 ResizeObserver（SSR / 老浏览器）时的兜底尺寸：直接按 390 宽算 scale，不抛错。 */
const FALLBACK_FIT = { w: 390, h: 640 };

/** 手机端内嵌终端。iframe 固定按 VIRTUAL_W 宽布局，xterm 由此自适应出够用的列数，
 *  再整体 transform: scale(实际宽 / VIRTUAL_W) 等比缩小贴合容器；高度反向放大
 *  （容器高 / scale），保证缩放后恰好占满，不留白也不溢出。这正是全屏终端页靠
 *  meta viewport 做的事——而 meta viewport 在 iframe 里不生效，只能自己来。
 *  滚动和点击坐标浏览器会按 transform 自动映射，触屏输入无需额外处理。 */
function ScaledTerminalFrame(props: { frameKey: string; src: string; title: string }): JSX.Element {
  const fitRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const node = fitRef.current;
    if (!node) return undefined;
    const update = () => setFit({ w: node.clientWidth || 0, h: node.clientHeight || 0 });
    update();
    // 转屏、分栏拖动都靠它重算 scale；没有 ResizeObserver 就退回上面那次测量。
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const box = fit.w > 0 && fit.h > 0
    ? fit
    : (typeof ResizeObserver === 'undefined' ? FALLBACK_FIT : null);
  const scale = box ? box.w / VIRTUAL_W : 1;
  return (
    <div ref={fitRef} className="wb-pane-frame-fit">
      {/* 量到宽高之前只渲染空占位：scale 未知时挂 iframe 只会先按错误尺寸闪一下。 */}
      {box ? (
        <iframe
          key={props.frameKey}
          className="wb-pane-frame"
          src={props.src}
          title={props.title}
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          style={{
            width: VIRTUAL_W,
            height: Math.round(box.h / scale),
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
          }}
        />
      ) : null}
    </div>
  );
}

export function TerminalPane(props: PaneCommonProps & {
  location: WorkbenchTerminalLocation | null;
  /** Request control as soon as the pane is ready, for the row shortcut that
   *  opens a writable terminal in one click. */
  autoTakeControl?: boolean;
  onAutoTakeControlConsumed?: () => void;
  /** 触屏容器（手机端）改用虚拟宽度等比缩放内嵌终端，见 ScaledTerminalFrame；
   *  标题栏的「新标签页打开」仍然是全屏入口。 */
  handOffToFullScreen?: boolean;
}): JSX.Element {
  const [control, setControl] = useState<TerminalControlState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [error, setError] = useState('');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [viewLink, setViewLink] = useState<string | null>(null);
  const [viewLinkPhase, setViewLinkPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [viewLinkAttempt, setViewLinkAttempt] = useState(0);
  const controlRef = useRef<TerminalControlState | null>(null);
  const requestGeneration = useRef(0);
  const terminalUrl = workbenchTerminalHref(props.session, props.location);
  const externalTerminalUrl = workbenchExternalTerminalHref(props.session);

  // Two ways to authenticate the frame. With a Dashboard cookie the same-origin
  // path is right: it carries the takeover grant, so Release/Take control work.
  // Without one — a Feishu WebView holds no Dashboard cookie — that path 403s,
  // so fall back to the viewToken capability URL the Feishu card already uses.
  // It cannot send input, which is exactly the read-only guarantee we want here.
  // Until that link is in hand the frame stays empty on purpose: the bare
  // same-origin URL without a cookie only ever renders the worker's plain-text
  // "Forbidden" body, which is worse than an honest waiting state.
  useEffect(() => {
    if (props.authenticated || externalTerminalUrl) return undefined;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setViewLink(null);
    setViewLinkPhase('loading');
    void props.api.getTerminalViewLink(props.session.sessionId, controller.signal)
      .then(url => {
        // Every failure — abort included — comes back as null rather than a
        // rejection, so this still runs after cleanup. Never schedule past it.
        if (controller.signal.aborted) return;
        if (url) {
          setViewLink(url);
          setViewLinkPhase('ready');
          return;
        }
        setViewLinkPhase('failed');
        // A missing link usually means the login lapsed or the worker has not
        // registered its terminal yet; both recover without the viewer acting.
        retry = setTimeout(() => setViewLinkAttempt(value => value + 1), 8_000);
      });
    return () => {
      controller.abort();
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [externalTerminalUrl, props.api, props.authenticated, props.session.sessionId, viewLinkAttempt]);

  // Bumping the attempt re-runs the effect above, which cancels any pending
  // auto-retry through its cleanup, so the button cannot stack timers.
  const retryViewLink = useCallback(() => {
    setViewLinkPhase('loading');
    setViewLinkAttempt(value => value + 1);
  }, []);

  const frameUrl = props.authenticated ? terminalUrl : viewLink;

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
    // Without a Dashboard cookie the control API can only 401, and taking over
    // is not on offer anyway — settle into read-only instead of surfacing an
    // authentication error the viewer cannot act on.
    if (!terminalUrl || externalTerminalUrl || !props.authenticated) {
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
  }, [applyControl, externalTerminalUrl, props.api, props.authenticated, props.session.sessionId, terminalUrl]);

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

  // Fires once per session for the "open writable" shortcut. A platform owner
  // (`fixed`) already writes, and an unauthenticated viewer cannot take over at
  // all, so neither needs the request.
  const autoTakeoverDone = useRef<string | null>(null);
  useEffect(() => {
    if (!props.autoTakeControl || !props.authenticated || phase !== 'ready') return;
    if (!control || control.mode !== 'readonly' || control.fixed) return;
    if (autoTakeoverDone.current === props.session.sessionId) return;
    autoTakeoverDone.current = props.session.sessionId;
    props.onAutoTakeControlConsumed?.();
    void mutate('takeover');
  });

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
  const status = controlled ? '可输入' : '只读';
  const expires = controlled && control?.expiresAt
    ? formatWorkbenchRelativeTime(control.expiresAt, props.now, 'zh-CN')
    : null;

  return (
    <section className="wb-pane wb-terminal-pane" aria-label="终端面板">
      <header className="wb-pane-titlebar">
        <div className="wb-pane-identity">
          <span className="wb-pane-glyph" aria-hidden="true">›_</span>
          <strong>终端</strong>
          <span className={`wb-mode-chip ${controlled ? 'is-controlled' : 'is-readonly'}`}>
            <span aria-hidden="true">{controlled ? '◆' : '◌'}</span>{status}
          </span>
          {expires ? <span className="wb-lease-time">{`${expires}到期`}</span> : null}
        </div>
        <div className="wb-pane-actions">
          {frameUrl ? <a href={frameUrl} target="_blank" rel="noopener noreferrer">新标签页打开</a> : null}
          {!externalTerminalUrl && terminalUrl && props.authenticated && !control?.fixed ? (
            controlled
              ? <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('release')}>释放输入</button>
              : <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('takeover')}>接管输入</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-feedback" role="status" aria-live="polite">
        {phase === 'loading' ? '正在检查终端权限…' : error || (control?.fixed
          ? '平台所有者身份已登录，可直接输入。'
          : controlled ? '已接管，可键盘输入。'
            : props.authenticated ? '只读查看中，点「接管输入」可操作。'
              : '只读查看。登录 Dashboard 后可接管。')}
      </div>
      <div className="wb-pane-frame-shell">
        {externalTerminalUrl ? (
          <div className="wb-pane-empty">
            <span aria-hidden="true">↗</span>
            <strong>外部 Riff 终端</strong>
            <p>该后端不在工作台面板内展示。</p>
            <a href={externalTerminalUrl} target="_blank" rel="noopener noreferrer">打开外部终端</a>
          </div>
        ) : frameUrl && props.handOffToFullScreen ? (
          <ScaledTerminalFrame
            frameKey={`${props.session.sessionId}-${frameGeneration}`}
            src={frameUrl}
            title={`终端 — ${workbenchSessionTitle(props.session)}`}
          />
        ) : frameUrl ? (
          <iframe
            key={`${props.session.sessionId}-${frameGeneration}`}
            className="wb-pane-frame"
            src={frameUrl}
            title={`终端 — ${workbenchSessionTitle(props.session)}`}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : !props.authenticated && !externalTerminalUrl && terminalUrl ? (
          // A terminal exists, we just have no credential for it yet. Say so
          // instead of framing a URL that would answer "Forbidden".
          viewLinkPhase === 'failed' ? (
            <div className="wb-pane-empty" role="status">
              <span aria-hidden="true">⚠</span>
              <strong>只读链接获取失败</strong>
              <p>登录态可能已过期，或该会话的终端服务未注册。稍后会自动重试。</p>
              <button type="button" onClick={retryViewLink}>重试</button>
            </div>
          ) : (
            <div className="wb-pane-empty" role="status">
              <span aria-hidden="true">›_</span>
              <strong>正在获取只读终端链接…</strong>
            </div>
          )
        ) : (
          <div className="wb-pane-empty" role="status">
            <span aria-hidden="true">□</span>
            <strong>终端不可用</strong>
            <p>{props.session.status === 'closed' ? '会话已关闭。' : '该会话尚未提供终端入口。'}</p>
          </div>
        )}
      </div>
    </section>
  );
}

const CLOSED_PREVIEW: PreviewInteractionState = {
  mode: 'preview',
  label: '预览',
  securityNotice: '交互遮罩用于防误触，不是应用级安全边界。',
};

export function WebPane(props: PaneCommonProps): JSX.Element {
  const previewPath = workbenchPreviewHref(props.session);
  const [interaction, setInteraction] = useState<PreviewInteractionState>(CLOSED_PREVIEW);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [feedback, setFeedback] = useState('预览模式已锁定。');
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
      setFeedback(source === 'poll' ? '长时间无操作，已重新锁定。' : '已重新锁定。');
    } else if (next.mode === 'interactive') {
      setFeedback('已开启交互，持续操作自动续期（15 分钟）。');
    } else {
      setFeedback('预览模式已锁定。');
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
      setFeedback(`已安全锁定：${apiErrorText(cause)}`);
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
      setFeedback(`已安全锁定：${apiErrorText(cause)}`);
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
    ? formatWorkbenchRelativeTime(interaction.idleExpiresAt, props.now, 'zh-CN')
    : null;
  const statusLabel = interaction.mode === 'interactive' ? '可交互' : '预览';

  return (
    <section className="wb-pane wb-web-pane" aria-label="网页预览面板" onPointerDown={noteActivity} onKeyDown={noteActivity}>
      <header className="wb-pane-titlebar">
        <div className="wb-pane-identity">
          <span className="wb-pane-glyph" aria-hidden="true">◎</span>
          <strong>网页</strong>
          <span className={`wb-mode-chip ${interaction.mode === 'interactive' ? 'is-interactive' : 'is-preview'}`}>
            <span aria-hidden="true">{interaction.mode === 'interactive' ? '◆' : '◉'}</span>{statusLabel}
          </span>
          {remaining ? <span className="wb-lease-time">{`${remaining}重新锁定`}</span> : null}
        </div>
        <div className="wb-pane-actions">
          {previewPath ? <a href={previewPath} target="_blank" rel="noopener noreferrer">新标签页打开</a> : null}
          {previewPath && props.authenticated ? (
            interaction.mode === 'interactive'
              ? <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('lock')}>立即锁定</button>
              : <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('unlock')}>开启交互</button>
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
            title={`网页预览 — ${workbenchSessionTitle(props.session)} — ${statusLabel}`}
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="wb-pane-empty" role="status">
            <span aria-hidden="true">◎</span>
            <strong>未注册网页预览</strong>
            <p>在该会话内运行 <code>botmux preview &lt;端口&gt;</code> 注册预览。</p>
          </div>
        )}
      </div>
    </section>
  );
}

interface PaneTreeProps extends PaneCommonProps {
  tree: WorkbenchPaneTree;
  location: WorkbenchTerminalLocation | null;
  autoTakeControl?: boolean;
  scaleTerminal?: boolean;
  onAutoTakeControlConsumed?: () => void;
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
    autoTakeControl: props.autoTakeControl,
    scaleTerminal: props.scaleTerminal,
    onAutoTakeControlConsumed: props.onAutoTakeControlConsumed,
    onRatioChange: props.onRatioChange,
  };
  return (
    <div ref={rootRef} className={`wb-pane-split is-${props.tree.axis}`} style={splitStyle}>
      <PaneTreeNode tree={props.tree.first} {...childProps} />
      <button
        type="button"
        className="wb-pane-separator"
        role="separator"
        aria-label={props.tree.axis === 'horizontal' ? '调整左右面板' : '调整上下面板'}
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
    ? <TerminalPane
        session={props.session}
        api={props.api}
        authenticated={props.authenticated}
        now={props.now}
        location={props.location}
        autoTakeControl={props.autoTakeControl}
        handOffToFullScreen={props.scaleTerminal}
        onAutoTakeControlConsumed={props.onAutoTakeControlConsumed}
      />
    : <WebPane session={props.session} api={props.api} authenticated={props.authenticated} now={props.now} />;
}

export function WorkbenchPaneRegion(props: PaneCommonProps & {
  layout: WorkbenchLayoutState;
  effectivePaneMode: 'focus' | 'split';
  location: WorkbenchTerminalLocation | null;
  autoTakeControl?: boolean;
  scaleTerminal?: boolean;
  onAutoTakeControlConsumed?: () => void;
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
        autoTakeControl={props.autoTakeControl}
        scaleTerminal={props.scaleTerminal}
        onAutoTakeControlConsumed={props.onAutoTakeControlConsumed}
        onRatioChange={props.onRatioChange}
      />
    </div>
  );
}

export function WorkbenchInfo(props: { session: WorkbenchSessionRow }): JSX.Element {
  const session = props.session;
  const entries = [
    ['会话 ID', session.sessionId],
    ['状态', session.status],
    ['机器人', session.botName || session.larkAppId || '—'],
    ['CLI', session.cliId || 'unknown'],
    ['仓库', session.repoName || session.workingDir || '—'],
    ['分支', session.gitBranch || '—'],
    ['群聊', session.chatDisplayName || session.chatId || '—'],
    ['范围', session.scope || 'thread'],
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
    </div>
  );
}

export function WorkbenchInfoDrawer(props: { session: WorkbenchSessionRow; open: boolean; onClose(): void }): JSX.Element | null {
  if (!props.open) return null;
  return (
    <aside className="wb-info-drawer" role="dialog" aria-modal="false" aria-labelledby="wb-info-title">
      <header>
        <strong id="wb-info-title">会话信息</strong>
        <button type="button" aria-label="关闭会话信息" onClick={props.onClose}>×</button>
      </header>
      <WorkbenchInfo session={props.session} />
    </aside>
  );
}

export function paneLabel(kind: WorkbenchPaneKind): string {
  return kind === 'terminal' ? '终端' : '网页';
}
