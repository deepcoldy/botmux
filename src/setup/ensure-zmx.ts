/**
 * zmx availability probe + env hygiene.
 *
 * zmx is an OPT-IN backend (BACKEND_TYPE=zmx). botmux does not auto-install it
 * during daemon bootstrap; the worker probes it at spawn time and hard-gates
 * the session if the binary/socket surface is not usable.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * Lowest zmx release whose `send` only queues input instead of taking client
 * leadership (upstream commit 8ba312d7 "fix(send): preserve client leadership",
 * shipped in v0.7.0). Below this floor `send` steals the leader and rewrites
 * the terminal size, which corrupts the `history` screen botmux reads.
 */
export const ZMX_MIN_VERSION: [number, number, number] = [0, 7, 0];

const ZMX_PATH_EXTRAS = [
  `${homedir()}/.local/share/mise/shims`,
  `${homedir()}/.local/bin`,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function withZmxSearchPath(pathValue: string | undefined): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...(pathValue?.split(':') ?? []), ...ZMX_PATH_EXTRAS]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    merged.push(part);
  }
  return merged.join(':');
}

/**
 * Strip zmx session identity vars inherited from a parent zmx attach.
 *
 * ZMX_DIR is intentionally preserved: it is the user's explicit socket-dir
 * selection. ZMX_SESSION_PREFIX is stripped so botmux's deterministic bmx-*
 * names stay literal and dashboard/API probes can match them.
 */
export function zmxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ZMX_SESSION: _session, ZMX_SESSION_PREFIX: _prefix, ...rest } = env;
  return {
    ...rest,
    PATH: withZmxSearchPath(rest.PATH),
  };
}

/**
 * Which env var decides zmx's socket dir, in zmx's own precedence order.
 * `zmx version` touches that dir, so a failure there is very often a socket-dir
 * problem rather than a missing binary — surface which var is in play.
 */
function zmxSocketDirHint(env: NodeJS.ProcessEnv): string {
  for (const key of ['ZMX_DIR', 'XDG_RUNTIME_DIR', 'TMPDIR'] as const) {
    const value = env[key];
    if (value) return `，socket dir 来自 ${key}=${value}`;
  }
  return '，未设置 ZMX_DIR / XDG_RUNTIME_DIR / TMPDIR';
}

/**
 * Only ENOENT proves the binary is absent. Mirrors ensure-tmux's
 * childFailureReason: a timeout / EACCES / non-zero exit must NOT be reported as
 * the misleading "not on PATH" diagnosis. `zmx version` is not a pure print —
 * it resolves and touches the socket dir, so a read-only or unwritable
 * ZMX_DIR / XDG_RUNTIME_DIR exits non-zero on an otherwise healthy install.
 */
function zmxProbeFailureReason(command: string, failure: any, timeoutMs: number, env: NodeJS.ProcessEnv): string {
  const nested = failure?.error;
  const code = failure?.code ?? nested?.code;
  const signal = failure?.signal ?? nested?.signal;
  const stderr = (failure?.stderr?.toString?.() ?? nested?.stderr?.toString?.() ?? '').trim();

  if (code === 'ENOENT') return 'zmx 二进制不在 PATH 上';
  if (code === 'EACCES') return `${command} 启动失败：zmx 不可执行（EACCES）`;
  if (code === 'EMFILE' || code === 'ENFILE') return `${command} 启动失败：文件描述符耗尽（${code}）`;
  if (code === 'ETIMEDOUT' || signal || failure?.killed || nested?.killed) {
    const detail = signal ? `，signal=${signal}` : '';
    return `${command} 探测超时（${timeoutMs}ms${detail}）${zmxSocketDirHint(env)}`;
  }
  if (stderr) return `${command} 失败：${stderr}${zmxSocketDirHint(env)}`;
  if (typeof failure?.status === 'number') {
    return `${command} 失败（exit ${failure.status}）${zmxSocketDirHint(env)}`;
  }
  const message = nested?.message ?? failure?.message;
  return `${command} 启动/探测失败${message ? `：${message}` : ''}`;
}

export function probeZmxVersion(): { ok: true; version: string } | { ok: false; reason: string } {
  const env = zmxEnv();
  let version: string;
  try {
    version = execFileSync('zmx', ['version'], {
      encoding: 'utf-8',
      // stderr is piped, not discarded: it carries the real cause (e.g.
      // `error: ReadOnlyFileSystem` for an unwritable socket dir).
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env,
    }).trim();
  } catch (err) {
    return { ok: false, reason: zmxProbeFailureReason('zmx version', err, 3000, env) };
  }

  const parsedVersion = parseZmxVersion(version);
  if (!parsedVersion) {
    return { ok: false, reason: `无法解析 zmx 版本：${version.split('\n')[0] || '(empty)'}` };
  }
  if (compareVersion(parsedVersion, ZMX_MIN_VERSION) < 0) {
    return {
      ok: false,
      reason: `zmx >= ${ZMX_MIN_VERSION.join('.')} 才受支持（当前 ${parsedVersion.join('.')}；需要 send 不抢占 client leadership 的行为，输出由 history 获取）`,
    };
  }

  // Normalise to a single "zmx x.y.z" line. `zmx version` also prints
  // ghostty_vt / socket_dir / log_dir, and this string is surfaced verbatim by
  // the Dashboard backend-availability API — returning the raw blob would leak
  // local socket/log paths and render as a multi-line smear next to peers like
  // "tmux 3.5".
  return { ok: true, version: `zmx ${parsedVersion.join('.')}` };
}

export function probeZmxFunctional(): { ok: true; version: string } | { ok: false; reason: string } {
  const versionProbe = probeZmxVersion();
  if (!versionProbe.ok) return versionProbe;

  try {
    execFileSync('zmx', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env: zmxEnv(),
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.().trim?.() || '';
    return { ok: false, reason: stderr || 'zmx list 失败' };
  }

  return versionProbe;
}

export function parseZmxVersion(output: string): [number, number, number] | null {
  const match = output.match(/(?:^|\n)zmx\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}
