/**
 * Global botmux configuration stored at `~/.botmux/config.json`.
 *
 * This is a single place for "machine-wide, non-bot-specific" settings. The
 * first field is `lang` (UI language). Future settings (log level, dashboard
 * defaults, etc.) can extend the same file without proliferating env vars or
 * sidecar files.
 *
 * Read path is forgiving: missing file → empty config (callers fall back to
 * code defaults). Malformed JSON → empty config + a single stderr warning.
 * Write path is conservative: only the keys the caller actually passes get
 * touched; unknown keys in the on-disk file are preserved across writes so
 * a future client that adds a setting we don't know about doesn't lose it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isLocale, type Locale } from './i18n/types.js';
import type { VoiceConfig } from './services/voice/types.js';

export interface WorkerConfig {
  maxLiveWorkers?: number;
  idleSuspendMs?: number;
}

export interface GlobalConfig {
  lang?: Locale;
  /** Machine-wide dashboard settings. These are intentionally global rather
   *  than per-bot: they govern the dashboard security boundary and the default
   *  terminal-opening behavior of cards emitted by all daemons on this host. */
  dashboard?: DashboardGlobalConfig;
  /** TTS engine + credentials for the voice-summary feature. See
   *  services/voice/types.ts. Presence (with usable creds) gates the
   *  "🔊 语音总结" button. */
  voice?: VoiceConfig;
  /** Machine-wide worker resource policy. Daemon falls back to an
   *  auto-derived live-worker budget when this block is absent. */
  worker?: WorkerConfig;
}

export interface DashboardGlobalConfig {
  /** When true, dashboard GET/HEAD pages and JSON APIs are public read-only;
   *  mutations still require the active dashboard token. */
  publicReadOnly?: boolean;
  /** When true, terminal buttons on Feishu cards use Feishu's sidebar web_url
   *  wrapper. Default false opens the terminal URL directly. */
  openTerminalInFeishu?: boolean;
}

/** Loosely validate a `voice` block: keep it only if it's an object with a
 *  recognizable engine or engine-specific creds. Deep validation (usable
 *  creds) happens in resolveVoiceConfig; here we just gate obvious garbage. */
function readVoice(raw: unknown): VoiceConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const engineOk = v.engine === 'sami' || v.engine === 'openai' || v.engine === undefined;
  if (!engineOk) return undefined;
  if (!v.sami && !v.openai && !v.engine) return undefined;
  return v as VoiceConfig;
}

function readDashboard(raw: unknown): DashboardGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const out: DashboardGlobalConfig = {};
  if (typeof d.publicReadOnly === 'boolean') out.publicReadOnly = d.publicReadOnly;
  if (typeof d.openTerminalInFeishu === 'boolean') out.openTerminalInFeishu = d.openTerminalInFeishu;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readPositiveInteger(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
}

function readWorker(raw: unknown): WorkerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const worker: WorkerConfig = {};
  const maxLiveWorkers = readPositiveInteger(v.maxLiveWorkers);
  const idleSuspendMs = readPositiveInteger(v.idleSuspendMs);
  if (maxLiveWorkers !== undefined) worker.maxLiveWorkers = maxLiveWorkers;
  if (idleSuspendMs !== undefined) worker.idleSuspendMs = idleSuspendMs;
  return Object.keys(worker).length > 0 ? worker : undefined;
}

export function globalConfigPath(): string {
  return join(homedir(), '.botmux', 'config.json');
}

let warnedOnce = false;

/** Load `~/.botmux/config.json`. Returns `{}` when the file is missing or
 *  unreadable. The raw JSON is also returned (untyped) so writers can
 *  preserve unknown keys round-trip — see `mergeGlobalConfig`. */
function readRawConfig(): Record<string, unknown> {
  const path = globalConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (err: any) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[botmux] Failed to parse ${path}: ${err?.message ?? err}. Ignoring file.`);
    }
    return {};
  }
}

// Short TTL cache: readGlobalConfig sits on hot paths (card-builder rebuilds
// the streaming card on every screen_update, i.e. ~per second per active
// session), and reading + parsing the file each time is wasted IO. 2s keeps
// cross-process freshness (dashboard PUT → daemon cards pick it up within 2s)
// while same-process writes invalidate immediately via mergeGlobalConfig.
// Keyed by path so tests that re-point HOME don't read a stale entry.
const READ_CACHE_TTL_MS = 2_000;
let readCache: { path: string; value: GlobalConfig; at: number } | null = null;

/** Typed view of the global config. Validates `lang` so a malformed file
 *  can't propagate a bad value into the i18n module. */
export function readGlobalConfig(): GlobalConfig {
  const path = globalConfigPath();
  if (readCache && readCache.path === path && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.value;
  }
  const raw = readRawConfig();
  const out: GlobalConfig = {};
  if (isLocale(raw.lang)) out.lang = raw.lang;
  const dashboard = readDashboard(raw.dashboard);
  if (dashboard) out.dashboard = dashboard;
  const voice = readVoice(raw.voice);
  if (voice) out.voice = voice;
  const worker = readWorker(raw.worker);
  if (worker) out.worker = worker;
  readCache = { path, value: out, at: Date.now() };
  return out;
}

/** Merge a patch into the on-disk config, preserving unknown keys. Creates
 *  the file (and parent dir) on first write. Use `null` to explicitly delete
 *  a known key from the file. */
export function mergeGlobalConfig(patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>): void {
  const path = globalConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readRawConfig();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete current[k];
    else current[k] = v;
  }
  // Atomic write (tmp + rename): readers in other processes poll this file on
  // hot paths; a plain writeFileSync window could serve a torn/partial JSON,
  // which readRawConfig would silently treat as {} (settings flap to defaults
  // for one read). pid suffix keeps concurrent writers off each other's tmp.
  // mode 0600 — the file can carry voice credentials; an umask-default tmp
  // (0644) surviving the rename would widen access. Fixing the mode here also
  // tightens legacy 0644 files created by the pre-atomic writeFileSync path.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  // Same-process read-after-write must see the new value immediately
  // (e.g. dashboard PUT /api/settings responds with the resolved config).
  readCache = null;
}

/** Merge only the dashboard sub-config, preserving unknown keys inside that
 *  object so a newer client can safely share the same config file. */
export function mergeDashboardConfig(patch: DashboardGlobalConfig): DashboardGlobalConfig {
  const raw = readRawConfig();
  const existing = raw.dashboard && typeof raw.dashboard === 'object' && !Array.isArray(raw.dashboard)
    ? raw.dashboard as Record<string, unknown>
    : {};
  mergeGlobalConfig({ dashboard: { ...existing, ...patch } as DashboardGlobalConfig });
  return readGlobalConfig().dashboard ?? {};
}

/** Convenience: set the global UI locale (or clear it when `null`). */
export function setGlobalLocale(loc: Locale | null): void {
  mergeGlobalConfig({ lang: loc });
}
