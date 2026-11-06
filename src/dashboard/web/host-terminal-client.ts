// 「终端」页的浏览器侧：每个标签一个 HostTerminalView（xterm + 一条 WS），由页面级单例
// HostTerminalWorkspace 持有。React 页面只负责画标签栏/选择器，终端 DOM 由这里命令式
// 管理——切到 dashboard 其它页面时只把终端节点摘下来，xterm 与 WS 都不销毁，切回来是
// 零成本的重新挂载，不重连、不重放。
//
// 性能取向（对标 Ghostty 这类 GPU 终端）：
//  - 渲染：xterm.js 6 + WebGL。软件 GL（SwiftShader / llvmpipe）下 WebGL 反而比 DOM 慢
//    （实测 TUI 重绘吞吐 20 vs 50 MB/s），自动退回 DOM；浏览器 WebGL 上下文有上限，
//    只给最近用过的几个标签留 GPU 渲染器。
//  - 传输：下行二进制帧直接 term.write(Uint8Array)（xterm 自己解码 UTF-8），上行按键
//    TextEncoder 成字节发二进制帧，都不经 JSON。
//  - 流控：write 回调确认消化后才 ack（见 host-terminal-protocol.ts），后台标签页
//    上报 hidden，不拖住服务端 PTY。

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  HOST_TERMINAL_ACK_BYTES,
  HOST_TERMINAL_API,
  hostTerminalTargetKey,
  hostTerminalWsPath,
  parseServerControl,
  type HostTerminalClientControl,
  type HostTerminalInfo,
  type HostTerminalTarget,
  type HostTerminalTargets,
} from '../host-terminal-protocol.js';
import { controlCsrfHeaders } from './control-csrf.js';
import { ctrlChord, hostTerminalKeyBytes, type HostTerminalKey } from './host-terminal-keys.js';

export type { HostTerminalKey } from './host-terminal-keys.js';
import { copyText } from './clipboard.js';

export type HostTerminalStatus = 'starting' | 'connecting' | 'open' | 'reconnecting' | 'exited' | 'failed';
export type RendererMode = 'webgl' | 'dom';

const FONT_SIZE_KEY = 'botmux.terminal.fontSize';
const RENDERER_KEY = 'botmux.terminal.renderer';
const DEFAULT_FONT_SIZE = 13;
/** 同时持有 WebGL 渲染器的标签数（浏览器活跃 WebGL 上下文通常上限 16，给页面其它部分留余量）。 */
const MAX_WEBGL_VIEWS = 4;
const ACK_IDLE_MS = 40;
const RESIZE_SEND_MS = 60;

const FONT_FAMILY = [
  '"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Monaco', '"Cascadia Mono"', 'Consolas',
  '"DejaVu Sans Mono"', '"Noto Sans Mono CJK SC"', '"PingFang SC"', '"Microsoft YaHei"', 'monospace',
].join(', ');

// Tokyo Night：与会话终端页同一套底色，16 色补全。
const THEME: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** 触屏设备（手机 / 平板）：页面切沉浸布局、显示快捷键行、接管触摸滚动与第三方输入法。 */
export const IS_TOUCH = typeof window !== 'undefined'
  && ('ontouchstart' in window || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));

let gpuVerdict: boolean | null = null;

/** WebGL2 可用且不是软件光栅化。结果缓存：探测要建一个 GL 上下文。 */
export function hardwareWebglAvailable(): boolean {
  if (gpuVerdict !== null) return gpuVerdict;
  gpuVerdict = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      gpuVerdict = !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL */ }
  return gpuVerdict;
}

export function preferredRenderer(): RendererMode {
  let forced: string | null = null;
  try { forced = localStorage.getItem(RENDERER_KEY); } catch { /* private mode */ }
  if (forced === 'dom') return 'dom';
  if (forced === 'webgl') return 'webgl';
  return hardwareWebglAvailable() ? 'webgl' : 'dom';
}

function readFontSize(): number {
  try {
    const v = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (Number.isFinite(v) && v >= 8 && v <= 32) return v;
  } catch { /* private mode */ }
  return DEFAULT_FONT_SIZE;
}

function wsUrl(id: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${hostTerminalWsPath(id)}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({})) as { ok?: boolean; error?: string } & T;
  if (!r.ok || body.ok === false) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const encoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);

/**
 * 用到的 xterm 内部服务（`terminal._core`）。xterm 自己的 WebGL 插件也这样取内部对象；
 * 这两处都做了缺失时的退路。
 */
interface XtermCore {
  coreService?: { onUserInput?: (cb: () => void) => unknown };
  coreMouseService?: {
    triggerMouseEvent?: (e: {
      col: number; row: number; x: number; y: number; button: number; action: number;
      ctrl: boolean; alt: boolean; shift: boolean;
    }) => boolean;
  };
}
let viewSeq = 0;

export class HostTerminalView {
  /** 页面内稳定的标签 id（服务端 id 要等创建请求回来才有）。 */
  readonly uid = `t${++viewSeq}`;
  /** 目标键：同一个 tmux/herdr session 只开一个标签。 */
  readonly key: string;
  readonly element: HTMLDivElement;
  readonly term: Terminal;
  info: HostTerminalInfo | null = null;
  status: HostTerminalStatus = 'starting';
  exitCode: number | null = null;
  error: string | null = null;
  /** 程序通过 OSC 0/2 设置的标题（shell 提示符常会带 cwd）。 */
  title = '';
  renderer: RendererMode = 'dom';

  private fit = new FitAddon();
  private webgl: WebglAddon | null = null;
  private ws: WebSocket | null = null;
  private opened = false;
  private active = false;
  private disposed = false;
  private processed = 0;
  /** 下一个二进制帧是服务端的重同步重放。 */
  private replayNext = false;
  /** 正在解析的重放帧数：期间 xterm 对历史终端查询的自动应答一律丢弃。 */
  private replaying = 0;
  /** hello 已按服务端网格摆好，等紧随的重放帧解析完再决定接管还是跟随。 */
  private claimAfterReplay = false;
  /** xterm 内部服务（区分用户输入 / 自动应答、按协商格式编码鼠标事件）；拿不到时为 undefined。 */
  private core: XtermCore | undefined;
  /** xterm 刚报告了一次用户输入，紧随其后的 onData 是用户字节而不是自动应答。 */
  private userInputPending = false;
  /**
   * 服务端指定的主控端：只有它把 xterm 的自动应答发给程序（多端都回会被当成输入）。
   * 和网格一样按输出流顺序生效（见 onmessage 的 role），未确认前不应答。
   */
  private owner = false;
  private ackTimer: number | null = null;
  private resizeTimer: number | null = null;
  private fitFrame: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 400;
  /** PTY 当前的真实尺寸（hello / 别的端接管时服务端推来；本端接管时乐观更新）。 */
  private serverSize: { cols: number; rows: number } | null = null;
  /** 别的端在用：本地 xterm 跟随它的网格显示，不按自己的容器折行。 */
  private following = false;
  /** 每次重连 +1：旧连接排队中的输出解析完后不能给新连接回 ack（新连接的计数是另一批字节）。 */
  private connGen = 0;
  /** xterm 正在解析的输出属于哪一代连接（按写入队列推进）。 */
  private parseGen = 0;
  /** 快捷键行的粘滞 Ctrl：下一个敲进来的字符变成控制字符。 */
  ctrlArmed = false;
  private touchY: number | null = null;
  private touchX = 0;
  private touchCarry = 0;
  private resizeObserver: ResizeObserver;

  constructor(
    readonly target: HostTerminalTarget,
    private readonly onChange: () => void,
    private readonly onFocusRequest: (view: HostTerminalView) => void,
  ) {
    this.key = hostTerminalTargetKey(target);
    this.element = document.createElement('div');
    this.element.className = 'host-terminal-view';
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: FONT_FAMILY,
      fontSize: readFontSize(),
      // 触屏上不闪：省电，也少一路重绘。
      cursorBlink: !IS_TOUCH,
      scrollback: 10_000,
      smoothScrollDuration: 0,
      fastScrollSensitivity: 5,
      drawBoldTextInBrightColors: true,
      // 右键交给终端里的程序（herdr / tmux 的右键菜单），不让 xterm 顺手选词。
      rightClickSelectsWord: false,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    // onData 同时承载两种字节：用户输入（按键 / 粘贴 / 鼠标上报）和 xterm 对程序查询
    // （DA / DSR / OSC 颜色…）的自动应答。后者不能接管尺寸、不能吃掉粘滞 Ctrl——否则一个
    // 只是在旁观的浏览器会因为程序发了个查询就把 PTY 尺寸抢走。xterm 只在内部 coreService
    // 上区分两者（onUserInput 紧挨着用户输入的 onData 之前同步触发）；拿不到时退回全按输入处理。
    const core = (this.term as unknown as { _core?: XtermCore })._core;
    this.core = core;
    const onUserInput = core?.coreService?.onUserInput;
    const canTellReplies = typeof onUserInput === 'function';
    if (canTellReplies) onUserInput.call(core!.coreService, () => { this.userInputPending = true; });
    this.term.onData(data => {
      const fromUser = canTellReplies ? this.userInputPending : true;
      this.userInputPending = false;
      // 重放解析期间只丢自动应答；用户这时敲的键（含 Ctrl-C）照常发。分不清时只好全丢。
      if (this.replaying > 0 && (!canTellReplies || !fromUser)) return;
      if (!fromUser) {
        // 焦点上报（?1004 打开时的 CSI I / CSI O）是本端自己的事实，不是对查询的应答：每端
        // 都照实上报，不按主控去重，也不转移主控。
        if (data === '\x1b[I' || data === '\x1b[O') {
          this.sendControl({ t: 'reply', data });
          return;
        }
        // 自动应答单独走 reply 控制帧：服务端照写进 PTY，但不当成输入去转移主控。重连后还在
        // 解析旧连接遗留输出时产生的应答属于旧连接，丢弃。
        if (this.owner && this.parseGen === this.connGen) this.sendControl({ t: 'reply', data });
        return;
      }
      if (this.ctrlArmed && data.length === 1) {
        const chord = ctrlChord(data);
        this.ctrlArmed = false;
        this.onChange();
        if (chord) data = chord;
      }
      this.sendInput(data);
    });
    // onBinary 只来自用户（X10 编码的鼠标上报），重放期间也照常发。
    this.term.onBinary(data => {
      this.claimSize(true);
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.sendBytes(bytes);
    });
    this.term.onTitleChange(title => { this.title = title; this.onChange(); });
    this.term.attachCustomKeyEventHandler(ev => this.handleKey(ev));
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    // 点到这个终端 = 开始用它：抢回 PTY 尺寸（别的端可能正按它们的尺寸在用）。
    this.element.addEventListener('pointerdown', () => this.claimSize(), { capture: true, passive: true });
    // 浏览器右键菜单会盖住终端程序自己的右键菜单（herdr / tmux 开了鼠标时右键是给它们的），
    // 手机长按也会弹系统菜单。默认屏蔽；按住 Shift 右键仍是浏览器菜单（复制 / 检查等逃生口）。
    this.element.addEventListener('contextmenu', (e) => {
      if (!(e as MouseEvent).shiftKey) e.preventDefault();
    });
    if (IS_TOUCH) this.installTouchSupport();
  }

  /** 用户输入：先接管尺寸再发字节（同一条 WS 上保序，PTY 先变尺寸再收到按键）。 */
  private sendInput(data: string): void {
    this.claimSize(true);
    this.sendBytes(encoder.encode(data));
  }

  /** 快捷键行。 */
  /**
   * 快捷键行。走 xterm 的用户输入路径（和真键盘、输入法补丁一样）：翻看历史时按键会照常
   * 滚回底部（scrollOnUserInput），再经 onData 走接管尺寸 / 粘滞 Ctrl / 发送。
   */
  sendKey(key: HostTerminalKey): void {
    this.term.input(hostTerminalKeyBytes(key, this.term.modes.applicationCursorKeysMode), true);
  }

  toggleCtrl(): void {
    this.ctrlArmed = !this.ctrlArmed;
    this.onChange();
  }

  focus(): void { this.term.focus(); }

  /**
   * 触屏补丁：
   *  - 单指上下拖动滚动（xterm 6 自己不处理触摸，合成的 WheelEvent 也不认）。按桌面滚轮
   *    的同一套语义自己分流：程序开了鼠标上报（tmux / herdr）→ 发 SGR 滚轮；备用屏没开鼠标
   *    （less / man）→ 方向键；普通屏 → 本地回滚。
   *  - iOS 第三方输入法（豆包 / 微信）的「keyCode 229 + insertText、无 composition 事件」
   *    死路径与语音纠错的多次删除，xterm 会吞字 / 只删一个——沿用会话终端页（worker.ts）
   *    基于真机事件轨迹的修法：只接管这两条路径，其余交给 xterm。上游 xterm.js #5835/#5836。
   */
  private installTouchSupport(): void {
    const el = this.element;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { this.touchY = null; return; }
      this.touchY = e.touches[0].clientY;
      this.touchX = e.touches[0].clientX;
      this.touchCarry = 0;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (this.touchY === null || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = this.touchY - t.clientY;
      if (Math.abs(dy) < 1) return;
      this.touchY = t.clientY;
      e.preventDefault();
      // 按行累积：一次滑动换算成整行滚轮，避免亚像素抖动刷屏。
      const cell = Math.max(8, this.element.clientHeight / Math.max(1, this.term.rows));
      this.touchCarry += dy;
      const lines = Math.trunc(this.touchCarry / cell);
      if (!lines) return;
      this.touchCarry -= lines * cell;
      this.touchScroll(lines, this.touchX, t.clientY);
    }, { passive: false });
    el.addEventListener('touchend', () => { this.touchY = null; }, { passive: true });
  }

  /** lines > 0：手指上推、看更新的内容；< 0：下拉看历史。 */
  private touchScroll(lines: number, clientX: number, clientY: number): void {
    const older = lines < 0;
    const n = Math.min(Math.abs(lines), 20);
    if (this.term.modes.mouseTrackingMode !== 'none') {
      // 交给 xterm 自己的鼠标服务编码：真滚轮走的就是它，自动按程序协商的协议（X10 不报
      // 滚轮）和编码（默认 / SGR / SGR 像素）出字节，经 onData / onBinary 发出去。
      const mouse = this.core?.coreMouseService;
      if (typeof mouse?.triggerMouseEvent !== 'function') return;
      const screen = this.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
      const x = screen ? Math.max(0, clientX - screen.left) : 0;
      const y = screen ? Math.max(0, clientY - screen.top) : 0;
      const col = screen ? Math.min(this.term.cols - 1, Math.floor(x / (screen.width / this.term.cols))) : 0;
      const row = screen ? Math.min(this.term.rows - 1, Math.floor(y / (screen.height / this.term.rows))) : 0;
      // CoreMouseButton.WHEEL = 4；CoreMouseAction.UP = 0（看更早的）/ DOWN = 1。
      for (let i = 0; i < n; i++) {
        mouse.triggerMouseEvent.call(mouse, { col, row, x, y, button: 4, action: older ? 0 : 1, ctrl: false, alt: false, shift: false });
      }
    } else if (this.term.buffer.active.type === 'alternate') {
      for (let i = 0; i < n; i++) this.sendKey(older ? 'up' : 'down');
    } else {
      this.term.scrollLines(older ? -n : n);
    }
  }

  private imeClaim = false;
  private imeComposing = false;
  private imeHooked = false;

  /** iOS 第三方输入法补丁的 textarea 监听（textarea 在 open 之后才存在）。 */
  private hookImeTextarea(): void {
    const ta = this.term.textarea;
    if (!IS_TOUCH || !ta || this.imeHooked) return;
    this.imeHooked = true;
    const opts = { capture: true, passive: true } as const;
    ta.addEventListener('compositionstart', () => { this.imeComposing = true; this.imeClaim = false; }, opts);
    ta.addEventListener('compositionend', () => { this.imeComposing = false; this.imeClaim = false; }, opts);
    ta.addEventListener('blur', () => { this.imeClaim = false; }, opts);
    ta.addEventListener('keyup', () => { this.imeClaim = false; }, opts);
    // 一个被接管的按键可能触发多次 input（连按空格变句号 = 删 + 插；语音纠错 = 多次删），
    // 所以不按 input 复位，整轮转发，keyup / compositionstart 才收口。
    ta.addEventListener('input', (e) => {
      if (!this.imeClaim || this.imeComposing) return;
      const ev = e as InputEvent;
      const type = ev.inputType || '';
      if (type.startsWith('delete')) { this.term.input('\x7f', true); return; }
      // 只认 composed 的 insertText：paste / replacement 由 xterm 自己处理，转发会重复。
      if (ev.data && ev.composed && type === 'insertText') this.term.input(ev.data, true);
    }, opts);
  }

  /** 返回 false = 这个按键由输入法补丁接管，xterm 跳过。 */
  private imeKeydown(ev: KeyboardEvent): boolean {
    // iOS 合成按键常常没有 keyup，每次 keydown 先复位，避免上一轮卡在接管状态重复发字。
    this.imeClaim = false;
    if (this.imeComposing) return true;
    if (ev.keyCode === 229) { this.imeClaim = true; return false; }
    // textarea 非空 = 输入法编辑中：一次退格的 N 个删除事件都要转给终端；空的就是普通退格。
    if (ev.keyCode === 8 && (this.term.textarea?.value.length ?? 0) > 0) { this.imeClaim = true; return false; }
    return true;
  }

  get label(): string {
    return this.info?.label ?? (this.target.kind === 'shell' ? 'shell' : this.target.session);
  }

  get id(): string | null { return this.info?.id ?? null; }

  attach(host: HTMLElement): void {
    if (this.element.parentElement !== host) host.appendChild(this.element);
    if (this.active) this.ensureOpened();
    if (this.active) this.scheduleFit();
  }

  detach(): void {
    this.element.remove();
  }

  setActive(active: boolean, focus = false): void {
    this.active = active;
    this.element.classList.toggle('is-active', active);
    if (!active) return;
    if (this.element.isConnected) this.ensureOpened();
    this.scheduleFit();
    if (focus) this.term.focus();
  }

  /**
   * 第一次显示时才 open xterm：open 要在可见节点上才量得出字宽，隐藏状态下 open 会拿到
   * 0 宽字格。没 open 的终端照样能 write（xterm 先解析进缓冲），不丢输出。
   */
  private ensureOpened(): void {
    if (this.opened) return;
    this.opened = true;
    this.term.open(this.element);
    this.resizeObserver.observe(this.element);
    this.hookImeTextarea();
  }

  /** 按真实字宽算出的尺寸（建 PTY 时直接用，免得起完再 resize 一次）。 */
  proposedSize(): { cols: number; rows: number } | null {
    if (!this.opened) return null;
    const d = this.fit.proposeDimensions();
    return d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 1 && d.rows > 0
      ? { cols: d.cols, rows: d.rows }
      : null;
  }

  /** 绑定服务端终端并连上 WS。 */
  bind(info: HostTerminalInfo): void {
    this.info = info;
    this.connect();
  }

  fail(error: string): void {
    this.status = 'failed';
    this.error = error;
    this.onChange();
  }

  setRenderer(mode: RendererMode): void {
    if (mode === 'webgl' && !this.webgl && this.opened) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // GPU 上下文被回收（驱动重置 / 上下文数超限）：退回 DOM，内容由 xterm 自己重画。
          addon.dispose();
          if (this.webgl === addon) this.webgl = null;
          this.renderer = 'dom';
          this.onChange();
        });
        this.term.loadAddon(addon);
        this.webgl = addon;
        this.renderer = 'webgl';
      } catch {
        this.webgl = null;
        this.renderer = 'dom';
      }
    } else if (mode === 'dom' && this.webgl) {
      this.webgl.dispose();
      this.webgl = null;
      this.renderer = 'dom';
    }
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  setVisibility(hidden: boolean): void {
    this.sendControl({ t: 'visibility', hidden });
    if (!hidden && this.active) this.scheduleFit();
  }

  /** 别的端在用、本地跟随显示中。 */
  get isFollowing(): boolean { return this.following; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    this.resizeObserver.disconnect();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    this.webgl?.dispose();
    this.webgl = null;
    this.term.dispose();
    this.element.remove();
  }

  // ── 连接 ────────────────────────────────────────────────────────────────
  private connect(): void {
    if (this.disposed || !this.info) return;
    this.status = this.status === 'open' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting';
    this.onChange();
    const ws = new WebSocket(wsUrl(this.info.id));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const thisGen = ++this.connGen;
    // 解析进度走到这条新连接的数据时才切代次；旧连接给的主控身份也到此作废，等新 role。
    this.term.write(EMPTY_BYTES, () => {
      this.parseGen = thisGen;
      this.owner = false;
    });
    this.processed = 0;
    if (this.ackTimer !== null) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    this.replayNext = false;
    this.claimAfterReplay = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 400;
      this.status = 'open';
      this.onChange();
      // 尺寸等 hello 带来 PTY 的真实尺寸后再定（断线期间可能被别的端改过）。
      if (document.hidden) this.sendControl({ t: 'visibility', hidden: true });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') {
        const msg = parseServerControl(ev.data);
        if (msg?.t === 'hello') {
          this.info = msg.terminal;
          // 重放内容是在 PTY 当前网格上产生的（含绝对光标定位），先按这个网格解析；前台
          // 标签等重放解析完再接管尺寸（tmux 新 attach 的客户端也是这样）。
          this.serverSize = { cols: msg.terminal.cols, rows: msg.terminal.rows };
          this.queueGrid(msg.terminal.cols, msg.terminal.rows);
          this.claimAfterReplay = true;
          this.onChange();
        } else if (msg?.t === 'size') {
          // PTY 尺寸变了（不论哪端发起的，含本端——服务端会回给发起者）：排在已收输出之后、
          // 按到达顺序逐个生效。之前的输出是在旧网格上产生的，xterm 的 write 又是异步解析，
          // 直接 resize 会让它们按新网格解析（折行错、光标被夹）。
          this.serverSize = { cols: msg.cols, rows: msg.rows };
          this.queueGrid(msg.cols, msg.rows);
        } else if (msg?.t === 'role') {
          // 主控交接同样按输出顺序生效：交接点之前的查询归旧主控答，之后的归新主控，
          // 各端解析进度不一也不会重复应答或没人应答。
          const owner = msg.owner;
          this.term.write(EMPTY_BYTES, () => { this.owner = owner; });
        } else if (msg?.t === 'replay') {
          this.replayNext = true;
        } else if (msg?.t === 'exit') {
          this.markExited(msg.code);
        }
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      const n = bytes.length;
      const gen = this.connGen;
      const replay = this.replayNext;
      this.replayNext = false;
      const claimAfter = replay && this.claimAfterReplay;
      if (replay) this.claimAfterReplay = false;
      // 只在解析重放帧本身时屏蔽应答：前面可能还排着正常输出（服务端重同步前会先冲掉
      // 待发帧），它们里的实时查询照常要应答。空写的回调在之前的数据都解析完后才触发，
      // 正好卡在重放帧开始解析之前。
      if (replay) this.term.write(EMPTY_BYTES, () => { this.replaying++; });
      this.term.write(bytes, () => {
        if (replay) this.replaying--;
        if (gen === this.connGen) this.onProcessed(n);
        if (claimAfter && this.active && this.opened && !document.hidden) this.claimSize(true);
      });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status === 'exited' || this.disposed) return;
      this.status = 'reconnecting';
      this.onChange();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.disposed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  /** 重连前确认服务端终端还在：被回收/关掉了就停在「已退出」，不无限重试。 */
  private async reconnect(): Promise<void> {
    if (this.disposed || !this.info) return;
    try {
      const { terminals } = await api<{ terminals: HostTerminalInfo[] }>(HOST_TERMINAL_API);
      if (!terminals.some(t => t.id === this.info!.id)) {
        this.markExited(null);
        return;
      }
    } catch {
      // dashboard 正在重启之类：继续退避重试。
      this.scheduleReconnect();
      return;
    }
    this.connect();
  }

  private markExited(code: number | null): void {
    if (this.status === 'exited') return;
    this.status = 'exited';
    this.exitCode = code;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    this.onChange();
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN && bytes.length) this.ws.send(bytes);
  }

  private sendControl(msg: HostTerminalClientControl): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ── 流控 ────────────────────────────────────────────────────────────────
  private onProcessed(n: number): void {
    this.processed += n;
    if (this.processed >= HOST_TERMINAL_ACK_BYTES) {
      this.flushAck();
    } else if (this.ackTimer === null) {
      this.ackTimer = window.setTimeout(() => this.flushAck(), ACK_IDLE_MS);
    }
  }

  private flushAck(): void {
    if (this.ackTimer !== null) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    if (this.processed <= 0) return;
    this.sendControl({ t: 'ack', bytes: this.processed });
    this.processed = 0;
  }

  // ── 尺寸 ────────────────────────────────────────────────────────────────
  // 「谁在用听谁的」：本端有交互（输入 / 点按 / 容器变化 / 切到前台）就请求把 PTY 改成自己
  // 容器的尺寸。本地网格不自己改，只跟服务端的 `size` 事件走（本端发起的也会回过来），
  // 按输出流顺序生效——网格因此始终等于「这段输出产生时的 PTY 尺寸」。
  private scheduleFit(): void {
    if (!this.opened || !this.active || this.fitFrame !== null) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      this.claimSize();
    });
  }

  /** 本地容器按真实字宽能放下的网格。 */
  private containerGrid(): { cols: number; rows: number } | null {
    if (!this.opened || !this.element.isConnected || this.element.clientWidth === 0) return null;
    const d = this.fit.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 2 || d.rows < 1) return null;
    return { cols: d.cols, rows: d.rows };
  }

  /**
   * 请求 PTY 改成本地容器的尺寸。后台标签页、隐藏标签不接管。
   * immediate：由输入触发时必须同步先发 resize——同一条 WS 保序，PTY 先变尺寸再收到按键，
   * 否则刚接管时敲的命令（`ls`、`stty size`）还按别的端的尺寸排版。
   */
  private claimSize(immediate = false): void {
    if (!this.active || document.hidden) return;
    const want = this.containerGrid();
    if (!want) return;
    if (this.serverSize && this.serverSize.cols === want.cols && this.serverSize.rows === want.rows) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const send = () => {
      if (this.resizeTimer !== null) { clearTimeout(this.resizeTimer); this.resizeTimer = null; }
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const size = this.containerGrid();
      if (!size) return;
      if (this.serverSize && this.serverSize.cols === size.cols && this.serverSize.rows === size.rows) return;
      // 乐观记下：同一尺寸不重复请求；真正改网格等服务端回 `size`。
      this.serverSize = size;
      this.sendControl({ t: 'resize', ...size });
    };
    if (immediate || !this.serverSize) { send(); return; }
    // 拖拽窗口时尾随节流——每次 resize 都会让 TUI 整屏重画。
    if (this.resizeTimer === null) this.resizeTimer = window.setTimeout(send, RESIZE_SEND_MS);
  }

  /** 在当前输出流位置排一个网格变更：之前收到的输出都按旧网格解析完再改。 */
  private queueGrid(cols: number, rows: number): void {
    this.term.write(EMPTY_BYTES, () => {
      if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
      this.updateFollowing();
    });
  }

  /** 网格和本地容器对不上 = 正按别的端的尺寸显示（UI 上提示「跟随其它端」）。 */
  private updateFollowing(): void {
    const want = this.active ? this.containerGrid() : null;
    const following = !!want && (want.cols !== this.term.cols || want.rows !== this.term.rows);
    if (following !== this.following) {
      this.following = following;
      this.onChange();
    }
  }

  // ── 键位 ────────────────────────────────────────────────────────────────
  private handleKey(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown') return true;
    if (IS_TOUCH && !this.imeKeydown(ev)) return false;
    const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;
    // Ctrl+Shift+C / Ctrl+Shift+V（Linux/Windows 终端惯例）；macOS 的 Cmd+C/V 走浏览器原生。
    if (!IS_MAC && ev.ctrlKey && ev.shiftKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'c') {
        const selection = this.term.getSelection();
        if (selection) {
          ev.preventDefault();
          void copyText(selection).then(() => this.term.focus());
        }
        return false;
      }
      // 不 preventDefault：交给浏览器原生粘贴，xterm 的 paste 监听会按括号粘贴发出去。
      if (k === 'v') return false;
    }
    // Ctrl/Cmd + = / - / 0：字号（Ghostty 同款），不让浏览器整页缩放。
    if (mod && !ev.altKey && (ev.key === '=' || ev.key === '+' || ev.key === '-' || ev.key === '0')) {
      ev.preventDefault();
      this.onFocusRequest(this);
      workspace.adjustFontSize(ev.key === '0' ? 0 : ev.key === '-' ? -1 : 1);
      return false;
    }
    return true;
  }
}

type Listener = () => void;

export class HostTerminalWorkspace {
  views: HostTerminalView[] = [];
  activeUid: string | null = null;
  fontSize = DEFAULT_FONT_SIZE;
  private host: HTMLElement | null = null;
  private listeners = new Set<Listener>();
  private webglOrder: HostTerminalView[] = [];
  private synced = false;
  private visibilityBound = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit = (): void => { for (const fn of this.listeners) fn(); };

  get activeView(): HostTerminalView | null {
    return this.views.find(v => v.uid === this.activeUid) ?? null;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    this.fontSize = readFontSize();
    this.bindVisibility();
    for (const view of this.views) view.attach(host);
    this.applyActive(true);
    if (!this.synced) void this.syncFromServer();
  }

  unmount(): void {
    for (const view of this.views) view.detach();
    this.host = null;
  }

  /** 页面首次挂载：把服务端已有的终端（别的标签页/刷新前开的）都接回来。 */
  async syncFromServer(): Promise<void> {
    this.synced = true;
    let terminals: HostTerminalInfo[] = [];
    try {
      terminals = (await api<{ terminals: HostTerminalInfo[] }>(HOST_TERMINAL_API)).terminals;
    } catch {
      this.synced = false;
      return;
    }
    const known = new Set(this.views.map(v => v.id).filter(Boolean));
    for (const info of terminals.sort((a, b) => a.createdAt - b.createdAt)) {
      if (known.has(info.id)) continue;
      const view = this.createView(info.target);
      view.bind(info);
      if (!this.activeUid) this.activeUid = view.uid;
    }
    this.applyActive();
    this.emit();
  }

  async listTargets(): Promise<HostTerminalTargets> {
    return (await api<{ targets: HostTerminalTargets }>(`${HOST_TERMINAL_API}/targets`)).targets;
  }

  /** 打开目标：tmux/herdr 已有标签就切过去，否则新建。 */
  async open(target: HostTerminalTarget): Promise<void> {
    if (target.kind !== 'shell') {
      const existing = this.views.find(v => v.key === hostTerminalTargetKey(target) && v.status !== 'exited' && v.status !== 'failed');
      if (existing) { this.activate(existing.uid); return; }
    }
    const view = this.createView(target);
    this.activeUid = view.uid;
    this.applyActive(true);
    this.emit();
    const size = view.proposedSize();
    try {
      const { terminal } = await api<{ terminal: HostTerminalInfo }>(HOST_TERMINAL_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...controlCsrfHeaders() },
        body: JSON.stringify({ target, ...(size ?? {}) }),
      });
      // 创建请求在途时标签已被关掉：服务端刚起的终端也一并关掉，别留到空闲回收。
      if (!this.views.includes(view)) {
        void this.closeRemote(terminal.id);
        return;
      }
      // 创建请求在途时选择器触发的同步可能已经把这个终端接回来了：留那一个，丢掉占位。
      const twin = this.views.find(v => v !== view && v.id === terminal.id);
      if (twin) {
        this.removeView(view);
        this.activate(twin.uid);
        return;
      }
      view.bind(terminal);
    } catch (err) {
      view.fail(err instanceof Error ? err.message : String(err));
    }
    this.emit();
  }

  /** 已退出的标签原地重开同一目标。 */
  async reopen(view: HostTerminalView): Promise<void> {
    const index = this.views.indexOf(view);
    this.removeView(view);
    await this.open(view.target);
    // 新标签放回原来的位置。
    const fresh = this.activeView;
    if (fresh && index >= 0) {
      this.views.splice(this.views.indexOf(fresh), 1);
      this.views.splice(Math.min(index, this.views.length), 0, fresh);
      this.emit();
    }
  }

  async close(view: HostTerminalView): Promise<void> {
    const id = view.id;
    this.removeView(view);
    if (id && view.status !== 'exited') await this.closeRemote(id);
  }

  private async closeRemote(id: string): Promise<void> {
    try {
      await api(`${HOST_TERMINAL_API}/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        headers: controlCsrfHeaders(),
      });
    } catch { /* 服务端会按空闲回收 */ }
  }

  activate(uid: string): void {
    this.activeUid = uid;
    this.applyActive(true);
    this.emit();
  }

  adjustFontSize(delta: number): void {
    const next = delta === 0 ? DEFAULT_FONT_SIZE : Math.max(8, Math.min(32, this.fontSize + delta));
    this.fontSize = next;
    try { localStorage.setItem(FONT_SIZE_KEY, String(next)); } catch { /* private mode */ }
    for (const view of this.views) view.setFontSize(next);
    this.emit();
  }

  private createView(target: HostTerminalTarget): HostTerminalView {
    const view = new HostTerminalView(target, this.emit, v => this.activate(v.uid));
    this.views.push(view);
    if (this.host) view.attach(this.host);
    view.setFontSize(this.fontSize);
    return view;
  }

  private removeView(view: HostTerminalView): void {
    const index = this.views.indexOf(view);
    if (index < 0) return;
    const wasActive = view.uid === this.activeUid;
    this.views.splice(index, 1);
    this.webglOrder = this.webglOrder.filter(v => v !== view);
    view.dispose();
    if (wasActive) {
      const next = this.views[Math.min(index, this.views.length - 1)];
      this.activeUid = next ? next.uid : null;
    }
    this.applyActive(wasActive);
    this.emit();
  }

  private applyActive(focus = false): void {
    const active = this.activeView;
    for (const view of this.views) view.setActive(view === active, focus && view === active);
    if (active && this.host) this.promoteRenderer(active);
  }

  /** GPU 渲染器只给最近用过的 MAX_WEBGL_VIEWS 个标签，其余退回 DOM（隐藏时本来也不画）。 */
  private promoteRenderer(view: HostTerminalView): void {
    const mode = preferredRenderer();
    if (mode === 'dom') { view.setRenderer('dom'); return; }
    this.webglOrder = [view, ...this.webglOrder.filter(v => v !== view)];
    for (const [i, v] of this.webglOrder.entries()) v.setRenderer(i < MAX_WEBGL_VIEWS ? 'webgl' : 'dom');
    this.webglOrder = this.webglOrder.slice(0, MAX_WEBGL_VIEWS);
  }

  private bindVisibility(): void {
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      for (const view of this.views) view.setVisibility(document.hidden);
    });
  }
}

export const workspace = new HostTerminalWorkspace();
