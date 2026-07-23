import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync, realpathSync as defaultRealpathSync, statSync as defaultStatSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';
import { shellPathProbes } from '../shared/shell-path-probes.js';
import type { ExternalRuntimeCandidate } from './runtime-service.js';
import { resolveEffectiveBotmuxVersion } from '../../utils/version-info.js';

const MAX_SHIM_BYTES = 4096;

type ReadTextFile = (path: string, encoding: BufferEncoding) => string;
type StatFile = (path: string) => { size: number };
type ExecFile = (
  file: string,
  args: string[],
  options: { encoding: BufferEncoding; timeout: number; stdio: ['ignore', 'pipe', 'ignore'] },
) => string;

interface InstallEntry {
  binPath: string;
  root: string;
  pathEnv?: string;
}

interface DiscoveredBin {
  binPath: string;
  pathEnv?: string;
}

interface InstallProbeDeps {
  readFile: (path: string) => string | null;
  realpath: (path: string) => string | null;
}

export interface ExternalRuntimeDiscoveryDeps {
  binPaths?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFile;
  existsSync?: (path: string) => boolean;
  readFileSync?: ReadTextFile;
  realpathSync?: (path: string) => string;
  statSync?: StatFile;
}

const LOGIN_SHELL_PATH_MARKER = '__BOTMUX_PATH__';

export function discoverExternalRuntimeCandidate(
  paths: DesktopPaths,
  deps: ExternalRuntimeDiscoveryDeps = {},
): ExternalRuntimeCandidate | null {
  const probeDeps = createInstallProbeDeps(deps);
  const binPaths = deps.binPaths?.map(binPath => ({ binPath })) ?? listBotmuxBins(paths, deps);
  const entries = analyzeBotmuxBins(binPaths, probeDeps);
  return selectExternalRuntimeCandidate(entries, paths, deps);
}

export function selectExternalRuntimeCandidate(
  entries: InstallEntry[],
  _paths: DesktopPaths,
  deps: ExternalRuntimeDiscoveryDeps = {},
): ExternalRuntimeCandidate | null {
  const exists = deps.existsSync ?? defaultExistsSync;
  const readFile = deps.readFileSync ?? defaultReadFileSync;
  const realpath = deps.realpathSync ?? defaultRealpathSync;

  for (const entry of entries) {
    const root = normalizePath(entry.root, realpath);
    const cliPath = join(root, 'dist', 'cli.js');
    const version = readPackageVersion(root, exists, readFile, deps.execFileSync);
    if (!exists(cliPath) || !version || !isSemverVersion(version)) continue;

    return {
      kind: 'external',
      root,
      cliPath,
      binPath: entry.binPath,
      ...(entry.pathEnv ? { pathEnv: entry.pathEnv } : {}),
      version,
      // Desktop only binds the user's global `botmux` command. A pnpm-linked
      // development checkout is still the global CLI contract from App's view.
      runtimeSource: 'global-cli',
    };
  }

  return null;
}

function createInstallProbeDeps(deps: ExternalRuntimeDiscoveryDeps): InstallProbeDeps {
  const exists = deps.existsSync ?? defaultExistsSync;
  const readFile = deps.readFileSync ?? defaultReadFileSync;
  const realpath = deps.realpathSync ?? defaultRealpathSync;
  const stat = deps.statSync ?? defaultStatSync;

  return {
    readFile: path => {
      try {
        // Only tiny shims are worth scanning; a real compiled cli.js is much
        // larger and can be resolved through realpath instead.
        if (stat(path).size >= MAX_SHIM_BYTES) return null;
        return readFile(path, 'utf-8');
      } catch {
        return null;
      }
    },
    realpath: path => {
      try {
        return realpath(path);
      } catch {
        return null;
      }
    },
  };
}

function analyzeBotmuxBins(binPaths: DiscoveredBin[], deps: InstallProbeDeps): InstallEntry[] {
  const seenBin = new Set<string>();
  const seenRoot = new Set<string>();
  const entries: InstallEntry[] = [];

  for (const raw of binPaths) {
    const binPath = raw.binPath.trim();
    if (!binPath || seenBin.has(binPath)) continue;
    seenBin.add(binPath);

    const resolved = resolveBotmuxBin(binPath, deps);
    const root = resolved?.root ?? binPath;
    if (seenRoot.has(root)) continue;
    seenRoot.add(root);
    entries.push({ binPath, root, pathEnv: raw.pathEnv });
  }

  return entries;
}

function resolveBotmuxBin(binPath: string, deps: InstallProbeDeps): { root: string } | null {
  let cliPath: string | null = null;
  const content = deps.readFile(binPath);
  if (content) {
    // Global package managers commonly expose botmux through tiny wrappers that
    // exec the built CLI. Matching the quoted target keeps this probe cheap.
    const match = content.match(/"([^"]*[/\\]cli\.js)"/);
    if (match) cliPath = match[1];
  }

  if (!cliPath) {
    const real = deps.realpath(binPath);
    if (real && /cli\.js$/i.test(real)) cliPath = real;
  }
  if (!cliPath) return null;

  return {
    root: /[/\\]dist[/\\]cli\.js$/i.test(cliPath)
      ? cliPath.replace(/[/\\]dist[/\\]cli\.js$/i, '')
      : dirname(dirname(cliPath)),
  };
}

function listBotmuxBins(paths: DesktopPaths, deps: ExternalRuntimeDiscoveryDeps): DiscoveredBin[] {
  const execFile = deps.execFileSync ?? (defaultExecFileSync as unknown as ExecFile);
  const platform = deps.platform ?? process.platform;
  // macOS GUI apps miss the user's shell PATH, so ask the user's shell (zsh or
  // bash, profile and rc flavors) — see shellPathProbes for the ladder.
  const shellProbe = platform === 'darwin'
    ? cachedShellPathWhich(execFile, deps)
    : { bins: [], pathEnv: undefined };
  // The merged shell PATH is attached to every candidate (not only shell-found
  // ones): whichever bin wins, the daemon it starts needs that PATH to find
  // `node` and the per-bot CLIs when they live in nvm/fnm-managed directories.
  const pathEnv = shellProbe.pathEnv;
  const bins: DiscoveredBin[] = [
    ...runWhich(execFile, platform).map(binPath => ({ binPath, pathEnv })),
    ...shellProbe.bins.map(binPath => ({ binPath, pathEnv })),
    // User-owned wrappers are useful fallbacks, but should not override the CLI
    // that the user's shell actually resolves for `botmux`.
    { binPath: join(paths.botmuxHome, 'bin', 'botmux'), pathEnv },
    { binPath: '/opt/homebrew/bin/botmux', pathEnv },
    { binPath: '/usr/local/bin/botmux', pathEnv },
  ];

  const byBin = new Map<string, DiscoveredBin>();
  for (const bin of bins) {
    const trimmed = bin.binPath.trim();
    if (!trimmed) continue;
    const existing = byBin.get(trimmed);
    if (existing) {
      if (!existing.pathEnv && bin.pathEnv) existing.pathEnv = bin.pathEnv;
      continue;
    }
    byBin.set(trimmed, { ...bin, binPath: trimmed });
  }
  return [...byBin.values()];
}

function runWhich(execFile: ExecFile, platform: NodeJS.Platform): string[] {
  try {
    const win = platform === 'win32';
    const out = execFile(win ? 'where' : 'which', win ? ['botmux'] : ['-a', 'botmux'], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return splitCommandOutput(out);
  } catch {
    return [];
  }
}

// Runtime state is polled every ~5s (createRuntimeStateMonitor) and each poll
// re-runs discovery. Spawning up to 4 rc-sourcing shells per poll is far too
// heavy, so the probe result is cached: shell PATH essentially never changes
// mid-run. A miss (no bins) expires within one poll period so a user who
// installs botmux while the app shows "install CLI" (or hits an explicit
// retry) never sees a stale miss for more than ~one refresh.
const SHELL_PROBE_HIT_TTL_MS = 5 * 60_000;
const SHELL_PROBE_MISS_TTL_MS = 5_000;
let shellProbeCache: { at: number; value: { bins: string[]; pathEnv?: string } } | null = null;

/**
 * Merged login+interactive shell PATH for GUI-launched processes (darwin only;
 * undefined elsewhere or when probing fails). The bundled-runtime daemon spawn
 * uses this so per-bot CLIs installed via nvm/fnm/homebrew stay findable —
 * PtyBackend spawns CLIs without any rc-sourcing shell wrapper, so whatever
 * PATH the daemon starts with is what `#!/usr/bin/env node` resolves against.
 */
export function probeShellPathEnv(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const execFile = defaultExecFileSync as unknown as ExecFile;
  return cachedShellPathWhich(execFile, {}).pathEnv;
}

function cachedShellPathWhich(
  execFile: ExecFile,
  deps: ExternalRuntimeDiscoveryDeps,
): { bins: string[]; pathEnv?: string } {
  // Tests inject execFileSync/env; caching across injected deps would leak
  // state between tests, so the cache only serves the production defaults.
  const cacheable = !deps.execFileSync && !deps.env;
  if (cacheable && shellProbeCache) {
    const ttl = shellProbeCache.value.bins.length ? SHELL_PROBE_HIT_TTL_MS : SHELL_PROBE_MISS_TTL_MS;
    if (Date.now() - shellProbeCache.at < ttl) return shellProbeCache.value;
  }
  const value = runShellPathWhich(execFile, deps.env ?? process.env);
  if (cacheable) shellProbeCache = { at: Date.now(), value };
  return value;
}

function runShellPathWhich(execFile: ExecFile, env: NodeJS.ProcessEnv): { bins: string[]; pathEnv?: string } {
  const bins: string[] = [];
  const pathParts: string[] = [];
  const seenBins = new Set<string>();
  const seenParts = new Set<string>();

  for (const probe of shellPathProbes(env)) {
    let out: string;
    try {
      // `|| true` keeps the probe's $PATH usable even when this particular
      // shell flavor cannot see botmux — the PATH is still needed downstream.
      out = execFile(probe.shell, [probe.flags, `printf '${LOGIN_SHELL_PATH_MARKER}%s\\n' "$PATH"; which -a botmux || true`], {
        encoding: 'utf-8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    const parsed = splitLoginShellWhichOutput(out);
    for (const bin of parsed.bins) {
      if (seenBins.has(bin)) continue;
      seenBins.add(bin);
      bins.push(bin);
    }
    for (const part of parsed.pathEnv?.split(delimiter) ?? []) {
      const trimmed = part.trim();
      if (!trimmed || seenParts.has(trimmed)) continue;
      seenParts.add(trimmed);
      pathParts.push(trimmed);
    }
  }

  return { bins, ...(pathParts.length ? { pathEnv: pathParts.join(delimiter) } : {}) };
}

function readPackageVersion(
  root: string,
  exists: (path: string) => boolean,
  readFile: ReadTextFile,
  execFile?: ExecFile,
): string | null {
  const packagePath = join(root, 'package.json');
  if (!exists(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFile(packagePath, 'utf-8')) as { name?: unknown; version?: unknown };
    if (typeof pkg.name === 'string' && pkg.name !== 'botmux') return null;
    return resolveEffectiveBotmuxVersion({
      rawVersion: typeof pkg.version === 'string' ? pkg.version : null,
      rootDir: root,
      execFileSync: execFile,
    });
  } catch {
    return null;
  }
}

function splitCommandOutput(out: string): string[] {
  return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function splitLoginShellWhichOutput(out: string): { bins: string[]; pathEnv?: string } {
  const lines = splitCommandOutput(out);
  const markerIndex = lines.findIndex(line => line.startsWith(LOGIN_SHELL_PATH_MARKER));
  const pathEnv = markerIndex >= 0
    ? lines[markerIndex]!.slice(LOGIN_SHELL_PATH_MARKER.length).trim() || undefined
    : undefined;
  const binLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
  // Interactive rc files can echo arbitrary text and zsh's `which` prints
  // "botmux not found" to stdout — keep only absolute paths.
  return { bins: binLines.filter(line => line.startsWith('/')), ...(pathEnv ? { pathEnv } : {}) };
}

function isSemverVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim());
}

function normalizePath(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}
