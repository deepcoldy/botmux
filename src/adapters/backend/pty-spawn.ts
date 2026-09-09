/**
 * PTY spawn 的运行时分流：Node 下用 node-pty，Bun 下用 Bun 原生 PTY
 * （`Bun.spawn` 的 `terminal` 选项，Bun ≥ 1.3 提供 `Bun.Terminal`）。
 *
 * 为什么需要这一层：node-pty 在 Bun 运行时下不可用。它把 pty master fd 包成
 * `tty.ReadStream`，Bun 的实现在 master 暂时没数据时把 `read()` 的 EAGAIN 当作
 * error 抛出并自毁（autoDestroy）；fd 一关，内核就给子进程发 SIGHUP。实测
 * （Bun 1.4.0 + node-pty 1.1.0）：spawn 后约 10ms 子进程即被 SIGHUP，与子进程
 * 有没有输出无关；同一段代码在 Node 22 下正常。node-pty 的 error 回调虽然忽略
 * EAGAIN，但流已经关了，救不回来。
 *
 * 线上分发的编译版单文件二进制就是 Bun 运行时，所以任何经 node-pty 的路径在
 * 编译态都是坏的。默认的 tmux 会话走 pipe 模式不经过 node-pty，所以一直没有
 * 暴露；flow 的 agent worker 每个 attempt 起一个裸 PTY，第一次真飞书运行就踩中
 * （症状：`spawn_failed: claude-code exited before its prompt was ready`，屏幕空白）。
 *
 * 这里只接管 `PtyBackend`。tmux / zellij / herdr 的 attach 客户端与 dashboard
 * 调试终端仍直接调 `pty.spawn`，它们在编译态同样受影响，是独立的 follow-up。
 *
 * 行为对齐 node-pty 的几处细节：
 * - env：删掉 TMUX / TMUX_PANE / STY / WINDOW / WINDOWID / TERMCAP / COLUMNS / LINES，
 *   `TERM` 置为 name（node-pty `_sanitizeEnv` 同一份名单）。
 * - exit：子进程退出后先等 PTY 流关闭（数据全部送达）再发 exit，最多等 200ms
 *   （node-pty `DESTROY_SOCKET_TIMEOUT_MS` 同一数值），避免尾部输出丢在 exit 后面。
 * - kill()：默认 SIGHUP，与 node-pty 一致。
 */
import * as nodePty from 'node-pty';

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 只保证 spawn 之后注册的回调收到数据（与 node-pty 一致）。 */
  onData(cb: (data: string) => void): void;
  /** `signal` 的取值随运行时：node-pty 给信号编号字符串（正常退出为 "0"，SIGHUP
   *  为 "1"），Bun 给信号名（正常退出为 null，否则如 "SIGHUP"）。只用于证据展示。 */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

export type PtyRuntime = 'bun-native' | 'node-pty';

const DEFAULT_TERM_NAME = 'xterm-256color';
/** node-pty 的 `DESTROY_SOCKET_TIMEOUT_MS`：进程退出后最多等这么久让 PTY 流关闭。 */
const PTY_CLOSE_GRACE_MS = 200;
const SANITIZED_ENV_KEYS = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES'] as const;

// Bun 全局在 Node / tsc 下不存在，这里只声明用到的最小形状，运行时再判定。
interface BunTerminalLike {
  readonly closed: boolean;
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}
interface BunSubprocessLike {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly terminal: BunTerminalLike | null;
  kill(signal?: string | number): void;
}
interface BunLike {
  Terminal?: unknown;
  spawn(cmd: string[], opts: Record<string, unknown>): BunSubprocessLike;
}

function bunWithNativePty(): BunLike | null {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun || typeof bun.spawn !== 'function' || typeof bun.Terminal !== 'function') return null;
  return bun;
}

export function ptyRuntime(): PtyRuntime {
  return bunWithNativePty() ? 'bun-native' : 'node-pty';
}

function sanitizedEnv(env: Record<string, string | undefined>, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  for (const k of SANITIZED_ENV_KEYS) delete out[k];
  out.TERM = name;
  return out;
}

export function spawnPty(bin: string, args: string[], opts: PtySpawnOptions): PtyHandle {
  const bun = bunWithNativePty();
  return bun ? spawnBunPty(bun, bin, args, opts) : spawnNodePty(bin, args, opts);
}

function spawnNodePty(bin: string, args: string[], opts: PtySpawnOptions): PtyHandle {
  const proc = nodePty.spawn(bin, args, {
    name: opts.name ?? DEFAULT_TERM_NAME,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  return {
    pid: proc.pid,
    write: (data) => { proc.write(data); },
    resize: (cols, rows) => { proc.resize(cols, rows); },
    onData: (cb) => { proc.onData(cb); },
    onExit: (cb) => {
      // 与改造前 PtyBackend 的换算逐字一致（node-pty 正常退出时 signal 为 0 → "0"），
      // Node 路径不改任何可观察行为。
      proc.onExit(({ exitCode, signal }) => {
        cb(exitCode, signal !== undefined ? String(signal) : null);
      });
    },
    kill: (signal) => { proc.kill(signal); },
  };
}

function spawnBunPty(bun: BunLike, bin: string, args: string[], opts: PtySpawnOptions): PtyHandle {
  const name = opts.name ?? DEFAULT_TERM_NAME;
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  const decoder = new TextDecoder('utf-8');
  let streamClosed = false;
  let notifyStreamClosed: (() => void) | null = null;

  const emitData = (text: string): void => {
    if (!text) return;
    for (const cb of dataListeners) cb(text);
  };

  const proc = bun.spawn([bin, ...args], {
    cwd: opts.cwd,
    env: sanitizedEnv(opts.env, name),
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name,
      data: (_term: unknown, chunk: Uint8Array) => { emitData(decoder.decode(chunk, { stream: true })); },
      exit: () => {
        streamClosed = true;
        notifyStreamClosed?.();
      },
    },
  });

  const settle = (code: number | null, signal: string | null): void => {
    emitData(decoder.decode());
    try { if (proc.terminal && !proc.terminal.closed) proc.terminal.close(); } catch { /* already closed */ }
    for (const cb of exitListeners) cb(code, signal);
  };

  proc.exited.then(
    (code) => {
      const finish = (): void => settle(proc.exitCode ?? code, proc.signalCode ?? null);
      if (streamClosed) { finish(); return; }
      // 进程已退出但 PTY 流还没关：尾部输出可能还在路上，等一小会儿。
      const timer = setTimeout(() => { notifyStreamClosed = null; finish(); }, PTY_CLOSE_GRACE_MS);
      notifyStreamClosed = () => { clearTimeout(timer); notifyStreamClosed = null; finish(); };
    },
    () => settle(null, null),
  );

  return {
    pid: proc.pid,
    write: (data) => {
      const term = proc.terminal;
      if (!term || term.closed) return;
      term.write(data);
    },
    resize: (cols, rows) => {
      const term = proc.terminal;
      if (!term || term.closed) return;
      term.resize(cols, rows);
    },
    onData: (cb) => { dataListeners.push(cb); },
    onExit: (cb) => { exitListeners.push(cb); },
    kill: (signal = 'SIGHUP') => { proc.kill(signal); },
  };
}
