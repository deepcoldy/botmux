import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { parse as parseDotEnv } from 'dotenv';

import { logger } from '../utils/logger.js';
import {
  readSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const CACHE_PATH = join(CONFIG_DIR, 'devbox-dashboard-export.json');
/** Operator settings file. Read here for ONE key only — see {@link autoExportSetting}. */
const ENV_FILE_PATH = join(CONFIG_DIR, '.env');
/** The port the dashboard actually bound (dashboard.ts persists it after listenWithProbe). */
const DASHBOARD_PORT_PATH = join(CONFIG_DIR, '.dashboard-port');
const DEFAULT_DASHBOARD_PORT = 7891;
const EXPORT_TIMEOUT_MS = 5_000;
const AUTO_EXPORT_ENV_KEY = 'BOTMUX_DEVBOX_AUTO_EXPORT';
/** Negative cache for a failed export: `merlin-cli` hanging must not make every
 *  later call in the same process pay the full timeout again. */
const EXPORT_FAILURE_TTL_MS = 60_000;

interface DevboxDashboardExportCache {
  workspaceId: string;
  port: number;
  shortUrl: string;
}

export interface DevboxExportStreams {
  stdout: string;
  stderr: string;
}

export type DevboxEnvFileMode = 'read' | 'ignore';

export interface EnsureDevboxDashboardExportOptions {
  port: number;
  remoteBaseConfigured: boolean;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  /** Defaults to `read`, even when `env` is injected. Tests/callers that need
   * a hermetic environment must opt out explicitly. */
  envFileMode?: DevboxEnvFileMode;
  envFilePath?: string;
  timeoutMs?: number;
  merlinCliPath?: string;
  runExport?: (binary: string, port: number, timeoutMs: number) => Promise<DevboxExportStreams>;
}

export interface DevboxDashboardBaseUrlOptions {
  /** The dashboard port this URL is being built for. Omitted → resolved from
   *  `~/.botmux/.dashboard-port` (see {@link resolveDashboardPort}). */
  port?: number;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  envFileMode?: DevboxEnvFileMode;
  envFilePath?: string;
  portFilePath?: string;
}

let baseUrlMemo: { key: string; url: string | null } | null = null;
let exportFailure: { key: string; at: number } | null = null;

/** Drop the in-process read-side memo and the export negative cache. A successful
 *  same-process export calls this directly; cross-process writes are detected by
 *  the file fingerprints folded into the memo key below. */
export function resetDevboxDashboardExportCaches(): void {
  baseUrlMemo = null;
  exportFailure = null;
}

/**
 * Resolve `BOTMUX_DEVBOX_AUTO_EXPORT` the same way in every process.
 *
 * The three processes that touch this feature load `~/.botmux/.env` very
 * differently: the bot daemon dotenv-loads it wholesale, the dashboard copies
 * only `isDashboardEnvKey` keys, and the CLI — which is the side that actually
 * spawns `merlin-cli` — never reads the file at all. Resolving the switch from
 * `env` alone therefore made a documented `=0` in `~/.botmux/.env` silently
 * ineffective on both the read side (dashboard) and the write side (CLI). The
 * key is now in DAEMON_ENV_KEYS (so it reaches the dashboard through the
 * allowlist and the baked PM2 block), and this file fallback covers the CLI,
 * which has no dotenv step of its own.
 *
 * Precedence matches dotenv: a value already in the environment wins over the
 * file. Only this one key is taken out of the parsed object — nothing from the
 * file enters `process.env`, which is what keeps unrelated credentials in
 * `~/.botmux/.env` out of the CLI process (see utils/dashboard-env.ts).
 */
function autoExportSetting(
  env: NodeJS.ProcessEnv,
  envFilePath: string | null,
): string | undefined {
  const inline = env[AUTO_EXPORT_ENV_KEY];
  if (inline !== undefined) return inline;
  if (envFilePath === null) return undefined;
  try {
    return parseDotEnv(readFileSync(envFilePath, 'utf8'))[AUTO_EXPORT_ENV_KEY];
  } catch {
    // Absent/unreadable settings file: the switch is simply unset (default on).
    return undefined;
  }
}

function resolveEnvFilePath(
  envFileMode: DevboxEnvFileMode | undefined,
  envFilePath: string | undefined,
): string | null {
  if (envFileMode === 'ignore') return null;
  return envFilePath ?? ENV_FILE_PATH;
}

function enabled(env: NodeJS.ProcessEnv, envFilePath: string | null): boolean {
  const raw = (autoExportSetting(env, envFilePath) ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/**
 * The dashboard port this host is currently serving on. The dashboard probes
 * upward on EADDRINUSE (`listenWithProbe`), so the configured 7891 is not
 * authoritative — the port it actually bound is persisted in
 * `~/.botmux/.dashboard-port`, the same file `botmux dashboard`,
 * `resolveWorkbenchUrl()` and the daemon's report links already trust.
 */
function resolveDashboardPort(
  env: NodeJS.ProcessEnv,
  portFilePath = DASHBOARD_PORT_PATH,
): number | null {
  let recorded = '';
  try { recorded = readFileSync(portFilePath, 'utf8').trim(); } catch { recorded = ''; }
  const raw = recorded || env.BOTMUX_DASHBOARD_PORT?.trim() || String(DEFAULT_DASHBOARD_PORT);
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function isExportablePort(port: number, env: NodeJS.ProcessEnv): boolean {
  // Validate the port before consulting PORT_LIST: `Number('') === 0`, so an
  // empty entry (`PORT_LIST='9001,'`) matched a port 0 caller. Rejecting a port
  // that is not a real one covers that at the source, for every entry shape.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  if (port >= 9001 && port <= 9010) return true;
  return (env.PORT_LIST ?? '').split(',').some(value => Number(value.trim()) === port);
}

function validPrivateShortUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function readCache(path = CACHE_PATH): DevboxDashboardExportCache | null {
  try {
    const raw = readSecureHostFileSync(path);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DevboxDashboardExportCache>;
    const shortUrl = validPrivateShortUrl(parsed.shortUrl);
    if (typeof parsed.workspaceId !== 'string' || typeof parsed.port !== 'number'
      || !Number.isInteger(parsed.port) || !shortUrl) return null;
    return { workspaceId: parsed.workspaceId, port: parsed.port, shortUrl };
  } catch {
    return null;
  }
}

function computeDevboxDashboardBaseUrl(opts: DevboxDashboardBaseUrlOptions): string | null {
  const env = opts.env ?? process.env;
  const envFilePath = resolveEnvFilePath(opts.envFileMode, opts.envFilePath);
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  // Devbox gates FIRST, switch second. `enabled()` may read ~/.botmux/.env (the
  // CLI has no dotenv step of its own), while these two only read env vars — and
  // on an ordinary host ARNOLD_WORKSPACE_ID is never set, so this function is
  // reached constantly from the CSRF hot path and must cost zero syscalls there.
  // All three are side-effect-free reads, so the AND is commutative.
  if (!workspaceId || !env.PORT_LIST) return null;
  if (!enabled(env, envFilePath)) return null;
  const port = opts.port ?? resolveDashboardPort(env, opts.portFilePath);
  if (port === null) return null;
  const cached = readCache(opts.cachePath ?? CACHE_PATH);
  // The port must match too, not just the workspace: the dashboard can land on
  // 9002 when 9001 is taken, and a tunnel created for 9001 then points at
  // whatever else holds that port. Mismatch → fall back to the local URL rather
  // than advertise (and trust as a CSRF authority) a link built for a port this
  // dashboard no longer owns.
  if (!cached || cached.workspaceId !== workspaceId || cached.port !== port) return null;
  return cached.shortUrl;
}

/** Cheap metadata fingerprint used to validate the hot-path memo without
 * reopening and reparsing secure files on every control request. Atomic writes
 * change the inode; in-place writes change size/mtime/ctime. A missing file has
 * its own stable fingerprint and is invalidated as soon as the file appears. */
function fileFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return `${path}:missing`;
  }
}

function baseUrlMemoKey(opts: DevboxDashboardBaseUrlOptions): string {
  const env = opts.env ?? process.env;
  const cachePath = opts.cachePath ?? CACHE_PATH;
  const portFilePath = opts.portFilePath ?? DASHBOARD_PORT_PATH;
  const envFilePath = resolveEnvFilePath(opts.envFileMode, opts.envFilePath);
  return JSON.stringify([
    opts.port ?? null,
    env.ARNOLD_WORKSPACE_ID ?? null,
    env.PORT_LIST ?? null,
    env.BOTMUX_DASHBOARD_PORT ?? null,
    env[AUTO_EXPORT_ENV_KEY] ?? null,
    fileFingerprint(cachePath),
    opts.port === undefined ? fileFingerprint(portFilePath) : null,
    env[AUTO_EXPORT_ENV_KEY] === undefined && envFilePath !== null
      ? fileFingerprint(envFilePath)
      : null,
  ]);
}

/**
 * The Devbox private short link to use as this host's public base, or null.
 *
 * Callers that know which dashboard port they are building a link for should
 * pass it; the rest resolve it from `~/.botmux/.dashboard-port`.
 */
export function devboxDashboardBaseUrl(opts: DevboxDashboardBaseUrlOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  const inlineSetting = env[AUTO_EXPORT_ENV_KEY]?.trim().toLowerCase();
  // Ordinary hosts are the overwhelmingly common case. These values come
  // only from the process environment, so reject them before fingerprinting
  // any files on the synchronous CSRF/control-request path.
  if (!workspaceId || !env.PORT_LIST || inlineSetting === '0' || inlineSetting === 'false') {
    return null;
  }
  // The key includes the cache, bound-port, and settings-file fingerprints.
  // This keeps the expensive secure read/JSON parse off the CSRF hot path while
  // making a cross-process export or port rebind visible on the very next call.
  const key = baseUrlMemoKey(opts);
  if (baseUrlMemo?.key === key) return baseUrlMemo.url;
  const url = computeDevboxDashboardBaseUrl(opts);
  baseUrlMemo = { key, url };
  return url;
}

function findMerlinCli(): string {
  const candidates = [join(homedir(), '.merlin-cli', 'bin', 'merlin-cli')];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }
  // PATH-based installs are still supported. spawn() fails softly with ENOENT
  // when the command is absent, so this never invokes a shell or login prompt.
  return 'merlin-cli';
}

async function runMerlinExport(
  binary: string,
  port: number,
  timeoutMs: number,
): Promise<DevboxExportStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['cpu-devbox', 'export', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('devbox export timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`merlin-cli exited ${code}`));
    });
  });
}

/**
 * Every top-level `{...}` region in `output`, brace-balanced and string-aware.
 *
 * `merlin-cli`'s exact output shape is outside this repo's control and its
 * stderr is mixed in, so slicing from the first `{` to the last `}` broke on any
 * warning containing braces (`Warning: config {legacy} deprecated`) or on a JSON
 * log line. Scanning candidates instead keeps the parse working around noise.
 */
interface JsonObjectCandidate {
  text: string;
  start: number;
  /** Exclusive end; null means the opening brace was never closed. */
  end: number | null;
}

function* jsonObjectCandidates(output: string): Generator<JsonObjectCandidate> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      yield { text: output.slice(start, i + 1), start, end: i + 1 };
      start = -1;
    }
  }
  // Once a result-shaped object has been seen, silently ignoring a truncated
  // suffix can turn a later public verdict into a fail-open private result.
  // Report the malformed tail to the caller so the entire output is rejected.
  if (start >= 0) yield { text: output.slice(start), start, end: null };
}

/** Count security-relevant JSON property names before JSON.parse discards
 * duplicate keys. This also sees nested keys, so a second result-shaped object
 * embedded inside the first candidate is treated as ambiguous. */
function securityPropertyKeyCounts(json: string): { shortUrl: number; isPublic: number } {
  const counts = { shortUrl: 0, isPublic: 0 };
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '"') continue;
    const start = i;
    let escaped = false;
    for (i++; i < json.length; i++) {
      const ch = json[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    let next = i + 1;
    while (/\s/.test(json[next] ?? '')) next++;
    if (json[next] !== ':') continue;
    try {
      const propertyName: unknown = JSON.parse(json.slice(start, i + 1));
      if (propertyName === 'short_url') counts.shortUrl++;
      else if (propertyName === 'is_public') counts.isPublic++;
    } catch {
      // The enclosing JSON parse will reject this candidate too.
    }
  }
  return counts;
}

function canonicalSecurityMarkerCounts(parsed: object): { shortUrl: number; isPublic: number } {
  const canonical = JSON.stringify(parsed);
  return {
    shortUrl: canonical.match(/\bshort_url\b/gu)?.length ?? 0,
    isPublic: canonical.match(/\bis_public\b/gu)?.length ?? 0,
  };
}

type ParsedExportResult = { shortUrl: string; isPublic: false };

function rejectExportOutput(source: 'stdout' | 'stderr', reason: string): null {
  // Deliberately omit candidate text and URLs: DEBUG=1 should explain the
  // parser decision without copying a possibly credential-bearing payload.
  logger.debug(`[devbox-export] rejected ${source} output: ${reason}`);
  return null;
}

/** Strict three-state parse: result / rejected null / no result shape undefined. */
function parseExportOutput(
  output: string,
  source: 'stdout' | 'stderr',
): ParsedExportResult | null | undefined {
  let found: ParsedExportResult | null = null;
  let scannedThrough = 0;
  const containsRawSecurityField = (text: string) => /\b(?:short_url|is_public)\b/u.test(text);
  for (const candidate of jsonObjectCandidates(output)) {
    // A result can also be rendered as key=value/plaintext. Treat security
    // fields outside JSON candidates as result-shaped ambiguity, otherwise a
    // public stdout verdict could be misclassified as "no result" and fall
    // through to a private-looking stderr object.
    if (containsRawSecurityField(output.slice(scannedThrough, candidate.start))) {
      return rejectExportOutput(source, 'result fields outside a JSON candidate');
    }
    if (candidate.end === null) {
      return rejectExportOutput(source, 'unterminated object candidate');
    }
    scannedThrough = candidate.end;
    const candidateText = candidate.text;
    // Inspect security keys before parsing: JSON syntax errors must not make a
    // public/result-shaped candidate disappear while a neighbouring private
    // candidate remains eligible. Malformed brace warnings without these keys
    // are still harmless noise and remain skippable.
    const keyCounts = securityPropertyKeyCounts(candidateText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateText);
    } catch {
      // A colon makes this look object-shaped even when it uses Python/JS
      // quoting rather than strict JSON. Reject that ambiguity instead of
      // allowing an unparseable public verdict to disappear beside a private
      // one. Plain brace prose such as `{legacy}` remains harmless noise.
      if (candidateText.includes(':')
        || containsRawSecurityField(candidateText)
        || keyCounts.shortUrl > 0
        || keyCounts.isPublic > 0) {
        return rejectExportOutput(source, 'malformed object-shaped candidate');
      }
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const result = parsed as { short_url?: unknown; is_public?: unknown };
    // JSON loggers can wrap a plaintext verdict in a string value. Re-encoding
    // the parsed object canonicalizes Unicode escapes, then comparing all
    // markers with actual property-key counts exposes any marker hidden in a
    // value without penalizing escaped spellings of the real keys.
    const canonicalMarkerCounts = canonicalSecurityMarkerCounts(parsed);
    if (canonicalMarkerCounts.shortUrl > keyCounts.shortUrl
      || canonicalMarkerCounts.isPublic > keyCounts.isPublic) {
      return rejectExportOutput(source, 'result fields inside a JSON value');
    }
    // A candidate without `short_url` is noise (a warning/log object) — skip it.
    if (keyCounts.shortUrl === 0) continue;
    // Exactly one top-level result is accepted. Duplicate/nested security keys
    // are ambiguous, and JSON.parse's last-key-wins behavior must not be able
    // to hide a preceding public verdict.
    if (keyCounts.shortUrl !== 1
      || keyCounts.isPublic !== 1
      || !Object.prototype.hasOwnProperty.call(result, 'short_url')
      || !Object.prototype.hasOwnProperty.call(result, 'is_public')) {
      return rejectExportOutput(source, 'ambiguous or nested result fields');
    }
    // Multiple result-shaped objects are ambiguous. In particular, a private-
    // looking log record followed by the real public verdict must never make a
    // public link eligible merely because it appeared first.
    if (found) return rejectExportOutput(source, 'multiple result candidates');
    const shortUrl = validPrivateShortUrl(result.short_url);
    if (!shortUrl || result.is_public !== false) {
      return rejectExportOutput(source, 'invalid URL or non-private export verdict');
    }
    found = { shortUrl, isPublic: false };
  }
  if (containsRawSecurityField(output.slice(scannedThrough))) {
    return rejectExportOutput(source, 'result fields outside a JSON candidate');
  }
  return found ?? undefined;
}

/** stdout is authoritative when it contains either a valid result or a
 * rejection. Only a truly result-free stdout may fall back to stderr. */
function parseMerlinExportStreams(output: DevboxExportStreams): ParsedExportResult | null {
  const stdoutResult = parseExportOutput(output.stdout, 'stdout');
  if (stdoutResult === null) return null;
  if (stdoutResult !== undefined) return stdoutResult;
  return parseExportOutput(output.stderr, 'stderr') ?? null;
}

export async function ensureDevboxDashboardExport(
  opts: EnsureDevboxDashboardExportOptions,
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const envFilePath = resolveEnvFilePath(opts.envFileMode, opts.envFilePath);
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  if (!enabled(env, envFilePath) || opts.remoteBaseConfigured || !workspaceId
    || !env.PORT_LIST || !isExportablePort(opts.port, env)) {
    return null;
  }

  const cachePath = opts.cachePath ?? CACHE_PATH;
  const cached = readCache(cachePath);
  if (cached?.workspaceId === workspaceId && cached.port === opts.port) return cached.shortUrl;

  const failureKey = `${workspaceId}|${opts.port}`;
  if (exportFailure?.key === failureKey
    && Date.now() - exportFailure.at < EXPORT_FAILURE_TTL_MS) return null;

  const binary = opts.merlinCliPath ?? findMerlinCli();
  try {
    const output = await (opts.runExport ?? runMerlinExport)(binary, opts.port, opts.timeoutMs ?? EXPORT_TIMEOUT_MS);
    const result = parseMerlinExportStreams(output);
    if (!result) {
      exportFailure = { key: failureKey, at: Date.now() };
      return null;
    }
    writeSecureHostFileSync(cachePath, `${JSON.stringify({
      workspaceId,
      port: opts.port,
      shortUrl: result.shortUrl,
    }, null, 2)}\n`);
    resetDevboxDashboardExportCaches();
    return result.shortUrl;
  } catch {
    exportFailure = { key: failureKey, at: Date.now() };
    return null;
  }
}
