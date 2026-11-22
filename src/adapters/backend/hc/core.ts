/**
 * botmux's private herdr-core core: where it listens, the env every hc
 * invocation carries, its config file, and the one explicit start.
 *
 * hc starts a core by itself whenever a client cannot connect, copies that
 * client's environment into every program the core runs (a run's env overlay
 * can add keys but never remove them), and keeps it across restarts. So every
 * hc child gets hcControlEnv(), never a CLI child env, and only
 * ensureHcCore() starts the core on purpose.
 */
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  HC_MIN_VERSION,
  compareHcVersion,
  hcBotmuxRoot,
  isHcEnvKey,
  parseHcSemver,
  probeHcAvailability,
} from '../../../setup/ensure-hc.js';
import { tmuxEnv } from '../../../setup/ensure-tmux.js';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { DEFAULT_RENDER_COLS, DEFAULT_RENDER_ROWS } from '../../../utils/render-dimensions.js';

export const HC_CORE_SESSION = 'botmux';
/** Linux `sun_path` minus its NUL: hc's MAX_SOCKET_PATH. */
export const HC_MAX_SOCKET_PATH = 107;
/** Hex digits of a holder id in its socket name (hc paths.rs HOLDER_ID). */
const HC_HOLDER_ID_DIGITS = 8;
const HC_STATUS_TIMEOUT_MS = 3_000;
const HC_STATUS_MAX_REPLY_BYTES = 1 << 20;
/** Above hc's own 15 s wait for a starting core, so hc reports its failure first. */
const HC_START_TIMEOUT_MS = 20_000;
const HC_START_OUTPUT_BYTES = 16 * 1024;

/** What pins one core: hc derives nothing else that matters from the env. */
export interface HcCoreIdentity {
  session: string;
  socket: string;
  configHome: string;
}

export interface HcCorePaths extends HcCoreIdentity {
  runtimeDir: string;
  /** Holders listen on `<this minus .sock>.<8 hex>.sock`: the longest socket path. */
  holderSocket: string;
  /** XDG_STATE_HOME of this core ({@link hcStateHome}). */
  stateHome: string;
}

/** The core a terminal was created on, frozen into its persistent target. */
export interface HcCoreAddress {
  hcSession: string;
  socket: string;
}

export function hcCoreAddress(core: HcCoreIdentity): HcCoreAddress {
  return { hcSession: core.session, socket: core.socket };
}

/** XDG_CONFIG_HOME of the botmux core, so a user's hc config (its `socket` key) never steers it. */
export function hcConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(hcBotmuxRoot(env), 'hc', 'config');
}

/** The socket path minus its last extension, as Rust `Path::with_extension` cuts it. */
function socketStem(socket: string): string {
  const name = basename(socket);
  const dir = socket.slice(0, socket.length - name.length);
  const dot = name.lastIndexOf('.');
  return `${dir}${dot > 0 ? name.slice(0, dot) : name}`;
}

/** hc's holder prefix for an explicit socket: Rust `Path::with_extension("holder.sock")`. */
export function hcHolderSocketPrefix(socket: string): string {
  return `${socketStem(socket)}.holder.sock`;
}

/**
 * Nothing can run on this core: neither its socket (a core removes it on exit)
 * nor a holder socket (a holder removes its own once its last program ends) is
 * there. A socket left by a killed core, or any holder, may still bring up
 * programs.
 */
export function hcCoreAbsent(socket: string): boolean {
  const holder = basename(hcHolderSocketPrefix(socket));
  const holderIds = `${holder.slice(0, -'.sock'.length)}.`;
  let names: string[];
  try {
    names = readdirSync(dirname(socket));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return !names.some(name => name === basename(socket)
    || name === holder
    || (name.startsWith(holderIds) && name.endsWith('.sock')));
}

/**
 * XDG_STATE_HOME of the core on `socket`: `<socket minus .sock>.state`.
 *
 * hc keeps core.lock in `$XDG_STATE_HOME/herdr-core/<HC_SESSION>`, and a core
 * that wins another state dir's lock still binds by unlinking the live socket
 * (herdrdev/herdr-core#200). So the state dir must follow from the socket
 * alone: not from an inherited XDG_STATE_HOME, the botmux data root or HOME
 * (the e2e fence keeps the real HOME around a private runtime dir).
 */
export function hcStateHome(socket: string): string {
  return `${socketStem(socket)}.state`;
}

/**
 * The XDG keys {@link hcControlEnv} pins for the core. A pane hands each back
 * to the CLI as the worker had it, or unsets it ({@link hcPaneXdgRestore}).
 */
export const HC_PINNED_XDG_KEYS = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const;

/** What a pane exports (`set`) and unsets so its program sees the worker's own XDG dirs. */
export function hcPaneXdgRestore(workerEnv: NodeJS.ProcessEnv): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const key of HC_PINNED_XDG_KEYS) {
    const value = workerEnv[key];
    if (value === undefined) unset.push(key);
    else set[key] = value;
  }
  return { set, unset };
}

/** Why hc would refuse this socket path, or null when it fits. */
export function hcSocketPathError(socket: string): string | null {
  const longest = Buffer.byteLength(hcHolderSocketPrefix(socket)) + 1 + HC_HOLDER_ID_DIGITS;
  const bytes = Math.max(Buffer.byteLength(socket), longest);
  if (bytes <= HC_MAX_SOCKET_PATH) return null;
  return `hc socket 路径过长：${socket}（最长的 holder socket 需 ${bytes} 字节，上限 ${HC_MAX_SOCKET_PATH}）`;
}

/**
 * This env's botmux core or, given `core`, the one a target was frozen on
 * (hc puts sockets in `<runtime dir>/herdr-core/`).
 */
export function hcCorePaths(
  env: NodeJS.ProcessEnv = process.env,
  opts: { uid?: number; core?: HcCoreAddress } = {},
): HcCorePaths {
  let session = HC_CORE_SESSION;
  let socket: string;
  let runtimeDir: string;
  if (opts.core) {
    if (!isAbsolute(opts.core.socket)) throw new Error(`hc socket 必须是绝对路径：${opts.core.socket}`);
    session = opts.core.hcSession;
    socket = opts.core.socket;
    runtimeDir = dirname(dirname(socket));
  } else {
    const xdg = env.XDG_RUNTIME_DIR;
    if (xdg && isAbsolute(xdg)) {
      runtimeDir = xdg;
    } else {
      const uid = opts.uid ?? process.getuid?.();
      if (uid === undefined) throw new Error('hc 后端目前只支持 Linux');
      runtimeDir = `/run/user/${uid}`;
    }
    socket = join(runtimeDir, 'herdr-core', `${session}.sock`);
  }
  const tooLong = hcSocketPathError(socket);
  if (tooLong) throw new Error(`${tooLong}；请换一个更短的 XDG_RUNTIME_DIR`);
  return {
    session,
    socket,
    holderSocket: hcHolderSocketPrefix(socket),
    runtimeDir,
    configHome: hcConfigHome(env),
    stateHome: hcStateHome(socket),
  };
}

/**
 * Why no hc call may run against these paths, or null. Any hc call can start
 * a core, and hc creates the socket's directories recursively, so a missing
 * runtime dir would come back as a plain directory where logind owns it.
 */
export function hcRuntimeDirError(paths: Pick<HcCorePaths, 'runtimeDir'>): string | null {
  if (isDirectory(paths.runtimeDir)) return null;
  return `hc 运行目录 ${paths.runtimeDir} 不存在（取自 XDG_RUNTIME_DIR，未设置时为 /run/user/<uid>）`;
}

/**
 * The env for every hc child: the scrub the tmux server's global env gets,
 * minus every inherited HC_* key, plus the pinned core identity and state dir.
 * Provider credentials stay, as they do in the tmux server's global env: panes
 * unset what they must not see.
 */
export function hcControlEnv(
  base: NodeJS.ProcessEnv = process.env,
  core: HcCoreIdentity = hcCorePaths(base),
): NodeJS.ProcessEnv {
  const env = tmuxEnv(base);
  for (const key of Object.keys(env)) {
    if (isHcEnvKey(key)) delete env[key];
  }
  env.HC_SESSION = core.session;
  env.HC_SOCKET = core.socket;
  env.XDG_CONFIG_HOME = core.configHome;
  env.XDG_STATE_HOME = hcStateHome(core.socket);
  return env;
}

export function hcConfigToml(): string {
  return [
    'notes = false',
    `headless = "${DEFAULT_RENDER_COLS}x${DEFAULT_RENDER_ROWS}"`,
    'history_mb = 5',
    '',
  ].join('\n');
}

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Write `<configHome>/herdr-core/config.toml` when its content differs. */
export function ensureHcConfig(configHome: string = hcConfigHome()): { path: string; written: boolean } {
  const dir = join(configHome, 'herdr-core');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (modeBits(dir) !== 0o700) chmodSync(dir, 0o700);
  const path = join(dir, 'config.toml');
  const content = hcConfigToml();
  let current: string | null = null;
  try {
    if (lstatSync(path).isFile()) current = readFileSync(path, 'utf-8');
  } catch { /* absent */ }
  if (current === content) {
    if (modeBits(path) !== 0o600) chmodSync(path, 0o600);
    return { path, written: false };
  }
  atomicWriteFileSync(path, content, { mode: 0o600, followTargetSymlink: false });
  return { path, written: true };
}

export type HcCoreProbe =
  | { state: 'running'; version: string; pid: number }
  | { state: 'absent'; reason: string }
  | { state: 'error'; reason: string };

function parseStatusReply(line: string, socket: string): HcCoreProbe {
  let reply: { result?: { version?: unknown; pid?: unknown }; error?: { message?: unknown } };
  try {
    reply = JSON.parse(line);
  } catch {
    return { state: 'error', reason: `hc core（${socket}）的 server.status 应答无法解析` };
  }
  if (reply.error) {
    const message = typeof reply.error.message === 'string' ? reply.error.message : 'refused';
    return { state: 'error', reason: `hc core（${socket}）拒绝 server.status：${message}` };
  }
  const { version, pid } = reply.result ?? {};
  if (typeof version !== 'string' || typeof pid !== 'number') {
    return { state: 'error', reason: `hc core（${socket}）的 server.status 缺少 version/pid` };
  }
  return { state: 'running', version, pid };
}

/** One plain-mode `server.status`. Only connects: never starts a core. */
export function queryHcCoreStatus(socket: string, timeoutMs: number = HC_STATUS_TIMEOUT_MS): Promise<HcCoreProbe> {
  return new Promise(resolve => {
    let settled = false;
    let reply = '';
    const conn = netConnect(socket);
    const finish = (probe: HcCoreProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(probe);
    };
    const timer = setTimeout(
      () => finish({ state: 'error', reason: `hc core（${socket}）${timeoutMs}ms 内没有应答 server.status` }),
      timeoutMs,
    );
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server.status', params: {} })}\n`);
    });
    conn.on('data', (chunk: string) => {
      reply += chunk;
      const end = reply.indexOf('\n');
      if (end >= 0) finish(parseStatusReply(reply.slice(0, end), socket));
      else if (reply.length > HC_STATUS_MAX_REPLY_BYTES) {
        finish({ state: 'error', reason: `hc core（${socket}）的 server.status 应答过长` });
      }
    });
    conn.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
        ? { state: 'absent', reason: `${socket}：${err.code}` }
        : { state: 'error', reason: `连接 hc core（${socket}）失败：${err.message}` });
    });
    conn.on('close', () => finish({ state: 'error', reason: `hc core（${socket}）未应答就关闭了连接` }));
  });
}

interface HcStartResult {
  ok: boolean;
  detail: string;
}

/** A failed `--json` command's stderr line `{"error":{kind,message,hint}}`; null for anything else. */
export function parseHcCliError(stderr: string): { kind: string; message: string } | null {
  const last = stderr.trim().split('\n').pop() ?? '';
  try {
    const error = JSON.parse(last)?.error;
    if (typeof error?.kind === 'string' && typeof error.message === 'string') {
      return { kind: error.kind, message: error.message };
    }
  } catch { /* plain text */ }
  return null;
}

function runHcServerStart(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<HcStartResult> {
  return new Promise(resolve => {
    let settled = false;
    let stderr = '';
    const child = spawn(bin, ['--json', 'server', 'start'], { env, cwd: '/', stdio: ['ignore', 'ignore', 'pipe'] });
    const finish = (result: HcStartResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, detail: `server start 超过 ${timeoutMs}ms 未返回` });
    }, timeoutMs);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-HC_START_OUTPUT_BYTES);
    });
    child.on('error', err => finish({ ok: false, detail: `server start 无法执行：${err.message}` }));
    child.on('close', (code, signal) => {
      if (code === 0) finish({ ok: true, detail: '' });
      else {
        const message = parseHcCliError(stderr)?.message ?? stderr.trim();
        finish({ ok: false, detail: `server start 失败（${signal ? `signal ${signal}` : `exit ${code}`}）${message ? `：${message}` : ''}` });
      }
    });
  });
}

export interface HcCoreStatus {
  bin: string;
  session: string;
  socket: string;
  /** The running core's version (`0.1.19`). */
  version: string;
  pid: number;
  /** This call ran `server start` (another caller's core may have won the start). */
  started: boolean;
}

export interface EnsureHcCoreOptions {
  env?: NodeJS.ProcessEnv;
  /** A target's frozen core; default: this env's botmux core. */
  core?: HcCoreAddress;
  timeoutMs?: number;
}

const inflight = new Map<string, Promise<HcCoreStatus>>();

async function startOrJoinHcCore(env: NodeJS.ProcessEnv, paths: HcCorePaths, timeoutMs: number): Promise<HcCoreStatus> {
  const availability = probeHcAvailability({ env });
  if (!availability.ok) throw new Error(availability.reason);
  const noRuntimeDir = hcRuntimeDirError(paths);
  if (noRuntimeDir) throw new Error(noRuntimeDir);
  ensureHcConfig(paths.configHome);
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  let probe = await queryHcCoreStatus(paths.socket, Math.min(HC_STATUS_TIMEOUT_MS, remaining()));
  let started = false;
  if (probe.state === 'absent') {
    // Concurrent starters are fine: hc's core.lock lets one core win, the
    // other cores exit, and every `server start` client waits for the winner.
    started = true;
    const start = await runHcServerStart(availability.bin, hcControlEnv(env, paths), remaining());
    probe = await queryHcCoreStatus(paths.socket, Math.min(HC_STATUS_TIMEOUT_MS, remaining()));
    if (probe.state !== 'running') {
      throw new Error(`hc core 启动失败（${paths.socket}）：${start.ok ? probe.reason : start.detail}`);
    }
  }
  if (probe.state !== 'running') throw new Error(probe.reason);

  const version = parseHcSemver(probe.version);
  if (!version || compareHcVersion(version, HC_MIN_VERSION) < 0) {
    throw new Error(
      `hc core（${paths.socket}，pid ${probe.pid}）运行的版本 ${probe.version} 低于 ${HC_MIN_VERSION.join('.')}；`
      + 'botmux 不会自动重启它（停掉它会结束其中的终端），请先停掉这个 core 再重试',
    );
  }
  return {
    bin: availability.bin,
    session: paths.session,
    socket: paths.socket,
    version: probe.version,
    pid: probe.pid,
    started,
  };
}

/**
 * Connect to the botmux core (or `opts.core`), starting it with the control
 * env when nothing listens, and refuse a running core below HC_MIN_VERSION.
 * Callers in one process share a single attempt per socket.
 */
export async function ensureHcCore(opts: EnsureHcCoreOptions = {}): Promise<HcCoreStatus> {
  const env = opts.env ?? process.env;
  const paths = hcCorePaths(env, { core: opts.core });
  const pending = inflight.get(paths.socket);
  if (pending) return pending;
  const attempt = startOrJoinHcCore(env, paths, opts.timeoutMs ?? HC_START_TIMEOUT_MS);
  inflight.set(paths.socket, attempt);
  try {
    return await attempt;
  } finally {
    if (inflight.get(paths.socket) === attempt) inflight.delete(paths.socket);
  }
}
