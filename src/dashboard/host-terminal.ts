// src/dashboard/host-terminal.ts
//
// 宿主网页终端（Dashboard → 管理 → 终端）：dashboard 进程内用 node-pty 起
//   - 本机登录 shell（passwd 里登记的那个，`-l`，HOME 起步）——不问目录、不继承
//     dashboard 进程 env，按 SSH 登录的口径给一份干净环境，其余交给用户自己的 rc；
//   - `tmux attach` 到本机任一 tmux session（botmux 托管的 `bmx-*` 带 ignore-size，
//     不改 bot 窗口尺寸）；
//   - `herdr session attach` 到本机 herdr session。
// 多个终端并存、浏览器断开后保留一段时间，刷新/换设备打开都能续上。
//
// 性能取向（对标原生终端）：
//  - 下行零转码：PTY 用 `encoding: null` 读出原始字节，二进制 WS 帧直发，服务端不做
//    UTF-8 解码/JSON 包装；同一轮 IO 里读到的多块在 setImmediate 合并成一帧——空闲时
//    单个回显不额外等待，洪水输出时帧数大幅下降。
//  - 背压：按客户端 ack 的「已发未消化」字节做水位线，超线 pause PTY（写端被内核
//    阻塞），浏览器不会被 `cat` 大文件灌死，Ctrl-C 也不会排在几十 MB 输出后面。
//    后台标签页（浏览器节流定时器）不参与背压，积压超限就停投、回到前台整屏重同步——
//    不能让一个看不见的标签页把正在跑的构建卡住。
//  - tmux / herdr 走它们自己的 attach 客户端：原生、实时、带全量重绘，不经 worker 那条
//    send-keys / 定时轮询的链路。
//  - 服务端不跑终端仿真器（见 host-terminal-replay.ts），重连靠「原始输出环 + 模式补发 +
//    SIGWINCH 让前台程序重绘」。
//
// 安全边界：这是一个**可写宿主 shell**。HTTP 路由挂在 dashboard auth gate 之后并额外要求
// `legacyAuthed`（dashboard.ts）；WS upgrade 不经 HTTP 门禁，在本模块内显式校验「管理
// cookie **且** legacy 管理身份」，带平台角色头（`X-Botmux-Role`，如 `t-` 终端分享子域）的
// 请求一律拒（角色头只在本机已绑定平台、且值是 owner/teammate/guest 之一时生效，见
// request-identity.ts），`Origin: null` 拒死。可信 Origin 档位见 dashboard/control-csrf.ts 的
// classifyManagementUpgrade。
//
// 注意：中心平台的机器 Dashboard（`m-` 子域）反代**故意不注入角色头**（平台侧决定：协管者
// 与机器主人等能力），所以从那里进来的机器主人和协管者在本机都解析成 legacy 管理身份，
// 能用宿主终端——与原调试终端、write-link 等 legacy-only 的面同一口径。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as pty from '../utils/pty.js';
import { logger } from '../utils/logger.js';
import { isExecutable, locateExecutable } from '../utils/executable.js';
import { herdrExecutable } from '../utils/herdr-executable.js';
import { redactChildEnv } from '../utils/child-env.js';
import { parseCookie } from './auth.js';
import {
  HOST_TERMINAL_API,
  HOST_TERMINAL_HIGH_WATER,
  HOST_TERMINAL_LOW_WATER,
  HOST_TERMINAL_WS_PREFIX,
  clampTerminalSize,
  hostTerminalTargetKey,
  parseClientControl,
  parseHostTerminalTarget,
  type HostHerdrSessionEntry,
  type HostTerminalInfo,
  type HostTerminalServerControl,
  type HostTerminalTarget,
  type HostTerminalTargets,
  type HostTmuxSessionEntry,
} from './host-terminal-protocol.js';
import { OutputRing, TerminalModeTracker, incompleteTailStart } from './host-terminal-replay.js';

/** 同时存在的宿主终端上限——挡住失控泄漏 PTY。 */
const MAX_TERMINALS = 16;
/** 没有浏览器连着之后多久回收：shell 留得久（里面可能有正在跑的东西）；tmux/herdr
 *  只是 attach 客户端，断了不丢任何状态，早点回收。 */
const SHELL_IDLE_MS = 30 * 60_000;
const ATTACH_IDLE_MS = 5 * 60_000;
/** 重连时重放的原始输出。 */
const RING_BYTES = 1024 * 1024;
/** 单帧上限：攒到这么多立刻发，不等 setImmediate。 */
const MAX_FRAME_BYTES = 256 * 1024;
/** 后台标签页最多积压这么多就停投，等它回前台再整屏重同步。 */
const HIDDEN_BACKLOG_BYTES = 4 * 1024 * 1024;
/** 可见客户端在 PTY 暂停期间这么久不 ack，视为卡死：停投并恢复 PTY，别让它拖住别人。 */
const STALL_MS = 15_000;
const LIST_TIMEOUT_MS = 3_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

const DEFAULT_LOGIN_PATH = process.platform === 'darwin'
  ? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

interface Client {
  ws: WebSocket;
  /** 已发未 ack 的字节。 */
  unacked: number;
  hidden: boolean;
  /** 积压过多 / 卡死而停投；回到可见时整屏重同步。 */
  stale: boolean;
  lastAckAt: number;
}

interface HostTerminal {
  id: string;
  target: HostTerminalTarget;
  label: string;
  createdAt: number;
  cols: number;
  rows: number;
  proc: pty.IPty;
  ring: OutputRing;
  modes: TerminalModeTracker;
  clients: Set<Client>;
  /** 主控端：最近输入 / 改尺寸的客户端，只有它应答终端查询（见协议注释）。 */
  owner: Client | null;
  pending: Buffer[];
  pendingBytes: number;
  /** 当前待发帧开头时是否在备用屏 / 跨进这一帧的半截序列（进环形缓冲时一起记，见 OutputRing.push）。 */
  pendingAlt: boolean;
  pendingCarry: Buffer | null;
  flushQueued: boolean;
  paused: boolean;
  stallTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  lastRedrawAt: number;
  exited: boolean;
}

export interface HostTerminalManager {
  /** 处理 `/api/host-terminal*`；返回 true 表示已接管。假定调用方已过 auth gate + legacyAuthed。 */
  handleHttp: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /** 处理 `/host-terminal/<id>/ws` upgrade；返回 true 表示已接管。本模块内部自校验身份。 */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** 关掉所有终端（dashboard 退出时）。 */
  shutdown: () => void;
}

export interface HostTerminalDeps {
  /** 返回当前有效的管理 token，用于 WS upgrade 的 cookie 校验。 */
  getActiveToken: () => string | null;
  /**
   * 本请求是否解析成 **legacy-dashboard 管理身份**——与 `/api/host-terminal` 的 HTTP 门禁
   * （dashboard.ts 的 `legacyAuthed`）同一口径。只比 cookie 不够：中心化平台隧道会剥掉
   * 浏览器 Cookie、注入本机活跃 cookie，带 `X-Botmux-Role` 的请求（终端分享子域等）cookie
   * 也对得上，但身份是平台角色、不是本机管理身份。必填（不给默认值），漏接线在类型层报错。
   */
  isLegacyManagementRequest: (req: IncomingMessage) => boolean;
  /** `bmx-*` tmux session 对应的 bot / 话题名，列表里给托管会话起个人话名字。 */
  describeManagedTmuxSession?: (name: string) => string | undefined;
  /** 测试注入：tmux 的前置参数（如 `-L <socket>`），生产不传 = 用户默认 tmux server。 */
  tmuxArgs?: string[];
  /** 测试注入：固定登录 shell，生产不传 = passwd 里登记的那个。 */
  loginShell?: string;
}

const PASSWD_SHELL_TTL_MS = 60_000;
let passwdShellCache: { value: string | null; at: number } | null = null;

function execText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 1500, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * passwd 里给当前用户登记的 shell（`chsh` 改的那个）。不能直接用 `os.userInfo().shell`：
 * Node 的实现是 getpwuid，但 Bun 的只是把 `$SHELL` 原样返回（实测，没设时是 "unknown"）——
 * 线上 dashboard 跑在 Bun 下，拿到的就是 daemon 启动环境里的 shell 而不是用户的。
 * Linux 用 getent（覆盖 LDAP/NSS），macOS 用 dscl，再不行解析 /etc/passwd。缓存一分钟。
 */
async function passwdShell(): Promise<string | null> {
  if (passwdShellCache && Date.now() - passwdShellCache.at < PASSWD_SHELL_TTL_MS) return passwdShellCache.value;
  let value: string | null = null;
  let uid = -1;
  let username = '';
  try { ({ uid, username } = userInfo()); } catch { /* no passwd entry */ }
  if (process.platform === 'darwin' && username) {
    value = (await execText('dscl', ['.', '-read', `/Users/${username}`, 'UserShell']))?.match(/UserShell:\s*(\S+)/)?.[1] ?? null;
  } else if (uid >= 0) {
    value = (await execText('getent', ['passwd', String(uid)]))?.trim().split(':')[6] || null;
  }
  if (!value && uid >= 0) {
    try {
      const line = (await readFile('/etc/passwd', 'utf8')).split('\n').find(l => l.split(':')[2] === String(uid));
      value = line?.split(':')[6]?.trim() || null;
    } catch { /* no /etc/passwd */ }
  }
  if (!value && !process.versions.bun) {
    try { value = userInfo().shell ?? null; } catch { /* ignore */ }
  }
  passwdShellCache = { value, at: Date.now() };
  return value;
}

/** passwd 里登记的登录 shell；取不到 / 不可执行就退回 $SHELL → bash → sh。 */
export async function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromPasswd = await passwdShell();
  for (const candidate of [fromPasswd, env.SHELL, '/bin/bash', '/bin/sh']) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return '/bin/sh';
}

function hasLocale(env: Record<string, string>): boolean {
  return Object.keys(env).some(k => k === 'LANG' || k.startsWith('LC_'));
}

/**
 * 登录环境：只给 sshd 那一档的基础变量，其余（PATH 扩展、nvm/fnm、代理…）全由用户
 * 自己的登录 rc 负责——这就是「本机啥配置就用啥配置」。
 *
 * 不继承 dashboard 进程 env 同时也是安全边界：dashboard 是全机唯一持有飞书 H5 登录
 * 凭据（BOTMUX_DASHBOARD_FEISHU_H5_*，含 APP_SECRET）的进程，继承的话一条 `env` 就能
 * 读到。语言区域与 tmux socket 目录照 sshd `AcceptEnv LANG LC_*` 的口径透传：前者决定
 * 中文能不能正常显示，后者决定 attach 的是不是 botmux 正在用的那个 tmux server。
 */
export function hostLoginEnv(shell: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  let user: { username: string; homedir: string } = { username: base.USER ?? '', homedir: homedir() };
  try { user = userInfo(); } catch { /* keep env fallback */ }
  const env: Record<string, string> = {
    HOME: user.homedir || homedir(),
    USER: user.username,
    LOGNAME: user.username,
    SHELL: shell,
    PATH: DEFAULT_LOGIN_PATH,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string' || !v) continue;
    if (k === 'LANG' || k.startsWith('LC_') || k === 'TZ' || k === 'TMPDIR' || k === 'TMUX_TMPDIR') env[k] = v;
    // XDG 目录决定 herdr 等工具去哪找自己的会话 / 配置：列表是用 dashboard 的环境查出来的，
    // attach 必须指向同一处，否则自定义了 XDG_CONFIG_HOME 时列出来的会话连不上。
    if (/^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(k) || k === 'XDG_RUNTIME_DIR') env[k] = v;
  }
  if (!hasLocale(env)) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return env;
}

interface ExecResult { ok: boolean; stdout: string; stderr: string; missing: boolean }

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: code === 'ENOENT' });
    });
  });
}

/** 查子进程的前台进程组，给它发 SIGWINCH 让全屏程序整屏重绘（默认动作是忽略，安全）。 */
function signalForegroundWinch(pid: number): void {
  execFile('ps', ['-o', 'tpgid=', '-p', String(pid)], { timeout: 1500 }, (err, stdout) => {
    const pgid = Number(String(stdout ?? '').trim());
    try {
      if (!err && Number.isInteger(pgid) && pgid > 1) process.kill(-pgid, 'SIGWINCH');
      else process.kill(pid, 'SIGWINCH');
    } catch { /* process gone */ }
  });
}

export function createHostTerminalManager(deps: HostTerminalDeps): HostTerminalManager {
  const terminals = new Map<string, HostTerminal>();
  const tmuxPrefix = deps.tmuxArgs ?? [];
  const loginShell = async (): Promise<string> => deps.loginShell ?? await resolveLoginShell();

  const tmuxBin = (): string | null => locateExecutable('tmux');
  // 列表 / 探测用的短命子进程也不带 dashboard 独有的凭据（H5 登录族等）：和 dashboard 其它
  // 子进程同一条脱敏边界（redactChildEnv），定位相关的变量（TMUX_TMPDIR / XDG / HERDR_*）保留。
  const listEnv = (): NodeJS.ProcessEnv => redactChildEnv(process.env);
  const tmuxListEnv = (): NodeJS.ProcessEnv => {
    const env = listEnv();
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
  };

  async function listTmux(): Promise<HostTerminalTargets['tmux']> {
    const bin = tmuxBin();
    if (!bin) return { available: false, sessions: [] };
    const fmt = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}';
    const r = await run(bin, [...tmuxPrefix, 'list-sessions', '-F', fmt], tmuxListEnv());
    if (!r.ok) {
      // 没有 tmux server 在跑是常态，不算错误。
      if (/no server running|error connecting|No such file or directory/i.test(r.stderr)) return { available: true, sessions: [] };
      return { available: true, sessions: [], error: r.stderr.trim().slice(0, 200) || 'tmux_list_failed' };
    }
    const sessions: HostTmuxSessionEntry[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [name, windows, attached, activity, command] = line.split('\t');
      if (!name) continue;
      const managed = name.startsWith('bmx-');
      const entry: HostTmuxSessionEntry = {
        name,
        windows: Number(windows) || 0,
        attached: Number(attached) || 0,
        activity: (Number(activity) || 0) * 1000,
        managed,
      };
      if (command) entry.command = command;
      if (managed) {
        const title = deps.describeManagedTmuxSession?.(name);
        if (title) entry.title = title;
      }
      sessions.push(entry);
    }
    // 用户自己的在前、托管的在后；各自按最近活动倒序。
    sessions.sort((a, b) => Number(a.managed) - Number(b.managed) || b.activity - a.activity);
    return { available: true, sessions };
  }

  async function listHerdr(): Promise<HostTerminalTargets['herdr']> {
    const bin = herdrExecutable();
    if (bin === 'herdr' && !locateExecutable('herdr')) return { available: false, sessions: [] };
    const r = await run(bin, ['session', 'list', '--json'], listEnv());
    if (r.missing) return { available: false, sessions: [] };
    if (!r.ok) return { available: true, sessions: [], error: r.stderr.trim().slice(0, 200) || 'herdr_list_failed' };
    try {
      const parsed = JSON.parse(r.stdout) as { sessions?: Array<{ name?: unknown; running?: unknown; default?: unknown }> };
      const sessions: HostHerdrSessionEntry[] = (parsed.sessions ?? [])
        .filter((s): s is { name: string; running?: unknown; default?: unknown } => typeof s.name === 'string' && !!s.name)
        .map(s => ({ name: s.name, running: s.running === true, isDefault: s.default === true }));
      sessions.sort((a, b) => Number(b.running) - Number(a.running) || Number(b.isDefault) - Number(a.isDefault)
        || a.name.localeCompare(b.name));
      return { available: true, sessions };
    } catch {
      return { available: true, sessions: [], error: 'herdr_list_unparseable' };
    }
  }

  async function listTargets(): Promise<HostTerminalTargets> {
    const [shell, tmux, herdr] = await Promise.all([loginShell(), listTmux(), listHerdr()]);
    return { shell: { path: shell, name: basename(shell) }, tmux, herdr };
  }

  type SpawnSpec = { file: string; args: string[]; label: string; env: Record<string, string> };

  /** 校验目标仍存在并给出 spawn 参数；不存在返回错误码。 */
  async function resolveSpawn(target: HostTerminalTarget): Promise<SpawnSpec | { error: string }> {
    const shell = await loginShell();
    const env = hostLoginEnv(shell);
    if (target.kind === 'shell') {
      return { file: shell, args: ['-l'], label: basename(shell), env };
    }
    if (target.kind === 'tmux') {
      const bin = tmuxBin();
      if (!bin) return { error: 'tmux_unavailable' };
      const exact = `=${target.session}`;
      const probe = await run(bin, [...tmuxPrefix, 'has-session', '-t', exact], tmuxListEnv());
      if (!probe.ok) return { error: 'tmux_session_not_found' };
      // 托管会话的窗口尺寸由 worker 管，这边 attach 不能把它撑大/缩小。
      const sizeFlags = target.session.startsWith('bmx-') ? ['-f', 'ignore-size'] : [];
      return {
        file: bin,
        // -E：不按 update-environment 用本客户端的环境改写会话环境。网页端给的是干净登录
        // 环境，没有 SSH_AUTH_SOCK / DISPLAY 等，不加的话连一次就会把这些从会话里删掉，
        // 会话之后新开的窗口就没了 SSH agent / 图形访问。
        args: [...tmuxPrefix, '-u', 'attach-session', '-E', ...sizeFlags, '-t', exact],
        label: target.session,
        env,
      };
    }
    const herdr = await listHerdr();
    if (!herdr.available) return { error: 'herdr_unavailable' };
    const entry = herdr.sessions.find(s => s.name === target.session);
    if (!entry) return { error: 'herdr_session_not_found' };
    // 默认会话就是裸 `herdr`（launch or attach）；具名会话运行中直接 attach，停着的用
    // `--session` 拉起（herdr 自己的语义：use or create）。
    const args = entry.isDefault ? []
      : entry.running ? ['session', 'attach', target.session] : ['--session', target.session];
    // herdr 自己的会话定位开关同理：跟列表查询用同一份。
    for (const k of ['HERDR_CONFIG_PATH', 'HERDR_SOCKET_PATH']) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    return { file: herdrExecutable(), args, label: `herdr · ${target.session}`, env };
  }

  function info(term: HostTerminal): HostTerminalInfo {
    return {
      id: term.id,
      target: term.target,
      label: term.label,
      createdAt: term.createdAt,
      cols: term.cols,
      rows: term.rows,
      clients: term.clients.size,
    };
  }

  function sendControl(ws: WebSocket, msg: HostTerminalServerControl): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function destroy(term: HostTerminal, reason: string, exit?: { code: number | null; signal: number | null }): void {
    if (term.exited) return;
    term.exited = true;
    if (term.idleTimer) clearTimeout(term.idleTimer);
    if (term.stallTimer) clearTimeout(term.stallTimer);
    flush(term);
    for (const c of term.clients) {
      sendControl(c.ws, { t: 'exit', code: exit?.code ?? null, signal: exit?.signal ?? null });
      try { c.ws.close(1000, reason.slice(0, 100)); } catch { /* ignore */ }
    }
    term.clients.clear();
    try { term.proc.kill(); } catch { /* already gone */ }
    terminals.delete(term.id);
    logger.info(`[host-terminal] destroyed ${term.id} ${hostTerminalTargetKey(term.target)} (${reason})`);
  }

  function armIdleTimer(term: HostTerminal): void {
    if (term.idleTimer) clearTimeout(term.idleTimer);
    const grace = term.target.kind === 'shell' ? SHELL_IDLE_MS : ATTACH_IDLE_MS;
    term.idleTimer = setTimeout(() => {
      if (term.clients.size === 0) destroy(term, 'idle');
    }, grace);
    term.idleTimer.unref?.();
  }

  // ── 下行：合帧 + 背压 ─────────────────────────────────────────────────────
  function onOutput(term: HostTerminal, chunk: Buffer): void {
    if (term.exited || chunk.length === 0) return;
    if (term.pendingBytes === 0) {
      term.pendingAlt = term.modes.altScreen;
      term.pendingCarry = term.modes.pendingSequence();
    }
    term.modes.feed(chunk);
    term.pending.push(chunk);
    term.pendingBytes += chunk.length;
    if (term.pendingBytes >= MAX_FRAME_BYTES) {
      flush(term);
    } else if (!term.flushQueued) {
      term.flushQueued = true;
      setImmediate(() => { term.flushQueued = false; flush(term); });
    }
  }

  function flush(term: HostTerminal): void {
    if (term.pendingBytes === 0) return;
    const frame = term.pending.length === 1 ? term.pending[0] : Buffer.concat(term.pending, term.pendingBytes);
    term.pending = [];
    term.pendingBytes = 0;
    term.ring.push(frame, term.pendingAlt, term.pendingCarry);
    for (const c of term.clients) deliver(term, c, frame);
    updateBackpressure(term);
  }

  function deliver(term: HostTerminal, c: Client, frame: Buffer): void {
    if (c.stale || c.ws.readyState !== WebSocket.OPEN) return;
    if (c.hidden && c.unacked > HIDDEN_BACKLOG_BYTES) {
      markStale(term, c);
      return;
    }
    c.ws.send(frame, { binary: true });
    c.unacked += frame.length;
  }

  function updateBackpressure(term: HostTerminal): void {
    if (term.exited) return;
    let worst = 0;
    for (const c of term.clients) {
      if (c.hidden || c.stale) continue;
      worst = Math.max(worst, c.unacked);
    }
    if (!term.paused && worst > HOST_TERMINAL_HIGH_WATER) {
      term.paused = true;
      try { term.proc.pause(); } catch { /* pty gone */ }
      armStallTimer(term);
    } else if (term.paused && worst < HOST_TERMINAL_LOW_WATER) {
      term.paused = false;
      if (term.stallTimer) { clearTimeout(term.stallTimer); term.stallTimer = null; }
      try { term.proc.resume(); } catch { /* pty gone */ }
    }
  }

  function armStallTimer(term: HostTerminal): void {
    if (term.stallTimer) clearTimeout(term.stallTimer);
    term.stallTimer = setTimeout(() => {
      term.stallTimer = null;
      if (!term.paused || term.exited) return;
      const now = Date.now();
      for (const c of term.clients) {
        if (!c.hidden && !c.stale && c.unacked > HOST_TERMINAL_LOW_WATER && now - c.lastAckAt >= STALL_MS) {
          markStale(term, c);
          logger.warn(`[host-terminal] ${term.id}: client stalled ${Math.round((now - c.lastAckAt) / 1000)}s, pausing delivery`);
        }
      }
      updateBackpressure(term);
      if (term.paused) armStallTimer(term);
    }, STALL_MS);
    term.stallTimer.unref?.();
  }

  /** 整屏重同步：RIS 复位 + 重放原始输出 + 补发模式；全屏程序再发 SIGWINCH 让它重绘。 */
  function resync(term: HostTerminal, c: Client): void {
    flush(term);
    c.stale = false;
    const snap = term.ring.snapshot();
    // 快照末尾可能是半截转义序列 / 半个 UTF-8 字符（下一块 PTY 输出才补完）：模式补发
    // 插在它前面，半截留在最后，让接下来的实时输出把它接上。
    const cut = incompleteTailStart(snap.bytes);
    const replay = Buffer.concat([
      // RIS 之后先回到快照开头时所在的屏，再画快照（DECSET 1047 只切屏，不动保存的光标）。
      Buffer.from(snap.altAtStart ? '\x1bc\x1b[?1047h' : '\x1bc', 'latin1'),
      snap.bytes.subarray(0, cut),
      Buffer.from(term.modes.restoreSequence(), 'latin1'),
      snap.bytes.subarray(cut),
    ]);
    if (c.ws.readyState === WebSocket.OPEN) {
      // 先告诉客户端下一帧是重放：消化它时 xterm 对历史查询的应答要丢掉。
      sendControl(c.ws, { t: 'replay' });
      c.ws.send(replay, { binary: true });
      c.unacked += replay.length;
    }
    if (term.modes.altScreen || term.target.kind !== 'shell') requestRedraw(term);
    updateBackpressure(term);
  }

  /**
   * 让全屏程序整屏重绘。tmux / herdr 客户端收到 SIGWINCH 一定整屏重画；shell 里跑的 TUI
   * 不一定（htop 尺寸没变时对 SIGWINCH 不出任何字节），所以给 PTY 来一次「缩一行再复原」，
   * 让前台程序看到真实的尺寸变化。
   */
  function requestRedraw(term: HostTerminal): void {
    const now = Date.now();
    if (now - term.lastRedrawAt < 300) return;
    term.lastRedrawAt = now;
    if (term.target.kind !== 'shell') {
      signalForegroundWinch(term.proc.pid);
      return;
    }
    const { cols, rows } = term;
    try { term.proc.resize(cols, rows > 2 ? rows - 1 : rows + 1); } catch { return; }
    setTimeout(() => {
      if (term.exited) return;
      // 期间有客户端改过尺寸就以它为准。
      try { term.proc.resize(term.cols, term.rows); } catch { /* pty gone */ }
    }, 60).unref?.();
  }

  async function create(target: HostTerminalTarget, size: { cols: number; rows: number } | null): Promise<HostTerminal | { error: string }> {
    if (terminals.size >= MAX_TERMINALS) return { error: 'too_many_terminals' };
    const spec = await resolveSpawn(target);
    if ('error' in spec) return spec;
    // resolveSpawn 是异步的，两个并发创建可能同时过了上面的上限检查。
    if (terminals.size >= MAX_TERMINALS) return { error: 'too_many_terminals' };
    const cols = size?.cols ?? DEFAULT_COLS;
    const rows = size?.rows ?? DEFAULT_ROWS;
    let proc: pty.IPty;
    try {
      // encoding:null 让输出保持原始字节（零转码），但 node-pty 只在 encoding==='utf8' 时给
      // PTY 打开 IUTF8——没有它，规范模式（cat / read / python input）里退格一次只删一个
      // 字节，输入中文再退格会留下半个字符。由 sh 先 `stty iutf8` 再 exec 目标程序（同一
      // pid、同一 argv），失败（不支持的平台）就照常 exec。
      proc = pty.spawn('/bin/sh', ['-c', 'stty iutf8 2>/dev/null; exec "$@"', 'sh', spec.file, ...spec.args], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.env.HOME || homedir(),
        env: spec.env,
        encoding: null,
      });
    } catch (err: any) {
      return { error: `spawn_failed: ${err?.message ?? err}` };
    }
    const term: HostTerminal = {
      id: randomBytes(9).toString('base64url'),
      target,
      label: spec.label,
      createdAt: Date.now(),
      cols,
      rows,
      proc,
      ring: new OutputRing(RING_BYTES),
      modes: new TerminalModeTracker(),
      clients: new Set(),
      owner: null,
      pending: [],
      pendingBytes: 0,
      pendingAlt: false,
      pendingCarry: null,
      flushQueued: false,
      paused: false,
      stallTimer: null,
      idleTimer: null,
      lastRedrawAt: 0,
      exited: false,
    };
    // node-pty 的类型把 onData 标成 string；encoding:null 下实际是 Buffer（测试桩可能给 string）。
    proc.onData((d: string | Buffer) => onOutput(term, typeof d === 'string' ? Buffer.from(d, 'utf8') : d));
    // node-pty 用 signal 0 表示「不是被信号杀的」。
    proc.onExit(({ exitCode, signal }) => destroy(term, 'process_exited', { code: exitCode ?? null, signal: signal || null }));
    terminals.set(term.id, term);
    armIdleTimer(term);
    logger.info(`[host-terminal] created ${term.id} ${hostTerminalTargetKey(target)} ${cols}x${rows} (total ${terminals.size})`);
    return term;
  }

  function isAuthed(req: IncomingMessage): boolean {
    const active = deps.getActiveToken();
    if (!active) return false;
    // `Origin: null` 只可能来自 opaque origin 文档（沙箱化的网页预览就是一个）。这条 WS
    // 是「拿宿主 shell」的最后一跳，不依赖单一层防线，这里显式拒死。
    if (req.headers.origin === 'null') return false;
    const cookieTok = parseCookie(req.headers.cookie);
    if (!cookieTok || cookieTok !== active) return false;
    // cookie 只是必要条件：平台隧道注入的也是这枚活跃 cookie。
    if (!deps.isLegacyManagementRequest(req)) {
      logger.warn('[host-terminal] 拒绝非本机管理身份的 WS 升级'
        + '（cookie 有效但不是 legacy-dashboard 身份，例如经中心平台隧道注入的角色）');
      return false;
    }
    return true;
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 16 * 1024) throw new Error('body_too_large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const handleHttp: HostTerminalManager['handleHttp'] = (req, res, url) => {
    const p = url.pathname;
    if (p !== HOST_TERMINAL_API && !p.startsWith(`${HOST_TERMINAL_API}/`)) return false;

    // 列出活着的终端：GET /api/host-terminal
    if (req.method === 'GET' && p === HOST_TERMINAL_API) {
      json(res, 200, { ok: true, terminals: [...terminals.values()].map(info) });
      return true;
    }

    // 可连接的目标：GET /api/host-terminal/targets
    if (req.method === 'GET' && p === `${HOST_TERMINAL_API}/targets`) {
      void listTargets().then(
        targets => json(res, 200, { ok: true, targets }),
        err => json(res, 500, { ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }

    // 新建：POST /api/host-terminal { target, cols?, rows? }
    if (req.method === 'POST' && p === HOST_TERMINAL_API) {
      void (async () => {
        let body: any;
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'bad_json' }); }
        const target = parseHostTerminalTarget(body?.target ?? { kind: 'shell' });
        if (!target) return json(res, 400, { ok: false, error: 'bad_target' });
        const r = await create(target, clampTerminalSize(body?.cols, body?.rows));
        if ('error' in r) {
          const status = r.error === 'too_many_terminals' ? 429 : r.error.endsWith('_not_found') ? 404
            : r.error.endsWith('_unavailable') ? 409 : 500;
          return json(res, status, { ok: false, error: r.error });
        }
        json(res, 200, { ok: true, terminal: info(r) });
      })();
      return true;
    }

    // 关闭：POST /api/host-terminal/<id>/close
    const m = p.match(/^\/api\/host-terminal\/([^/]+)\/close$/);
    if (req.method === 'POST' && m) {
      const term = terminals.get(decodeURIComponent(m[1]));
      if (term) destroy(term, 'closed_by_user');
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { ok: false, error: 'not_found' });
    return true;
  };

  // ── WebSocket ───────────────────────────────────────────────────────────────
  // 不绑定 http server（手动 handleUpgrade）：dashboard 的 upgrade 事件全局共享。
  // perMessageDeflate 保持 ws 默认的关闭：终端帧压缩省的带宽换不回 CPU 和延迟。
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });

  function setOwner(term: HostTerminal, owner: Client | null): void {
    if (term.owner === owner) return;
    term.owner = owner;
    for (const c of term.clients) sendControl(c.ws, { t: 'role', owner: c === owner });
  }

  /**
   * 主控端收不到输出（停投 / 切到后台）时，把应答终端查询的职责交给一个能及时收到输出的
   * 端：优先可见的、没停投的；没有就保持不变（总比没人应答好）。
   */
  function handOffOwner(term: HostTerminal, from: Client): void {
    if (term.owner !== from) return;
    const next = pickOwner(term, from);
    if (next && (!next.hidden || from.stale)) setOwner(term, next);
  }

  /** 接任主控的候选：优先可见且没停投的，其次没停投的，最后任意一个（越晚连上越优先）。 */
  function pickOwner(term: HostTerminal, exclude: Client | null): Client | null {
    const others = [...term.clients].filter(c => c !== exclude);
    return others.filter(c => !c.stale && !c.hidden).pop()
      ?? others.filter(c => !c.stale).pop()
      ?? others.pop()
      ?? null;
  }

  function markStale(term: HostTerminal, c: Client): void {
    c.stale = true;
    handOffOwner(term, c);
  }

  function onClientMessage(term: HostTerminal, c: Client, raw: RawData, isBinary: boolean): void {
    if (term.exited) return;
    if (isBinary) {
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (data.length === 0) return;
      setOwner(term, c);
      term.proc.write(data);
      // Bun 下 PTY 读端空闲时是 20ms 一轮的重试；刚写了输入，回显马上就到，催一下。
      pty.nudgeRead(term.proc);
      return;
    }
    const msg = parseClientControl(String(raw));
    if (!msg) return;
    if (msg.t === 'reply') {
      // 主控交接按输出顺序生效：旧主控可能还在合法地应答交接点之前的查询，不能因此把主控
      // 交回给它。
      term.proc.write(msg.data);
      pty.nudgeRead(term.proc);
    } else if (msg.t === 'ack') {
      c.unacked = Math.max(0, c.unacked - msg.bytes);
      c.lastAckAt = Date.now();
      // 卡死被停投的可见客户端追上来了：整屏重同步后恢复投递。
      if (c.stale && !c.hidden && c.unacked < HOST_TERMINAL_LOW_WATER) resync(term, c);
      updateBackpressure(term);
    } else if (msg.t === 'resize') {
      setOwner(term, c);
      if (msg.cols === term.cols && msg.rows === term.rows) {
        // 没变也回给发起者：它的乐观尺寸可能和真实 PTY 对不上，让它对齐。
        sendControl(c.ws, { t: 'size', cols: term.cols, rows: term.rows });
        return;
      }
      // 旧网格上产生、还没发出去的输出先发完，再通知改网格（各端按到达顺序解析）。
      flush(term);
      term.cols = msg.cols;
      term.rows = msg.rows;
      try { term.proc.resize(msg.cols, msg.rows); } catch { /* pty gone */ }
      // 所有端（含发起者）都只在收到这条之后、按输出流顺序改本地网格。
      for (const other of term.clients) sendControl(other.ws, { t: 'size', cols: msg.cols, rows: msg.rows });
    } else if (msg.t === 'visibility') {
      c.hidden = msg.hidden;
      if (msg.hidden) handOffOwner(term, c);
      if (!msg.hidden && c.stale) resync(term, c);
      updateBackpressure(term);
    }
  }

  function detach(term: HostTerminal, c: Client): void {
    if (!term.clients.delete(c)) return;
    if (term.exited) return;
    // 主控端走了：交给最合适的那个，总得有一端应答终端查询。
    if (term.owner === c) setOwner(term, pickOwner(term, null));
    updateBackpressure(term);
    if (term.clients.size === 0) armIdleTimer(term);
  }

  const handleUpgrade: HostTerminalManager['handleUpgrade'] = (req, socket, head) => {
    const pathname = (req.url ?? '/').split(/[?#]/)[0];
    if (!pathname.startsWith(HOST_TERMINAL_WS_PREFIX)) return false;
    const m = pathname.match(/^\/host-terminal\/([^/]+)\/ws$/);
    if (!m) { try { socket.destroy(); } catch { /* ignore */ } return true; }
    if (!isAuthed(req)) { try { socket.destroy(); } catch { /* ignore */ } return true; }
    const term = terminals.get(decodeURIComponent(m[1]));
    if (!term || term.exited) { try { socket.destroy(); } catch { /* ignore */ } return true; }
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      if (term.exited) { try { ws.close(1000, 'process_exited'); } catch { /* ignore */ } return; }
      const c: Client = { ws, unacked: 0, hidden: false, stale: false, lastAckAt: Date.now() };
      term.clients.add(c);
      if (term.idleTimer) { clearTimeout(term.idleTimer); term.idleTimer = null; }
      sendControl(ws, { t: 'hello', terminal: info(term) });
      // 现任主控端已经收不到输出（停投 / 后台）时，新连上的端直接接任——它的尺寸若恰好
      // 和 PTY 一样就不会发 resize，等不到靠交互接管，终端查询就没人应答。
      if (!term.owner || term.owner.stale || term.owner.hidden) setOwner(term, c);
      else sendControl(ws, { t: 'role', owner: false });
      resync(term, c);
      ws.on('message', (raw, isBinary) => onClientMessage(term, c, raw, isBinary));
      ws.on('close', () => detach(term, c));
      ws.on('error', () => detach(term, c));
    });
    return true;
  };

  const shutdown: HostTerminalManager['shutdown'] = () => {
    for (const term of [...terminals.values()]) destroy(term, 'dashboard_shutdown');
  };

  return { handleHttp, handleUpgrade, shutdown };
}
