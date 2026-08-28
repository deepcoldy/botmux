import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { parse as parseDotEnv } from 'dotenv';

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
/** Read-side memo TTL: `devboxDashboardBaseUrl()` sits on the CSRF hot path
 *  (every control request / WS upgrade), and each miss costs a secure-file read
 *  plus a `.dashboard-port` read. Short enough that a `botmux dashboard`
 *  re-export is picked up within seconds without a restart. */
const BASE_URL_MEMO_TTL_MS = 5_000;
/** Negative cache for a failed export: `merlin-cli` hanging must not make every
 *  later call in the same process pay the full timeout again. */
const EXPORT_FAILURE_TTL_MS = 60_000;

interface DevboxDashboardExportCache {
  workspaceId: string;
  port: number;
  shortUrl: string;
}

export interface EnsureDevboxDashboardExportOptions {
  port: number;
  remoteBaseConfigured: boolean;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  envFilePath?: string;
  timeoutMs?: number;
  merlinCliPath?: string;
  runExport?: (binary: string, port: number, timeoutMs: number) => Promise<string>;
}

export interface DevboxDashboardBaseUrlOptions {
  /** The dashboard port this URL is being built for. Omitted → resolved from
   *  `~/.botmux/.dashboard-port` (see {@link resolveDashboardPort}). */
  port?: number;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  portFilePath?: string;
}

let baseUrlMemo: { key: string; at: number; url: string | null } | null = null;
let exportFailure: { key: string; at: number } | null = null;

/** Drop the in-process read-side memo and the export negative cache. Called
 *  after a successful export (so the fresh short link is visible immediately)
 *  and by tests, which otherwise observe a previous case's memo. */
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
  envFilePath = ENV_FILE_PATH,
): string | undefined {
  const inline = env[AUTO_EXPORT_ENV_KEY];
  if (inline !== undefined) return inline;
  try {
    return parseDotEnv(readFileSync(envFilePath, 'utf8'))[AUTO_EXPORT_ENV_KEY];
  } catch {
    // Absent/unreadable settings file: the switch is simply unset (default on).
    return undefined;
  }
}

function enabled(env: NodeJS.ProcessEnv, envFilePath?: string): boolean {
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
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  if (!enabled(env, opts.envFilePath) || !workspaceId || !env.PORT_LIST) return null;
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

/**
 * The Devbox private short link to use as this host's public base, or null.
 *
 * Callers that know which dashboard port they are building a link for should
 * pass it; the rest resolve it from `~/.botmux/.dashboard-port`.
 */
export function devboxDashboardBaseUrl(opts: DevboxDashboardBaseUrlOptions = {}): string | null {
  // Only the production shape (real cache/env/settings paths) is memoized;
  // callers that inject paths — tests — always recompute.
  const memoizable = opts.cachePath === undefined && opts.env === undefined
    && opts.envFilePath === undefined && opts.portFilePath === undefined;
  const key = String(opts.port ?? '');
  const now = Date.now();
  if (memoizable && baseUrlMemo && baseUrlMemo.key === key
    && now - baseUrlMemo.at < BASE_URL_MEMO_TTL_MS) return baseUrlMemo.url;
  const url = computeDevboxDashboardBaseUrl(opts);
  if (memoizable) baseUrlMemo = { key, at: now, url };
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

async function runMerlinExport(binary: string, port: number, timeoutMs: number): Promise<string> {
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
      // stdout first: the result object is the payload, stderr only carries
      // warnings/log lines. parseExportOutput scans both, but ordering makes
      // the intended source win when a warning happens to be JSON too.
      if (code === 0) resolve(`${stdout}\n${stderr}`);
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
function* jsonObjectCandidates(output: string): Generator<string> {
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < output.length; j++) {
      const ch = output[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        yield output.slice(i, j + 1);
        i = j; // Nested objects are part of this candidate, not candidates too.
        break;
      }
    }
  }
}

function parseExportOutput(output: string): { shortUrl: string; isPublic: boolean } | null {
  for (const candidate of jsonObjectCandidates(output)) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const result = parsed as { short_url?: unknown; is_public?: unknown };
    // A candidate without `short_url` is noise (a warning/log object) — skip it.
    // One that HAS it is the export result and decides the outcome here: a
    // public or credentialed URL fails closed instead of letting a later object
    // in the stream override the verdict.
    if (!('short_url' in result)) continue;
    const shortUrl = validPrivateShortUrl(result.short_url);
    if (!shortUrl || result.is_public !== false) return null;
    return { shortUrl, isPublic: false };
  }
  return null;
}

export async function ensureDevboxDashboardExport(
  opts: EnsureDevboxDashboardExportOptions,
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const workspaceId = env.ARNOLD_WORKSPACE_ID?.trim();
  if (!enabled(env, opts.envFilePath) || opts.remoteBaseConfigured || !workspaceId
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
    const result = parseExportOutput(output);
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
