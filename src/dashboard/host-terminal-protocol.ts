// src/dashboard/host-terminal-protocol.ts
//
// 「终端」页（Dashboard → 管理 → 终端）浏览器 ↔ dashboard 的线协议。纯模块：服务端
// （host-terminal.ts）与前端（web/terminal-*.ts）共用同一份常量、形状与校验，改一处
// 两边一起变。
//
// 帧约定（性能优先，理由见 host-terminal.ts 头注释）：
//  - 二进制帧 = 终端字节流。下行是 PTY 原始输出（服务端不做 UTF-8 解码、不包 JSON，
//    xterm 自己按字节流解码，跨帧截断的多字节字符也由它拼回）；上行是键盘输入的字节。
//  - 文本帧 = 低频控制消息 JSON：下行 hello / replay / size / role / exit，上行 resize / ack / visibility。
//
// 多个浏览器连同一个终端时尺寸按「谁在用听谁的」（同 tmux window-size latest）：有输入 /
// 点按 / 窗口变化的那端发 resize 接管 PTY 尺寸，服务端用 `size` 告诉其它端，其它端把本地
// xterm 调成同一网格跟随显示（不再按自己容器折行，免得 `ls` 这类按列排版的输出错位）。
// 同理只有「主控端」（最近输入 / 改尺寸的那端，`role.owner`）应答程序发来的终端查询
// （DA / DSR / OSC 颜色…）：每个浏览器里的 xterm 都会应答，多端都回的话程序只读一份，
// 剩下的会被当成键盘输入打进去。
//
// 重同步（新连接 / 回到前台）时服务端先发 `replay`，紧跟的那一个二进制帧是「RIS + 最近
// 输出重放 + 模式补发」。重放内容里夹着程序当初发的终端查询（DA / DSR / OSC 颜色查询…），
// xterm 消化时会照常应答——这些应答是对历史的回答，客户端必须丢掉，否则会被当成键盘
// 输入打进 shell（实测 tmux 重放后 shell 里冒出 `0;276;0c`）。
//
// 流控：客户端每消化（xterm write 回调）约 ACK_BYTES 字节回一次 ack；服务端按「已发未
// ack」字节数做水位线背压——超过 HIGH_WATER 暂停读 PTY（写端随之阻塞，`cat` 大文件
// 不会把浏览器灌死，Ctrl-C 立即生效），回落到 LOW_WATER 以下再恢复。

export type HostTerminalTarget =
  | { kind: 'shell' }
  | { kind: 'tmux'; session: string }
  | { kind: 'herdr'; session: string };

export type HostTerminalKind = HostTerminalTarget['kind'];

/** 一个活着的宿主终端（服务端注册表里的一项）。 */
export interface HostTerminalInfo {
  id: string;
  target: HostTerminalTarget;
  /** 标签页显示名：shell 名 / tmux session 名 / herdr session 名。 */
  label: string;
  createdAt: number;
  cols: number;
  rows: number;
  /** 当前连着的浏览器数。 */
  clients: number;
}

export interface HostTmuxSessionEntry {
  name: string;
  windows: number;
  /** 已经 attach 在这个 session 上的 tmux client 数（不含本页）。 */
  attached: number;
  /** 最近活动时间（ms epoch）；tmux 没给时为 0。 */
  activity: number;
  /** 当前窗格的前台命令（如 zsh / vim / claude）。 */
  command?: string;
  /** `bmx-*`：botmux 托管会话的 tmux session。 */
  managed: boolean;
  /** 托管会话对应的 bot / 话题名（dashboard 能对上时才有）。 */
  title?: string;
}

export interface HostHerdrSessionEntry {
  name: string;
  running: boolean;
  isDefault: boolean;
}

/** 「连接」选择器里可选的目标。 */
export interface HostTerminalTargets {
  shell: { path: string; name: string };
  tmux: { available: boolean; sessions: HostTmuxSessionEntry[]; error?: string };
  herdr: { available: boolean; sessions: HostHerdrSessionEntry[]; error?: string };
}

export type HostTerminalServerControl =
  | { t: 'hello'; terminal: HostTerminalInfo }
  | { t: 'replay' }
  | { t: 'size'; cols: number; rows: number }
  | { t: 'role'; owner: boolean }
  | { t: 'exit'; code: number | null; signal: number | null };

export type HostTerminalClientControl =
  | { t: 'resize'; cols: number; rows: number }
  // xterm 对终端查询的自动应答：照写进 PTY，但不算用户输入（不转移主控、不接管尺寸）。
  | { t: 'reply'; data: string }
  | { t: 'ack'; bytes: number }
  | { t: 'visibility'; hidden: boolean };

/** 客户端累计消化这么多字节回一次 ack（空闲时把零头也补齐）。 */
export const HOST_TERMINAL_ACK_BYTES = 64 * 1024;
/** 任一可见客户端「已发未 ack」超过它就暂停读 PTY。 */
export const HOST_TERMINAL_HIGH_WATER = 1024 * 1024;
/** 所有可见客户端都回落到它以下才恢复读 PTY。 */
export const HOST_TERMINAL_LOW_WATER = 256 * 1024;

export const HOST_TERMINAL_API = '/api/host-terminal';
export const HOST_TERMINAL_WS_PREFIX = '/host-terminal/';

export function hostTerminalWsPath(id: string): string {
  return `${HOST_TERMINAL_WS_PREFIX}${encodeURIComponent(id)}/ws`;
}

/** 终端尺寸的合法区间：挡住 0/负数/NaN 与离谱的大值（PTY winsize 是 u16）。 */
export function clampTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = typeof cols === 'number' ? Math.floor(cols) : NaN;
  const r = typeof rows === 'number' ? Math.floor(rows) : NaN;
  if (!Number.isFinite(c) || !Number.isFinite(r) || c < 2 || r < 1) return null;
  return { cols: Math.min(c, 1000), rows: Math.min(r, 500) };
}

/**
 * tmux / herdr session 名的准入：非空、≤128、无控制字符、不以 `-` 开头。
 * 名字只会作为 argv 元素传给 tmux / herdr（不过 shell），这里挡的是 `-x` 被当成
 * 选项、以及换行之类会把日志/界面搞乱的字节。存在性另由列表校验。
 */
export function isValidMultiplexerSessionName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 128
    && !name.startsWith('-')
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(name);
}

export function parseHostTerminalTarget(raw: unknown): HostTerminalTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'shell') return { kind: 'shell' };
  if ((r.kind === 'tmux' || r.kind === 'herdr') && isValidMultiplexerSessionName(r.session)) {
    return { kind: r.kind, session: r.session };
  }
  return null;
}

/** 目标的稳定键：同一个 tmux/herdr session 在前端只开一个标签。 */
export function hostTerminalTargetKey(target: HostTerminalTarget): string {
  return target.kind === 'shell' ? 'shell' : `${target.kind}:${target.session}`;
}

export function parseClientControl(text: string): HostTerminalClientControl | null {
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.t === 'resize') {
    const size = clampTerminalSize(m.cols, m.rows);
    return size ? { t: 'resize', ...size } : null;
  }
  if (m.t === 'ack' && typeof m.bytes === 'number' && Number.isFinite(m.bytes) && m.bytes > 0) {
    return { t: 'ack', bytes: Math.floor(m.bytes) };
  }
  if (m.t === 'visibility' && typeof m.hidden === 'boolean') return { t: 'visibility', hidden: m.hidden };
  if (m.t === 'reply' && typeof m.data === 'string' && m.data.length > 0 && m.data.length <= 4096) {
    return { t: 'reply', data: m.data };
  }
  return null;
}

export function parseServerControl(text: string): HostTerminalServerControl | null {
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.t === 'hello' && m.terminal && typeof m.terminal === 'object') return m as HostTerminalServerControl;
  if (m.t === 'replay') return { t: 'replay' };
  if (m.t === 'role' && typeof m.owner === 'boolean') return { t: 'role', owner: m.owner };
  if (m.t === 'size') {
    const size = clampTerminalSize(m.cols, m.rows);
    return size ? { t: 'size', ...size } : null;
  }
  if (m.t === 'exit') {
    return {
      t: 'exit',
      code: typeof m.code === 'number' ? m.code : null,
      signal: typeof m.signal === 'number' ? m.signal : null,
    };
  }
  return null;
}
