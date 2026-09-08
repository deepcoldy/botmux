/**
 * Browser-restart降压 for the host-overload alert.
 *
 * Motivation: on a dev Mac the real memory hog is almost always a browser
 * (Arc / Chrome / Edge each routinely hold multiple GB), NOT botmux sessions.
 * The overload card's original two buttons (clean zombie / suspend idle) free
 * almost nothing when 僵尸/闲置 are both 0 — the machine is red because a
 * browser is sitting on 6 GB. This module lets the owner bounce a specific
 * browser straight from the alert card, which reliably reclaims that memory
 * (the browser reopens and restores its tabs).
 *
 * Design:
 *  - Targets are DATA, never hard-coded control flow. {@link DEFAULT_BROWSER_TARGETS}
 *    ships Arc / Chrome / Edge; a global-config `browserRestartTargets` list can
 *    override any field by bundleId, disable one (`enabled:false`), or append a
 *    brand-new browser (Safari/Brave/Firefox…) with ZERO code change.
 *  - Pure helpers ({@link resolveBrowserTargets}, {@link formatBrowserLabel},
 *    the action-value codec) have no I/O and are unit-tested. The host probes +
 *    the actual quit/relaunch live in {@link detectRunningBrowsers} /
 *    {@link restartBrowser}, which shell out via bundle id (precise — never a
 *    fuzzy process-name kill).
 *  - The card only renders browsers that are BOTH installed AND currently
 *    holding memory on THIS host, so the owner never taps a dead button.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** A restartable browser target. `bundleId` is the macOS CFBundleIdentifier —
 *  the single source of truth we quit + relaunch by (no process-name guessing).
 *  `openArgs` are passed to `open -b <id> --args …` on relaunch (e.g. Chromium's
 *  `--restore-last-session` to force tab restore). */
export interface BrowserTarget {
  bundleId: string;
  label: string;
  /** Extra argv forwarded on relaunch (Chromium restore flag, etc.). */
  openArgs?: string[];
  /** false ⇒ never offered on the card (config can disable a default). */
  enabled?: boolean;
}

/** Config entry shape (all optional except bundleId) — merged over the defaults
 *  by bundleId. Kept separate from {@link BrowserTarget} so config validation is
 *  explicit and forgiving of missing fields. */
export interface BrowserTargetConfig {
  bundleId?: unknown;
  label?: unknown;
  openArgs?: unknown;
  enabled?: unknown;
}

/** Built-in defaults. Chromium browsers get `--restore-last-session` so a bounce
 *  reopens the exact tabs; Arc restores its own state on launch. Order here is
 *  the display order on the card. NOT exhaustive by design — extend via config. */
export const DEFAULT_BROWSER_TARGETS: readonly BrowserTarget[] = [
  { bundleId: 'company.thebrowser.Browser', label: 'Arc' },
  { bundleId: 'com.google.Chrome', label: 'Chrome', openArgs: ['--restore-last-session'] },
  { bundleId: 'com.microsoft.edgemac', label: 'Edge', openArgs: ['--restore-last-session'] },
];

/**
 * Merge a config `browserRestartTargets` list over {@link DEFAULT_BROWSER_TARGETS}:
 *  - a config entry whose bundleId matches a default OVERRIDES its label/openArgs/
 *    enabled (only the fields actually present);
 *  - a config entry with a new bundleId is APPENDED (so new browsers need no code);
 *  - the result drops anything with `enabled === false`.
 * Pure: no I/O. Invalid/garbage entries (missing/blank bundleId) are ignored so a
 * hand-edited config can't crash the resolver. When `raw` is undefined/empty the
 * built-in defaults are returned unchanged.
 */
export function resolveBrowserTargets(raw: unknown): BrowserTarget[] {
  const byId = new Map<string, BrowserTarget>();
  for (const d of DEFAULT_BROWSER_TARGETS) byId.set(d.bundleId, { ...d });

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const c = item as BrowserTargetConfig;
      const bundleId = typeof c.bundleId === 'string' ? c.bundleId.trim() : '';
      if (!bundleId) continue;
      const prev = byId.get(bundleId);
      const merged: BrowserTarget = prev
        ? { ...prev }
        : { bundleId, label: bundleId };
      if (typeof c.label === 'string' && c.label.trim()) merged.label = c.label.trim();
      if (Array.isArray(c.openArgs) && c.openArgs.every(a => typeof a === 'string')) {
        merged.openArgs = c.openArgs as string[];
      }
      if (typeof c.enabled === 'boolean') merged.enabled = c.enabled;
      byId.set(bundleId, merged);
    }
  }

  return [...byId.values()].filter(t => t.enabled !== false);
}

/** Card button label, e.g. `♻️ 重启 Arc · 6.2 GB`. Memory is optional (unknown
 *  ⇒ omit the suffix). Pure. */
export function formatBrowserLabel(label: string, memMB?: number): string {
  if (memMB === undefined || !Number.isFinite(memMB) || memMB <= 0) return `♻️ 重启 ${label}`;
  const mem = memMB >= 1024 ? `${(memMB / 1024).toFixed(1)} GB` : `${Math.round(memMB)} MB`;
  return `♻️ 重启 ${label} · ${mem}`;
}

/** A running browser found on the host, with its aggregate RSS in MB. */
export interface RunningBrowser {
  bundleId: string;
  label: string;
  memMB: number;
  openArgs?: string[];
}

/** Resolve a bundle id to its .app path via Spotlight. Returns '' when the app
 *  isn't installed (or Spotlight can't answer). Impure (mdfind). */
async function appPathForBundleId(bundleId: string): Promise<string> {
  try {
    const { stdout } = await pExecFile('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 5_000 });
    const line = stdout.split('\n').map(s => s.trim()).find(s => s.endsWith('.app'));
    return line ?? '';
  } catch { return ''; }
}

/**
 * Probe the host for which of `targets` are installed AND currently holding
 * memory, returning them (in `targets` order) with aggregate RSS in MB. A
 * browser that's installed but not running contributes nothing (no button).
 *
 * Memory is summed over every process whose command line lives under the app's
 * bundle path (helper renderers, GPU process, …) — matched by RESOLVED app path,
 * not a fuzzy name, so "Google Chrome" can't accidentally match "Chrome" text
 * elsewhere. Impure (mdfind + ps). Best-effort: a probe failure yields [].
 */
export async function detectRunningBrowsers(
  targets: BrowserTarget[],
  deps: {
    /** injectable for tests; defaults to the real ps. */
    psList?: () => Promise<string>;
    /** injectable for tests; defaults to the real Spotlight lookup. */
    appPathFor?: (bundleId: string) => Promise<string>;
    /** override the platform gate in tests. */
    platform?: NodeJS.Platform;
  } = {},
): Promise<RunningBrowser[]> {
  // The quit/relaunch path is macOS-only (osascript + `open -b <bundleId>`);
  // on any other platform there's nothing to offer, so skip the probe entirely
  // instead of spawning mdfind/ps for no reason.
  if ((deps.platform ?? process.platform) !== 'darwin') return [];
  const psList = deps.psList ?? (async () => (await pExecFile('ps', ['-Axo', 'rss=,command='], { timeout: 8_000, maxBuffer: 32 * 1024 * 1024 })).stdout);
  const appPathFor = deps.appPathFor ?? appPathForBundleId;
  let psOut = '';
  try { psOut = await psList(); } catch { return []; }
  const lines = psOut.split('\n');

  const out: RunningBrowser[] = [];
  for (const t of targets) {
    const appPath = await appPathFor(t.bundleId);
    if (!appPath) continue; // not installed → no button
    let kb = 0;
    for (const ln of lines) {
      const m = ln.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      if (commandInApp(m[2], appPath)) kb += Number(m[1]) || 0;
    }
    const memMB = Math.round(kb / 1024);
    if (memMB <= 0) continue; // installed but not running → no button
    out.push({ bundleId: t.bundleId, label: t.label, memMB, ...(t.openArgs ? { openArgs: t.openArgs } : {}) });
  }
  return out;
}

/** Result of a restart attempt. `relaunched` is best-effort — a failure to
 *  reopen still counts the quit as done (memory was freed) but is reported. */
export interface RestartResult {
  ok: boolean;
  quit: boolean;
  relaunched: boolean;
  error?: string;
}

/**
 * Restart a browser by bundle id: graceful `quit` via AppleScript, poll until
 * its processes are gone, then relaunch with `open -b <id>` (+ openArgs). Never
 * SIGKILLs — a browser refusing to quit (unsaved prompt) is left alone and
 * reported rather than force-killed under the user. Impure. `sleep`/`now`/`run`
 * are injectable so the polling loop is unit-testable without real timers.
 */
export async function restartBrowser(
  target: { bundleId: string; openArgs?: string[] },
  opts: {
    run?: (file: string, args: string[]) => Promise<{ stdout: string }>;
    isRunning?: (bundleId: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    quitTimeoutMs?: number;
    /** inject the resolved bundle path (tests); defaults to a Spotlight lookup. */
    appPath?: string;
    appPathFor?: (bundleId: string) => Promise<string>;
  } = {},
): Promise<RestartResult> {
  const run = opts.run ?? (async (file, args) => pExecFile(file, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const quitTimeoutMs = opts.quitTimeoutMs ?? 12_000;
  // Resolve the app's bundle path ONCE, up front, and let the liveness probe run
  // `ps` against THAT path for the whole poll loop. This is the fail-safe the
  // review flagged: the previous default was `appPathForBundleId(id) !== '' &&
  // bundleHasProcess(...)`, so a missing/failed mdfind returned '' and the `&&`
  // short-circuited to "not running" — we'd `open` and report ok WITHOUT ever
  // checking ps. Now an unresolvable path or a ps error is treated as "still
  // running" (never gone), so we never blindly relaunch on unknown state.
  const appPath = opts.appPath ?? await (opts.appPathFor ?? appPathForBundleId)(target.bundleId);
  const isRunning = opts.isRunning ?? (async () => {
    if (!appPath) return true; // unknown bundle path ⇒ assume running (don't relaunch)
    try {
      const { stdout } = await run('ps', ['-Axo', 'command=']);
      return stdout.split('\n').some(ln => commandInApp(ln, appPath));
    } catch { return true; } // ps error ⇒ assume running (conservative)
  });

  // 1) graceful quit
  try {
    await run('osascript', ['-e', `tell application id "${target.bundleId}" to quit`]);
  } catch (err) {
    return { ok: false, quit: false, relaunched: false, error: `quit failed: ${errMsg(err)}` };
  }

  // 2) wait for the app's processes to actually exit before relaunching, or a
  //    fast `open` races the still-shutting-down instance and no-ops.
  const deadline = now() + quitTimeoutMs;
  let gone = false;
  while (now() < deadline) {
    await sleep(500);
    if (!(await isRunning(target.bundleId))) { gone = true; break; }
  }
  if (!gone) {
    // Still alive after the grace window — likely an unsaved-changes dialog.
    // Do NOT force-kill: report so the owner can handle it.
    return { ok: false, quit: false, relaunched: false, error: '浏览器未在超时内退出（可能有未保存的弹窗，或进程状态无法确认），已放弃，未强杀' };
  }

  // 3) relaunch
  try {
    const args = ['-b', target.bundleId, ...(target.openArgs && target.openArgs.length ? ['--args', ...target.openArgs] : [])];
    await run('open', args);
    return { ok: true, quit: true, relaunched: true };
  } catch (err) {
    return { ok: true, quit: true, relaunched: false, error: `relaunch failed: ${errMsg(err)}` };
  }
}

/**
 * True when a `ps` command line's EXECUTABLE belongs to the app at `appPath`.
 *
 * A `ps` line is `<argv0> <args...>`; the executable is argv0 at the very start.
 * We anchor on that left boundary — the command (after trimming leading spaces)
 * must BEGIN with `appPath` — instead of scanning for the path anywhere in the
 * line. This is deliberately stricter than a substring/right-boundary match:
 *   - a backup copy launched from elsewhere, e.g. `/Volumes/Backup/…/Arc.app/…`,
 *     does NOT start with `/Applications/Arc.app` → excluded;
 *   - `/Applications/Arc.app-copy/…` is not under `/Applications/Arc.app/` → excluded;
 *   - the path appearing as an unrelated ARGUMENT, e.g.
 *     `/usr/bin/open -b x /Applications/Arc.app`, is not argv0 → excluded.
 * Bundle-internal helpers (`<app>/Contents/Frameworks/…`) start with `<app>/`, so
 * they match. Prefix-matching (not whitespace-splitting) also tolerates spaces in
 * the app path itself (e.g. `/Applications/Google Chrome.app`). Pure.
 */
export function commandInApp(command: string, appPath: string): boolean {
  if (!appPath) return false;
  const cmd = command.replace(/^\s+/, ''); // argv0 sits at the start of the line
  if (cmd === appPath) return true;               // executable is exactly the path
  if (cmd.startsWith(appPath + '/')) return true; // helper/binary under the bundle
  if (cmd.startsWith(appPath + ' ')) return true; // path is argv0, followed by args
  return false;
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
