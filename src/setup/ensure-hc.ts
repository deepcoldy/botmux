/**
 * herdr-core (`hc`) discovery for the opt-in `hc` backend.
 *
 * botmux does not install hc and never modifies a user's own copy: it only
 * picks a binary new enough to drive botmux's private core
 * (src/adapters/backend/hc/core.ts). The session selector hard-gates on the
 * reason returned here, like the zmx gate.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';

/**
 * Lowest hc release botmux drives. 0.1.18 added `terminal.run` size and
 * AUTOMATIC_INPUT frames; 0.1.19 keeps detached programs alive across a kill
 * and preserves the core env across restarts, which teardown and the control
 * env rely on.
 */
export const HC_MIN_VERSION: [number, number, number] = [0, 1, 19];

export type HcVersion = [number, number, number];

export type HcAvailability =
  | { ok: true; bin: string; version: string }
  | { ok: false; reason: string };

const HC_VERSION_PROBE_TIMEOUT_MS = 3_000;
const HC_VERSION_PROBE_MAX_BUFFER = 64 * 1024;
/** A failed lookup is retried after this long, so installing hc needs no daemon restart. */
const HC_NEGATIVE_CACHE_MS = 30_000;

/** hc reads every `HC_*` / `_HC_*` key, so an inherited one can retarget it. */
export function isHcEnvKey(key: string): boolean {
  return /^_?HC_/.test(key);
}

/** `<botmux data root>`: the parent of SESSION_DATA_DIR, beside `bin/` (`~/.botmux` by default). */
export function hcBotmuxRoot(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolveBotmuxDataDir({ env }));
}

/** `hc 0.1.19` (the `--version` line; also printed when invoked as `herdr-core`). */
export function parseHcVersion(output: string): HcVersion | null {
  const match = output.match(/(?:^|\n)hc\s+(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]*)?\s*(?:\n|$)/);
  return match ? parseHcSemver(match[1]!) : null;
}

/** `0.1.19` as reported by `server.status`; pre-release suffixes compare as the release. */
export function parseHcSemver(value: string): HcVersion | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareHcVersion(left: HcVersion, right: HcVersion): number {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Candidates in priority order. An explicit BOTMUX_HC_BIN is the only one:
 * falling back past it could run a binary its setter meant to exclude (the
 * test fence points it at a shim that refuses host cores).
 */
export function hcBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.BOTMUX_HC_BIN?.trim();
  if (explicit) return [explicit];
  const candidates = [join(hcBotmuxRoot(env), 'bin', 'herdr-core')];
  for (const name of ['herdr-core', 'hc']) {
    const found = findOnPath(name, env.PATH);
    if (found) candidates.push(found);
  }
  return candidates;
}

function versionProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isHcEnvKey(key)) clean[key] = value;
  }
  return clean;
}

/** Only ENOENT proves absence; a timeout or non-zero exit must not read as "not installed". */
function versionProbeFailure(failure: any): string {
  const code = failure?.code;
  const signal = failure?.signal;
  const stderr = (failure?.stderr?.toString?.() ?? '').trim().split('\n')[0];
  if (code === 'ENOENT') return '不存在';
  if (code === 'EACCES') return '不可执行（EACCES）';
  if (code === 'ETIMEDOUT' || signal || failure?.killed) {
    return `--version 探测超时（${HC_VERSION_PROBE_TIMEOUT_MS}ms${signal ? `，signal=${signal}` : ''}）`;
  }
  if (stderr) return `--version 失败：${stderr}`;
  if (typeof failure?.status === 'number') return `--version 失败（exit ${failure.status}）`;
  return `--version 失败${failure?.message ? `：${failure.message}` : ''}`;
}

function probeCandidate(path: string, env: NodeJS.ProcessEnv): HcAvailability {
  if (!isAbsolute(path)) return { ok: false, reason: `${path}：必须是绝对路径` };
  if (!isExecutableFile(path)) return { ok: false, reason: `${path}：不存在或不可执行` };
  let output: string;
  try {
    output = execFileSync(path, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HC_VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: HC_VERSION_PROBE_MAX_BUFFER,
      env: versionProbeEnv(env),
    });
  } catch (err) {
    return { ok: false, reason: `${path}：${versionProbeFailure(err)}` };
  }
  const version = parseHcVersion(output);
  if (!version) {
    return { ok: false, reason: `${path}：无法解析版本输出 ${JSON.stringify(output.trim().split('\n')[0] ?? '')}` };
  }
  if (compareHcVersion(version, HC_MIN_VERSION) < 0) {
    return { ok: false, reason: `${path}：版本 ${version.join('.')} 低于 ${HC_MIN_VERSION.join('.')}` };
  }
  return { ok: true, bin: path, version: `hc ${version.join('.')}` };
}

export interface HcAvailabilityOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Uncached discovery: the first candidate whose `--version` meets HC_MIN_VERSION. */
export function discoverHcBinary(opts: HcAvailabilityOptions = {}): HcAvailability {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { ok: false, reason: `hc 后端支持 Linux 和 macOS（当前 ${platform}）` };
  }

  const candidates = hcBinaryCandidates(env);
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let identity = candidate;
    try { identity = realpathSync(candidate); } catch { /* reported by the probe */ }
    if (seen.has(identity)) continue;
    seen.add(identity);
    const probe = probeCandidate(candidate, env);
    if (probe.ok) return probe;
    reasons.push(probe.reason);
  }
  const searched = env.BOTMUX_HC_BIN?.trim()
    ? 'BOTMUX_HC_BIN'
    : `BOTMUX_HC_BIN、${join(hcBotmuxRoot(env), 'bin', 'herdr-core')}、PATH 上的 herdr-core 与 hc`;
  return {
    ok: false,
    reason: `没有可用的 herdr-core >= ${HC_MIN_VERSION.join('.')}（查找 ${searched}）`
      + (reasons.length > 0 ? `：${reasons.join('；')}` : ''),
  };
}

let cached: { key: string; result: HcAvailability; at: number } | undefined;

/** {@link discoverHcBinary}, cached per discovery input; failures expire after a short while. */
export function probeHcAvailability(opts: HcAvailabilityOptions = {}): HcAvailability {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const key = JSON.stringify([platform, env.BOTMUX_HC_BIN ?? '', hcBotmuxRoot(env), env.PATH ?? '']);
  const now = Date.now();
  if (cached && cached.key === key && (cached.result.ok || now - cached.at < HC_NEGATIVE_CACHE_MS)) {
    return cached.result;
  }
  const result = discoverHcBinary({ env, platform });
  cached = { key, result, at: now };
  return result;
}

export function resetHcAvailabilityCache(): void {
  cached = undefined;
}
