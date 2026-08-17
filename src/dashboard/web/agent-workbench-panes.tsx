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
import type { WorkbenchCapabilities } from './agent-workbench-capabilities.js';
// 触屏鉴权契约只有一份实现，终端面板和会话坞共用（P1-17）。
import { useTerminalViewLink, useTouchEnvironment } from './agent-workbench-touch.js';

interface PaneCommonProps {
  session: WorkbenchSessionRow;
  api: WorkbenchApi;
  authenticated: boolean;
  /** P1-4：服务端投影的最小操作能力集。`authenticated` 继续决定观察级链路
   *  （同源 iframe vs viewToken、控制权状态拉取）；写操作入口各看自己的布尔：
   *  终端「接管输入/释放输入」看 canControl，Preview「开启交互/立即锁定」看
   *  canInteract。触屏只读限制是叠加在这之上的，不是替换。 */
  capabilities: WorkbenchCapabilities;
  now: number;
}

/** 终端 iframe 内部实时通道的一次读数。`unknown` 表示读不出来（跨域、时序、状态
 *  节点还没渲染出来），一律不作数：宁可不提示，也不要在连接其实正常的浏览器上盖一层
 *  假警告。 */
export type TerminalFrameStatus = 'connected' | 'disconnected' | 'unknown';

/** 生产实现。终端页和工作台同源（都挂在 /s/<id> 前置代理下），所以可以直接读它右下角
 *  那个 #status 节点——'connected' / 'disconnected' 是终端页自己的 WebSocket 回调写进去
 *  的，比任何外部探测都准。跨域或时序异常时读取会抛，按未知处理。 */
export function readTerminalFrameStatus(frame: HTMLIFrameElement | null): TerminalFrameStatus {
  try {
    const text = frame?.contentWindow?.document?.getElementById('status')?.textContent?.trim();
    if (text === 'connected') return 'connected';
    if (text === 'disconnected') return 'disconnected';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const FRAME_STATUS_POLL_MS = 1_000;
/** 连续 8 拍（≈8 秒）都是 disconnected 才提示。终端页自己每 2 秒重连一次，正常网络下
 *  一两拍就连上了；8 秒还连不上，基本可以断定是这个浏览器环境拦掉了 ws://。 */
const FRAME_STATUS_BLOCK_TICKS = 8;

/** 盯着终端 iframe 内部的实时通道：iframe 明明加载出来了、里面却长时间连不上时，
 *  给外层一个 blocked 信号去盖提示层。iframe 本身不卸载，连上后提示自动撤掉。 */
function useTerminalFrameWatch(params: {
  enabled: boolean;
  /** 换会话就把本轮结论清空；同一会话内 iframe 重挂（接管/释放触发的 reload）不算换环境。 */
  sessionId: string;
  /** 当前这块 iframe 的身份。只有它自己报过 load 才开始轮询，避免拿上一块的结论套新的。 */
  frameKey: string;
  read(): TerminalFrameStatus;
}): { blocked: boolean; onFrameLoad?: () => void } {
  const { enabled, frameKey, sessionId } = params;
  const [blocked, setBlocked] = useState(false);
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  // 连上过一次就永久收手：环境本身没问题，之后的闪断交给终端页自己的重连，不再打扰。
  const connectedRef = useRef(false);
  const readRef = useRef(params.read);
  // 每渲染刷新一次读数源，轮询时从 ref 取最新实现。把它写进依赖会让定时器每次渲染重
  // 建，8 秒的连续计数就永远攒不满了。
  useEffect(() => { readRef.current = params.read; });

  useEffect(() => {
    connectedRef.current = false;
    setBlocked(false);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || connectedRef.current || loadedFrameKey !== frameKey) return undefined;
    let streak = 0;
    const timer = setInterval(() => {
      const status = readRef.current();
      if (status === 'connected') {
        connectedRef.current = true;
        setBlocked(false);
        clearInterval(timer);
        return;
      }
      // unknown 既不累计也不撤下已经显示的提示：读不到不等于连上了。
      if (status !== 'disconnected') {
        streak = 0;
        return;
      }
      streak += 1;
      if (streak >= FRAME_STATUS_BLOCK_TICKS) setBlocked(true);
    }, FRAME_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, frameKey, loadedFrameKey]);

  const onFrameLoad = useCallback(() => setLoadedFrameKey(frameKey), [frameKey]);
  return { blocked: enabled && blocked, onFrameLoad: enabled ? onFrameLoad : undefined };
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

export function TerminalPane(props: PaneCommonProps & {
  location: WorkbenchTerminalLocation | null;
  /** Request control as soon as the pane is ready, for the row shortcut that
   *  opens a writable terminal in one click. */
  autoTakeControl?: boolean;
  /** 测试注入点：组件测试环境里没有真 iframe 的 internals，注入一个假的读数源即可。
   *  生产默认走同源 contentWindow（`readTerminalFrameStatus`）。 */
  readFrameStatus?: (frame: HTMLIFrameElement | null) => TerminalFrameStatus;
}): JSX.Element {
  const [control, setControl] = useState<TerminalControlState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [error, setError] = useState('');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const controlRef = useRef<TerminalControlState | null>(null);
  const requestGeneration = useRef(0);
  const terminalUrl = workbenchTerminalHref(props.session, props.location);
  const externalTerminalUrl = workbenchExternalTerminalHref(props.session);
  // 触屏和桌面在鉴权方式上彻底分道，详见下面那段注释。
  const touch = useTouchEnvironment();

  // 给 iframe 鉴权有两条路，选哪条不看登录态，看的是「这个浏览器发 WebSocket 时带不带
  // Cookie」：
  // - 桌面登录态 → 同源 /s/<id>。Cookie 带得过去，而且它捎带接管授权，接管/释放才有意义。
  // - 触屏（iOS WebView，飞书内嵌浏览器同理）→ 必须换成带 ?viewToken= 查询参数的能力
  //   地址。**iOS WebView 发起 WebSocket 升级时不携带 Cookie**，所以同源地址即使页面本身
  //   能加载（HTTP 请求带 Cookie），紧接着的 WS 握手也会被 403 掉，终端页永远停在
  //   disconnected、整片空白。viewToken 把凭证放在 URL 查询参数里，与 Cookie 无关，无
  //   Cookie 也能升级成功——旧版飞书卡片给的就是这条链接，「以前手机上是好用的」正是
  //   这个原因。代价是这条通道只读，所以触屏下接管按钮一并隐藏。
  // - 未登录（飞书 WebView 里没有 Dashboard Cookie）→ 同样只能走 viewToken。
  // 因此这里的取链条件是「非外部终端，且（触屏 或 未登录）」；登录态下拉 view-link 走的是
  // 普通 HTTP fetch，Cookie 正常带得上，iOS 也拿得到。
  // 链接到手之前 iframe 故意留空：没有 Cookie 的裸同源地址只会渲染出 worker 的
  // "Forbidden" 纯文本，比一个诚实的等待态更糟。
  // 取链本身（重试、到期前换链、换会话清空）住在 agent-workbench-touch，会话坞用的是
  // 同一个 hook——同一份触屏契约不能有第二种实现（P1-17）。
  const {
    link: viewLink,
    phase: viewLinkPhase,
    retry: retryViewLink,
  } = useTerminalViewLink({
    api: props.api,
    sessionId: props.session.sessionId,
    enabled: !externalTerminalUrl && (touch || !props.authenticated),
  });

  // 触屏没有裸回退：viewLink 还没到手就让空态顶着，绝不退回同源地址——那条路在 iOS 上
  // 必然是黑屏（WS 不带 Cookie，握手被 403），显示出来只会让人以为是终端坏了。
  const viewLinkUrl = viewLink ? viewLink.url : null;
  const frameUrl = !externalTerminalUrl && touch
    ? viewLinkUrl
    : props.authenticated ? terminalUrl : viewLinkUrl;

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
  // all, so neither needs the request. 触屏也跳过：那边的 iframe 走 viewToken 只读通道，
  // 抢来的写权限自己用不上，反而会把别人电脑上的输入权顶掉。canControl=false 的
  // 身份（平台 teammate/guest 等）同样跳过——那个 POST 只会 403（P1-4）。
  const autoTakeoverDone = useRef<string | null>(null);
  useEffect(() => {
    if (!props.autoTakeControl || !props.authenticated || !props.capabilities.canControl
      || touch || phase !== 'ready') return;
    if (!control || control.mode !== 'readonly' || control.fixed) return;
    if (autoTakeoverDone.current === props.session.sessionId) return;
    autoTakeoverDone.current = props.session.sessionId;
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

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameKey = `${props.session.sessionId}-${frameGeneration}`;
  const readFrameStatus = props.readFrameStatus ?? readTerminalFrameStatus;
  const frameWatch = useTerminalFrameWatch({
    enabled: touch,
    sessionId: props.session.sessionId,
    frameKey,
    read: () => readFrameStatus(frameRef.current),
  });

  // 触屏挂的是 viewToken 只读通道：控制权接口哪怕报「已接管」或平台所有者（fixed），这块
  // iframe 也送不进输入，徽标必须跟着说只读，否则和下面那行反馈自相矛盾。
  const controlled = !touch && control?.mode === 'controlled' && control.owned;
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
          {/* 触屏不给接管按钮：那边挂的是 viewToken 只读通道，接管到手也送不进输入，
              摆出来只会让人反复点。canControl=false（平台 teammate/guest 等）同样不给：
              那个入口点了只会 403（P1-4，服务端投影的最小能力集）。 */}
          {!externalTerminalUrl && terminalUrl && props.authenticated
            && props.capabilities.canControl && !touch && !control?.fixed ? (
            controlled
              ? <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('release')}>释放输入</button>
              : <button type="button" disabled={phase === 'busy'} onClick={() => void mutate('takeover')}>接管输入</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-feedback" role="status" aria-live="polite">
        {/* 触屏一句话说死，登录与否都一样：这块 iframe 挂的是 viewToken 只读通道，控制权
            接口报什么都改变不了这个事实，转述它反而误导。 */}
        {touch ? '只读查看中。手机端为只读视图，需要输入请在电脑上操作。'
          : phase === 'loading' ? '正在检查终端权限…' : error || (control?.fixed
            ? '平台所有者身份已登录，可直接输入。'
            : controlled ? '已接管，可键盘输入。'
              // 没有接管能力的身份别劝人去点一个根本没渲染的按钮。
              : props.authenticated && props.capabilities.canControl ? '只读查看中，点「接管输入」可操作。'
                : props.authenticated ? '只读查看中，当前身份不可接管输入。'
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
        ) : frameUrl ? (
          <>
            {/* 手机端和桌面走同一条直嵌路径，不做任何 transform 缩放：iOS WKWebView 对被
                缩放的 iframe 内 canvas/WebGL 有不渲染的合成缺陷，终端会整片空白。终端页
                自身会按 iframe 的实际宽度 fit 出列数，窄屏直嵌即可正常显示。 */}
            <iframe
              key={frameKey}
              ref={frameRef}
              className="wb-pane-frame"
              src={frameUrl}
              title={`终端 — ${workbenchSessionTitle(props.session)}`}
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
              onLoad={frameWatch.onFrameLoad}
            />
            {/* iframe 加载得出来、里面的实时通道却始终连不上（iOS 会拦掉 http 页里的
                ws://）。这时终端区域只会是一片黑，与其让人对着黑屏猜，不如直说，并给一条
                能自己走通的路。覆盖层盖在 iframe 上而不是替换它：页面自身一直在重连，
                连上后这层会自动撤掉。 */}
            {frameWatch.blocked ? (
              <div className="wb-pane-empty wb-ws-blocked" role="status">
                <span aria-hidden="true">⚠</span>
                <strong>终端实时连接未建立</strong>
                <p>当前浏览器环境限制了非加密的实时连接（iOS 内常见）。可尝试用系统浏览器打开，或在电脑上查看。</p>
                <a href={frameUrl} target="_blank" rel="noopener">在浏览器中打开</a>
                <p>飞书内可通过右上角 ⋯ 菜单选择「在浏览器打开」。</p>
              </div>
            ) : null}
          </>
        ) : (touch || !props.authenticated) && !externalTerminalUrl && terminalUrl ? (
          // A terminal exists, we just have no credential for it yet. Say so
          // instead of framing a URL that would answer "Forbidden". 触屏即使已登录也走
          // 这里：它等的是 viewToken 链接，同源地址对它等同于没有凭证。
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
          {/* canInteract=false（平台 teammate/guest 等）不渲染解锁入口：那个 POST
              只会 403（P1-4）。只读身份仍可看预览，遮罩保持锁定态。 */}
          {previewPath && props.authenticated && props.capabilities.canInteract ? (
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
    capabilities: props.capabilities,
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
    ? <TerminalPane session={props.session} api={props.api} authenticated={props.authenticated} capabilities={props.capabilities} now={props.now} location={props.location} />
    : <WebPane session={props.session} api={props.api} authenticated={props.authenticated} capabilities={props.capabilities} now={props.now} />;
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
        capabilities={props.capabilities}
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
