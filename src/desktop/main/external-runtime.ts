import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync, realpathSync as defaultRealpathSync, statSync as defaultStatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';
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
  const bins: DiscoveredBin[] = [
    ...runWhich(execFile, platform).map(binPath => ({ binPath })),
    // macOS GUI apps often miss the user's login shell PATH, so ask zsh too.
    ...(platform === 'darwin' ? runLoginShellWhich(execFile) : []),
    // User-owned wrappers are useful fallbacks, but should not override the CLI
    // that the user's shell actually resolves for `botmux`.
    { binPath: join(paths.botmuxHome, 'bin', 'botmux') },
    { binPath: '/opt/homebrew/bin/botmux' },
    { binPath: '/usr/local/bin/botmux' },
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

function runLoginShellWhich(execFile: ExecFile): DiscoveredBin[] {
  try {
    const out = execFile('/bin/zsh', ['-lc', `printf '${LOGIN_SHELL_PATH_MARKER}%s\\n' "$PATH"; which -a botmux`], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return splitLoginShellWhichOutput(out);
  } catch {
    return [];
  }
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

function splitLoginShellWhichOutput(out: string): DiscoveredBin[] {
  const lines = splitCommandOutput(out);
  const markerIndex = lines.findIndex(line => line.startsWith(LOGIN_SHELL_PATH_MARKER));
  const pathEnv = markerIndex >= 0
    ? lines[markerIndex]!.slice(LOGIN_SHELL_PATH_MARKER.length).trim() || undefined
    : undefined;
  const binLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
  return binLines.map(binPath => ({ binPath, ...(pathEnv ? { pathEnv } : {}) }));
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
