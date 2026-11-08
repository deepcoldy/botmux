import { existsSync, lstatSync, mkdirSync, openSync, readSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { botmuxWrapperFiles } from '../../core/botmux-wrapper.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

/**
 * State of `~/.botmux/bin/botmux`, the launcher every agent session gets on PATH
 * (worker-pool prepends that dir) and that a terminal reaches once the shell
 * profile adds it.
 *
 *  · missing  — nothing there yet (fresh machine, app-only install)
 *  · self     — already execs the app's bundled binary
 *  · live     — belongs to a working install the user set up (npm, install.sh
 *               binary, source checkout). Left alone: the running daemon rewrites
 *               it to match whoever owns the fleet, and that is the source of truth
 *  · dangling — points at a file that no longer exists (a deleted worktree, an
 *               uninstalled npm package). Broken for every agent, so it is repaired
 */
export type BotmuxShimState =
  | { kind: 'missing' }
  | { kind: 'self' }
  | { kind: 'live'; target: string }
  | { kind: 'dangling'; target: string };

export interface ShimFs {
  existsSync(path: string): boolean;
  lstatSync(path: string): { isSymbolicLink(): boolean };
  realpathSync(path: string): string;
  readHead(path: string, bytes: number): string;
  readFileSync(path: string): string;
}

const defaultFs: ShimFs = {
  existsSync,
  lstatSync,
  realpathSync,
  readHead(path, bytes) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const n = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, n).toString('latin1');
    } finally {
      closeSync(fd);
    }
  },
  readFileSync: path => readFileSync(path, 'utf-8'),
};

export function inspectBotmuxShim(shimPath: string, bundledBinary: string, fs: ShimFs = defaultFs): BotmuxShimState {
  let isLink = false;
  try {
    isLink = fs.lstatSync(shimPath).isSymbolicLink();
  } catch {
    return { kind: 'missing' };
  }
  if (!fs.existsSync(shimPath)) {
    // lstat succeeded but the path does not resolve: a dangling symlink.
    return { kind: 'dangling', target: shimPath };
  }
  const resolved = safe(() => fs.realpathSync(shimPath), shimPath);
  const bundled = safe(() => fs.realpathSync(bundledBinary), bundledBinary);
  if (resolved === bundled) return { kind: 'self' };
  if (isLink || !fs.readHead(shimPath, 2).startsWith('#!')) {
    // A real executable (install.sh puts the compiled binary right here).
    return { kind: 'live', target: resolved };
  }

  const targets = scriptTargets(fs.readFileSync(shimPath));
  if (targets.length === 0) return { kind: 'live', target: shimPath };
  const missing = targets.find(target => !fs.existsSync(target));
  if (missing) return { kind: 'dangling', target: missing };
  const first = targets[0]!;
  if (safe(() => fs.realpathSync(first), first) === bundled) return { kind: 'self' };
  return { kind: 'live', target: targets[targets.length - 1]! };
}

/** Absolute paths a generated wrapper execs: `exec "<interp>" "<cli.js>" "$@"`. */
export function scriptTargets(script: string): string[] {
  const line = script.split('\n').find(candidate => /^\s*exec\s/.test(candidate));
  if (!line) return [];
  return [...line.matchAll(/"([^"]+)"/g)]
    .map(match => match[1]!)
    .filter(value => value.startsWith('/'));
}

export interface EnsureShimResult {
  before: BotmuxShimState;
  wrote: boolean;
}

/**
 * Make sure agents always have a working `botmux`. Never replaces a live launcher
 * owned by another install; only fills a missing one or repairs a dangling one.
 */
export function ensureBotmuxShim(input: {
  binDir: string;
  bundledBinary: string;
  fs?: ShimFs;
  write?: (path: string, content: string, mode: number) => void;
}): EnsureShimResult {
  const shimPath = join(input.binDir, 'botmux');
  const before = inspectBotmuxShim(shimPath, input.bundledBinary, input.fs);
  if (before.kind === 'live' || before.kind === 'self') return { before, wrote: false };

  const write = input.write ?? ((path: string, content: string, mode: number) => {
    // followTargetSymlink:false — a dangling symlink must be replaced, not
    // followed to wherever it used to point.
    atomicWriteFileSync(path, content, { mode, followTargetSymlink: false });
  });
  mkdirSync(input.binDir, { recursive: true });
  // Same files (and the same compiled-binary form) the daemon itself writes, so a
  // later daemon start sees identical content and leaves them untouched.
  for (const file of botmuxWrapperFiles('', input.bundledBinary, process.platform, true)) {
    write(join(input.binDir, file.name), file.content, file.mode);
  }
  return { before, wrote: true };
}

/** Whether any PATH entry already provides an executable `botmux`. */
export function pathProvidesBotmux(pathEnv: string | undefined, exists: (path: string) => boolean = existsSync): boolean {
  return (pathEnv ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some(dir => exists(join(dir, 'botmux')));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
