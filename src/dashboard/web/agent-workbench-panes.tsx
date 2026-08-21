import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
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
// 控制权只有一份状态机（面板侧 + 外层意图），见该文件头部的注释。
import {
  WORKBENCH_TERM_WRITE_MESSAGE,
  claimTerminalWrite,
  hasLiveTerminalWriteClaim,
  initialTerminalControlModel,
  terminalControlBusy,
  terminalControlMode,
  terminalControlNeedsMask,
  terminalControlReducer,
  terminalControlSettled,
  type TerminalPaneControlMode,
  type TerminalWriteAction,
} from './agent-workbench-terminal-control.js';
import type { WorkbenchCapabilities } from './agent-workbench-capabilities.js';
// 触屏鉴权契约只有一份实现，终端面板和会话坞共用（P1-17）。
import { useTerminalViewLink, useTouchEnvironment } from './agent-workbench-touch.js';
import {
  postWorkbenchTermAppearance,
  workbenchTermCanvasStyle,
  workbenchTermContainerClass,
} from './agent-workbench-appearance.js';
import {
  WorkbenchTermStyleSegment,
  useWorkbenchAppearance,
} from './agent-workbench-appearance-menu.js';

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

/** 终端页自己算出来的写权限。`unknown` = 读不出来（跨域、页面还没跑到那一行）。 */
export type TerminalFrameWrite = 'writable' | 'readonly' | 'unknown';

/**
 * 生产实现：读终端页自己的两个全局，**WS 的结论优先**。
 *
 *   `wsHasWrite`  这条已经建立的 WebSocket 实际拿到的权限（worker 在握手完成时
 *                 把结论发下来，终端页落成这个全局）。`null` = 还没连上。
 *   `hasToken`    页面那次 HTTP GET 的判定（worker.ts 的 `var hasToken=${hasWrite}`），
 *                 只当初值。
 *
 * 为什么必须分开：两次是**各自独立**的鉴权。页面是 HTTP 请求，iOS WebView 会带
 * Cookie；紧接着的 WebSocket 升级**不带** Cookie，前置代理给平台所有者补 WRITE
 * grant 这件事也就跟着落空。于是同一份页面完全可能「HTTP 判可写、WS 只读」——照抄
 * hasToken 的 UI 会写着「手机端可输入」，用户打的字却被 worker 丢掉，屏幕上什么都
 * 不发生。工作台与终端页同源，所以这是第一手事实，比任何外部推断都准。
 */
export function readTerminalFrameWrite(frame: HTMLIFrameElement | null): TerminalFrameWrite {
  try {
    const view = frame?.contentWindow as { wsHasWrite?: unknown; hasToken?: unknown } | null | undefined;
    const settled = view?.wsHasWrite;
    if (settled === true) return 'writable';
    if (settled === false) return 'readonly';
    const initial = view?.hasToken;
    if (initial === true) return 'writable';
    if (initial === false) return 'readonly';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 终端页 → 工作台的一次写权限回报（终端页在 WS 建立后 postMessage 上抛）。
 *
 * 同源读全局已经够用，这条消息解决的是**时机**：不用等下一拍轮询，连上那一刻面板
 * 就能把文案改对；而且万一将来这块 iframe 走到跨文档隔离的场景，同源读会直接抛，
 * 消息通道仍然成立。来源校验沿用外观桥那一套：只认这块 iframe 自己的 contentWindow
 * 发来的、结构完全对得上的消息。
 */
export function readTerminalWriteReport(data: unknown): boolean | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; write?: unknown };
  if (message.type !== WORKBENCH_TERM_WRITE_MESSAGE) return null;
  return typeof message.write === 'boolean' ? message.write : null;
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

/** 最多读几拍就收手：`hasToken` 是终端页顶部同步赋的全局，onLoad 时通常已经在了；
 *  读不到基本就是读不到（跨域 / 页面报错），一直转下去没有意义。 */
const FRAME_WRITE_MAX_TICKS = 5;

/** 盯着 iframe 自报的写权限。只在需要它当判据的场景启用（触屏那条 viewToken
 *  通道）；桌面同源链路的权威是控制权接口本身，多一个来源只会打架。 */
function useTerminalFrameWrite(params: {
  enabled: boolean;
  /** iframe 换一次（重挂 / 换链接）就重新判定：上一块的结论套不到新的上面。 */
  frameKey: string;
  read(): TerminalFrameWrite;
}): TerminalFrameWrite {
  const { enabled, frameKey } = params;
  const [write, setWrite] = useState<TerminalFrameWrite>('unknown');
  const readRef = useRef(params.read);
  useEffect(() => { readRef.current = params.read; });

  useEffect(() => {
    if (!enabled) return undefined;
    setWrite('unknown');
    let ticks = 0;
    const sample = (): boolean => {
      const value = readRef.current();
      if (value === 'unknown') return false;
      setWrite(value);
      return true;
    };
    if (sample()) return undefined;
    const timer = setInterval(() => {
      ticks += 1;
      if (sample() || ticks >= FRAME_WRITE_MAX_TICKS) clearInterval(timer);
    }, FRAME_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, frameKey]);

  return enabled ? write : 'unknown';
}

/**
 * 收终端页在 WS 建立后主动上抛的写权限。
 *
 * 只认这块 iframe 自己的 `contentWindow` 发来的消息（与外观桥同一套来源校验）：这
 * 页面会被跨 origin 嵌入，别的窗口发来的同名消息一律不作数。换一块 iframe 就把结论
 * 清空——上一块的判定套不到新的连接上。
 */
function useTerminalFrameWriteReport(params: {
  enabled: boolean;
  frameKey: string;
  frame(): { contentWindow?: unknown } | null;
}): TerminalFrameWrite {
  const { enabled, frameKey } = params;
  const [write, setWrite] = useState<TerminalFrameWrite>('unknown');
  const frameRef = useRef(params.frame);
  useEffect(() => { frameRef.current = params.frame; });

  useEffect(() => {
    setWrite('unknown');
    if (!enabled || typeof window === 'undefined' || !window.addEventListener) return undefined;
    const onMessage = (event: { data?: unknown; source?: unknown }) => {
      const source = frameRef.current()?.contentWindow;
      if (!source || event.source !== source) return;
      const reported = readTerminalWriteReport(event.data);
      if (reported === null) return;
      setWrite(reported ? 'writable' : 'readonly');
    };
    window.addEventListener('message', onMessage as EventListener);
    return () => window.removeEventListener('message', onMessage as EventListener);
  }, [enabled, frameKey]);

  return enabled ? write : 'unknown';
}

function browserHref(): string | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.location?.href;
  } catch {
    return undefined;
  }
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
      control_request_timeout: '控制权请求超时',
    };
    return known[error.code] ?? error.code.replaceAll('_', ' ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 写请求（takeover / release）的硬超时。
 *
 * 没有它时，一个**永远不回执**的 POST 会把这块面板整个焊死：`pending` 一直挂着 →
 * `busy` 恒为真 → 标题栏和行内按钮永久禁用；轮询读数一律被在途写丢弃，界面停在
 * 「正在接管输入…」；连卸载补偿也等不到那个 promise。半开连接、被代理吞掉的回执
 * 都是这个形状，而且它不会自己好。
 *
 * 到点就按失败处理：进 `unknown`（**不是**只读——服务端很可能已经受理了）、遮罩
 * 挡住盲输入、立刻发一次权威复核 GET 把状态收敛回来。
 */
export const TERMINAL_WRITE_TIMEOUT_MS = 10_000;

/**
 * 跑一次写请求，超时就自己判负。
 *
 * 两件事一起做，缺一不可：
 *   ① `abort()` 掐掉请求本身——不然这条 fetch 会带着一个没人看的写租约继续飞；
 *   ② 竞速 reject——调用方拿到的必须是一个**会结束**的 promise。只靠 abort 不够：
 *      注入的 api 替身（以及某些不认 signal 的 fetch polyfill）可能压根不理会
 *      signal，那样 promise 依旧永久 pending，超时也就形同虚设。
 */
async function withWriteTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = TERMINAL_WRITE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch { /* 环境不支持 abort：超时判定照旧成立 */ }
      reject(new WorkbenchApiError(504, 'control_request_timeout'));
    }, timeoutMs);
  });
  // 被丢下的那一半 promise 若稍后 reject，没人接就会冒成 unhandled rejection。
  expiry.catch(() => {});
  try {
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 面板对外的一次控制权回执。形状与语义住在状态机文件里，这里只做转出，省得
 *  调用方为了一个类型再多认一个模块。 */
export type { TerminalPaneControlMode };

/**
 * 控制权未知时顶替终端 iframe 的那一屏。
 *
 * 它**不是**盖在 iframe 上的一层提示，而是把 iframe 整个换掉：真实 Chromium 里量
 * 过——焦点已经落在 iframe 内部时，父文档往上盖一个 `position:absolute` 的层只吃
 * 得到指针事件，`keyboard.type` 照旧一个字不落地打进终端。要真的挡住盲输入，只有
 * 让那块可能可写的 iframe 从 DOM 里消失（焦点随之回到 document.body）。
 *
 * 自己再收一次焦点是兜底：将来若有调用方出于别的理由把 iframe 留着，至少焦点先
 * 离开它；对读屏用户来说，这一屏也确实是此刻该被读出来的东西。
 */
function TerminalControlUnknown(props: { onRetry(): void }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    try { ref.current?.focus?.(); } catch { /* 没有 DOM 的宿主（SSR / 组件测试） */ }
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="wb-pane-empty wb-control-unknown"
      role="status"
    >
      <span aria-hidden="true">◇</span>
      <strong>控制权状态未知</strong>
      <p>没有拿到确认，这块终端可能仍然可写。已断开终端画面挡住输入，正在重新确认。</p>
      <button type="button" onClick={props.onRetry}>立即重试</button>
    </div>
  );
}

export function TerminalPane(props: PaneCommonProps & {
  location: WorkbenchTerminalLocation | null;
  /** 这块面板是按哪个意图挂起来的，**两态**：
   *    false     行内「终端」的只读打开 → 还攥着租约就还回去；
   *    undefined 没有意图（分栏树里的面板、直接挂载的调用方）→ 一概不动控制权。
   *  「没意见」必须和「明确要只读」分开：把缺省也当成只读意图，任何一处顺手挂起
   *  的终端面板都会把用户正握着的写权限收走。
   *  没有 `true`：接管**只**由标题栏的「接管输入」发起（产品决策：会话行不再提供
   *  接管捷径），一键接管的意图连同它那条分支一起删掉了，别再加回来。
   *  只读意图只在面板第一次拿到控制权读数时兑现一次，之后控制权只由标题栏的
   *  「接管输入 / 释放输入」驱动。 */
  autoTakeControl?: false;
  /** 控制权回执。面板是唯一知道自己真实模式的人——标题栏的接管/释放不经过外层，
   *  恒可写身份更是从头到尾没发过任何请求——外层的行内「终端」按钮要靠它判断
   *  「再点一次 = 关掉还是降回只读」，断了回执就会把已接管的面板直接关掉。 */
  onControlModeChange?(mode: TerminalPaneControlMode): void;
  /** 测试注入点：组件测试环境里没有真 iframe 的 internals，注入一个假的读数源即可。
   *  生产默认走同源 contentWindow（`readTerminalFrameStatus`）。 */
  readFrameStatus?: (frame: HTMLIFrameElement | null) => TerminalFrameStatus;
  /** 同上，注入「这块 iframe 自报能不能写」的读数源（生产走
   *  `readTerminalFrameWrite`，读终端页同源的 `hasToken`）。 */
  readFrameWrite?: (frame: HTMLIFrameElement | null) => TerminalFrameWrite;
}): JSX.Element {
  // 控制权的唯一状态机。散着的 useState 版本让观察轮询和写操作共用一个
  // generation，15 秒一发的轮询会把在途写的回执丢掉；失败又一律乐观压成只读。
  const [model, dispatch] = useReducer(terminalControlReducer, undefined, initialTerminalControlModel);
  /** 观察与写各自一份 epoch：写只被更新的写作废，轮询作废不了它。 */
  const observeEpoch = useRef(0);
  const writeEpoch = useRef(0);
  /** 卸载后到达的写回执要走补偿路径，不能再 dispatch。 */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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

  const sessionId = props.session.sessionId;

  /** 一次观察（首屏 / 15s 轮询 / 写失败后的复核）。回执带着自己的 epoch 回来，
   *  过期的、或有写在途的，都在 reducer 里被丢掉。 */
  const observe = useCallback(async (
    source: 'load' | 'poll' | 'reconcile',
    signal?: AbortSignal,
  ) => {
    // Without a Dashboard cookie the control API can only 401, and taking over
    // is not on offer anyway — settle into read-only instead of surfacing an
    // authentication error the viewer cannot act on.
    if (!terminalUrl || externalTerminalUrl || !props.authenticated) {
      dispatch({ type: 'settle-readonly' });
      return;
    }
    const epoch = ++observeEpoch.current;
    dispatch({ type: 'observe-start', epoch, source });
    try {
      const next = await props.api.getTerminalControl(sessionId, signal);
      dispatch({ type: 'observe-settled', epoch, control: next });
    } catch (cause) {
      if (signal?.aborted) return;
      dispatch({ type: 'observe-failed', epoch, error: apiErrorText(cause) });
    }
  }, [externalTerminalUrl, props.api, props.authenticated, sessionId, terminalUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void observe('load', controller.signal);
    const timer = setInterval(() => { void observe('poll', controller.signal); }, 15_000);
    return () => {
      // 换会话 / 卸载：作废在途观察。写不走这个计数器——它有自己的 epoch，
      // 卸载后的写回执要留到补偿逻辑里处理，不能在这里"顺手"丢掉。
      observeEpoch.current += 1;
      clearInterval(timer);
      controller.abort();
    };
  }, [observe]);

  const leaseExpiresAt = model.authoritative?.expiresAt;
  useEffect(() => {
    if (model.phase !== 'controlled' || !leaseExpiresAt) return undefined;
    const timer = setTimeout(() => { void observe('poll'); }, Math.max(0, leaseExpiresAt - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [leaseExpiresAt, model.phase, observe]);

  // 写失败 → 立刻复核一次。P1-3：release 失败绝不能乐观宣称只读，真实的写租约
  // 可能还在服务端挂着；这一发 GET 是把 unknown 收敛回权威读数的唯一途径
  // （期间可写 iframe 由下面那层遮罩挡住）。
  useEffect(() => {
    if (model.reconcileNonce === 0) return undefined;
    const controller = new AbortController();
    void observe('reconcile', controller.signal);
    return () => controller.abort();
  }, [model.reconcileNonce, observe]);

  // 开场只读意图只兑现一次，在这块面板第一次拿到**权威**读数的时候：发现自己还
  // 攥着上一轮留下的租约（标题栏接管过，行内点「终端」把它降回只读），就把它还
  // 回去。这是「打开只读终端」名副其实的关键：不真的释放，只读就只是外层记了一笔，
  // 面板照样可输入，用户点完「终端」看到的还是一个可写终端。
  // 它必须是一次性的——兑现之后控制权只由标题栏的「接管输入 / 释放输入」驱动，
  // 否则只读面板会把用户刚在标题栏按下的接管在同一拍里撤销回去。
  // 平台所有者（`fixed`）恒可写、既接管不了也释放不了，直接跳过；未登录 / 触屏 /
  // canControl=false（平台 teammate/guest 等）同样跳过——它们压根没有租约可还，
  // 那个 POST 只会 401/403（P1-4），触屏那边更是走 viewToken 只读通道。
  const openIntentApplied = useRef<string | null>(null);
  useEffect(() => {
    if (props.autoTakeControl === undefined) return;
    if (!props.authenticated || !props.capabilities.canControl || touch) return;
    if (!terminalControlSettled(model)) return;
    const control = model.authoritative;
    if (!control || control.fixed) return;
    if (openIntentApplied.current === sessionId) return;
    openIntentApplied.current = sessionId;
    if (control.mode === 'controlled' && control.owned) void mutate('release');
  });

  /**
   * 面板已经没了，而这次写**可能**已经在服务端落地：收掉没人管的写租约。
   *
   * 三条判据缺一不可：
   *   ① 这份文档里还有活面板攥着同一把租约 → 它不是孤儿，别动。租约挂在
   *      （会话 × 登录）上，第二块面板 takeover 拿到的是同一把，服务端看来两次
   *      请求完全同形，只有这里分得清。
   *   ② 回执丢了（失败 / 超时）时先拿一次**权威读数**：这次写到底有没有落地。
   *      以前这条分支是裸 `return`，于是「服务端已经发了租约、回执却没回来」的
   *      租约从此没人管，一直挂到 TTL 到期。
   *   ③ 释放时带上 marker，说明白要还的是**哪一次**接管。跨标签页 / 跨设备的
   *      抢先接管只有服务端看得见，marker 不匹配时它会拒绝（P1 的 CAS）。
   */
  const compensateUnmounted = useCallback(async (settled: TerminalControlState | null) => {
    if (hasLiveTerminalWriteClaim(sessionId)) return;
    let marker = settled?.marker;
    if (settled) {
      // 拿到回执了：只有真的握到手的接管才需要还。释放成功没有东西要还，恒可写
      // 身份压根没有租约。
      if (settled.fixed === true || settled.mode !== 'controlled' || !settled.owned) return;
    } else {
      const authoritative = await props.api.getTerminalControl(sessionId).catch(() => null);
      if (!authoritative || authoritative.fixed === true) return;
      if (authoritative.mode !== 'controlled' || !authoritative.owned) return;
      // 复核这一个 await 的工夫里可能已经有新面板接手了。
      if (hasLiveTerminalWriteClaim(sessionId)) return;
      marker = authoritative.marker;
    }
    await props.api.releaseTerminal(sessionId, undefined, marker).catch(() => {});
  }, [props.api, sessionId]);

  const mutate = async (action: TerminalWriteAction) => {
    const epoch = ++writeEpoch.current;
    dispatch({ type: 'write-start', epoch, action });
    try {
      // 硬超时：永久 pending 的 POST 会把 busy / 按钮 / 卸载补偿一起焊死。
      const next = await withWriteTimeout(signal => (action === 'takeover'
        ? props.api.takeoverTerminal(sessionId, signal)
        : props.api.releaseTerminal(sessionId, signal)));
      if (!mounted.current) {
        // 服务端刚刚把写租约发给了这次调用，面板却已经关掉 / 换会话 / 离开工作台。
        void compensateUnmounted(next);
        return;
      }
      dispatch({ type: 'write-settled', epoch, control: next });
    } catch (cause) {
      if (!mounted.current) {
        // 失败不代表服务端没受理——超时、断连都只是丢了回执。这里**不能**裸 return。
        void compensateUnmounted(null);
        return;
      }
      dispatch({ type: 'write-failed', epoch, error: apiErrorText(cause) });
    }
  };

  // 只要这块面板**可能**握着写租约，就在登记簿上留个名：别的面板的迟到补偿据此
  // 知道「这把租约还有人在管」。卸载时 effect 的清理先跑，补偿的续行在其后的微
  // 任务里，所以补偿看到的永远是**别人**的认领，不是自己的。
  const writeClaim = useRef({});
  useEffect(() => {
    if (!model.mayWrite) return undefined;
    return claimTerminalWrite(sessionId, writeClaim.current);
  }, [model.mayWrite, sessionId]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameKey = `${sessionId}-${model.frameGeneration}`;
  const readFrameStatus = props.readFrameStatus ?? readTerminalFrameStatus;
  const frameWatch = useTerminalFrameWatch({
    enabled: touch,
    sessionId,
    frameKey,
    read: () => readFrameStatus(frameRef.current),
  });
  // 触屏那条 viewToken 通道到底能不能写，只有终端页自己知道（前置代理会给平台
  // owner 的 viewToken 请求补 WRITE grant，而补不补又取决于这个 WebView 带不带
  // Cookie）。桌面不启用：那边的权威是控制权接口，多一个来源只会两边打架。
  const readFrameWrite = props.readFrameWrite ?? readTerminalFrameWrite;
  const polledFrameWrite = useTerminalFrameWrite({
    enabled: touch,
    frameKey,
    read: () => readFrameWrite(frameRef.current),
  });
  // 终端页连上 WS 那一刻主动上抛的结论。它比轮询早、也比轮询确定（轮询读的是同一
  // 份全局，只是要等下一拍），所以有它就以它为准。
  const reportedFrameWrite = useTerminalFrameWriteReport({
    enabled: touch,
    frameKey,
    frame: () => frameRef.current,
  });
  const frameWrite = reportedFrameWrite !== 'unknown' ? reportedFrameWrite : polledFrameWrite;

  // 终端渲染风格：容器 class 管几何（行距 / 内边距），xterm 的配色住在跨文档的
  // 终端页里，父页换 class 它收不到 —— 必须把 theme 推过去，否则会出现「工作台
  // 换了配色、终端还是旧色」的半截状态。切换和重挂 iframe 时各推一次。
  const { appearance, skin } = useWorkbenchAppearance();
  const pushTermAppearance = useCallback(() => {
    // 相对地址要靠当前页 href 才解得出 origin；测试环境的假 window 没有 location，
    // 解不出来时 postWorkbenchTermAppearance 自己放弃这次下发（绝不用 `*` 广播）。
    postWorkbenchTermAppearance(frameRef.current, frameUrl, appearance.termStyle, skin, browserHref());
  }, [appearance.termStyle, frameUrl, skin]);
  useEffect(() => { pushTermAppearance(); }, [pushTermAppearance]);
  const onFrameLoad = useCallback(() => {
    frameWatch.onFrameLoad?.();
    pushTermAppearance();
  }, [frameWatch, pushTermAppearance]);

  const control = model.authoritative;
  const busy = terminalControlBusy(model);
  const fixed = control?.fixed === true;
  // 标题栏能不能切模式 —— 也就是这块面板有没有第二种状态可去。触屏（viewToken
  // 通道没有租约可接管）、无 canControl 能力、恒可写身份、外部终端都没有。
  const canSwitchMode = !externalTerminalUrl && !!terminalUrl && props.authenticated
    && props.capabilities.canControl && !touch && !fixed;
  // 触屏这块 iframe 到底能不能写，最终以终端页自己的结论为准。它还没给出结论时
  // 别急着猜：非恒可写身份走的 viewToken 通道**必定**只读（前置代理只对平台所有者
  // 补 WRITE grant），照实说只读；恒可写身份则取决于这个 WebView 带不带 Cookie，
  // 只能先说未知，等页面自己说话——这总好过写死一句与实际能力相反的「只读」。
  const touchWrite = frameWrite !== 'unknown' ? frameWrite : fixed ? 'unknown' : 'readonly';
  // 用户眼里的模式。触屏不看租约：那条通道上「控制权接口说什么」和「这一页能不能
  // 输入」本来就是两件事，照抄接口就会得出「UI 说只读、链路其实可写」的分裂表述
  // （P1-4）。
  const paneMode = touch
    ? (touchWrite === 'writable' ? 'controlled' : touchWrite === 'readonly' ? 'readonly' : 'unknown')
    : terminalControlMode(model);
  const controlled = paneMode === 'controlled';
  // 徽标只说有依据的话。首屏 GET 还在飞时说「只读」是最容易被信以为真的一句假话：
  // 同一个登录留下的写租约会让这块 iframe 真的可以打字（详见状态机文件里 loading
  // 那条注释），所以 loading 有自己的说法，不借用只读。
  const status = controlled ? '可输入'
    : paneMode === 'unknown' ? '未知'
      : paneMode === 'loading' ? '检查中' : '只读';
  const chipClass = controlled ? 'is-controlled'
    : paneMode === 'unknown' ? 'is-unknown'
      : paneMode === 'loading' ? 'is-checking' : 'is-readonly';
  const chipGlyph = controlled ? '◆'
    : paneMode === 'unknown' ? '◇'
      : paneMode === 'loading' ? '⋯' : '◌';
  // 未知且这块 iframe 可能仍然可写 → 盖住它。这一刻既不能说「已接管」也不能说
  // 「只读」，而盲输入会真的打进终端（P1-3）。复核 GET 回来后遮罩自动撤掉。
  const masked = !touch && terminalControlNeedsMask(model);

  // 把徽标看到的这份结论原样回执给外层。回执的是**渲染出来的模式**（含触屏那层
  // 覆盖），不是接口原始读数——外层拿它决定行内按钮的开关语义，两边看到的必须是
  // 同一个「用户眼里的模式」。sessionId 一并带上：面板换会话是重挂，回执路上不该
  // 有把上一块面板的结论套到新会话头上的缝。
  const onControlModeChange = props.onControlModeChange;
  const toggleOnly = !canSwitchMode;
  useEffect(() => {
    onControlModeChange?.({ sessionId, mode: paneMode, fixed, toggleOnly, busy });
  }, [busy, fixed, onControlModeChange, paneMode, sessionId, toggleOnly]);
  const expires = controlled && control?.expiresAt
    ? formatWorkbenchRelativeTime(control.expiresAt, props.now, 'zh-CN')
    : null;

  return (
    <section
      className={`wb-pane wb-terminal-pane ${workbenchTermContainerClass(appearance.termStyle)}`}
      // 外壳那圈安全边距的底色 = 这一刻真正渲染出来的 xterm 底色（同一个
      // workbenchTermTheme 也在往 iframe 里推），经典渲染下才不会露出一圈更黑的边。
      style={workbenchTermCanvasStyle(appearance.termStyle, skin) as CSSProperties}
      aria-label="终端面板"
    >
      <header className="wb-pane-titlebar">
        <div className="wb-pane-identity">
          <span className="wb-pane-glyph" aria-hidden="true">›_</span>
          <strong>终端</strong>
          <span className={`wb-mode-chip ${chipClass}`}>
            <span aria-hidden="true">{chipGlyph}</span>{status}
          </span>
          {expires ? <span className="wb-lease-time">{`${expires}到期`}</span> : null}
        </div>
        {/* 「阅读｜经典」就近可切；与右边那组终端操作隔开、不共板——它们不是同一组操作。 */}
        <WorkbenchTermStyleSegment termStyle={appearance.termStyle} />
        <div className="wb-pane-actions">
          {frameUrl ? <a href={frameUrl} target="_blank" rel="noopener noreferrer">新标签页打开</a> : null}
          {/* 触屏不给接管按钮：那边挂的是 viewToken 通道，没有租约可接管/可释放，
              摆出来只会让人反复点。canControl=false（平台 teammate/guest 等）同样不给：
              那个入口点了只会 403（P1-4，服务端投影的最小能力集）。
              busy 期间禁用：写在途时再点一次只会再发一条 POST，第一条的租约没人管。 */}
          {canSwitchMode ? (
            controlled
              ? <button type="button" disabled={busy} onClick={() => void mutate('release')}>释放输入</button>
              : <button type="button" disabled={busy} onClick={() => void mutate('takeover')}>接管输入</button>
          ) : null}
        </div>
      </header>
      <div className="wb-pane-feedback" role="status" aria-live="polite">
        {/* 触屏说的是这块 iframe **自报**的写权限：那条 viewToken 通道对平台所有者
            会被前置代理补成可写（#960），一口咬定「手机端只读」会与用户实际能打字
            的事实相矛盾；读不出来时才退回保守说法，并说清依据在终端页自己身上。 */}
        {touch ? (controlled
          ? '当前身份在手机端也可直接输入。'
          : paneMode === 'unknown'
            ? '只读链接查看中，能否输入以终端页内的提示为准。'
            : '只读查看中。手机端为只读视图，需要输入请在电脑上操作。')
          : model.phase === 'loading' ? '正在检查终端权限…'
            : model.phase === 'taking-over' ? '正在接管输入…'
              : model.phase === 'releasing' ? '正在释放输入…'
                // 失败要连着「现在怎么办」一起说：只报错不说状态，用户会以为界面
                // 上写的只读就是真的（P1-3）。
                : model.error ? `${model.error.text}${model.phase === 'unknown' ? '；控制权状态未知，正在重新确认…' : ''}`
                  : model.phase === 'unknown' ? '控制权状态未知，正在重新确认…'
                    : control?.fixed ? '平台所有者身份已登录，可直接输入。'
                      : controlled ? '已接管，可键盘输入。'
                        // 没有接管能力的身份别劝人去点一个根本没渲染的按钮。
                        : props.authenticated && props.capabilities.canControl ? '只读查看中，点「接管输入」可操作。'
                          : props.authenticated ? '只读查看中，当前身份不可接管输入。'
                            : '只读查看。登录 Dashboard 后可接管。'}
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
                自身会按 iframe 的实际宽度 fit 出列数，窄屏直嵌即可正常显示。
                控制权未知时这块 iframe 直接不挂：盖一层挡不住已经聚焦在里面的键盘。 */}
            {masked ? null : (
              <iframe
                key={frameKey}
                ref={frameRef}
                className="wb-pane-frame"
                src={frameUrl}
                title={`终端 — ${workbenchSessionTitle(props.session)}`}
                allow="clipboard-read; clipboard-write"
                referrerPolicy="no-referrer"
                onLoad={onFrameLoad}
              />
            )}
            {/* iframe 加载得出来、里面的实时通道却始终连不上（iOS 会拦掉 http 页里的
                ws://）。这时终端区域只会是一片黑，与其让人对着黑屏猜，不如直说，并给一条
                能自己走通的路。覆盖层盖在 iframe 上而不是替换它：页面自身一直在重连，
                连上后这层会自动撤掉。 */}
            {frameWatch.blocked && !masked ? (
              <div className="wb-pane-empty wb-ws-blocked" role="status">
                <span aria-hidden="true">⚠</span>
                <strong>终端实时连接未建立</strong>
                <p>当前浏览器环境限制了非加密的实时连接（iOS 内常见）。可尝试用系统浏览器打开，或在电脑上查看。</p>
                <a href={frameUrl} target="_blank" rel="noopener">在浏览器中打开</a>
                <p>飞书内可通过右上角 ⋯ 菜单选择「在浏览器打开」。</p>
              </div>
            ) : null}
            {/* 控制权状态未知、而这块 iframe 可能仍然可写（回执丢了、首屏读不到）：
                把它换掉。乐观说一句「只读」再放任键盘打进去，是这轮复审里最实在的
                一条风险；复核 GET 一回来 iframe 就重新挂上（P1-3）。 */}
            {masked ? <TerminalControlUnknown onRetry={() => void observe('reconcile')} /> : null}
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
