/**
 * zmx availability probe + env hygiene.
 *
 * zmx is an OPT-IN backend (BACKEND_TYPE=zmx). botmux does not auto-install it
 * during daemon bootstrap; the worker probes it at spawn time and hard-gates
 * the session if the binary/socket surface is not usable.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

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

export function probeZmxFunctional(): { ok: true; version: string } | { ok: false; reason: string } {
  let version: string;
  try {
    version = execFileSync('zmx', ['version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zmxEnv(),
    }).trim();
  } catch {
    return { ok: false, reason: 'zmx 二进制不在 PATH 上' };
  }

  const parsedVersion = parseZmxVersion(version);
  if (!parsedVersion) {
    return { ok: false, reason: `无法解析 zmx 版本：${version.split('\n')[0] || '(empty)'}` };
  }
  if (compareVersion(parsedVersion, [0, 6, 0]) < 0) {
    return {
      ok: false,
      reason: `zmx >= 0.6.0 才受支持（当前 ${parsedVersion.join('.')}）`,
    };
  }

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

  return { ok: true, version };
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
